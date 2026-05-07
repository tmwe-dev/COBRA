// modules/browser/scrape.js — Smart scraping with Puppeteer + fallback
// Source: server.js lines 2309-2640 (merged scrape-content.js)

const { getOrCreateBrowser } = require('./browser');
const { dismissCookieBanner } = require('./cookie-banner');
const { sanitizeScrapedContent } = require('../security/injection');

// ── Content extraction script (was scrape-content.js) ──
function getContentScript() {
  return function () {
    const NOISE_SELECTORS = [
      'nav','header','footer','[role="navigation"]','[role="banner"]','[role="contentinfo"]',
      '.nav','.navbar','.header','.footer','.sidebar','.menu','.breadcrumb','.pagination',
      '.ad','.ads','.advert','.advertisement','[class*="ad-"]','[id*="ad-"]',
      '.cookie','.cookie-banner','[class*="cookie"]','.popup','.modal','.overlay',
      '.social-share','.share-buttons','[class*="social"]','.comments','#comments',
      'script','style','noscript','iframe','svg','[aria-hidden="true"]',
      '.skip-link','.sr-only','form:not([role="search"])',
    ];
    const MAIN_SELECTORS = [
      'main','article','[role="main"]','#content','#main-content','.main-content',
      '.post-content','.article-content','.entry-content','.page-content','.content',
    ];
    function getMainContent() {
      for (const sel of MAIN_SELECTORS) { const el = document.querySelector(sel); if (el && el.textContent.trim().length > 200) return el.cloneNode(true); }
      return document.body.cloneNode(true);
    }
    function removeNoise(root) {
      for (const sel of NOISE_SELECTORS) root.querySelectorAll(sel).forEach(el => el.remove());
      root.querySelectorAll('[style]').forEach(el => { const s = el.style; if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') el.remove(); });
      return root;
    }
    function nodeToMd(node, depth = 0) {
      if (depth > 50) return node.textContent || '';
      if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const inner = () => Array.from(node.childNodes).map(c => nodeToMd(c, depth + 1)).join('');
      switch (tag) {
        case 'h1': return '\n\n# ' + inner().trim() + '\n\n';
        case 'h2': return '\n\n## ' + inner().trim() + '\n\n';
        case 'h3': return '\n\n### ' + inner().trim() + '\n\n';
        case 'h4': return '\n\n#### ' + inner().trim() + '\n\n';
        case 'h5': case 'h6': return '\n\n##### ' + inner().trim() + '\n\n';
        case 'p': return '\n\n' + inner().trim() + '\n\n';
        case 'br': return '\n'; case 'hr': return '\n\n---\n\n';
        case 'blockquote': return '\n\n> ' + inner().trim().replace(/\n/g, '\n> ') + '\n\n';
        case 'ul': case 'ol': return '\n\n' + listToMd(node, tag === 'ol') + '\n\n';
        case 'li': return inner().trim();
        case 'strong': case 'b': { const t = inner().trim(); return t ? '**' + t + '**' : ''; }
        case 'em': case 'i': { const t = inner().trim(); return t ? '*' + t + '*' : ''; }
        case 'code': return '`' + inner().trim() + '`';
        case 'pre': { const code = node.querySelector('code'); const lang = code?.className?.match(/language-(\w+)/)?.[1] || ''; return '\n\n```' + lang + '\n' + (code || node).textContent.trim() + '\n```\n\n'; }
        case 'a': { const href = node.getAttribute('href'); const t = inner().trim(); if (!t || !href || href === '#') return t || ''; try { return '[' + t + '](' + new URL(href, document.location.href).href + ')'; } catch { return t; } }
        case 'img': { const src = node.getAttribute('src'); const alt = node.getAttribute('alt') || 'image'; if (!src) return ''; try { return '![' + alt + '](' + new URL(src, document.location.href).href + ')'; } catch { return ''; } }
        case 'table': return '\n\n' + tableToMd(node) + '\n\n';
        case 'figure': return '\n\n' + inner().trim() + '\n\n';
        case 'figcaption': return '_' + inner().trim() + '_\n';
        case 'time': return node.getAttribute('datetime') || inner().trim();
        default: return inner();
      }
    }
    function listToMd(el, ordered) {
      const items = []; let i = 1;
      for (const li of el.children) { if (li.tagName?.toLowerCase() === 'li') { items.push((ordered ? i++ + '. ' : '- ') + nodeToMd(li).trim()); } }
      return items.join('\n');
    }
    function tableToMd(table) {
      const rows = [];
      table.querySelectorAll('tr').forEach(tr => { const cells = []; tr.querySelectorAll('th, td').forEach(cell => { const cs = parseInt(cell.getAttribute('colspan') || '1', 10); const c = nodeToMd(cell).trim().replace(/\|/g, '\\|'); for (let j = 0; j < cs; j++) cells.push(c); }); rows.push(cells); });
      if (!rows.length) return '';
      const cols = Math.max(...rows.map(r => r.length));
      const norm = r => { while (r.length < cols) r.push(''); return r; };
      const parts = ['| ' + norm(rows[0]).join(' | ') + ' |', '| ' + Array(cols).fill('---').join(' | ') + ' |'];
      for (let r = 1; r < rows.length; r++) parts.push('| ' + norm(rows[r]).join(' | ') + ' |');
      return parts.join('\n');
    }
    const root = removeNoise(getMainContent());
    const markdown = Array.from(root.childNodes).map(n => nodeToMd(n)).join('').replace(/\n{3,}/g, '\n\n').trim();
    const metadata = { title: document.title || '', url: document.location.href, description: document.querySelector('meta[name="description"]')?.content || '', author: document.querySelector('meta[name="author"]')?.content || '', lang: document.documentElement.lang || '' };
    const links = []; document.querySelectorAll('a[href]').forEach(a => { try { const href = new URL(a.href, document.location.href).href; const t = a.textContent.trim().substring(0, 100); if (t && href.startsWith('http')) links.push({ href, text: t }); } catch { /* best-effort */ } });
    const wordCount = markdown.replace(/[#*`\[\]()>-]/g, '').split(/\s+/).filter(w => w.length > 0).length;
    const paywallSignals = [];
    for (const sel of ['[class*="paywall"]','[id*="paywall"]','[class*="subscribe"]','[class*="locked"]','[class*="metered"]','[data-paywall]','.tp-modal','.piano-offer','[class*="abbona"]']) {
      const el = document.querySelector(sel); if (el && el.offsetParent !== null) paywallSignals.push(sel);
    }
    return { markdown, metadata, links: links.slice(0, 50), stats: { chars: markdown.length, words: wordCount, readingTime: Math.ceil(wordCount / 200) + ' min' }, rawHtml: document.documentElement.outerHTML, isPaywalled: paywallSignals.length > 0, paywallSignals };
  };
}

async function smartScrape(url, options = {}) {
  const { timeout = 12000, existingPage = null } = options;
  let ownPage = null;
  const page = existingPage;
  if (!page) {
    const browser = await getOrCreateBrowser();
    ownPage = await browser.newPage();
    await ownPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await ownPage.setViewport({ width: 1280, height: 800 });
    await ownPage.goto(url, { waitUntil: 'domcontentloaded', timeout });
    try { await ownPage.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }); } catch { /* best-effort */ }
    await dismissCookieBanner(ownPage);
  }
  const activePage = page || ownPage;
  try {
    // Scroll to trigger lazy-loaded images
    try {
      await activePage.evaluate(async () => {
        const step = Math.max(300, window.innerHeight * 0.7);
        const max = Math.min(document.body.scrollHeight, 8000);
        for (let y = 0; y < max; y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 200)); }
        document.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]').forEach(img => {
          const s = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
          if (s && !img.src.startsWith('http')) img.src = s;
        });
        document.querySelectorAll('img[data-srcset]').forEach(img => { img.srcset = img.getAttribute('data-srcset'); });
        window.scrollTo(0, 0);
      });
      await new Promise(r => setTimeout(r, 2000));
    } catch { /* best-effort */ }

    const result = await activePage.evaluate(getContentScript());
    // P0.1: Scan scraped content for prompt injection
    if (result.markdown) {
      const scan = sanitizeScrapedContent(result.markdown, result.metadata?.url || url);
      result.markdown = scan.text;
      if (scan.injectionDetected) {
        result._injectionWarning = scan.warning;
        console.log(`[Security/Injection] ${scan.warning}`);
      }
    }
    let screenshot = null;
    try { screenshot = await activePage.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60, fullPage: true }); } catch { /* best-effort */ }
    result.screenshot = screenshot;
    return result;
  } finally {
    if (ownPage) await ownPage.close().catch(() => {});
  }
}

async function simpleScrape(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    redirect: 'follow', signal: AbortSignal.timeout(10000),
  });
  const html = await resp.text();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '').replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // P0.1: Scan for injection
  const scan = sanitizeScrapedContent(text, url);
  text = scan.text;
  const result = { markdown: text, metadata: { title, url: resp.url || url }, links: [], stats: { chars: text.length }, rawHtml: html };
  if (scan.injectionDetected) { result._injectionWarning = scan.warning; console.log(`[Security/Injection] ${scan.warning}`); }
  return result;
}

async function scrapeUrl(url, options = {}) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch { /* best-effort */ }
  if (puppeteer) {
    try { return await smartScrape(url, options); }
    catch (e) { console.log(`[SmartScraper] Puppeteer failed for ${url}: ${e.message} — fallback`); }
  }
  return await simpleScrape(url);
}

module.exports = { smartScrape, simpleScrape, scrapeUrl };
