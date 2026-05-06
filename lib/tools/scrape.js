// lib/tools/scrape.js — Page reading, scraping, and table tools

async function toolReadPage(args, deps) {
  const { log, session, wsBroadcast, emitThinking, emitReasoning,
    isBridgeReady, bridgeCommand, _activePage, takeActiveScreenshot } = deps;

  emitReasoning('Leggo e analizzo la pagina corrente...', '📖');
  emitThinking('Leggo il contenuto...');

  if (isBridgeReady() && !session.lastPage?.markdown) {
    try {
      const bridgeContent = await bridgeCommand('get_page_content');
      if (bridgeContent.ok) {
        session.lastPage = { url: bridgeContent.url || session.lastPage?.url || '', title: bridgeContent.title || '', markdown: bridgeContent.markdown || bridgeContent.text || '', links: [], html: '' };
      }
    } catch (e) { /* silent */ }
  }
  if (!session.lastPage) return JSON.stringify({ error: 'Nessuna pagina caricata. Usa navigate prima.' });
  wsBroadcast({ type: 'page_loaded', url: session.lastPage.url, title: session.lastPage.title });
  if (session.lastPage.markdown) {
    wsBroadcast({ type: 'monitor_content', markdown: session.lastPage.markdown.substring(0, 8000), url: session.lastPage.url, title: session.lastPage.title });
  }
  if (_activePage) {
    await takeActiveScreenshot(session.lastPage.url, session.lastPage.title);
  } else if (isBridgeReady()) {
    try {
      const ss = await bridgeCommand('screenshot', { quality: 70 });
      if (ss.ok && ss.screenshot) {
        session.lastScreenshotData = ss.screenshot;
        session.lastBroadcastUrl = session.lastPage.url;
        wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: session.lastPage.url, title: session.lastPage.title });
      }
    } catch (e) { log(`[Bridge] screenshot in read_page error: ${e.message}`); }
  }
  if (session.lastPage.markdown) {
    const content = session.lastPage.markdown.substring(0, 12000);
    const links = (session.lastPage.links || []).slice(0, 30).map(l => `- [${l.text}](${l.href})`).join('\n');
    return JSON.stringify({ ok: true, content, links, url: session.lastPage.url, title: session.lastPage.title });
  }
  let text = (session.lastPage.html || '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 8000);
  return JSON.stringify({ ok: true, content: text, url: session.lastPage.url, title: session.lastPage.title });
}

async function toolScrapeUrl(args, deps) {
  const { log, session, wsBroadcast, emitThinking, isSSRFSafe, scrapeUrl,
    HumanDriver, ResearchStrategy, COBRA_DEFAULTS, emitSiteVisit } = deps;

  const url = args.url;
  if (!isSSRFSafe(url)) { log(`[Security] SSRF blocked in scrape_url: ${url}`); return JSON.stringify({ error: 'URL bloccato: IP locale/privato non consentito.' }); }
  const hdScrape = await HumanDriver.checkAndDelay(url);
  if (!hdScrape.allowed) return JSON.stringify({ error: hdScrape.reason, rateLimited: true });
  ResearchStrategy.registerSource({ url, title: '', relevance: 'medium' });
  emitThinking(`Scraping ${url}...`);
  const scraped = await scrapeUrl(url, { timeout: COBRA_DEFAULTS.FETCH_TIMEOUT });
  const title = scraped.metadata?.title || '';
  const content = scraped.markdown.substring(0, 12000);
  ResearchStrategy.registerSource({ url, title, relevance: 'high' });
  session.lastPage = { url: scraped.metadata?.url || url, title, markdown: scraped.markdown, links: scraped.links || [], html: scraped.rawHtml || '' };
  emitSiteVisit(url, title || url, 'active');
  wsBroadcast({ type: 'page_loaded', url, title });
  wsBroadcast({ type: 'monitor_content', markdown: scraped.markdown.substring(0, 8000), url, title });
  if (scraped.screenshot) {
    session.lastScreenshotData = scraped.screenshot;
    session.lastBroadcastUrl = url;
    wsBroadcast({ type: 'screenshot', data: scraped.screenshot, url, title });
  }
  return JSON.stringify({ ok: true, content, title, url: scraped.metadata?.url || url, stats: scraped.stats });
}

async function toolBatchScrape(args, deps) {
  const { emitThinking } = deps;
  emitThinking('Batch scraping...');
  let urls;
  try { urls = JSON.parse(args.urls); } catch { return JSON.stringify({ error: 'JSON array di URL non valido' }); }
  const results = await Promise.allSettled(urls.slice(0, 10).map(async (url) => {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const html = await resp.text();
    const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000);
    return { url, text };
  }));
  const scraped = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  return JSON.stringify({ ok: true, results: scraped, count: scraped.length });
}

async function toolReadTable(args, deps) {
  const { emitThinking, isBridgeReady, bridgeCommand, _activePage } = deps;
  emitThinking('Leggo tabella...');
  if (isBridgeReady()) {
    const result = await bridgeCommand('read_table', { selector: args.selector, maxRows: args.maxRows });
    return JSON.stringify(result);
  }
  if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try {
    const data = await _activePage.evaluate((sel, max) => {
      const table = sel ? document.querySelector(sel) : document.querySelector('table');
      if (!table) return { ok: false, error: 'No table found' };
      const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map(th => th.textContent.trim());
      const rows = [];
      for (const tr of [...table.querySelectorAll('tbody tr, tr')].slice(0, max || 50)) {
        const cells = [...tr.querySelectorAll('td, th')].map(td => td.textContent.trim().substring(0, 200));
        if (cells.length > 0) rows.push(cells);
      }
      return { ok: true, headers, rows, totalRows: table.querySelectorAll('tr').length };
    }, args.selector || null, args.maxRows || 50);
    return JSON.stringify(data);
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

module.exports = { toolReadPage, toolScrapeUrl, toolBatchScrape, toolReadTable };
