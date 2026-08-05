// modules/tools/handlers/read-scrape.js — read_page, scrape_url, crawl_website, extract_data
// Source: server.js lines 5406-6146

const { COBRA_DEFAULTS } = require('../../config');
const { assertSSRFSafe } = require('../../security/ssrf');
const { sanitizeScrapedContent } = require('../../security/injection');

async function readPage(args, ctx) {
  ctx.emitReasoning('Leggo e analizzo la pagina corrente...', '📖');
  ctx.emitThinking('Leggo il contenuto...');
  // Dismiss popup prima di leggere
  if (ctx.isBridgeReady()) { try { await ctx.dismissModalsBridge(); } catch (_) { /* best-effort */ } }
  else if (ctx.getState('activePage')) { try { await ctx.dismissModals(ctx.getState('activePage')); } catch (_) { /* best-effort */ } }
  // Bridge: rilegge se il contenuto manca o è troppo scarno.
  // Sulle pagine che caricano i dati via javascript la prima lettura torna
  // spesso vuota: si riprova con attese progressive invece di arrendersi.
  const scarso = (ctx.session.lastPage?.markdown || '').length < 1200;
  if (ctx.isBridgeReady() && scarso) {
    for (const attesa of [0, 1500, 2500]) {
      if (attesa) await new Promise(r => setTimeout(r, attesa));
      try {
        const bc = await ctx.bridgeCommand('get_page_content');
        const testo = bc?.markdown || bc?.text || '';
        if (bc?.ok && testo.length > (ctx.session.lastPage?.markdown || '').length) {
          ctx.session.lastPage = {
            url: bc.url || ctx.session.lastPage?.url || '',
            title: bc.title || ctx.session.lastPage?.title || '',
            markdown: testo, links: [], html: '',
          };
        }
      } catch (_) { /* si riprova al giro successivo */ }
      if ((ctx.session.lastPage?.markdown || '').length > 1200) break;
    }
  }
  if (!ctx.session.lastPage) return JSON.stringify({ error: 'Nessuna pagina caricata. Usa navigate prima.' });
  ctx.wsBroadcast({ type: 'page_loaded', url: ctx.session.lastPage.url, title: ctx.session.lastPage.title });
  if (ctx.session.lastPage.markdown) ctx.wsBroadcast({ type: 'monitor_content', markdown: ctx.session.lastPage.markdown.substring(0, 8000), url: ctx.session.lastPage.url, title: ctx.session.lastPage.title });
  // Screenshot
  const ap = ctx.getState('activePage');
  if (ap) { await ctx.takeActiveScreenshot(ctx.session.lastPage.url, ctx.session.lastPage.title); }
  else if (ctx.isBridgeReady()) {
    try { const ss = await ctx.bridgeCommand('screenshot', { quality: 70 }); if (ss.ok && ss.screenshot) { ctx.session.lastScreenshotData = ss.screenshot; ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage.url, title: ctx.session.lastPage.title }); } } catch (_) { /* best-effort */ }
  }
  if (ctx.session.lastPage.markdown) {
    // P0.1: Sanitize content before injecting into AI context
    const scan = sanitizeScrapedContent(ctx.session.lastPage.markdown, ctx.session.lastPage.url);
    const content = scan.text.substring(0, 12000);
    if (scan.injectionDetected) ctx.log(`[Security/Injection] readPage: ${scan.warning}`);
    const links = (ctx.session.lastPage.links || []).slice(0, 30).map(l => `- [${l.text}](${l.href})`).join('\n');
    return JSON.stringify({ ok: true, content, links, url: ctx.session.lastPage.url, title: ctx.session.lastPage.title, ...(scan.injectionDetected ? { _injectionWarning: true } : {}) });
  }
  // Fallback: HTML grezzo
  const text = (ctx.session.lastPage.html || '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 8000);
  return JSON.stringify({ ok: true, content: text, url: ctx.session.lastPage.url, title: ctx.session.lastPage.title });
}

