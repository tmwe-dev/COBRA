// modules/tools/handlers/search.js — web_search/google_search handler
// Source: server.js lines 5205-5404

const { COBRA_DEFAULTS } = require('../../config');
const { sanitizeScrapedContent } = require('../../security/injection');

// ── La stessa domanda non si fa due volte ──
//
// Verificato dal vivo il 6 agosto: nello stesso turno la query "voli Milano
// Tokyo 14-28 settembre 2026" è stata cercata QUATTRO volte identica, e il
// Supervisore ha dovuto fermare il lavoro per loop. navigate una cache di
// turno ce l'aveva già; la ricerca no, e il giro si chiudeva sempre lì:
// cerca → apri → bloccato → ricerca uguale.
//
// Servire il risultato dalla cache non basta: se torna la stessa cosa senza
// dire niente, il modello rifà la stessa mossa. Va DETTO che è già stata
// fatta, così quella strada risulta chiusa e se ne cerca un'altra.
function _chiaveRicerca(query) {
  return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function handle(args, ctx) {
  const query = args.query || '';

  if (!ctx.session._cacheRicerche) ctx.session._cacheRicerche = new Map();
  const chiave = _chiaveRicerca(query);
  if (chiave && ctx.session._cacheRicerche.has(chiave)) {
    const primo = ctx.session._cacheRicerche.get(chiave);
    ctx.log('INFO', `[search] Query già fatta in questo turno, servita dalla cache: "${query}"`);
    ctx.emitReasoning(`Questa ricerca l'ho già fatta: uso quei risultati`, '♻️');
    return JSON.stringify({
      ...primo,
      giaCercata: true,
      avvertenza: 'Questa ricerca è già stata fatta in questo turno e i risultati sono gli stessi. '
        + 'Ripeterla non porta niente di nuovo: usa questi risultati, oppure cambia strada — '
        + 'una query diversa, una fonte diretta, un altro modo di arrivare al dato.',
    });
  }

  const hdSearch = await ctx.HumanDriver.checkAndDelay('https://www.google.com/search?q=' + encodeURIComponent(query));
  if (!hdSearch.allowed) return JSON.stringify({ error: hdSearch.reason, rateLimited: true });
  ctx.emitReasoning(`Cerco informazioni su: "${query}"`, '🔍');
  ctx.emitThinking(`Cerco "${query}"...`);

  let results = [];
  let searchSource = '';

  // Strategy 1: DuckDuckGo HTML
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const ddgResp = await fetch(ddgUrl, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    const ddgHtml = await ddgResp.text();
    ctx.session.lastPage = { url: ddgUrl, title: `Ricerca: ${query}`, html: ddgHtml };
    const ddgRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = ddgRegex.exec(ddgHtml)) !== null && results.length < 10) {
      let rUrl = m[1]; const uddg = rUrl.match(/[?&]uddg=([^&]+)/);
      if (uddg) rUrl = decodeURIComponent(uddg[1]);
      const rTitle = m[2].replace(/<[^>]+>/g, '').trim();
      if (rTitle && rUrl.startsWith('http')) results.push({ url: rUrl, title: rTitle });
    }
    if (results.length > 0) {
      const snipRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let si = 0;
      while ((m = snipRegex.exec(ddgHtml)) !== null && si < results.length) { results[si].snippet = m[1].replace(/<[^>]+>/g, '').trim().substring(0, 200); si++; }
      searchSource = 'duckduckgo';
    }
    if (results.length === 0) {
      const linkRegex = /href="(https?:\/\/(?!duckduckgo\.com)[^"]+)"[^>]*>([^<]{4,80})<\/a>/gi;
      while ((m = linkRegex.exec(ddgHtml)) !== null && results.length < 10) {
        const t = m[2].trim();
        if (t.length > 3 && !m[1].includes('duckduckgo.com')) results.push({ url: m[1], title: t });
      }
      if (results.length > 0) searchSource = 'duckduckgo-links';
    }
    ctx.log('INFO', `[search] DuckDuckGo: ${results.length} risultati`);
  } catch (e) { ctx.log('WARN', `[search] DuckDuckGo failed: ${e.message}`); }

  // Strategy 2: Google fallback
  if (results.length === 0) {
    try {
      const gUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=it&num=10`;
      const gResp = await fetch(gUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept-Language': 'it-IT,it;q=0.9', 'Accept': 'text/html' }, signal: AbortSignal.timeout(COBRA_DEFAULTS.FETCH_TIMEOUT) });
      const gHtml = await gResp.text();
      ctx.session.lastPage = { url: gUrl, title: `Google: ${query}`, html: gHtml };
      const regexA = /<a[^>]+href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
      let m;
      while ((m = regexA.exec(gHtml)) !== null && results.length < 10) {
        const rUrl = decodeURIComponent(m[1]); const rTitle = m[2].replace(/<[^>]+>/g, '').trim();
        if (rTitle && !rUrl.includes('google.com')) results.push({ url: rUrl, title: rTitle });
      }
      if (results.length > 0) searchSource = 'google';
    } catch (e) { ctx.log('WARN', `[search] Google failed: ${e.message}`); }
  }

  // Strategy 3: Brave Search
  if (results.length === 0) {
    try {
      const braveUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
      const braveResp = await fetch(braveUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }, signal: AbortSignal.timeout(8000) });
      const braveHtml = await braveResp.text();
      const braveRegex = /<a[^>]+class="[^"]*result-header[^"]*"[^>]+href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi;
      let m;
      while ((m = braveRegex.exec(braveHtml)) !== null && results.length < 10) {
        const t = m[2].replace(/<[^>]+>/g, '').trim();
        if (t && m[1].startsWith('http')) results.push({ url: m[1], title: t });
      }
      if (results.length > 0) searchSource = 'brave';
    } catch (e) { ctx.log('WARN', `[search] Brave failed: ${e.message}`); }
  }

  // Extract page text as extra context
  let pageText = '';
  if (ctx.session.lastPage?.html) {
    pageText = ctx.session.lastPage.html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 6000);
  }

  // Broadcast results
  if (results.length > 0) {
    ctx.emitReasoning(`Trovati ${results.length} risultati`, '📋');
    for (const r of results.slice(0, 4)) ctx.emitReasoning(`📄 ${r.title}`, '🔗');
    const md = results.slice(0, 8).map((r, i) => `### ${i + 1}. ${r.title}\n**${r.url}**\n${r.snippet || ''}\n`).join('\n');
    ctx.wsBroadcast({ type: 'monitor_content', markdown: `# Ricerca: ${query}\n\n${md}`, url: results[0]?.url || '', title: `Ricerca: ${query}` });
    if (ctx.puppeteer && results[0]?.url) {
      try { const pp = await ctx.getActivePage(results[0].url); await new Promise(r => setTimeout(r, 1000)); await ctx.takeActiveScreenshot(results[0].url, results[0].title || query); } catch (_) { /* best-effort */ }
    }
  } else {
    ctx.emitReasoning('Nessun risultato trovato', '⚠️');
  }

  // P0.1: Sanitize pageText before injecting into AI context
  if (pageText) {
    const scan = sanitizeScrapedContent(pageText, ctx.session.lastPage?.url);
    pageText = scan.text;
    if (scan.injectionDetected) ctx.log(`[Security/Injection] search pageText: ${scan.warning}`);
  }
  const esito = { ok: true, query, results, count: results.length, source: searchSource || 'none', pageText: results.length < 3 ? pageText : pageText.substring(0, 2000) };
  if (chiave) ctx.session._cacheRicerche.set(chiave, esito);
  return JSON.stringify(esito);
}

module.exports = { web_search: handle, google_search: handle };
