// modules/tools/handlers/navigate.js — navigate tool handler
// Source: server.js lines 5041-5203

const { COBRA_DEFAULTS } = require('../../config');
const { assertSSRFSafe } = require('../../security/ssrf');
const { Sorveglianza } = require('../../collega/sorveglianza');

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
  // La cache serve il TESTO, ma il browser resta dov'è: se dopo si clicca o
  // si compila un campo, si agisce sulla pagina precedente credendo di essere
  // qui. È il modo in cui i prezzi di una città finiscono sotto il nome di
  // un'altra — questa volta per meccanica, non per distrazione del modello.
  //
  // Quindi la scorciatoia vale solo se non c'è stato niente in mezzo. Appena
  // qualcuno ha toccato la pagina, si torna a navigare per davvero.
  const toccataDopo = ctx.session._ultimaAzionePagina
    && ctx.session._cachePagine.has(chiave)
    && ctx.session._ultimaAzionePagina > (ctx.session._cachePagine.get(chiave).quando || 0);

  if (ctx.session._cachePagine.has(chiave) && !toccataDopo) {
    const c = ctx.session._cachePagine.get(chiave);
    ctx.log(`[navigate] Già letta in questo turno, servita dalla cache: ${chiave}`);
    ctx.emitReasoning('Pagina già letta in questo turno: riuso il contenuto', '♻️');
    return JSON.stringify({
      ok: true, url: c.url, title: c.title, content: c.content, via: 'cache-turno',
      nota: 'Questa pagina l\'hai GIÀ letta in questo turno: sotto c\'è il contenuto identico a prima. '
        + 'Non rileggerla ancora. Se ti serve una tratta o un parametro diverso, cambia l\'URL. '
        + 'Attenzione: il contenuto arriva dalla lettura di prima, la scheda del browser non si è mossa.',
    });
  }
  if (toccataDopo) {
    ctx.log(`[navigate] La pagina è stata toccata dopo la lettura: ci torno per davvero invece di riusare la cache`);
    ctx.session._cachePagine.delete(chiave);
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

  // Una navigazione può durare decine di secondi fra attese anti-bot, cookie
  // e riletture. Se non lascia traccia nel registro, quel tempo è
  // indistinguibile da un blocco — ed è già successo di cercare un guasto che
  // non c'era. Si segna l'inizio e, sotto, la fine con la durata.
  const _iniziaNav = Date.now();
  ctx.log(`[navigate] → ${String(url).substring(0, 120)}`);
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
        // Non c'è un tetto al tempo: c'è un tetto all'IMMOBILITÀ. Una pagina
        // che cresce può prendersi un minuto — sta lavorando. Una ferma da tre
        // letture ha finito, o non ha niente, e aspettare non la cambia.
        // A decidere è la sorveglianza, e mentre decide parla a Luca.
        const guardia = new Sorveglianza({
          avvisa: (msg, icona) => { ctx.emitReasoning(msg, icona); ctx.log(`[Sorveglianza] ${msg}`); },
          log: ctx.log,
        });
        const dominio = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();

        let sbloccatoVolte = 0;
        for (let giro = 0; giro < 25; giro++) {
          if (giro) await new Promise(r => setTimeout(r, Math.min(1000 + giro * 300, 3000)));
          let guasto = null;
          let stato = null;

          // Si CHIEDE alla pagina in che stato è, invece di indovinarlo dal
          // testo. Il browser sa dire se ha finito di caricare e se c'è
          // qualcosa che copre il contenuto: sono fatti, non stime.
          try {
            stato = await ctx.bridgeCommand('stato_pagina', {});
          } catch (_) { /* comando non disponibile: si prosegue come prima */ }

          // Un ostacolo si riconosce da cosa fa — sta davanti, copre, blocca
          // lo scorrimento — non da come si chiama. Che sia un banner cookie,
          // una newsletter, un invito a scaricare l'app o un avviso di età,
          // il trattamento è lo stesso: si toglie di mezzo e si rilegge.
          if (stato?.bloccata && sbloccatoVolte < 3) {
            sbloccatoVolte++;
            try {
              const sblocco = await ctx.bridgeCommand('sblocca_pagina', {});
              const quanti = (stato.ostacoli || []).length;
              ctx.log(`[Ostacoli] ${dominio}: ${quanti} elemento/i copriva/no la pagina`
                + `${stato.scorrimentoBloccato ? ' (scorrimento bloccato)' : ''} → ${(sblocco?.azioni || []).join(', ')}`);
              ctx.emitReasoning(`Tolgo di mezzo quello che copre la pagina su ${dominio}`, '🧹');
            } catch (e) { ctx.log(`[Ostacoli] sblocco non riuscito su ${dominio}: ${e.message}`); }
            continue;   // si rilegge subito dopo aver liberato la vista
          }

          try {
            const fresh = await ctx.bridgeCommand('get_page_content', {});
            const freshText = fresh?.markdown || fresh?.text || '';
            // Il testo nuovo si tiene se è più lungo, OPPURE se porta dei dati
            // che prima non c'erano. Su una pagina che si costruisce da sola
            // lo scheletro di caricamento — filtri, elenco compagnie, riquadri
            // vuoti — è spesso più lungo del risultato finale: preferendo
            // sempre il più lungo si buttava via proprio la versione coi
            // prezzi, che è l'unica che interessa.
            const haDati = (t) => /(?:€|\$|£)\s?\d|\d[\d.,]*\s?(?:€|\$|EUR|USD)|\d{1,2}:\d{2}/.test(t);
            if (fresh?.ok && freshText && (freshText.length > content.length || (haDati(freshText) && !haDati(content)))) {
              content = freshText.substring(0, 12000);
            }
          } catch (e) { guasto = e.message; }

          // Il documento non ha finito di caricare: è la pagina a dirlo, e
          // finché lo dice non c'è nessun motivo di considerarla ferma.
          const nonHaFinito = stato ? (!stato.pronta || stato.dichiaraAttesa) : false;
          const staCaricando = nonHaFinito
            || /caricamento|sto cercando|in corso\.\.\.|loading|searching|please wait|ricerca in corso/i.test(content);
          const esito = guardia.segnala({ misura: content.length, attesa: staCaricando, guasto, cosa: dominio });

          if (esito.decisione === 'concluso') break;
          if (esito.decisione === 'cambia_strada') {
            ctx.log(`[Sorveglianza] Cambio strada su ${dominio}: ${esito.motivo}`);
            break;
          }
          if (esito.decisione === 'chiedi_a_luca') {
            ctx.log(`[Sorveglianza] ${dominio}: ${esito.motivo} — consegno quello che ho`);
            ctx.emitReasoning(`${dominio} è fermo: vado avanti con quello che sono riuscito a leggere`, '🔀');
            break;
          }
        }
        // L'esperienza si scrive: la prossima volta il registro sapra' gia'
        // se questa fonte risponde o fa perdere tempo.
        if (ctx.registroFonti) {
          try {
            const haDati = /(?:€|\$|£)\s?\d|\d[\d.,]*\s?(?:€|\$|EUR|USD)|\d{1,2}:\d{2}/.test(content);
            ctx.registroFonti.registra(url, { caratteri: content.length, bloccata: false, dati: haDati });
          } catch (_) { /* best-effort */ }
        }
        const _sorv = guardia.riepilogo();
        ctx.log(`[Sorveglianza] ${dominio}: ${_sorv.letture} letture, ${_sorv.progressi} progressi, `
          + `${_sorv.guasti.length} guasti, ${Math.round(_sorv.durataMs / 1000)}s`);
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
        ctx.session._cachePagine.set(chiave, { url: ctx.session.lastPage.url, title, content, quando: Date.now() });
        ctx.log(`[navigate] ← ${content.length} caratteri in ${Math.round((Date.now() - _iniziaNav) / 1000)}s da ${String(ctx.session.lastPage.url).substring(0, 80)}`);
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
