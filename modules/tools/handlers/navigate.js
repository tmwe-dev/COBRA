// modules/tools/handlers/navigate.js — navigate tool handler
// Source: server.js lines 5041-5203

const { COBRA_DEFAULTS } = require('../../config');
const { assertSSRFSafe } = require('../../security/ssrf');

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

  // ── Cache per turno: lo stesso URL non si rilegge ──
  // Osservato in produzione: su una richiesta con tre partenze diverse il
  // modello ha riaperto gli stessi tre indirizzi ad ogni passo del processo,
  // nove navigazioni per tre pagine. Oltre al tempo sprecato, il vero danno è
  // che i blocchi di risultati si confondono tra loro e finiscono attribuiti
  // alla tratta sbagliata. Una pagina già letta in questo turno si restituisce
  // com'era, dicendolo apertamente.
  if (!ctx.session._cachePagine) ctx.session._cachePagine = new Map();
  const chiave = String(url).trim();
  if (ctx.session._cachePagine.has(chiave)) {
    const c = ctx.session._cachePagine.get(chiave);
    ctx.log(`[navigate] Già letta in questo turno, servita dalla cache: ${chiave}`);
    ctx.emitReasoning('Pagina già letta in questo turno: riuso il contenuto', '♻️');
    return JSON.stringify({
      ok: true, url: c.url, title: c.title, content: c.content, via: 'cache-turno',
      nota: 'Questa pagina l\'hai GIÀ letta in questo turno: sotto c\'è il contenuto identico a prima. '
        + 'Non rileggerla ancora. Se ti serve una tratta o un parametro diverso, cambia l\'URL.',
    });
  }

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
  // Verifica completa con risoluzione DNS: intercetta anche i domini pubblici
  // che puntano alla rete interna (DNS rebinding)
  const ssrf = await assertSSRFSafe(url);
  if (!ssrf.safe) {
    ctx.log(`[Security/SSRF] navigate BLOCCATO ${url}: ${ssrf.reason}`);
    return JSON.stringify({ error: `URL bloccato: ${ssrf.reason}` });
  }
  // Va detto a voce alta: se il controllo è stato saltato per un guasto di rete
  // e più tardi qualcosa non torna, questa riga è la spiegazione.
  if (ssrf.degradato) ctx.log(`[Security/SSRF] verifica ridotta su ${url}: ${ssrf.reason}`);
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
        // L'estensione restituisce { ok, title, url, markdown, text, stats }
        // Allarme se il contratto cambia: senza 'markdown' il contenuto sarebbe vuoto
        if (bridgeNav.content && bridgeNav.content.markdown === undefined) {
          ctx.log(`[navigate] ATTENZIONE: risposta bridge senza campo 'markdown' — chiavi=[${Object.keys(bridgeNav.content).join(',')}]`);
        }
        const title = bridgeNav.content?.title || '';
        let content = (bridgeNav.content?.markdown || bridgeNav.content?.text || '').substring(0, 12000);

        // Molti siti (Google Voli, portali di prenotazione, gestionali) caricano
        // i dati dopo il rendering iniziale. La soglia sui caratteri non basta:
        // misurato su Google Voli, a 4 secondi la pagina ha già 1.400 caratteri
        // di intestazioni e filtri ma ZERO prezzi; i risultati compaiono verso il
        // nono secondo. Fermarsi sulla lunghezza significa leggere il guscio e
        // credere che il sito non abbia dati.
        //
        // Si aspetta quindi finché la pagina non è FERMA e non dichiara più di
        // stare caricando, non finché è abbastanza lunga.
        const attese = [0, 1200, 1800, 2500, 3000, 3500, 4000, 4000];
        let uguali = 0;
        for (const attesa of attese) {
          if (attesa) await new Promise(r => setTimeout(r, attesa));
          let cresciuto = false;
          try {
            const fresh = await ctx.bridgeCommand('get_page_content', {});
            const freshText = fresh?.markdown || fresh?.text || '';
            if (fresh?.ok && freshText.length > content.length) { content = freshText.substring(0, 12000); cresciuto = true; }
          } catch (_) { /* si tiene il contenuto già ottenuto */ }

          uguali = cresciuto ? 0 : uguali + 1;
          const staCaricando = /caricamento|sto cercando|in corso\.\.\.|loading|searching|please wait|ricerca in corso/i.test(content);
          // Ferma e senza segnali di attesa: la pagina ha finito, qualunque sia la lunghezza
          if (uguali >= 2 && !staCaricando) break;
        }
        const haNumeri = /(?:€|\$|£)\s?\d|\d[\d.,]*\s?(?:€|\$|£|EUR|USD)/.test(content);
        if (!haNumeri && content.length <= 1500) {
          ctx.log(`[navigate] Pagina senza dati leggibili su ${url} (${content.length} caratteri) — probabile blocco anti-bot o zero risultati`);
        }
        ctx.session.lastPage = { url: bridgeNav.url || url, title, markdown: content, links: [], html: '' };
        ctx.emitSiteVisit(ctx.session.lastPage.url, title || url, 'active');
        ctx.wsBroadcast({ type: 'page_loaded', url: ctx.session.lastPage.url, title });
        ctx.wsBroadcast({ type: 'monitor_content', markdown: content.substring(0, 8000), url: ctx.session.lastPage.url, title });
        try {
          const ss = await ctx.bridgeCommand('screenshot', { quality: 70 });
          if (ss.ok && ss.screenshot) {
            ctx.session.lastScreenshotData = ss.screenshot;
            ctx.session.lastBroadcastUrl = ctx.session.lastPage.url;
            ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage.url, title });
          } else {
            ctx.log(`[Screenshot] navigate non ha ottenuto l'immagine: ${ss?.error || 'risposta senza campo screenshot'}`);
          }
        } catch (e) { ctx.log(`[Screenshot] navigate: comando fallito — ${e.message}`); }
        ctx.session._cachePagine.set(chiave, { url: ctx.session.lastPage.url, title, content });
        const result = { ok: true, url: ctx.session.lastPage.url, title, content, via: 'bridge' };
        // Distinguere "non ho letto" da "non c'è niente da leggere" è decisivo:
        // se l'AI non lo sa, riempie il vuoto con dati inventati.
        if (/0\s+risultati|nessun risultato|no results found/i.test(content)) {
          result.hint = 'QUESTA FONTE NON HA RISULTATI per la ricerca fatta. Non è un errore di lettura: '
            + 'il sito ha risposto e non ha trovato nulla. Cambia fonte (per i voli: Google Voli) '
            + 'oppure cambia parametri. NON inventare dati.';
        } else if (!haNumeri && content.length < 1500) {
          result.hint = 'CONTENUTO SCARSO: la pagina non ha reso i dati (dinamica o anti-bot). '
            + 'Usa screenshot() poi read_page(), oppure cambia fonte. NON inventare dati.';
        }
        return JSON.stringify(result);
      }
      ctx.log(`[navigate] Bridge ha risposto senza ok: ${JSON.stringify(bridgeNav).substring(0, 200)}`);
    } catch (e) {
      // Non silenziare: senza Puppeteer il bridge è l'unica via per screenshot e DOM
      ctx.log(`[navigate] BRIDGE FALLITO (${url}): ${e.message} — passo al fallback fetch (niente screenshot)`);
    }
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
