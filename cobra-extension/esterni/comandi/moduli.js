// cobra-extension/esterni/comandi/moduli.js — Compilare quello che c'e' su
// una pagina: campi, tendine, caselle, allegati.
//
// Spostato da background.js senza toccare una riga. La regola che vive qui e'
// una sola, e viene da un difetto vero: si scrive, poi si RILEGGE, e si
// riferisce cio' che c'e' nel campo — non cio' che si voleva metterci. Un
// campo dichiarato compilato e rimasto vuoto e' peggio di un errore.

(function () {
  'use strict';

  const comandi = {};

  // ── Entrare in un sito chiuso ──
  //
  // La password arriva qui dal server e finisce nel campo. Non viene
  // registrata, non torna nella risposta, non passa dal modello.
  //
  // Prima si guarda se si e' GIA' dentro: la sessione condivisa del
  // profilo di Luca spesso e' ancora valida, e in quel caso rifare
  // l'accesso e' solo un rischio in piu'.

  comandi['compila_accesso'] = async function (args) {
        const tab = await getWorkTab();
        if (args.url) {
          await chrome.tabs.update(tab.id, { url: args.url });
          await waitForTabLoad(tab.id, 15000);
          await new Promise(r => setTimeout(r, 1200));
        }

        const trovaCampi = () => {
          const vedi = (el) => {
            const r = el.getBoundingClientRect();
            return r.width >= 2 && r.height >= 2;
          };
          const tutti = [...document.querySelectorAll('input')].filter(vedi);
          const pwd = tutti.find(i => (i.type || '').toLowerCase() === 'password');
          const utente = tutti.find(i => {
            const t = (i.type || '').toLowerCase();
            const n = ((i.name || '') + ' ' + (i.id || '') + ' ' + (i.autocomplete || '')
              + ' ' + (i.placeholder || '')).toLowerCase();
            return (t === 'email' || t === 'text' || t === 'tel')
              && /user|email|mail|login|account|utente|username|userid/.test(n);
          }) || tutti.find(i => ['email', 'text'].includes((i.type || '').toLowerCase()));
          return { utente, pwd };
        };

        // Si e' gia' dentro? Se non c'e' un campo password, quasi certamente si'.
        const stato = await run(tab.id, () => {
          const pwd = [...document.querySelectorAll('input')].find(i => {
            const r = i.getBoundingClientRect();
            return (i.type || '').toLowerCase() === 'password' && r.width >= 2 && r.height >= 2;
          });
          const testo = (document.body.innerText || '').toLowerCase();
          return {
            campoPassword: !!pwd,
            sembraDentro: !pwd && /esci|logout|il mio account|my account|dashboard|benvenut/.test(testo),
          };
        });
        if (stato && !stato.campoPassword) {
          return { ok: true, gia: true, motivo: 'la sessione era ancora valida: non ho rifatto l\'accesso' };
        }

        // Si compila. Il setter nativo serve ai moduli fatti in React, che
        // altrimenti riscrivono il campo appena si gira lo sguardo.
        const esito = await run(tab.id, (u, p, sorgenteTrova) => {
          // eslint-disable-next-line no-new-func
          const trova = new Function('return ' + sorgenteTrova)();
          const { utente, pwd } = trova();
          if (!pwd) return { ok: false, motivo: 'non trovo il campo della password' };

          const scrivi = (el, valore) => {
            el.focus();
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
            if (setter && setter.set) setter.set.call(el, valore); else el.value = valore;
            for (const e of ['input', 'change', 'blur']) el.dispatchEvent(new Event(e, { bubbles: true }));
            return el.value === valore;
          };

          const okU = utente ? scrivi(utente, u) : true;
          const okP = scrivi(pwd, p);
          if (!okP) return { ok: false, motivo: 'la pagina ha rifiutato il valore nel campo password' };

          // Il pulsante di invio: quello del modulo, o il primo che lo dice.
          const modulo = pwd.form;
          let invio = modulo && modulo.querySelector('button[type="submit"], input[type="submit"]');
          if (!invio) {
            invio = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
              .find(b => {
                const r = b.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const t = ((b.innerText || b.value || '') + '').trim().toLowerCase();
                return /^(accedi|entra|login|log in|sign in|continua|invia|submit)$/.test(t);
              });
          }
          if (invio) { invio.click(); return { ok: true, compilati: { utente: okU, password: true }, inviato: true }; }
          if (modulo) { try { modulo.submit(); return { ok: true, inviato: true, via: 'modulo' }; } catch (_) { /* niente */ } }
          return { ok: false, motivo: 'campi compilati ma non trovo il pulsante per entrare' };
        }, [String(args.utente || ''), String(args.password || ''), trovaCampi.toString()]);

        if (!esito || !esito.ok) return esito || { ok: false, motivo: 'accesso non riuscito' };

        await waitForTabLoad(tab.id, 15000);
        await new Promise(r => setTimeout(r, 1500));

        // Ha funzionato davvero? Se c'e' ancora un campo password, no. E se
        // chiede un codice, serve una persona: non e' un fallimento nostro.
        const dopo = await run(tab.id, () => {
          const t = (document.body.innerText || '').toLowerCase();
          const pwd = [...document.querySelectorAll('input')].some(i => {
            const r = i.getBoundingClientRect();
            return (i.type || '').toLowerCase() === 'password' && r.width >= 2 && r.height >= 2;
          });
          return {
            ancoraFuori: pwd,
            chiedeCodice: /codice di verifica|verification code|autenticazione a due|two.?factor|otp|sms/.test(t),
            erroreCredenziali: /credenziali non valide|password errata|incorrect password|invalid (username|password|credentials)/.test(t),
          };
        });

        if (dopo && dopo.chiedeCodice) {
          return { ok: false, serveUmano: true, motivo: 'il sito chiede un codice di verifica' };
        }
        if (dopo && dopo.erroreCredenziali) {
          return { ok: false, motivo: 'il sito dice che le credenziali non sono valide' };
        }
        if (dopo && dopo.ancoraFuori) {
          return { ok: false, motivo: 'dopo l\'invio c\'e\' ancora il modulo di accesso' };
        }
        return { ok: true, entrato: true };
  };

  comandi['compila_campo'] = async function (args) {
        const tab = await getWorkTab();
        await muoviCursoreSu(tab.id, args.selettore, 'scrivo');
        return await run(tab.id, (sel, valore) => {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, motivo: 'campo non trovato', selettore: sel };

          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return { ok: false, motivo: 'campo presente ma non visibile', selettore: sel };
          if (el.disabled) return { ok: false, motivo: 'campo disabilitato: la pagina non permette di compilarlo', selettore: sel };
          if (el.readOnly) return { ok: false, motivo: 'campo di sola lettura', selettore: sel };

          const tag = el.tagName.toLowerCase();
          const tipo = (el.type || '').toLowerCase();
          const testo = String(valore);
          const avvisa = () => {
            for (const e of ['input', 'change', 'blur']) el.dispatchEvent(new Event(e, { bubbles: true }));
          };

          try { el.focus(); } catch (_) { /* alcuni campi non prendono il fuoco */ }

          // ── Elenco a tendina ──
          if (tag === 'select') {
            const opzioni = [...el.options];
            const norm = (x) => String(x || '').trim().toLowerCase();
            let scelta = opzioni.find(o => norm(o.value) === norm(testo))
              || opzioni.find(o => norm(o.text) === norm(testo))
              || opzioni.find(o => norm(o.text).includes(norm(testo)));
            if (!scelta) {
              return { ok: false, motivo: 'nessuna opzione corrisponde', selettore: sel,
                opzioniDisponibili: opzioni.slice(0, 25).map(o => o.text.trim()).filter(Boolean) };
            }
            el.value = scelta.value;
            avvisa();
            return { ok: el.value === scelta.value, tipo: 'elenco', scritto: scelta.text.trim(), rilettoDalCampo: el.value };
          }

          // ── Casella e scelta singola: la spunta non è un testo ──
          if (tipo === 'checkbox' || tipo === 'radio') {
            const vuole = !(testo === 'false' || testo === '0' || testo === '' || testo === 'no');
            if (el.checked !== vuole) { try { el.click(); } catch (_) { el.checked = vuole; avvisa(); } }
            return { ok: el.checked === vuole, tipo: tipo === 'radio' ? 'scelta' : 'casella', rilettoDalCampo: el.checked };
          }

          // ── Testo modificabile (editor ricchi) ──
          if (el.isContentEditable) {
            el.textContent = testo;
            avvisa();
            return { ok: (el.textContent || '').includes(testo), tipo: 'testo libero', rilettoDalCampo: (el.textContent || '').slice(0, 80) };
          }

          // ── Campo di testo: si passa dal setter nativo, altrimenti React
          //    non si accorge del cambiamento e al primo ridisegno lo cancella.
          const proto = tag === 'textarea' ? HTMLTextAreaElement : HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
          if (setter && setter.set) setter.set.call(el, testo); else el.value = testo;
          avvisa();

          // La rilettura è il punto: un modulo che rifiuta il valore lo si
          // scopre adesso, non quando l'utente guarda il modulo mezzo vuoto.
          const dopo = el.value;
          if (dopo === testo) return { ok: true, tipo: tipo || 'testo', rilettoDalCampo: dopo };
          return { ok: false, tipo: tipo || 'testo', selettore: sel,
            motivo: dopo === '' ? 'la pagina ha svuotato il campo subito dopo'
              : 'la pagina ha cambiato il valore scritto',
            volevo: testo, rilettoDalCampo: dopo };
        }, [args.selettore, args.valore]);
  };

  // Cosa c'è davvero in un modulo, prima di provare a compilarlo.

  comandi['leggi_modulo'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const campi = [];
          for (const el of document.querySelectorAll('input, select, textarea, [contenteditable="true"]')) {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const tipo = (el.type || '').toLowerCase();
            if (tipo === 'hidden') continue;

            // L'etichetta come la vede una persona: quella collegata, quella
            // che lo contiene, il segnaposto, o il testo di aiuto.
            let etichetta = '';
            try {
              if (el.id) {
                const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (l) etichetta = l.innerText.trim();
              }
              if (!etichetta) {
                const dentro = el.closest('label');
                if (dentro) etichetta = dentro.innerText.trim();
              }
              if (!etichetta) etichetta = el.getAttribute('aria-label') || el.placeholder || '';
            } catch (_) { /* etichetta non trovata */ }

            const voce = {
              selettore: el.id ? '#' + CSS.escape(el.id)
                : el.name ? `[name="${el.name}"]`
                : el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` : null,
              etichetta: etichetta.slice(0, 80),
              tag: el.tagName.toLowerCase(),
              tipo,
              obbligatorio: !!(el.required || el.getAttribute('aria-required') === 'true'),
              disabilitato: !!el.disabled,
              solaLettura: !!el.readOnly,
              valoreAttuale: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : String(el.value || '').slice(0, 60),
            };
            if (el.tagName === 'SELECT') {
              voce.opzioni = [...el.options].slice(0, 30).map(o => o.text.trim()).filter(Boolean);
            }
            if (voce.selettore) campi.push(voce);
          }
          const invii = [...document.querySelectorAll('button[type="submit"],input[type="submit"],button')]
            .filter(b => { const r = b.getBoundingClientRect(); return r.width > 2 && r.height > 2; })
            .map(b => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 8);
          return { ok: true, campi, quanti: campi.length, pulsanti: invii };
        });
  };

  // Type istantaneo (setValue + react events)

  comandi['type'] = async function (args) {
        try {
          const t = await getWorkTab();
          await muoviCursoreSu(t.id, args.selector, 'scrivo');
        } catch (_) { /* il cursore non deve mai bloccare la scrittura */ }
        const tab = await getWorkTab();
        return await run(tab.id, (text, sel, clear) => {
          eval(RESOLVE_CODE);
          const el = sel ? resolveElement(sel) : (document.activeElement || document.body);
          if (!el) return { ok: false, error: 'No element' };
          el.focus();
          // Supporto contenteditable
          if (el.isContentEditable || el.contentEditable === 'true') {
            if (clear) el.innerHTML = '';
            // Usa execCommand per compatibilità con rich editors (Gmail, Notion, etc.)
            document.execCommand('insertText', false, text);
            return { ok: true, method: 'contenteditable' };
          }
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (clear) { if (nativeSetter) nativeSetter.call(el, ''); else el.value = ''; }
          if (nativeSetter) nativeSetter.call(el, (clear ? '' : el.value) + text);
          else el.value = (clear ? '' : el.value) + text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, method: 'value' };
        }, [args.text, args.selector || null, args.clear === true]);
  };

  // Type realistico char-by-char con delay gaussiano
  // Fix: doppia strategia — eventi sintetici + value setter nativo per siti con isTrusted check

  comandi['type_human'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, async (text, sel, avgDelay, clear) => {
          eval(RESOLVE_CODE);
          const el = sel ? resolveElement(sel) : (document.activeElement || document.body);
          if (!el) return { ok: false, error: 'No element' };
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.focus();
          el.dispatchEvent(new Event('focus', { bubbles: true }));

          const isContentEditable = el.isContentEditable || el.contentEditable === 'true';
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

          if (!isContentEditable) {
            if (clear) { if (setter) setter.call(el, ''); else el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
          } else if (clear) {
            el.innerHTML = '';
          }

          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const u1 = Math.random(), u2 = Math.random();
            const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const delay = Math.max(20, Math.round(avgDelay + gauss * (avgDelay / 3)));
            await new Promise(r => setTimeout(r, delay));

            el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: ch.length === 1 ? 'Key' + ch.toUpperCase() : ch, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));

            if (isContentEditable) {
              document.execCommand('insertText', false, ch);
            } else {
              // Strategia doppia: setter nativo (React/Angular) + value diretto (vanilla)
              if (setter) setter.call(el, el.value + ch);
              else el.value += ch;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));

          // Verifica: se il valore non è cambiato (isTrusted rejection), forza con setter completo
          if (!isContentEditable && el.value !== text && !el.value.endsWith(text)) {
            if (setter) setter.call(el, clear ? text : (el.value || '') + text);
            else el.value = clear ? text : (el.value || '') + text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, typed: text.length, method: 'forced_setter' };
          }
          return { ok: true, typed: text.length, method: isContentEditable ? 'contenteditable_human' : 'human' };
        }, [args.text, args.selector || null, args.delay || 80, args.clear === true]);
  };

  comandi['fill_form'] = async function (args) {
        const tab = await getWorkTab();
        const fields = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields;
        // Fill sequenziale con supporto componenti custom (combobox, popup, ecc.)
        const results = [];
        for (const [sel, value] of Object.entries(fields)) {
          try {
            const fieldResult = await run(tab.id, (sel, value) => {
              eval(RESOLVE_CODE);
              eval(MOUSE_CODE);

              function nativeSet(target, val) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                  || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (setter) setter.call(target, val);
                else target.value = val;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
              }

              const el = resolveElement(sel);
              if (!el) return { selector: sel, ok: false, error: 'Not found' };
              el.scrollIntoView({ block: 'center', behavior: 'smooth' });

              // Determina se è un campo standard o un componente custom
              const tag = el.tagName?.toLowerCase();
              const role = (el.getAttribute('role') || '').toLowerCase();
              const isStandardInput = (tag === 'input' || tag === 'textarea') && !role;
              const isSelect = tag === 'select';
              const isCheckbox = el.type === 'checkbox' || el.type === 'radio';
              const isDate = el.type === 'date' || el.type === 'datetime-local' || el.type === 'time';
              const isEditable = el.isContentEditable || el.contentEditable === 'true';
              const isCustom = role === 'combobox' || role === 'textbox' || role === 'searchbox' || role === 'listbox' || (!isStandardInput && !isSelect && !isCheckbox && !isDate && !isEditable);

              realisticClick(el);

              if (isSelect) {
                let found = false;
                for (const opt of el.options) {
                  if (opt.value === value || opt.textContent.trim() === value) {
                    opt.selected = true; found = true; break;
                  }
                }
                if (!found) return { selector: sel, ok: false, error: 'Option not found: ' + value };
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { selector: sel, ok: true, value, method: 'select' };
              }
              if (isCheckbox) {
                if (String(value) === 'true' && !el.checked) el.click();
                if (String(value) === 'false' && el.checked) el.click();
                return { selector: sel, ok: true, value, method: 'checkbox' };
              }
              if (isDate) {
                nativeSet(el, value);
                return { selector: sel, ok: true, value, method: 'date' };
              }
              if (isEditable) {
                el.innerHTML = '';
                document.execCommand('insertText', false, value);
                return { selector: sel, ok: true, value, method: 'contenteditable' };
              }
              if (isStandardInput) {
                nativeSet(el, value);
                return { selector: sel, ok: true, value, method: 'native' };
              }
              // CUSTOM COMPONENT: click ha già aperto il popup — marca per fase 2
              return { selector: sel, ok: false, custom: true, method: 'needs_active_input' };
            }, [sel, value]);

            // Fase 2: componente custom — aspetta popup, cerca input attivo, scrivi lì
            if (fieldResult && fieldResult.custom) {
              await new Promise(r => setTimeout(r, 500)); // aspetta popup/dropdown
              const phase2 = await run(tab.id, (value) => {
                function nativeSet(target, val) {
                  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                    || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                  if (setter) setter.call(target, val);
                  else target.value = val;
                  target.dispatchEvent(new Event('input', { bubbles: true }));
                  target.dispatchEvent(new Event('change', { bubbles: true }));
                }
                // Strategia 1: activeElement è un input/textarea
                const active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
                  nativeSet(active, value);
                  return { ok: true, method: 'active_element', tag: active.tagName };
                }
                // Strategia 2: contentEditable attivo
                if (active && (active.isContentEditable || active.contentEditable === 'true')) {
                  active.innerHTML = '';
                  document.execCommand('insertText', false, value);
                  return { ok: true, method: 'active_contenteditable' };
                }
                // Strategia 3: trova ultimo input visibile apparso (popup/dialog)
                const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]'))
                  .filter(n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; });
                if (inputs.length > 0) {
                  const target = inputs[inputs.length - 1]; // ultimo apparso
                  target.focus();
                  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                    nativeSet(target, value);
                  } else {
                    target.innerHTML = '';
                    document.execCommand('insertText', false, value);
                  }
                  return { ok: true, method: 'last_visible_input', tag: target.tagName };
                }
                return { ok: false, error: 'No active/visible input after click' };
              }, [value]);
              results.push({ selector: sel, ...phase2, value });
            } else {
              results.push(fieldResult);
            }
          } catch (e) {
            results.push({ selector: sel, ok: false, error: e.message });
          }
        }
        return { ok: results.every(r => r.ok), results };
  };

  // Submit form

  comandi['submit_form'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const form = sel ? resolveElement(sel) : document.querySelector('form');
          if (!form) return { ok: false, error: 'No form found' };
          // Cerca submit button
          const submit = form.querySelector('button[type="submit"], input[type="submit"]');
          if (submit) { submit.click(); return { ok: true, method: 'button_click' }; }
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.submit();
          return { ok: true, method: 'form_submit' };
        }, [args.selector || null]);
  };

  comandi['set_datepicker'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel, value) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };

          // Strategy 1: input[type=date] nativo
          if (el.type === 'date' || el.type === 'datetime-local') {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, method: 'native_date' };
          }

          // Strategy 2: React/MUI datepicker — click + type
          realisticClick(el);
          el.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return { ok: true, method: 'type_date' };
        }, [args.selector, args.value]);
  };

  comandi['select_dropdown'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, async (sel, value, searchable) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };

          // Native select
          if (el.tagName === 'SELECT') {
            for (const opt of el.options) {
              if (opt.value === value || opt.textContent.trim().toLowerCase().includes(value.toLowerCase())) {
                opt.selected = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, method: 'native_select', selected: opt.textContent.trim() };
              }
            }
            return { ok: false, error: 'Option not found' };
          }

          // Custom dropdown (React Select, MUI, etc.): click to open
          realisticClick(el);
          await new Promise(r => setTimeout(r, 300));

          // Se searchable, digita il valore
          if (searchable) {
            const input = el.querySelector('input') || document.activeElement;
            if (input && (input.tagName === 'INPUT' || input.isContentEditable)) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (setter) setter.call(input, value);
              else input.value = value;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
            }
          }

          // Cerca opzione visibile con testo corrispondente
          const lower = value.toLowerCase();
          const options = document.querySelectorAll('[role="option"], [role="listbox"] > *, .option, li[data-value], .select-option, [class*="option"]');
          for (const opt of options) {
            if (opt.textContent.trim().toLowerCase().includes(lower) && ((opt.getBoundingClientRect().width || 0) >= 2 && (opt.getBoundingClientRect().height || 0) >= 2)) {
              realisticClick(opt);
              return { ok: true, method: 'custom_dropdown', selected: opt.textContent.trim() };
            }
          }
          return { ok: false, error: 'Option not found in dropdown: ' + value };
        }, [args.selector, args.value, args.searchable || false]);
  };

  comandi['file_upload'] = async function (args) {
        const tab = await getWorkTab();
        // Per input[type=file] serve un approccio speciale
        // Il file deve essere passato come base64 o URL dal server
        return await runIsolated(tab.id, (sel, fileName, fileType, fileDataB64) => {
          const el = sel ? document.querySelector(sel) : document.querySelector('input[type="file"]');
          if (!el) return { ok: false, error: 'No file input found' };

          // Converti base64 in File
          const byteStr = atob(fileDataB64);
          const bytes = new Uint8Array(byteStr.length);
          for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
          const file = new File([bytes], fileName, { type: fileType || 'application/octet-stream' });

          const dt = new DataTransfer();
          dt.items.add(file);
          el.files = dt.files;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true, fileName, size: file.size };
        }, [args.selector || null, args.fileName || 'file.pdf', args.fileType || 'application/pdf', args.fileData || '']);
  };

  comandi['iframe_type'] = async function (args) {
        const tab = await getWorkTab();
        let frameId = args.frameId;
        if (frameId === undefined && args.urlPattern) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          const match = frames.find(f => f.url.includes(args.urlPattern));
          if (!match) return { ok: false, error: 'Frame not found' };
          frameId = match.frameId;
        }
        return await runInFrame(tab.id, frameId, (sel, text) => {
          const el = sel ? document.querySelector(sel) : document.activeElement;
          if (!el) return { ok: false, error: 'Not found' };
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }, [args.selector, args.text]);
  };

  comandi['get_forms'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          eval(RESOLVE_CODE);
          const forms = [];
          // Anche form dentro Shadow DOM
          const allForms = queryShadowAll(document, 'form');
          for (const form of allForms) {
            const fields = [];
            for (const el of form.querySelectorAll('input, select, textarea')) {
              fields.push({
                tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
                id: el.id || '', placeholder: el.placeholder || '', value: el.value || '',
                label: el.labels?.[0]?.textContent?.trim() || '',
                required: el.required,
                selector: el.id ? '#' + el.id : el.name ? '[name="' + el.name + '"]' : null
              });
            }
            forms.push({ action: form.action, method: form.method, id: form.id || '', fields });
          }
          return { ok: true, forms };
        });
  };

  const quanti = globalThis.Registro.area('moduli', comandi);
  console.log(`[COBRA] moduli: ${quanti} comandi registrati`);
})();