async function scrapeUrl(args, ctx) {
  const url = args.url;
  const ssrf = await assertSSRFSafe(url);
  if (!ssrf.safe) {
    ctx.log(`[Security/SSRF] scrape_url BLOCCATO ${url}: ${ssrf.reason}`);
    return JSON.stringify({ error: `URL bloccato: ${ssrf.reason}` });
  }
  const hd = await ctx.HumanDriver.checkAndDelay(url);
  if (!hd.allowed) return JSON.stringify({ error: hd.reason, rateLimited: true });
  ctx.emitThinking(`Scraping ${url}...`);
  const scraped = await ctx.scrapeUrl(url, { timeout: COBRA_DEFAULTS.FETCH_TIMEOUT });
  const title = scraped.metadata?.title || '';
  ctx.session.lastPage = { url: scraped.metadata?.url || url, title, markdown: scraped.markdown, links: scraped.links || [], html: scraped.rawHtml || '' };
  ctx.emitSiteVisit(url, title || url, 'active');
  ctx.wsBroadcast({ type: 'page_loaded', url, title });
  ctx.wsBroadcast({ type: 'monitor_content', markdown: scraped.markdown.substring(0, 8000), url, title });
  if (scraped.screenshot) { ctx.session.lastScreenshotData = scraped.screenshot; ctx.wsBroadcast({ type: 'screenshot', data: scraped.screenshot, url, title }); }
  return JSON.stringify({ ok: true, content: scraped.markdown.substring(0, 12000), title, url: scraped.metadata?.url || url, stats: scraped.stats });
}

async function crawlWebsite(args, ctx) {
  const startUrl = args.url, maxPages = Math.min(args.maxPages || 10, 20);
  const startCheck = await assertSSRFSafe(startUrl);
  if (!startCheck.safe) {
    ctx.log(`[Security/SSRF] crawl_website BLOCCATO ${startUrl}: ${startCheck.reason}`);
    return JSON.stringify({ error: `URL bloccato: ${startCheck.reason}` });
  }
  ctx.emitThinking(`Crawling ${startUrl} (max ${maxPages})...`);
  const visited = new Set(), results = [], queue = [startUrl];
  const baseDomain = new URL(startUrl).hostname;
  while (queue.length > 0 && results.length < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue; visited.add(url);
    try {
      // Ogni URL della coda proviene dall'HTML scaricato: va verificato singolarmente
      const check = await assertSSRFSafe(url);
      if (!check.safe) { ctx.log(`[Security/SSRF] crawl salta ${url}: ${check.reason}`); continue; }
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      // Un redirect può puntare alla rete interna: si segue solo dopo verifica
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) continue;
        const target = new URL(loc, url).href;
        const rc = await assertSSRFSafe(target);
        if (!rc.safe) { ctx.log(`[Security/SSRF] crawl blocca redirect ${url} -> ${target}: ${rc.reason}`); continue; }
        if (!visited.has(target)) queue.push(target);
        continue;
      }
      const html = await resp.text();
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
      results.push({ url: resp.url || url, title: titleMatch?.[1]?.trim() || '', text });
      if (args.sameDomain !== false) {
        const linkRegex = /href="(https?:\/\/[^"]+)"/gi; let m;
        while ((m = linkRegex.exec(html)) !== null && queue.length < maxPages * 3) { try { if (new URL(m[1]).hostname === baseDomain && !visited.has(m[1])) queue.push(m[1]); } catch (_) { /* best-effort */ } }
      }
    } catch (_) { /* best-effort */ }
  }
  ctx.session.lastPage = { url: startUrl, title: `Crawl: ${baseDomain}`, html: results.map(r => r.text).join('\n') };
  return JSON.stringify({ ok: true, pages: results.length, results: results.map(r => ({ url: r.url, title: r.title, textPreview: r.text.substring(0, 300) })) });
}

async function extractData(args, ctx) {
  ctx.emitThinking('Estraggo dati strutturati...');
  if (!ctx.session.lastPage) return JSON.stringify({ error: 'Nessuna pagina caricata.' });
  const html = ctx.session.lastPage.html;
  const data = {};
  const headings = []; const hRegex = /<(h[1-3])[^>]*>(.*?)<\/\1>/gi; let hm;
  while ((hm = hRegex.exec(html)) !== null && headings.length < 15) headings.push({ level: hm[1].toUpperCase(), text: hm[2].replace(/<[^>]+>/g, '').trim() });
  data.headings = headings;
  const meta = {}; const metaRegex = /<meta[^>]+(name|property)="([^"]+)"[^>]+content="([^"]+)"/gi; let mm;
  while ((mm = metaRegex.exec(html)) !== null) meta[mm[2]] = mm[3]; data.meta = meta;
  const tables = []; const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi; let tm;
  while ((tm = tableRegex.exec(html)) !== null && tables.length < 5) {
    const rows = []; const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let rm;
    while ((rm = rowRegex.exec(tm[1])) !== null && rows.length < 20) {
      const cells = []; const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi; let cm;
      while ((cm = cellRegex.exec(rm[1])) !== null) cells.push(cm[1].replace(/<[^>]+>/g, '').trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  if (tables.length) data.tables = tables;
  return JSON.stringify({ ok: true, data, url: ctx.session.lastPage.url });
}

module.exports = { read_page: readPage, scrape_url: scrapeUrl, crawl_website: crawlWebsite, extract_data: extractData };
