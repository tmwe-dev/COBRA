// lib/tools/navigate.js
// Navigation & search tools: navigate, google_search, web_search, scrape_url, batch_scrape, read_table

/**
 * toolNavigate - Navigate to a URL and scrape content
 * Cases: navigate (server.js 4856-4997)
 */
async function toolNavigate(args, deps) {
  const { log, session, wsBroadcast, emitThinking, emitReasoning, isBridgeReady, bridgeCommand,
    bridgeNavigate, _activePage, takeActiveScreenshot, smartScrape, scrapeUrl,
    HumanDriver, ResearchStrategy, Supervisor, isSSRFSafe, detectCaptcha, puppeteer, getActivePage,
    COBRA_DEFAULTS, _paywallDomains, _savePaywallDomains, emitSiteVisit, dismissModalsBridge } = deps;

  const url = args.url;
  // GUARDRAIL: blocca navigate verso google.com generico per task di azione
  try {
    const navUrl = new URL(url);
    const isGenericGoogle = /^(www\.)?google\.\w+$/.test(navUrl.hostname) && (navUrl.pathname === '/' || navUrl.pathname === '' || navUrl.pathname === '/search');
    const currentOpLevel = session.currentOperationLevel || 'read';
    if (isGenericGoogle && (currentOpLevel === 'write' || currentOpLevel === 'prepare')) {
      log(`[Supervisor] BLOCKED: navigate to generic Google (${url}) during opLevel=${currentOpLevel}`);
      return JSON.stringify({ error: 'BLOCCATO: Per task di azione, vai direttamente al sito del servizio (es. Google Flights, Booking, Trenitalia). NON usare Google Search — i click sui risultati falliscono. Usa navigate con l\'URL del sito specifico.' });
    }
    // flight_booking guardrail rimosso — COBRA non fa più booking via browser
  } catch (e) { /* URL parse fail */ }

  // Same-domain loop protection
  try {
    const navDom = new URL(url).hostname.replace('www.','');
    if (!Supervisor._navDomainCount) Supervisor._navDomainCount = {};
    Supervisor._navDomainCount[navDom] = (Supervisor._navDomainCount[navDom] || 0) + 1;
    if (Supervisor._navDomainCount[navDom] > 4) {
      log(`[Supervisor] DOMAIN LOOP: ${navDom} navigated ${Supervisor._navDomainCount[navDom]}x — forcing stop`);
      return JSON.stringify({ error: `LOOP: hai navigato su ${navDom} ${Supervisor._navDomainCount[navDom]} volte senza risultati. FERMATI e rispondi all'utente con quello che hai. Suggerisci un approccio alternativo.` });
    }
  } catch (e) { /* URL parse fail */ }

  // SSRF guard
  if (!isSSRFSafe(url)) {
    log(`[Security] SSRF blocked in navigate: ${url}`);
    return JSON.stringify({ error: 'URL bloccato: non è consentito navigare verso IP locali o privati.' });
  }

  // Blocca mailto:
  if (/^mailto:/i.test(url)) {
    return JSON.stringify({ error: 'Non navigare mailto: — usa il tool send_email per inviare email. Prima usa prepare_email_draft per mostrare la bozza.' });
  }

  // Human Driver: delay gaussiano per piattaforme protette
  const hdCheck = await HumanDriver.checkAndDelay(url);
  if (!hdCheck.allowed) {
    return JSON.stringify({ error: hdCheck.reason, rateLimited: true });
  }
  if (hdCheck.delayed) {
    log(`[HumanDriver] navigate ${hdCheck.domain} (T${hdCheck.tier}) delayed ${hdCheck.delay}ms`);
  }

  emitReasoning(`Apro il sito per leggere il contenuto...`, '🌐');
  emitThinking(`Navigo su ${url}...`);

  // Check if this domain is known to be paywalled
  const navDomain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  const isArticle = /\/\d{4}\/|\/article|\/news\/|\/notizie\/|\/cronaca\/|\/politica\/|\/economia\//i.test(url);
  const knownPaywall = _paywallDomains.has(navDomain);
  if (knownPaywall && isArticle) {
    log(`[Paywall] Blocked article on paywalled domain: ${navDomain}`);
    emitReasoning(`⚠️ ${navDomain} richiede abbonamento per gli articoli — leggo solo la homepage`, '🔒');
  }

  // ── BRIDGE PATH: naviga nel browser reale ──
  if (isBridgeReady()) {
    try {
      const bridgeNav = await bridgeNavigate(url);
      if (bridgeNav.ok) {
        // ── POST-NAVIGATE: dismiss popup/cookie/overlay via bridge ──
        await new Promise(r => setTimeout(r, 1500)); // attendi caricamento completo + popup ritardati
        try { await dismissModalsBridge(); } catch (e) { log(`[Bridge] dismissModals after navigate: ${e.message}`); }
        // Secondo passaggio dopo 2s per popup ritardati (es. newsletter, promo)
        setTimeout(async () => { try { await dismissModalsBridge(); } catch {} }, 2000);

        const title = bridgeNav.content?.title || '';
        // Re-read content DOPO dismiss (altrimenti legge il popup)
        let content = (bridgeNav.content?.content || '').substring(0, 12000);
        try {
          const freshRead = await bridgeCommand('read_page', {});
          if (freshRead.ok && freshRead.content) {
            content = (freshRead.content || '').substring(0, 12000);
          }
        } catch {}
        session.lastPage = { url: bridgeNav.url || url, title, markdown: content, links: [], html: '' };
        emitSiteVisit(session.lastPage.url, title || url, 'active');
        wsBroadcast({ type: 'page_loaded', url: session.lastPage.url, title });
        wsBroadcast({ type: 'monitor_content', markdown: content.substring(0, 8000), url: session.lastPage.url, title });
        try {
          const ss = await bridgeCommand('screenshot', { quality: 70 });
          if (ss.ok && ss.screenshot) {
            session.lastScreenshotData = ss.screenshot;
            session.lastBroadcastUrl = session.lastPage.url;
            wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: session.lastPage.url, title });
          }
        } catch (e) { log(`[Bridge] screenshot after navigate error: ${e.message}`); }
        return JSON.stringify({ ok: true, url: session.lastPage.url, title, content, via: 'bridge' });
      }
      log(`[Bridge] navigate failed, fallback to Puppeteer: ${bridgeNav.error}`);
    } catch (e) {
      log(`[Bridge] navigate error, fallback to Puppeteer: ${e.message}`);
    }
  }

  // Navigate: UNA sola pagina, estrai contenuto dalla stessa
  let scraped;
  if (puppeteer) {
    try {
      const activePg = await getActivePage(url);
      await new Promise(r => setTimeout(r, 1000));
      try {
        const captchaType = await detectCaptcha(activePg);
        if (captchaType) {
          log(`[navigate] CAPTCHA rilevato: ${captchaType}`);
          emitReasoning(`⚠️ CAPTCHA rilevato (${captchaType}) — potrebbe servire intervento umano`, '🔒');
        }
      } catch (e) { /* silent */ }
      scraped = await smartScrape(url, { existingPage: activePg });
    } catch (e) {
      log(`[navigate] Active page failed: ${e.message} — fallback to scrapeUrl`);
      scraped = await scrapeUrl(url, { timeout: COBRA_DEFAULTS.TAB_LOAD_TIMEOUT });
    }
  } else {
    scraped = await scrapeUrl(url, { timeout: COBRA_DEFAULTS.TAB_LOAD_TIMEOUT });
  }

  const title = scraped.metadata?.title || '';
  session.lastPage = { url: scraped.metadata?.url || url, title, markdown: scraped.markdown, links: scraped.links || [], html: scraped.rawHtml || '' };
  emitSiteVisit(session.lastPage.url, title || url, 'active');
  wsBroadcast({ type: 'page_loaded', url: session.lastPage.url, title });
  wsBroadcast({ type: 'monitor_content', markdown: scraped.markdown.substring(0, 8000), url: session.lastPage.url, title });

  let _navScreenshot = null;
  if (_activePage) {
    _navScreenshot = await takeActiveScreenshot(session.lastPage.url, title);
  }
  if (!_navScreenshot && scraped.screenshot) {
    session.lastScreenshotData = scraped.screenshot;
    session.lastBroadcastUrl = session.lastPage.url;
    wsBroadcast({ type: 'screenshot', data: scraped.screenshot, url: session.lastPage.url, title });
  }

  // ── PAYWALL DETECTION & MEMORY ──
  if (scraped.isPaywalled) {
    if (!_paywallDomains.has(navDomain)) {
      _paywallDomains.add(navDomain);
      _savePaywallDomains();
      log(`[Paywall] Detected paywall on ${navDomain} — remembered for future`);
    }
    wsBroadcast({ type: 'ai_reasoning', text: `🔒 ${navDomain} richiede abbonamento — contenuto limitato`, icon: '🔒' });
    const content = scraped.markdown.substring(0, 12000);
    return JSON.stringify({
      ok: true, url: session.lastPage.url, title, content, stats: scraped.stats,
      linksCount: (scraped.links || []).length,
      paywall: true,
      paywallWarning: `ATTENZIONE: ${navDomain} ha un paywall attivo. NON tentare di aprire articoli interni — richiedono abbonamento. Puoi solo leggere titoli e anteprime dalla homepage. Ricordati di questo sito.`
    });
  }

  const content = scraped.markdown.substring(0, 12000);
  return JSON.stringify({ ok: true, url: session.lastPage.url, title, content, stats: scraped.stats, linksCount: (scraped.links || []).length });
}

module.exports = { toolNavigate };
