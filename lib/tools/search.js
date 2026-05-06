// lib/tools/search.js — Web search tools (DuckDuckGo, Google, Brave)

async function toolGoogleSearch(args, deps) {
  const { log, session, wsBroadcast, emitThinking, emitReasoning,
    HumanDriver, ResearchStrategy, puppeteer, getActivePage, takeActiveScreenshot,
    COBRA_DEFAULTS } = deps;

  const query = args.query || '';
  const hdSearch = await HumanDriver.checkAndDelay('https://www.google.com/search?q=' + encodeURIComponent(query));
  if (!hdSearch.allowed) return JSON.stringify({ error: hdSearch.reason, rateLimited: true });

  ResearchStrategy.registerQuery(query, 'google');
  emitReasoning(`Cerco informazioni su: "${query}"`, '🔍');
  emitThinking(`Cerco "${query}"...`);
  let results = [];
  let searchSource = '';

  // STRATEGY 1: DuckDuckGo HTML
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const ddgResp = await fetch(ddgUrl, {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(8000), redirect: 'follow',
    });
    const ddgHtml = await ddgResp.text();
    session.lastPage = { url: ddgUrl, title: `Ricerca: ${query}`, html: ddgHtml };
    const ddgRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = ddgRegex.exec(ddgHtml)) !== null && results.length < 10) {
      let rUrl = m[1];
      const uddgMatch = rUrl.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) rUrl = decodeURIComponent(uddgMatch[1]);
      const rTitle = m[2].replace(/<[^>]+>/g, '').trim();
      if (rTitle && rUrl.startsWith('http')) results.push({ url: rUrl, title: rTitle });
    }
    if (results.length > 0) {
      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let si = 0;
      while ((m = snippetRegex.exec(ddgHtml)) !== null && si < results.length) {
        results[si].snippet = m[1].replace(/<[^>]+>/g, '').trim().substring(0, 200);
        si++;
      }
      searchSource = 'duckduckgo';
    }
    if (results.length === 0) {
      const altRegex = /<a[^>]+class="result__url"[^>]+href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]+class="result__title"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = altRegex.exec(ddgHtml)) !== null && results.length < 10) {
        let rUrl = m[1]; const uddg2 = rUrl.match(/[?&]uddg=([^&]+)/); if (uddg2) rUrl = decodeURIComponent(uddg2[1]);
        const rTitle = m[2].replace(/<[^>]+>/g, '').trim();
        if (rTitle) results.push({ url: rUrl, title: rTitle });
      }
      if (results.length > 0) searchSource = 'duckduckgo-alt';
    }
    if (results.length === 0) {
      const linkRegex = /href="(https?:\/\/(?!duckduckgo\.com)[^"]+)"[^>]*>([^<]{4,80})<\/a>/gi;
      while ((m = linkRegex.exec(ddgHtml)) !== null && results.length < 10) {
        const rTitle = m[2].trim();
        if (rTitle.length > 3 && !m[1].includes('duckduckgo.com')) results.push({ url: m[1], title: rTitle });
      }
      if (results.length > 0) searchSource = 'duckduckgo-links';
    }
    log('INFO', `[search] DuckDuckGo: ${results.length} risultati`);
  } catch (ddgErr) { log('WARN', `[search] DuckDuckGo failed: ${ddgErr.message}`); }

  // STRATEGY 2: Google fallback
  if (results.length === 0) {
    try {
      const gUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=it&num=10`;
      const gResp = await fetch(gUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(COBRA_DEFAULTS.FETCH_TIMEOUT)
      });
      const gHtml = await gResp.text();
      session.lastPage = { url: gUrl, title: `Google: ${query}`, html: gHtml };
      const regexA = /<a[^>]+href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
      let m;
      while ((m = regexA.exec(gHtml)) !== null && results.length < 10) {
        const rUrl = decodeURIComponent(m[1]); const rTitle = m[2].replace(/<[^>]+>/g, '').trim();
        if (rTitle && !rUrl.includes('google.com')) results.push({ url: rUrl, title: rTitle });
      }
      if (results.length > 0) searchSource = 'google';
      log('INFO', `[search] Google fallback: ${results.length} risultati`);
    } catch (gErr) { log('WARN', `[search] Google fallback failed: ${gErr.message}`); }
  }

  // STRATEGY 3: Brave Search
  if (results.length === 0) {
    try {
      const braveUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
      const braveResp = await fetch(braveUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(8000),
      });
      const braveHtml = await braveResp.text();
      session.lastPage = { url: braveUrl, title: `Brave: ${query}`, html: braveHtml };
      const braveRegex = /<a[^>]+class="[^"]*result-header[^"]*"[^>]+href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi;
      let m;
      while ((m = braveRegex.exec(braveHtml)) !== null && results.length < 10) {
        const rTitle = m[2].replace(/<[^>]+>/g, '').trim();
        if (rTitle && m[1].startsWith('http')) results.push({ url: m[1], title: rTitle });
      }
      if (results.length === 0) {
        const altBrave = /href="(https?:\/\/(?!search\.brave)[^"]+)"[^>]*>([^<]{5,100})<\/a>/gi;
        while ((m = altBrave.exec(braveHtml)) !== null && results.length < 10) {
          const t = m[2].trim(); if (t.length > 4) results.push({ url: m[1], title: t });
        }
      }
      if (results.length > 0) searchSource = 'brave';
      log('INFO', `[search] Brave: ${results.length} risultati`);
    } catch (braveErr) { log('WARN', `[search] Brave failed: ${braveErr.message}`); }
  }

  // Extract text from page as extra context
  let pageText = '';
  if (session.lastPage && session.lastPage.html) {
    pageText = session.lastPage.html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '').replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 6000);
  }

  if (results.length > 0) {
    emitReasoning(`Trovati ${results.length} risultati — analizzo i più rilevanti...`, '📋');
    for (const r of results.slice(0, 4)) emitReasoning(`📄 ${r.title}`, '🔗');
    const searchMarkdown = results.slice(0, 8).map((r, i) => `### ${i + 1}. ${r.title || 'Risultato'}\n**${r.url}**\n${r.snippet || ''}\n`).join('\n');
    wsBroadcast({ type: 'monitor_content', markdown: `# Ricerca: ${query}\n\n${searchMarkdown}`, url: results[0]?.url || '', title: `Ricerca: ${query}` });
    if (puppeteer && results[0]?.url) {
      try {
        const previewPage = await getActivePage(results[0].url);
        await new Promise(r => setTimeout(r, 1000));
        await takeActiveScreenshot(results[0].url, results[0].title || query);
      } catch (e) { log(`[search] Preview screenshot failed: ${e.message}`); }
    }
  } else {
    emitReasoning('Nessun risultato trovato, provo un approccio diverso...', '⚠️');
  }

  return JSON.stringify({ ok: true, query, results, count: results.length, source: searchSource || 'none', pageText: results.length < 3 ? pageText : pageText.substring(0, 2000) });
}

async function toolWebSearch(args, deps) {
  return toolGoogleSearch(args, deps);
}

module.exports = { toolGoogleSearch, toolWebSearch };
