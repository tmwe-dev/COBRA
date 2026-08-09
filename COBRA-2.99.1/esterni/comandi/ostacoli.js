// cobra-extension/esterni/comandi/ostacoli.js — Togliere di mezzo quello che
// copre la pagina.
//
// Spostato da background.js senza modifiche. Un ostacolo si riconosce da cosa
// FA — sta davanti, copre, blocca lo scorrimento — non da come si chiama.
// E la visibilita' non si misura con offsetParent: un elemento
// `position: fixed` ha sempre offsetParent nullo, ed e' esattamente il caso
// dei banner. Per tre volte di fila il registro diceva "tolgo di mezzo" mentre
// non toglieva niente.

(function () {
  'use strict';

  const comandi = {};

  // Sblocca la coda del ritmo. Serve se un'operazione e' rimasta appesa
  // (tipico: la pagina ricaricata mentre COBRA la stava leggendo).

  comandi['sblocca_coda'] = async function (args) {
        return globalThis.Ritmo ? globalThis.Ritmo.sbloccaCoda()
                                : { ok: false, motivo: 'ritmo non caricato' };
  };

  comandi['handle_dialog'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (action, promptText, duration) => {
          const origAlert = window.alert;
          const origConfirm = window.confirm;
          const origPrompt = window.prompt;
          let captured = null;

          window.alert = (msg) => { captured = { type: 'alert', message: msg }; };
          window.confirm = (msg) => { captured = { type: 'confirm', message: msg }; return action === 'accept'; };
          window.prompt = (msg, def) => { captured = { type: 'prompt', message: msg }; return action === 'accept' ? (promptText || def || '') : null; };

          // beforeunload handler
          const unloadHandler = (e) => { if (action === 'accept') { e.preventDefault(); delete e.returnValue; } };
          window.addEventListener('beforeunload', unloadHandler);

          setTimeout(() => {
            window.alert = origAlert;
            window.confirm = origConfirm;
            window.prompt = origPrompt;
            window.removeEventListener('beforeunload', unloadHandler);
          }, duration || 10000);

          return { ok: true, action, duration: duration || 10000, interceptors: ['alert', 'confirm', 'prompt', 'beforeunload'] };
        }, [args.action || 'accept', args.promptText || '', args.duration || 10000]);
  };

  // Toglie di mezzo cio' che copre il contenuto. Prima si prova a chiudere
  // come farebbe una persona (pulsante, Esc); se resiste, si rimuove
  // l'elemento e si ridà lo scorrimento. Un banner che non si lascia
  // chiudere non deve poter impedire di leggere.

  comandi['sblocca_pagina'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
          const azioni = [];

          const chiusuraTesti = ['accetta','accept','ok','ho capito','got it','continua','continue',
            'chiudi','close','no grazie','no thanks','dismiss','x','consenti','allow','agree','accetto',
            'acconsento','prosegui','va bene','capito','accetta tutti','accept all','accetta tutto'];

          // Una cosa è visibile se occupa spazio e non è nascosta.
          //
          // Prima si usava "offsetParent === null" per dire "invisibile". Ma
          // un elemento con position:fixed ha SEMPRE offsetParent nullo — è
          // così che funziona il posizionamento fisso — e i banner dei cookie
          // sono fissi per definizione. Quel controllo saltava esattamente i
          // pulsanti che bisognava premere: su tmwe.it il banner è rimasto lì
          // dopo tre tentativi, e nel registro si leggeva tre volte "tolgo di
          // mezzo quello che copre la pagina" mentre non veniva tolto niente.
          const siVede = (el) => {
            try {
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) return false;
              const st = getComputedStyle(el);
              return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
            } catch (_) { return false; }
          };

          // Un selettore rifiutato non deve portarsi via tutto il resto.
          //
          // querySelectorAll con una lista separata da virgole è tutto-o-niente:
          // se UNA sola parte non è valida per il motore, la chiamata solleva
          // un'eccezione e non torna NIENTE — nemmeno i pulsanti che sarebbero
          // stati trovati dalle parti valide.
          //
          // Qui dentro c'è [class*="accept" i], che usa il modificatore di
          // maiuscole/minuscole negli attributi: Chrome, Firefox e Safari lo
          // accettano da anni, ma è la parte più giovane della lista, ed è
          // stata aggiunta oggi. Se un domani un motore la rifiuta, senza
          // questa rete salterebbe l'intera rimozione degli ostacoli — e il
          // sintomo sarebbe "i banner non si tolgono più", che manda a cercare
          // dalla parte sbagliata.
          const cerca = (sel) => {
            try { return [...document.querySelectorAll(sel)]; }
            catch (_) { return []; }
          };

          // 1. Come farebbe una persona: cercare il pulsante di chiusura
          const candidati = [
            ...cerca('button,[role="button"],a[role="button"],input[type="button"],input[type="submit"],[aria-label],[class*="close"],[id*="close"]'),
            ...cerca('[class*="accept" i],[id*="accept" i]'),
          ];
          for (const el of candidati) {
            try {
              if (!siVede(el)) continue;
              const et = ((el.innerText || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
              if (!et || et.length > 40) continue;
              if (chiusuraTesti.some(t => et === t || et.includes(t))) { el.click(); azioni.push('cliccato:' + et.substring(0, 20)); break; }
            } catch (_) { /* elemento sparito */ }
          }

          // 1b. Gli stessi pulsanti dentro i riquadri di consenso annidati.
          // Molti servizi (OneTrust, Cookiebot, Iubenda) mettono il banner in
          // un iframe: se è dello stesso sito si può entrare, altrimenti no.
          for (const fr of document.querySelectorAll('iframe')) {
            let doc = null;
            try { doc = fr.contentDocument; } catch (_) { continue; }   // altro dominio: non si entra
            if (!doc) continue;
            try {
              for (const el of doc.querySelectorAll('button,[role="button"],a')) {
                const et = (el.innerText || '').trim().toLowerCase();
                if (!et || et.length > 40) continue;
                if (chiusuraTesti.some(t => et === t || et.includes(t))) {
                  el.click(); azioni.push('cliccato nel riquadro:' + et.substring(0, 20)); break;
                }
              }
            } catch (_) { /* riquadro non leggibile */ }
          }

          // 1c. I muri di accesso: si chiudono, non si attraversano.
          //
          // Google, LinkedIn, Pinterest e molti altri aprono un riquadro
          // "Accedi con Google" sopra il contenuto. Quel riquadro va tolto di
          // mezzo per continuare a leggere — quasi sempre la pagina sotto è
          // consultabile lo stesso.
          //
          // Ma NON si preme "Continua con Google". Quel gesto concede a un
          // sito l'accesso all'account di Luca: nome, indirizzo, a volte molto
          // di più, e su alcuni siti resta valido finché non lo si revoca a
          // mano. È una decisione sua, non una scorciatoia da automatizzare.
          // Se la pagina è leggibile solo dopo l'accesso, si chiede a lui.
          const testiAccesso = ['continua con google','continue with google','accedi con google',
            'sign in with google','continua con facebook','accedi con facebook','sign in with apple',
            'continua con apple','accedi con linkedin','sign in with linkedin'];
          let muroDiAccesso = null;
          for (const el of document.querySelectorAll('div,section,dialog,form,[role="dialog"]')) {
            let st; try { st = getComputedStyle(el); } catch (_) { continue; }
            if (st.position !== 'fixed' && el.tagName !== 'DIALOG') continue;
            const t = (el.innerText || '').toLowerCase();
            if (t.length > 600) continue;
            if (testiAccesso.some(x => t.includes(x))) { muroDiAccesso = el; break; }
          }
          if (muroDiAccesso) {
            // Prima si cerca la sua X, che è il modo pulito di dire "no grazie"
            let chiuso = false;
            for (const b of muroDiAccesso.querySelectorAll('button,[role="button"],[aria-label]')) {
              const et = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().toLowerCase();
              if (/^(x|✕|×|chiudi|close|dismiss|not now|non ora|salta|skip|annulla|cancel)$/.test(et)
                  || /chiudi|close|dismiss/.test(b.getAttribute('aria-label') || '')) {
                try { b.click(); chiuso = true; azioni.push('chiuso il riquadro di accesso'); break; } catch (_) { /* sparito */ }
              }
            }
            if (!chiuso) {
              try { muroDiAccesso.remove(); azioni.push('tolto il riquadro di accesso'); } catch (_) { /* gia via */ }
            }
            azioni.push('NB: non ho fatto l\'accesso, ho solo tolto il riquadro');
          }

          // 2. Esc: molti modali lo ascoltano
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            azioni.push('esc');
          } catch (_) { /* niente */ }

          // 3. Se qualcosa copre ancora, si toglie
          for (const el of document.querySelectorAll('div,section,aside,dialog,iframe')) {
            let st; try { st = getComputedStyle(el); } catch (_) { continue; }
            if (st.position !== 'fixed' && st.position !== 'sticky' && el.tagName !== 'DIALOG') continue;
            if (st.display === 'none' || st.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            const copertura = (r.width * r.height) / (vw * vh);

            // Un banner d'angolo non copre un quarto dello schermo: quello di
            // tmwe.it sta in basso a destra e ne copre circa un decimo. Se però
            // si chiama "cookie", "consent" o "privacy", quello che è si è
            // dichiarato da solo, e basta molto meno spazio per toglierlo.
            const nome = ((el.id || '') + ' ' + (el.className || '')).toString().toLowerCase();
            const siDichiara = /cookie|consent|gdpr|privacy|onetrust|cookiebot|iubenda|didomi|quantcast/.test(nome);
            const soglia = siDichiara ? 0.02 : 0.25;
            if (copertura < soglia) continue;
            try { el.remove(); azioni.push('rimosso:' + (el.id || el.tagName.toLowerCase())); } catch (_) { /* gia' via */ }
          }

          // 4. Ridare lo scorrimento, che i modali spengono
          try {
            document.body.style.overflow = 'auto';
            document.body.style.position = 'static';
            document.documentElement.style.overflow = 'auto';
            azioni.push('scorrimento ripristinato');
          } catch (_) { /* niente */ }

          return { ok: true, azioni, caratteri: (document.body.innerText || '').length };
        });
  };

  comandi['detect_block'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const blocks = [];
          const body = document.body.innerText.toLowerCase();

          // CAPTCHA
          if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey], .cf-challenge'))
            blocks.push('captcha');
          if (body.includes('captcha') || body.includes('verify you are human') || body.includes('conferma di essere umano'))
            blocks.push('captcha_text');

          // 2FA / OTP
          if (document.querySelector('input[name*="otp"], input[name*="2fa"], input[autocomplete="one-time-code"], input[name*="totp"]'))
            blocks.push('2fa');
          if (body.includes('two-factor') || body.includes('verifica in due passaggi') || body.includes('codice di verifica') || body.includes('authentication code'))
            blocks.push('2fa_text');

          // Login
          if (document.querySelector('input[type="password"]') && document.querySelector('form'))
            blocks.push('login_form');

          // Permission dialogs
          if (body.includes('allow notifications') || body.includes('consenti notifiche') || body.includes('enable location'))
            blocks.push('permission_request');

          // Blocked / rate limited
          if (body.includes('access denied') || body.includes('403') || body.includes('rate limit') || body.includes('too many requests'))
            blocks.push('access_denied');

          return { ok: true, blocked: blocks.length > 0, blocks };
        });
  };

  comandi['dismiss_cookies'] = async function (args) {
        const tab = await getWorkTab();
        // Strategy A: main frame search (includes shadow DOM traversal)
        const mainResult = await run(tab.id, () => {
          // Deep querySelectorAll — traverses shadow DOM roots
          function deepQueryAll(root, selector) {
            const results = [...root.querySelectorAll(selector)];
            // Search inside shadow roots
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) {
                results.push(...deepQueryAll(el.shadowRoot, selector));
              }
            }
            return results;
          }

          const rejectTexts = ['rifiuta tutto','rifiuta tutti','rifiuta','reject all','reject','deny all','deny',
            'decline','solo necessari','strictly necessary only','nur notwendige','tout refuser','solo cookies tecnici',
            'ablehnen','rechazar todo'];
          const acceptTexts = ['accetta tutto','accetta tutti','accetta e continua','accetta','accept all','accept and continue','accept','agree',
            'allow all','allow','consent','got it','ok','ho capito','continua','alle akzeptieren','tout accepter',
            'aceptar todo','einverstanden'];
          const manageTexts = ['gestisci','gestisci cookie','gestisci preferenze','manage','manage cookies','manage preferences',
            'cookie settings','personalizza','customize','impostazioni cookie'];
          const SELS = 'button, a[role="button"], [role="button"], a.btn, span[role="button"], div[role="button"], a[class*="cookie"], a[class*="consent"], [class*="cookie"] button, [class*="consent"] button, [id*="cookie"] button';

          function findAndClick(texts) {
            for (const el of deepQueryAll(document, SELS)) {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length > 80 || txt.length === 0) continue;
              try {
                if (texts.some(t => txt.includes(t)) && (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none')) {
                  el.click(); return txt;
                }
              } catch { /* shadow DOM element without getComputedStyle */ }
            }
            return null;
          }

          // Si ACCETTA e si va avanti, per scelta dichiarata dell'utente.
          //
          // Prima si tentava il rifiuto per primo. Su molti siti il rifiuto
          // non esiste come pulsante diretto: sta dentro "Preferenze", e il
          // banner restava aperto a coprire la pagina. Su emirates.com il
          // risultato era una pagina da 8.578 caratteri letta come vuota.
          // Un banner che resta aperto non protegge nessuno: impedisce solo
          // di leggere.
          const acceptSels = ['#onetrust-accept-btn-handler', '.cmp-accept-all', 'button.fc-cta-consent',
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '[data-testid="cookie-accept"]',
            '#didomi-notice-agree-button', '.iubenda-cs-accept-btn',
            // Aggiunti dopo averli incontrati sul campo
            '#onetrust-accept-btn-handler', '#accept-recommended-btn-handler',
            '.ot-pc-refuse-all-handler ~ button', '#truste-consent-button',
            '.qc-cmp2-summary-buttons button[mode="primary"]', '#usercentrics-root',
            'button[data-cky-tag="accept-button"]', '.cc-allow', '.cookie-accept-all',
            '#cookie-accept', '#acceptCookies', '.js-accept-cookies'];
          for (const sel of acceptSels) {
            for (const el of deepQueryAll(document, sel)) {
              try { if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none') { el.click(); return { ok: true, action: 'accepted_sel', button: sel }; } } catch {}
            }
          }
          let clicked = findAndClick(acceptTexts);
          if (clicked) return { ok: true, action: 'accepted', button: clicked };
          // Se non c'e' nulla da accettare, si prova comunque a chiudere:
          // meglio un rifiuto che un banner che copre la pagina.
          clicked = findAndClick(rejectTexts);
          if (clicked) return { ok: true, action: 'rejected', button: clicked };
          const rejectSels = ['#onetrust-reject-all-handler', '.cmp-reject-all', 'button.fc-cta-do-not-consent',
            '[data-testid="cookie-reject"]', '.cookie-reject', '#CybotCookiebotDialogBodyButtonDecline',
            '#didomi-notice-disagree-button', '.iubenda-cs-reject-btn'];
          for (const sel of rejectSels) {
            for (const el of deepQueryAll(document, sel)) {
              try { if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none') { el.click(); return { ok: true, action: 'rejected_sel', button: sel }; } } catch {}
            }
          }
          // Ultima risorsa: aprire "Preferenze" e accettare da dentro
          // 4. Manage button (two-step: click manage, then accept inside panel)
          clicked = findAndClick(manageTexts);
          if (clicked) return { ok: true, action: 'manage_clicked', button: clicked, needsSecondStep: true };

          return { ok: true, action: 'no_banner' };
        });

        // If manage was clicked, wait and then accept inside the opened panel
        if (mainResult?.needsSecondStep) {
          await new Promise(r => setTimeout(r, 1000));
          const secondResult = await run(tab.id, () => {
            const acceptTexts = ['accetta tutto','accetta tutti','accetta','accept all','accept','conferma','confirm',
              'salva e accetta','save and accept','accetta e chiudi','accept and close','salva','save',
              'consenti tutto','allow all','accetta selezionati','accept selected'];
            for (const el of document.querySelectorAll('button, a[role="button"], [role="button"], span[role="button"], div[role="button"]')) {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length > 80 || txt.length === 0) continue;
              if (acceptTexts.some(t => txt.includes(t)) && (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none')) {
                el.click(); return { ok: true, action: 'accepted_after_manage', button: txt };
              }
            }
            return { ok: true, action: 'manage_opened_no_accept' };
          });
          return secondResult;
        }

        // If no_banner in main frame, check inside iframes (CMP often in iframe)
        if (mainResult?.action === 'no_banner') {
          try {
            const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
            const cmpFrames = frames.filter(f => f.frameId !== 0 && f.url && !f.url.startsWith('about:') &&
              (f.url.includes('consent') || f.url.includes('cookie') || f.url.includes('privacy') ||
               f.url.includes('onetrust') || f.url.includes('didomi') || f.url.includes('iubenda') ||
               f.url.includes('cookiebot') || f.url.includes('quantcast') || f.url.includes('consentmanager')));
            for (const frame of cmpFrames) {
              const frameResult = await runInFrame(tab.id, frame.frameId, () => {
                const rejectTexts = ['rifiuta tutto','rifiuta tutti','rifiuta','reject all','reject','deny all','deny','decline'];
                const acceptTexts = ['accetta tutto','accetta tutti','accetta','accept all','accept','agree','allow all','allow','consent','ok','continua'];
                for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                  const txt = (el.textContent || '').trim().toLowerCase();
                  if (txt.length > 80 || txt.length === 0) continue;
                  if (rejectTexts.some(t => txt.includes(t)) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                    el.click(); return { ok: true, action: 'rejected_iframe', button: txt };
                  }
                }
                for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                  const txt = (el.textContent || '').trim().toLowerCase();
                  if (txt.length > 80 || txt.length === 0) continue;
                  if (acceptTexts.some(t => txt.includes(t)) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                    el.click(); return { ok: true, action: 'accepted_iframe', button: txt };
                  }
                }
                return null;
              });
              if (frameResult && frameResult.ok) return frameResult;
            }
          } catch (e) { /* iframe access failed, return no_banner */ }
        }

        return mainResult;
  };

  comandi['dismiss_overlay'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          // Deep querySelectorAll — traverses shadow DOM roots
          function deepQueryAll(root, selector) {
            const results = [...root.querySelectorAll(selector)];
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
            }
            return results;
          }

          // Detect fullscreen/near-fullscreen overlays covering the page
          // Common patterns: video splash, welcome screens, age gates, newsletter popups
          const closeTexts = ['chiudi','close','skip','salta','x','✕','✖','×','continua','continue',
            'vai al sito','go to site','enter','entra','esplora','explore','scopri','discover',
            'prosegui','proceed','inizia','start','accedi al sito','enter site','skip intro',
            'skip video','chiudi video','close video'];
          const closeSels = [
            // Generic close/dismiss buttons on overlays
            '[class*="overlay"] [class*="close"]', '[class*="overlay"] [class*="skip"]',
            '[class*="modal"] [class*="close"]', '[class*="modal"] button',
            '[class*="splash"] [class*="close"]', '[class*="splash"] [class*="skip"]',
            '[class*="interstitial"] [class*="close"]', '[class*="intro"] [class*="close"]',
            '[class*="welcome"] [class*="close"]', '[class*="hero"] [class*="close"]',
            '[class*="fullscreen"] [class*="close"]', '[class*="video"] [class*="close"]',
            '[class*="popup"] [class*="close"]', '[class*="lightbox"] [class*="close"]',
            '.close-button', '.btn-close', '[aria-label="Close"]', '[aria-label="Chiudi"]',
            '[data-dismiss="modal"]', '.modal-close', '.overlay-close',
            // Age gates
            '[class*="age"] button', '[class*="gate"] button',
          ];

          // Strategy 1: check if there's a large overlay element covering the viewport (deep: shadow DOM)
          const overlayEls = deepQueryAll(document, '[class*="overlay"], [class*="modal"], [class*="splash"], [class*="interstitial"], [class*="lightbox"], [class*="popup"], [class*="fullscreen-video"], [class*="hero-video"], [class*="welcome"]');
          let foundOverlay = false;
          for (const ov of overlayEls) {
            const style = getComputedStyle(ov);
            const rect = ov.getBoundingClientRect();
            // Is it covering most of the viewport?
            if (rect.width > window.innerWidth * 0.7 && rect.height > window.innerHeight * 0.5 &&
                style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.1 &&
                (style.position === 'fixed' || style.position === 'absolute' || parseInt(style.zIndex) > 10)) {
              foundOverlay = true;
              // Look for close/skip button inside this overlay
              for (const btn of ov.querySelectorAll('button, a, [role="button"], span, div[class*="close"], svg')) {
                const txt = (btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
                if (txt.length > 60) continue;
                if (closeTexts.some(t => txt === t || txt.includes(t)) ||
                    btn.classList.toString().toLowerCase().match(/close|skip|dismiss|chiudi/) ||
                    (btn.tagName === 'SVG' && btn.closest('[class*="close"]'))) {
                  btn.click();
                  return { ok: true, action: 'overlay_closed', button: txt || btn.className, overlay: ov.className };
                }
              }
              // No labeled close button — try clicking the overlay background itself (some dismiss on bg click)
              // But only if it has a click handler or pointer cursor
              if (style.cursor === 'pointer') {
                ov.click();
                return { ok: true, action: 'overlay_bg_clicked', overlay: ov.className };
              }
            }
          }

          // Strategy 2: look for close buttons matching known selectors (deep)
          for (const sel of closeSels) {
            try {
              for (const el of deepQueryAll(document, sel)) {
                if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    el.click();
                    return { ok: true, action: 'overlay_closed_sel', button: sel };
                  }
                }
              }
            } catch {}
          }

          // Strategy 3: text-based search on visible buttons (deep)
          for (const el of deepQueryAll(document, 'button, a[role="button"], [role="button"], a.btn')) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (txt.length > 40 || txt.length === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const elZ = parseInt(getComputedStyle(el).zIndex) || 0;
            const parentZ = parseInt(getComputedStyle(el.parentElement).zIndex) || 0;
            // Only click if element is in a high z-index layer (overlay)
            if ((elZ > 100 || parentZ > 100) && closeTexts.some(t => txt.includes(t))) {
              el.click();
              return { ok: true, action: 'overlay_closed_text', button: txt };
            }
          }

          // Strategy 4: detect "empty" page with just a video — page has very little readable text
          const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
          if (bodyText.length < 100) {
            // Almost empty page — likely a video splash. Look for ANY close/skip button (deep)
            for (const el of deepQueryAll(document, 'button, a, [role="button"]')) {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length > 40 || txt.length === 0) continue;
              if (closeTexts.some(t => txt.includes(t)) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                el.click();
                return { ok: true, action: 'empty_page_close', button: txt };
              }
            }
          }

          return { ok: true, action: foundOverlay ? 'overlay_no_close_found' : 'no_overlay' };
        });
  };

  comandi['get_cookies'] = async function (args) {
        const cookies = await chrome.cookies.getAll({ url: args.url });
        return { ok: true, cookies: cookies.map(c => ({ name: c.name, value: c.value.substring(0, 50), domain: c.domain, httpOnly: c.httpOnly })) };
  };

  const quanti = globalThis.Registro.area('ostacoli', comandi);
  console.log(`[COBRA] ostacoli: ${quanti} comandi registrati`);
})();
