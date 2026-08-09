// cobra-extension/esterni/comandi/schede.js — Muoversi fra le pagine.
//
// Spostato da background.js senza modifiche. La regola: non si dirotta mai la
// scheda che Luca sta guardando. Se serve una pagina, si apre una scheda
// nuova in secondo piano.

(function () {
  'use strict';

  const comandi = {};

  comandi['navigate'] = async function (args) {
        // MAI navigare sul tab di COBRA — usa un work tab separato
        const tab = await getWorkTab();

        // Se il work tab è nella stessa finestra di COBRA, spostalo in una finestra separata
        if (_cobraTabId) {
          try {
            const cobraTab = await chrome.tabs.get(_cobraTabId);
            if (cobraTab && tab.windowId === cobraTab.windowId) {
              const currentWindow = await chrome.windows.get(cobraTab.windowId);
              const screenW = currentWindow.width || 1440;
              const screenH = currentWindow.height || 900;
              const popW = Math.round(screenW * 0.55);
              const popH = Math.round(screenH * 0.90);
              const popX = Math.round(screenW * 0.42);
              const popY = 30;
              await chrome.windows.create({
                tabId: tab.id,
                type: 'normal',
                width: popW,
                height: popH,
                left: popX,
                top: popY,
                focused: true
              });
              try { await chrome.tabs.setZoom(tab.id, 0.80); } catch {}
            }
          } catch (e) {
            log('[Navigate] Popup window: ' + e.message);
          }
        }

        // La scheda resta in secondo piano: l'utente segue tutto dal monitor di
        // COBRA e non si vede rubare il fuoco ad ogni pagina aperta.
        await chrome.tabs.update(tab.id, { url: args.url, active: false });
        await ricordaWorkTab(tab.id);
        await waitForTabLoad(tab.id);

        // ── I permessi non si trattano qui ──
        //
        // Qui c'era un'iniezione che rifiutava la geolocalizzazione a pagina
        // gia' caricata. Due difetti: arrivava dopo che il sito aveva gia'
        // chiesto (e la bolla era gia' sullo schermo), e spariva al primo
        // redirect o ridisegno della SPA.
        //
        // Adesso decide `esterni/permessi.js`, una volta sola e a livello di
        // browser: la posizione si concede — vera, non inventata — e
        // notifiche, microfono e telecamera si bloccano. Niente bolla, niente
        // iniezione da rifare a ogni pagina.
        //
        // Restano gli ostacoli DENTRO la pagina (cookie, banner paese,
        // inviti all'app): quelli sono nel DOM e li tratta ostacoli.js.


        return { ok: true, url: args.url, tabId: tab.id };
  };

  comandi['go_back'] = async function (args) {
        const tab = await getWorkTab();
        await chrome.tabs.goBack(tab.id);
        await waitForTabLoad(tab.id);
        return { ok: true };
  };

  comandi['go_forward'] = async function (args) {
        const tab = await getWorkTab();
        await chrome.tabs.goForward(tab.id);
        await waitForTabLoad(tab.id);
        return { ok: true };
  };

  comandi['reload'] = async function (args) {
        const tab = await getWorkTab();
        await chrome.tabs.reload(tab.id);
        await waitForTabLoad(tab.id);
        return { ok: true };
  };

  comandi['get_url'] = async function (args) {
        const tab = await getWorkTab();
        return { ok: true, url: tab.url, title: tab.title };
  };

  // Quali schede ci sono, e su quali si puo' davvero guardare.
  //
  // Serve a rispondere a una domanda precisa senza indovinare: quando un
  // modulo dice "non riesco ad accedere alla pagina", su QUALE pagina non
  // riesce? Le pagine chrome:// e il Web Store sono vietate a ogni
  // estensione, e se la scheda scelta e' una di quelle l'errore parla di
  // permessi ma il problema e' la scelta.

  comandi['elenco_schede'] = async function (args) {
        const schede = await chrome.tabs.query({});
        const vietata = (u) => /^(chrome|edge|about|devtools|view-source):/i.test(u || '')
          || /chrome\.google\.com\/webstore|chromewebstore\.google\.com/i.test(u || '');
        return {
          quante: schede.length,
          whatsapp: schede.filter(t => /web\.whatsapp\.com/i.test(t.url || ''))
            .map(t => ({ id: t.id, url: t.url, attiva: t.active, stato: t.status, finestra: t.windowId })),
          linkedin: schede.filter(t => /linkedin\.com/i.test(t.url || ''))
            .map(t => ({ id: t.id, url: (t.url || '').slice(0, 70), attiva: t.active })),
          // Se COBRA riesce a leggere QUESTA, il permesso c'e'.
          provaLettura: await (async () => {
            const wa = schede.find(t => /web\.whatsapp\.com/i.test(t.url || ''));
            if (!wa) return 'nessuna scheda WhatsApp aperta';
            try {
              const r = await chrome.scripting.executeScript({
                target: { tabId: wa.id },
                func: () => ({ titolo: document.title, caratteri: (document.body?.innerText || '').length }),
              });
              return { riuscita: true, ...r[0].result };
            } catch (e) { return { riuscita: false, errore: e.message }; }
          })(),
          attiva: (schede.find(t => t.active) || {}).url,
          vietate: schede.filter(t => vietata(t.url)).map(t => (t.url || '').slice(0, 50)),
        };
  };

  comandi['open_tab'] = async function (args) {
        const tab = await chrome.tabs.create({ url: args.url || 'about:blank', active: args.active !== false });
        if (args.url && args.url !== 'about:blank') await waitForTabLoad(tab.id);
        return { ok: true, tabId: tab.id, url: tab.url };
  };

  comandi['switch_tab'] = async function (args) {
        if (args.tabId) {
          await chrome.tabs.update(args.tabId, { active: true });
          return { ok: true, tabId: args.tabId };
        }
        if (args.index !== undefined) {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const target = tabs[args.index];
          if (!target) return { ok: false, error: `Tab index ${args.index} not found` };
          await chrome.tabs.update(target.id, { active: true });
          return { ok: true, tabId: target.id };
        }
        if (args.urlContains) {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const target = tabs.find(t => t.url.includes(args.urlContains));
          if (!target) return { ok: false, error: `No tab with URL containing "${args.urlContains}"` };
          await chrome.tabs.update(target.id, { active: true });
          return { ok: true, tabId: target.id, url: target.url };
        }
        return { ok: false, error: 'Specify tabId, index, or urlContains' };
  };

  comandi['close_tab'] = async function (args) {
        const tabId = args.tabId || (await getWorkTab()).id;
        await chrome.tabs.remove(tabId);
        return { ok: true, closed: tabId };
  };

  comandi['list_tabs'] = async function (args) {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        return { ok: true, tabs: tabs.map((t, i) => ({ index: i, id: t.id, url: t.url, title: t.title, active: t.active })) };
  };

  // Attendi cambio URL

  comandi['wait_url_change'] = async function (args) {
        const tab = await getWorkTab();
        const startUrl = tab.url;
        const timeout = args.timeout || 15000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          await new Promise(r => setTimeout(r, 300));
          const current = await getWorkTab();
          if (current.url !== startUrl) return { ok: true, oldUrl: startUrl, newUrl: current.url, waited: Date.now() - start };
        }
        return { ok: false, error: 'URL did not change', waited: timeout };
  };

  const quanti = globalThis.Registro.area('schede', comandi);
  console.log(`[COBRA] schede: ${quanti} comandi registrati`);
})();
