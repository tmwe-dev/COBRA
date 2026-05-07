// modules/tools/handlers/navigate.js — navigate tool handler
// Source: server.js lines 5041-5203

const { COBRA_DEFAULTS } = require('../../config');
const { isSSRFSafe } = require('../../security/ssrf');

async function handle(args, ctx) {
  const url = args.url;

  // GUARDRAIL: blocca navigate verso google.com generico per task di azione
  try {
    const navUrl = new URL(url);
    const isGenericGoogle = /^(www\.)?google\.\w+$/.test(navUrl.hostname) && ['/', '', '/search'].includes(navUrl.pathname);
    const opLevel = ctx.session.currentOperationLevel || 'read';
    if (isGenericGoogle && (opLevel === 'write' || opLevel === 'prepare')) {
      ctx.log(`[Supervisor] BLOCKED: navigate to generic Google during opLevel=${opLevel}`);
      return JSON.stringify({ error: 'BLOCCATO: Per task di azione, vai direttamente al sito del servizio. NON usare Google Search.' });
    }
  } catch (_) { /* best-effort */ }

  // Same-domain loop protection
  try {
    const navDom = new URL(url).hostname.replace('www.', '');
    if (!ctx._navDomainCount) ctx._navDomainCount = {};
    ctx._navDomainCount[navDom] = (ctx._navDomainCount[navDom] || 0) + 1;
    if (ctx._navDomainCount[navDom] > 4) {
      return JSON.stringify({ error: `LOOP: hai navigato su ${navDom} ${ctx._navDomainCount[navDom]} volte senza risultati. FERMATI e rispondi.` });
    }
  } catch (_) { /* best-effort */ }

  // SSRF guard
  if (!isSSRFSafe(url)) return JSON.stringify({ error: 'URL bloccato: IP locale/privato non consentito.' });
  if (/^mailto:/i.test(url)) return JSON.stringify({ error: 'Non navigare mailto: — usa send_email.' });

  // Human Driver delay
  const hdCheck = await ctx.HumanDriver.checkAndDelay(url);
  if (!hdCheck.allowed) return JSON.stringify({ error: hdCheck.reason, rateLimited: true });
  if (hdCheck.delayed) ctx.log(`[HumanDriver] navigate ${hdCheck.domain} delayed ${hdCheck.delay}ms`);

  ctx.emitReasoning('Apro il sito per leggere il contenuto...', '🌐');
  ctx.emitThinking(`Navigo su ${url}...`);

  // Paywall check
  const navDomain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  const isArticle = /\/\d{4}\/|\/article|\/news\/|\/notizie\//i.test(url);
  if (ctx.paywallDomains.has(navDomain) && isArticle) {
    ctx.emitReasoning(`⚠️ ${navDomain} richiede abbonamento — leggo solo la homepage`, '🔒');
  }

  // ── BRIDGE PATH ──
  if (ctx.isBridgeReady()) {
    try {
      const bridgeNav = await ctx.bridgeNavigate(url);
      if (bridgeNav.ok) {
        await new Promise(r => setTimeout(r, 1500));
        try { await ctx.dismissModalsBridge(); } catch (_) { /* best-effort */ }
        setTimeout(async () => { try { await ctx.dismissModalsBridge(); } catch (_) { /* best-effort */ } }, 2000);
        const title = bridgeNav.content?.title || '';
        let content = (bridgeNav.content?.content || '').substring(0, 12000);
        try { const fresh = await ctx.bridgeCommand('read_page', {}); if (fresh.ok && fresh.content) content = (fresh.content || '').substring(0, 12000); } catch (_) { /* best-effort */ }
        ctx.session.lastPage = { url: bridgeNav.url || url, title, markdown: content, links: [], html: '' };
        ctx.emitSiteVisit(ctx.session.lastPage.url, title || url, 'active');
        ctx.wsBroadcast({ type: 'page_loaded', url: ctx.session.lastPage.url, title });
        ctx.wsBroadcast({ type: 'monitor_content', markdown: content.substring(0, 8000), url: ctx.session.lastPage.url, title });
        try {
          const ss = await ctx.bridgeCommand('screenshot', { quality: 70 });
          if (ss.ok && ss.screenshot) { ctx.session.lastScreenshotData = ss.screenshot; ctx.session.lastBroadcastUrl = ctx.session.lastPage.url; ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage.url, title }); }
        } catch (_) { /* best-effort */ }
        const result = { ok: true, url: ctx.session.lastPage.url, title, content, via: 'bridge' };
        if (content.length < 500) result.hint = 'CONTENUTO SCARSO: pagina dinamica? Usa screenshot() poi read_page().';
        return JSON.stringify(result);
      }
    } catch (_) { /* best-effort */ }
  }

  // ── PUPPETEER PATH ──
  let scraped;
  if (ctx.puppeteer) {
    try {
      const activePg = await ctx.getActivePage(url);
      await new Promise(r => setTimeout(r, 1000));
      try { const ct = await ctx.detectCaptcha(activePg); if (ct) ctx.emitReasoning(`⚠️ CAPTCHA rilevato (${ct})`, '🔒'); } catch (_) { /* best-effort */ }
      scraped = await ctx.smartScrape(url, { existingPage: activePg });
    } catch (e) {
      ctx.log(`[navigate] fallback to scrapeUrl: ${e.message}`);
      scraped = await ctx.scrapeUrl(url, { timeout: COBRA_DEFAULTS.TAB_LOAD_TIMEOUT });
    }
  } else {
    scraped = await ctx.scrapeUrl(url, { timeout: COBRA_DEFAULTS.TAB_LOAD_TIMEOUT });
  }

  const title = scraped.metadata?.title || '';
  ctx.session.lastPage = { url: scraped.metadata?.url || url, title, markdown: scraped.markdown, links: scraped.links || [], html: scraped.rawHtml || '' };
  ctx.emitSiteVisit(ctx.session.lastPage.url, title || url, 'active');
  ctx.wsBroadcast({ type: 'page_loaded', url: ctx.session.lastPage.url, title });
  ctx.wsBroadcast({ type: 'monitor_content', markdown: scraped.markdown.substring(0, 8000), url: ctx.session.lastPage.url, title });

  // Screenshot
  let _ss = null;
  if (ctx.getState('activePage')) _ss = await ctx.takeActiveScreenshot(ctx.session.lastPage.url, title);
  if (!_ss && scraped.screenshot) {
    ctx.session.lastScreenshotData = scraped.screenshot;
    ctx.wsBroadcast({ type: 'screenshot', data: scraped.screenshot, url: ctx.session.lastPage.url, title });
  }

  // Paywall detection
  if (scraped.isPaywalled) {
    if (!ctx.paywallDomains.has(navDomain)) { ctx.paywallDomains.add(navDomain); ctx.savePaywallDomains(); }
    ctx.wsBroadcast({ type: 'ai_reasoning', text: `🔒 ${navDomain} richiede abbonamento`, icon: '🔒' });
    return JSON.stringify({ ok: true, url: ctx.session.lastPage.url, title, content: scraped.markdown.substring(0, 12000), paywall: true, paywallWarning: `${navDomain} ha paywall. NON aprire articoli interni.` });
  }

  const content = scraped.markdown.substring(0, 12000);
  const navResult = { ok: true, url: ctx.session.lastPage.url, title, content, stats: scraped.stats, linksCount: (scraped.links || []).length };
  if (content.length < 500) navResult.hint = 'CONTENUTO SCARSO: usa screenshot() poi read_page().';
  return JSON.stringify(navResult);
}

module.exports = { navigate: handle };
