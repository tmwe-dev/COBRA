// cobra-extension/esterni/comandi/linkedin.js — LinkedIn.
//
// Uscito da messaggistica.js insieme a whatsapp.js: erano 1.318 righe in un
// file solo, e due cose che cambiano per motivi diversi non stanno insieme.
//
// LE REGOLE, che si vedono nel codice:
//   · la messaggistica di LinkedIn non espone i profili: `a[href*="/in/"]`
//     restituisce zero. Le conversazioni si aprono per NOME, e per questo la
//     verifica del destinatario e' l'unica difesa che resta.
//   · i pulsanti si cercano per significato (ruolo + nome accessibile), non
//     per classe: le classi cambiano a ogni rilascio.
//   · la visibilita' non si misura con offsetParent — il riquadro "Aggiungi
//     una nota" e' `position: fixed`, e li' offsetParent e' sempre nullo.

(function () {
  'use strict';

  const comandi = {};

  comandi['linkedin_profilo'] = async function (args) {
        return await Esterni.con('li', (m) => m.Actions.extractProfileByUrl(args.url), args.modo || 'automatico');
  };

  comandi['linkedin_cerca'] = async function (args) {
        return await Esterni.con('li', (m) => m.Actions.searchProfile(args.chi), args.modo || 'automatico');
  };

  // Duplicato di linkedin_elenco_chat. Il lettore vecchio, misurato sulla
  // messaggistica vera il 7 agosto: 26 righe per 12 conversazioni (ogni
  // persona due volte, la seconda vuota) in 28 secondi. Il nuovo: 10
  // conversazioni pulite in 0,1 secondi.

  comandi['linkedin_posta'] = async function (args) {
        return await executeCommand('linkedin_elenco_chat',
          { quante: args.quante || 50 });
  };

  // Duplicato di linkedin_leggi_conversazione.

  comandi['linkedin_conversazione'] = async function (args) {
        return await executeCommand('linkedin_leggi_conversazione',
          { nome: args.contatto || args.nome, quanti: args.quanti || 30 });
  };

  // ── linkedin_scrivi: converge su linkedin_rispondi ──
  //
  // Delegava a sendLinkedInMessage, che pretende un indirizzo di profilo.
  // Il codice ha cose buone — controlla lo slug, si rifiuta se la scheda
  // e' su un'altra conversazione — ma non ha il ritmo umano, non passa
  // dalla mappa dei selettori, e cerca i pulsanti con offsetParent, che
  // sui riquadri `position: fixed` li scarta come invisibili.
  //
  // Soprattutto: era la porta da cui si usciva dal percorso controllato
  // semplicemente passando un indirizzo invece di un nome. Adesso
  // linkedin_rispondi accetta anche `url` e fa lo stesso lavoro con le
  // verifiche al posto giusto.

  comandi['linkedin_scrivi'] = async function (args) {
        return await executeCommand('linkedin_rispondi',
          { url: args.url, nome: args.nome, testo: args.testo });
  };

  comandi['linkedin_diagnosi'] = async function (args) {
        return await Esterni.con('li', (m) => m.Actions.diagnostic(), args.modo || 'automatico');
  };

  // ── L'elenco delle conversazioni LinkedIn ──
  //
  // Scritto guardando la pagina vera il 7 agosto, non a memoria. Il
  // lettore del Navigator (readLinkedInInbox, metodo "legacy-structural")
  // su quella stessa pagina restituiva 26 righe per 12 conversazioni:
  // ogni contatto compariva due volte, la seconda vuota. E' lo stesso
  // difetto che aveva su WhatsApp — prende elementi annidati e li conta
  // tutti — e per giunta ci arriva solo dopo che il metodo principale
  // scade (optimus_inbox_timeout_12000ms), quindi 28 secondi per un dato
  // sbagliato.
  //
  // Qui si legge una volta sola, dal contenitore giusto.
  //
  // COSA NON C'E', e va detto: nella messaggistica LinkedIn non esiste
  // nessun link al profilo delle persone — verificato, zero <a href="/in/">
  // in tutta la pagina. Il numero della conversazione sta solo
  // nell'indirizzo, e compare dopo averla aperta. Per questo qui si torna
  // il NOME: e' l'unica chiave che la pagina offre davvero.

  comandi['linkedin_elenco_chat'] = async function (args) {
        // Regola di Luca: mai in serie, mai sovrapposte, mai meccaniche.
        // Ritmo.comeUnaPersona mette in coda (una operazione per volta),
        // aspetta una pausa gaussiana, muove il mouse su una traiettoria
        // curva e ogni tanto scorre. Se il modulo non e' caricato si procede
        // lo stesso: meglio senza ritmo che fermi.
        // Una funzione sola porta sulla pagina giusta: la cerca, la sveglia,
        // o la apre in secondo piano. Prima questo blocco era lungo trenta
        // righe ed era diverso in ognuno dei cinque comandi.
        const _pe = await globalThis.Pagine.preparaPagina('linkedin_messaggi');
        if (!_pe.ok) return _pe;
        const viva = _pe.scheda;
        const apertaDaMe = !!_pe.apertaDaMe;

        // ── Il selettore lo chiede alla mappa, non lo sa a memoria ──
        //
        // La prima volta guarda la pagina e impara; le volte dopo usa quello
        // che sa, e ci mette un millisecondo. Se il DOM e' cambiato, il
        // selettore imparato non regge piu' e la mappa ne trova un altro da
        // sola: il lavoro prosegue, e la riscoperta viene detta invece di
        // essere nascosta.
        let selRighe = 'li.msg-conversation-listitem';
        let comeLoSo = 'scritto a mano (mappa non disponibile)';
        let riscoperto = false;
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'elenco_conversazioni');
          if (m.ok) {
            selRighe = m.selettore;
            comeLoSo = m.dallaMemoria ? 'gia\' noto dalla mappa' : m.come;
            riscoperto = !!m.riscoperto;
          }
        }

        const r = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          args: [Number(args.quante) || 50, selRighe],
          func: (quante, selRighe) => {
            const righe = document.querySelectorAll(selRighe);
            if (!righe.length) {
              return {
                ok: false,
                motivo: 'non trovo le conversazioni',
                cosaFare: 'Apri https://www.linkedin.com/messaging/ e riprova.',
                cosaCeDentro: document.title.slice(0, 80),
              };
            }

            // Righe che non sono persone: la barra di stato in fondo, e le
            // InMail pubblicitarie che mettono l'etichetta al posto del nome.
            const NON_PERSONE = /^(stato:|messaggio inmail$|sponsorizzat)/i;

            const chat = [];
            const visti = new Set();
            for (const el of righe) {
              const n = el.querySelector('.msg-conversation-listitem__participant-names, h3');
              const nome = n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
              if (!nome || NON_PERSONE.test(nome)) continue;
              if (visti.has(nome)) continue;      // niente doppioni
              visti.add(nome);

              const p = el.querySelector('.msg-conversation-card__message-snippet, .msg-conversation-card__message-snippet-body');
              const t = el.querySelector('time, .msg-conversation-listitem__time-stamp');
              chat.push({
                nome,
                anteprima: p ? p.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
                quando: t ? t.innerText.trim() : '',
                nonLetto: !!el.querySelector('.msg-conversation-card__unread-count, [class*="unread"]'),
              });
              if (chat.length >= quante) break;
            }

            return {
              ok: true,
              righeGuardate: righe.length,
              conversazioni: chat.length,
              conNonLetti: chat.filter(c => c.nonLetto).length,
              // Detto apertamente, perche' chi legge questa risposta deve
              // sapere cosa NON puo' fare con essa.
              nota: 'La messaggistica LinkedIn non espone il profilo di nessuno: '
                + 'per rispondere si usa il nome, non un indirizzo.',
              chat,
            };
          },
        });
        if (r?.[0]?.result) {
          r[0].result.selettore = selRighe;
          r[0].result.comeLoSo = comeLoSo;
          if (riscoperto) {
            r[0].result.paginaCambiata = 'Il selettore che conoscevo non funzionava piu\': '
              + 'ho riguardato la pagina e ne ho imparato uno nuovo (' + selRighe + ').';
          }
        }
        const esito = r?.[0]?.result || { ok: false, motivo: 'la pagina non ha risposto' };

        // ── La foto della pagina che ho letto davvero ──
        //
        // Il pannello di COBRA restava nero durante le letture. Il comando
        // 'screenshot' fotografa la scheda ATTIVA, che quasi sempre e' COBRA
        // stesso o un'altra cosa: la messaggistica sta in un'altra scheda, a
        // volte perfino in secondo piano.
        //
        // Quindi la foto si scatta qui, dove si sa quale scheda e'. Cosi' Luca
        // vede la pagina da cui sono usciti quei nomi, e puo' controllarla a
        // occhio in un secondo invece di fidarsi.
        if (esito.ok) {
          const foto = await fotoDi(viva.id);
          if (foto.screenshot) esito.screenshot = foto.screenshot;
          esito.url = foto.url;
          if (foto.perche) esito.notaFoto = foto.perche;
        }
        // Se la scheda l'ho aperta io e non e' servita a niente, la chiudo:
        // lasciarne in giro una a ogni tentativo fallito e' come Luca si e'
        // ritrovato con centocinquanta copie dell'estensione.
        if (apertaDaMe && !esito.ok) { try { await chrome.tabs.remove(viva.id); } catch (_) {} }
        else if (apertaDaMe) esito.nota2 = 'Ho aperto io la scheda della messaggistica: era su un\'altra pagina.';
        return esito;
  };

  // ── Aprire una conversazione e leggerla per intero ──
  //
  // Domanda di Luca, 7 agosto: "se legge la pagina e non entra nel
  // messaggio di ognuno, come riporta i risultati?". Non li riportava: la
  // lista da' solo l'anteprima, centocinquanta caratteri tagliati a meta'.
  // Un riepilogo costruito su quelle e' un riepilogo di titoli, non di
  // messaggi — e infatti diceva cose come "ha inviato un allegato".
  //
  // Qui la conversazione si apre davvero e si leggono i messaggi uno per
  // uno, con chi ha scritto e quando.
  //
  // UN EFFETTO DA SAPERE: aprire una conversazione la segna come letta su
  // LinkedIn. Non e' evitabile — succede anche a una persona che clicca —
  // ma va detto, perche' e' un cambiamento sull'account di Luca fatto per
  // leggere, non per scrivere.

  comandi['linkedin_leggi_conversazione'] = async function (args) {
        // Regola di Luca: mai in serie, mai sovrapposte, mai meccaniche.
        // Ritmo.comeUnaPersona mette in coda (una operazione per volta),
        // aspetta una pausa gaussiana, muove il mouse su una traiettoria
        // curva e ogni tanto scorre. Se il modulo non e' caricato si procede
        // lo stesso: meglio senza ritmo che fermi.
        const chi = String(args.nome || args.contact || '').trim();
        if (!chi) return { ok: false, motivo: 'non mi hai detto quale conversazione' };

        const _pl = await globalThis.Pagine.preparaPagina('linkedin_messaggi');
        if (!_pl.ok) return _pl;
        const viva = _pl.scheda;

        // 1. Trovare la riga e aprirla — dopo aver aspettato il proprio turno,
        //    con la pausa e il movimento del mouse di una persona.
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const righe = [...document.querySelectorAll('li.msg-conversation-listitem')];
            const nomeDi = (el) => {
              const n = el.querySelector('.msg-conversation-listitem__participant-names, h3');
              return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
            };
            let trovate = righe.filter(el => piatto(nomeDi(el)) === cerca);
            if (!trovate.length) trovate = righe.filter(el => piatto(nomeDi(el)).includes(cerca));

            if (!trovate.length) {
              return { ok: false, motivo: `non trovo nessuna conversazione con "${chi}"`,
                disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 12) };
            }
            // Piu' di una: NON si sceglie. Aprire la conversazione sbagliata
            // significa segnarla come letta e riferire le parole di un altro.
            if (trovate.length > 1) {
              return { ok: false, ambiguo: true,
                motivo: `"${chi}" corrisponde a ${trovate.length} conversazioni`,
                candidati: trovate.map(nomeDi) };
            }
            const el = trovate[0];
            const cliccabile = el.querySelector('.msg-conversation-listitem__link, a, [role="link"]') || el;
            cliccabile.click();
            return { ok: true, aperta: nomeDi(el) };
          },
        });
        const esitoApri = apri?.[0]?.result;
        if (!esitoApri || !esitoApri.ok) return esitoApri || { ok: false, motivo: 'la pagina non ha risposto' };

        // 2. Aspettare che i messaggi compaiano. Leggere subito significa
        //    leggere la conversazione precedente, ancora sullo schermo.
        await new Promise(r => setTimeout(r, 2500));

        let selMsg = '.msg-s-event-listitem';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'messaggi');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selMsg = m.selettore;
        }

        const leggi = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [Number(args.quanti) || 30, esitoApri.aperta, selMsg],
          func: (quanti, aperta, selMsg) => {
            const nodi = [...document.querySelectorAll(selMsg)];
            if (!nodi.length) return { ok: false, motivo: 'la conversazione si e\' aperta ma non vedo messaggi' };

            const messaggi = [];
            let ultimoAutore = '';
            for (const n of nodi.slice(-quanti)) {
              const a = n.querySelector('.msg-s-message-group__name');
              // LinkedIn scrive il nome solo sul primo messaggio di un gruppo:
              // i successivi dello stesso autore non lo ripetono.
              if (a && a.innerText.trim()) ultimoAutore = a.innerText.replace(/\s+/g, ' ').trim();
              const t = n.querySelector('.msg-s-event-listitem__body');
              const q = n.querySelector('time, .msg-s-message-group__timestamp');
              const testo = t ? t.innerText.replace(/\n{3,}/g, '\n\n').trim() : '';
              if (!testo) continue;
              messaggi.push({ da: ultimoAutore || '(sconosciuto)', quando: q ? q.innerText.trim() : '', testo });
            }
            return { ok: true, conversazione: aperta, quanti: messaggi.length, messaggi,
              nota: 'Aprire la conversazione l\'ha segnata come letta su LinkedIn.' };
          },
        });

        const esito = leggi?.[0]?.result || { ok: false, motivo: 'non riesco a leggere i messaggi' };
        if (esito.ok) {
          const foto = await fotoDi(viva.id);
          if (foto.screenshot) esito.screenshot = foto.screenshot;
          esito.url = foto.url;
          if (foto.perche) esito.notaFoto = foto.perche;
        }
        return esito;
  };

  comandi['linkedin_collegati'] = async function (args) {
        const url = String(args.url || args.profilo || '').trim();
        const nota = String(args.nota || args.note || args.testo || '');
        if (!/linkedin\.com\/(in|pub)\//i.test(url)) {
          return { ok: false, motivo: 'serve l\'indirizzo di un profilo LinkedIn' };
        }

        const _pc = await globalThis.Pagine.preparaPagina('linkedin_profilo', { vai: url });
        if (!_pc.ok) return _pc;
        const viva = _pc.scheda;

        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});
        await new Promise(r => setTimeout(r, 2000));

        // 1. Chi e' aperto davvero? Come per i messaggi: se non si legge il
        //    nome non si va avanti. Un invito alla persona sbagliata non si
        //    richiama piu' di un messaggio.
        const chiCe = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [url],
          func: (atteso) => {
            const h1 = document.querySelector('h1');
            const slug = (location.pathname.match(/\/in\/([^/]+)/) || [])[1] || '';
            const attesoSlug = (String(atteso).match(/\/in\/([^/?#]+)/) || [])[1] || '';
            const piatto = (x) => String(x || '').replace(/[-_]/g, ' ')
              .replace(/\s+\S*\d\S*$/, '').toLowerCase().trim();
            return {
              nome: h1 ? h1.innerText.trim() : '',
              stessaPagina: piatto(slug) === piatto(attesoSlug),
              url: location.href,
            };
          },
        });
        const q = chiCe?.[0]?.result;
        if (!q || !q.nome) return { ok: false, motivo: 'non riesco a leggere di chi e\' il profilo: non procedo' };
        if (!q.stessaPagina) return { ok: false, motivo: `sono finito su un altro profilo (${q.url}): non procedo` };

        // 2. Il pulsante "Collegati". A volte e' in vista, a volte sta dentro
        //    il menu "Altro": si guarda prima fuori, poi dentro.
        if (globalThis.Ritmo) await globalThis.Ritmo.primaDiScrivere();
        const premi = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          func: async () => {
            const attendi = (ms) => new Promise(r => setTimeout(r, ms));
            const nomeDi = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
            // Un elemento in `position: fixed` ha SEMPRE offsetParent nullo:
            // e' cosi' che funziona il posizionamento fisso. Il riquadro
            // "Aggiungi una nota" di LinkedIn e' esattamente questo, quindi
            // filtrare su offsetParent lo avrebbe scartato come invisibile.
            // Stesso difetto che teneva a schermo i banner dei cookie.
            const siVede = (el) => {
              try {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const st = getComputedStyle(el);
                return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
              } catch (_) { return false; }
            };
            const bottoni = () => [...document.querySelectorAll('button, a[role="button"]')].filter(siVede);
            const cerca = (re) => bottoni().find(b => re.test(nomeDi(b)));

            const collega = /^(collegati|connect)\b/i;
            const gia = /(in attesa|pending|messaggio|message)$/i;

            let b = cerca(collega);
            if (!b) {
              // Dietro "Altro": si apre e si riguarda.
              const altro = cerca(/^(altro|more)\b/i);
              if (altro) { altro.click(); await attendi(1200); b = cerca(collega); }
            }
            if (!b) {
              const inAttesa = bottoni().find(x => /^(in attesa|pending)\b/i.test(nomeDi(x)));
              if (inAttesa) return { ok: false, gia: true, motivo: 'la richiesta era gia\' in attesa' };
              return { ok: false, motivo: 'non trovo il pulsante Collegati',
                visti: bottoni().map(nomeDi).filter(Boolean).slice(0, 15) };
            }
            b.click();
            await attendi(2000);
            return { ok: true, premuto: nomeDi(b) };
          },
        });
        const pr = premi?.[0]?.result;
        if (!pr || !pr.ok) return pr || { ok: false, motivo: 'la pagina non ha risposto' };

        // 3. La nota, se c'e'. "Aggiungi una nota" → si scrive → "Invia".
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'pensare', async () => {});
        const invia = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [nota],
          func: async (nota) => {
            const attendi = (ms) => new Promise(r => setTimeout(r, ms));
            const nomeDi = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
            // Un elemento in `position: fixed` ha SEMPRE offsetParent nullo:
            // e' cosi' che funziona il posizionamento fisso. Il riquadro
            // "Aggiungi una nota" di LinkedIn e' esattamente questo, quindi
            // filtrare su offsetParent lo avrebbe scartato come invisibile.
            // Stesso difetto che teneva a schermo i banner dei cookie.
            const siVede = (el) => {
              try {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const st = getComputedStyle(el);
                return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
              } catch (_) { return false; }
            };
            const visibili = () => [...document.querySelectorAll('button')].filter(siVede);
            const cerca = (re) => visibili().find(b => re.test(nomeDi(b)));

            if (nota && nota.trim()) {
              const aggiungi = cerca(/^(aggiungi una nota|add a note)\b/i);
              if (aggiungi) {
                aggiungi.click();
                await attendi(1200);
                const campo = document.querySelector('textarea[name="message"], textarea#custom-message, textarea');
                if (!campo) return { ok: false, motivo: 'non trovo il campo della nota' };
                campo.focus();
                // A pezzetti, non tutto insieme: come scrive una persona.
                campo.value = '';
                for (const pezzo of String(nota).match(/.{1,4}/g) || []) {
                  campo.value += pezzo;
                  campo.dispatchEvent(new Event('input', { bubbles: true }));
                  await attendi(40 + Math.random() * 90);
                }
                await attendi(600);
              }
            }

            const spedisci = cerca(/^(invia(\s+ora)?|send(\s+now)?|invia senza nota|send without a note)\b/i);
            if (!spedisci) return { ok: false, motivo: 'non trovo il pulsante Invia',
              visti: visibili().map(nomeDi).filter(Boolean).slice(0, 15) };
            spedisci.click();
            await attendi(2000);
            return { ok: true, premuto: nomeDi(spedisci) };
          },
        });
        const iv = invia?.[0]?.result;
        if (!iv || !iv.ok) return iv || { ok: false, motivo: 'la pagina non ha risposto' };

        // 4. La prova: il pulsante deve essere diventato "In attesa".
        await new Promise(r => setTimeout(r, 2500));
        const prova = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          func: () => {
            const testo = document.body.innerText;
            return { inAttesa: /\b(in attesa|pending)\b/i.test(testo),
              collegatiAncoraLi: /\b(collegati|connect)\b/i.test(testo) };
          },
        });
        const pv = prova?.[0]?.result || {};
        return { ok: true, a: q.nome, url: q.url, conNota: !!(nota && nota.trim()),
          confermato: !!pv.inAttesa,
          nota: pv.inAttesa ? 'il profilo dice "In attesa": la richiesta e\' partita'
            : 'non vedo "In attesa" sul profilo: verifica a mano' };
  };

  comandi['linkedin_rispondi'] = async function (args) {
        // Regola di Luca: mai in serie, mai sovrapposte, mai meccaniche.
        // Ritmo.comeUnaPersona mette in coda (una operazione per volta),
        // aspetta una pausa gaussiana, muove il mouse su una traiettoria
        // curva e ogni tanto scorre. Se il modulo non e' caricato si procede
        // lo stesso: meglio senza ritmo che fermi.
        const chi = String(args.nome || args.a || '').trim();
        const profilo = String(args.url || args.profilo || '').trim();
        const testo = String(args.testo || '');
        if (!testo) return { ok: false, motivo: 'serve il testo' };
        if (!chi && !profilo) return { ok: false, motivo: 'serve il nome o l\'indirizzo del profilo' };

        // ── Con un indirizzo si parte dal profilo, non dall'elenco chat ──
        //
        // Prima questa strada non c'era e il server mandava gli indirizzi al
        // comando vendorizzato, fuori da ogni verifica. Qui invece si apre il
        // profilo, si controlla che lo slug sia proprio quello chiesto, si
        // legge il nome, e da li' si apre la finestra di scrittura: dopodiche'
        // il testo passa dallo stesso identico percorso del caso "per nome".
        if (profilo && !chi) {
          const _pp = await globalThis.Pagine.preparaPagina('linkedin_profilo', { vai: profilo });
          if (!_pp.ok) return _pp;
          const t = _pp.scheda;
          if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(t.id, 'leggere', async () => {});
          await new Promise(r => setTimeout(r, 1800));

          const ap = await chrome.scripting.executeScript({
            target: { tabId: t.id }, args: [profilo],
            func: async (atteso) => {
              const attendi = (ms) => new Promise(r => setTimeout(r, ms));
              const siVede = (el) => {
                try {
                  const r = el.getBoundingClientRect();
                  if (r.width < 2 || r.height < 2) return false;
                  const st = getComputedStyle(el);
                  return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
                } catch (_) { return false; }
              };
              const piatto = (x) => String(x || '').replace(/[-_]/g, ' ')
                .replace(/\s+\S*\d\S*$/, '').toLowerCase().trim();
              const mio = (location.pathname.match(/\/in\/([^/]+)/) || [])[1] || '';
              const suo = (String(atteso).match(/\/in\/([^/?#]+)/) || [])[1] || '';
              if (piatto(mio) !== piatto(suo)) {
                return { ok: false, motivo: `sono su un altro profilo (${location.href}): non scrivo` };
              }
              const h1 = document.querySelector('h1');
              const nome = h1 ? h1.innerText.trim() : '';
              if (!nome) return { ok: false, motivo: 'non riesco a leggere di chi e\' il profilo: non scrivo' };

              const nomeDi = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
              const b = [...document.querySelectorAll('button, a[role="button"]')]
                .filter(siVede).find(x => /^(invia messaggio|message|messaggio)\b/i.test(nomeDi(x)));
              if (!b) return { ok: false, motivo: `non trovo il pulsante per scrivere a ${nome}` };
              b.click();
              await attendi(2500);
              return { ok: true, nome };
            },
          });
          const a0 = ap?.[0]?.result;
          if (!a0 || !a0.ok) return a0 || { ok: false, motivo: 'la pagina non ha risposto' };
          // Da qui in poi la finestra di scrittura e' aperta sul profilo
          // giusto: si prosegue come per una conversazione aperta.
          args = { ...args, nome: a0.nome };
          return await executeCommand('linkedin_rispondi', { nome: a0.nome, testo });
        }

        const _pr = await globalThis.Pagine.preparaPagina('linkedin_messaggi');
        if (!_pr.ok) return _pr;
        const viva = _pr.scheda;

        // 1. Aprire la conversazione giusta (o fermarsi).
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const righe = [...document.querySelectorAll('li.msg-conversation-listitem')];
            const nomeDi = (el) => {
              const n = el.querySelector('.msg-conversation-listitem__participant-names, h3');
              return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
            };
            let t = righe.filter(el => piatto(nomeDi(el)) === cerca);
            if (!t.length) t = righe.filter(el => piatto(nomeDi(el)).includes(cerca));
            if (!t.length) return { ok: false, motivo: `non trovo "${chi}" fra le conversazioni`,
              disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 12) };
            if (t.length > 1) return { ok: false, ambiguo: true,
              motivo: `"${chi}" corrisponde a ${t.length} conversazioni`, candidati: t.map(nomeDi) };
            (t[0].querySelector('.msg-conversation-listitem__link, a, [role="link"]') || t[0]).click();
            return { ok: true, aperta: nomeDi(t[0]) };
          },
        });
        const a = apri?.[0]?.result;
        if (!a || !a.ok) return a || { ok: false, motivo: 'la pagina non ha risposto' };

        await new Promise(r => setTimeout(r, 2500));

        // Prima di scrivere una persona legge quello che le hanno mandato e ci
        // pensa su. Scrivere nell'istante in cui la conversazione si apre e'
        // il gesto meno umano di tutti.
        if (globalThis.Ritmo) { await globalThis.Ritmo.primaDiScrivere(); await globalThis.Ritmo.comeUnaPersona(viva.id, 'pensare', async () => {}); }

        // ── Verificare CHI c'e' aperto, come su WhatsApp ──
        //
        // Qui non c'era per niente: si apriva la conversazione e si scriveva.
        // Su WhatsApp il controllo c'era (rotto, ma c'era); qui mancava del
        // tutto. E' l'ennesima asimmetria fra le due strade, e sta sul percorso
        // dove un errore manda un messaggio a uno sconosciuto.
        //
        // Il titolo su LinkedIn e' in chiaro, verificato sulla pagina:
        // .msg-entity-lockup__entity-title dice "Samuel Chen".
        //
        // Se non si riesce a leggerlo NON si scrive: nel dubbio si perde un
        // invio, non si sbaglia persona.
        const conferma = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [a.aperta],
          func: (atteso) => {
            const e = document.querySelector('.msg-entity-lockup__entity-title, .msg-title-bar h2, [class*="entity-title"]');
            const chi = e ? (e.innerText || '').split('\n')[0].trim() : '';
            if (!chi) return { chi: null, perche: 'non riesco a leggere il nome in cima alla conversazione' };
            const piatto = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            return { chi, combacia: piatto(chi) === piatto(atteso) };
          },
        });
        const c = conferma?.[0]?.result;
        if (!c || !c.chi) {
          return { ok: false,
            motivo: c?.perche || 'non riesco a verificare quale conversazione e\' aperta',
            cosaFare: 'Non scrivo senza sapere a chi. Riprova, o aprila tu e dimmelo.' };
        }
        if (!c.combacia) {
          return { ok: false,
            motivo: `ho chiesto "${a.aperta}" ma in cima vedo "${c.chi}": non scrivo`,
            cosaFare: 'La conversazione aperta non e\' quella giusta. Riferiscilo a Luca.' };
        }

        // 2. Scrivere e mandare.
        // La casella dalla mappa: se il DOM cambia, la ritrova da sola —
        // anche per significato, cioe' "la casella dove si scrive un messaggio".
        let selCasellaLi = '.msg-form__contenteditable';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'casella_scrittura');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selCasellaLi = m.selettore;
        }

        const inviato = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [testo, a.aperta, selCasellaLi],
          func: async (testo, aperta, selCasella) => {
            const box = document.querySelector(selCasella)
              || document.querySelector('.msg-form__contenteditable, div[contenteditable="true"][role="textbox"]');
            if (!box) return { ok: false, motivo: 'non trovo la casella di scrittura' };
            box.focus();

            const svuota = () => {
              try {
                const r = document.createRange(); r.selectNodeContents(box);
                const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                document.execCommand('delete', false);
              } catch (e) { /* si riprova */ }
            };
            let residuo = '';
            for (let i = 0; i < 3; i++) {
              svuota();
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
              try {
                box.innerHTML = '';
                box.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
              } catch (e) { /* ignore */ }
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
            }
            if (residuo) {
              return { ok: false, motivo: 'casella_non_vuota', residuo: residuo.slice(0, 120),
                perche: 'Nella casella e\' rimasto del testo: se scrivessi adesso partirebbe attaccato al mio.' };
            }

            // ── Si scrive a pezzi, non di colpo ──
            //
            // Regola di Luca: niente modifiche troppo rapide. Un messaggio di
            // duecento caratteri che compare tutto insieme in un millisecondo
            // non e' scritto da nessuno: e' incollato da un programma. Qui il
            // testo entra a gruppi di poche lettere, con pause diverse ogni
            // volta e qualche sosta piu' lunga dopo la punteggiatura, come chi
            // rilegge la frase prima di continuare.
            //
            // Resta l'incollata come riserva: se il modo lento non attecchisce
            // (Lexical a volte ignora insertText), meglio un messaggio inviato
            // in fretta che un messaggio non inviato.
            const uguale = () => (box.innerText || '').trim() === testo.trim();
            const attesa = (ms) => new Promise(r => setTimeout(r, ms));

            let scritto = '';
            for (let i = 0; i < testo.length && !uguale();) {
              const pezzo = 2 + Math.floor(Math.random() * 4);   // 2-5 caratteri
              const parte = testo.slice(i, i + pezzo);
              try { document.execCommand('insertText', false, parte); }
              catch (e) { break; }
              scritto += parte;
              i += pezzo;
              // Il ritmo di chi scrive non e' costante.
              let pausa = 45 + Math.random() * 110;
              if (/[.,;:!?]\s*$/.test(parte)) pausa += 200 + Math.random() * 400;
              if (Math.random() < 0.07) pausa += 500 + Math.random() * 900;  // si ferma a pensare
              await attesa(pausa);
            }

            if (!uguale()) {
              try {
                const dt = new DataTransfer(); dt.setData('text/plain', testo);
                box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
              } catch (e) { /* ignore */ }
            }
            if (!uguale()) { try { document.execCommand('insertText', false, testo); } catch (e) { /* ignore */ } }
            if (!uguale()) {
              try {
                box.textContent = testo;
                box.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: testo, bubbles: true, composed: true }));
              } catch (e) { /* ignore */ }
            }
            if (!uguale()) return { ok: false, motivo: 'non riesco a scrivere nella casella',
              dentro: (box.innerText || '').slice(0, 80) };

            // Una persona rilegge prima di premere Invia.
            await attesa(700 + Math.random() * 1600);
            const bottone = [...document.querySelectorAll('button')]
              .find(b => /invia|send/i.test(b.innerText || b.getAttribute('aria-label') || '') && !b.disabled);
            if (!bottone) return { ok: false, motivo: 'il pulsante Invia e\' disattivato: il testo non e\' stato accettato' };
            bottone.click();
            await new Promise(r => setTimeout(r, 1200));

            // La prova che e' partito: la casella si e' svuotata da sola.
            const partito = !(box.innerText || '').trim();
            return partito
              ? { ok: true, a: aperta, testo }
              : { ok: false, motivo: 'ho premuto Invia ma il testo e\' ancora nella casella' };
          },
        });
        return inviato?.[0]?.result || { ok: false, motivo: 'la pagina non ha risposto' };
  };

  // ── Aprire una chat WhatsApp e leggerla ──
  //
  // Scritta da zero il 7 agosto. Quella del Navigator — readThread in
  // wa/actions.js — non ha mai potuto funzionare: chiama
  // _pageOpenAndReadThread e _pageDomReadMessages, e nessuna delle due
  // esiste in nessun file. Ogni chiamata finiva nel catch e tornava
  // { success: false }. Nessuno se n'era accorto perche' il fallimento
  // sembrava un problema di sessione.
  //
  // DUE COSE IMPARATE GUARDANDO LA PAGINA, non a memoria:
  //
  //   1. Un .click() sulla riga NON apre la chat. WhatsApp ascolta la
  //      sequenza vera del puntatore: pointerdown, mousedown, pointerup,
  //      mouseup, click. Con il solo click la pagina non si muove, e si
  //      finisce a leggere la conversazione precedente.
  //
  //   2. Autore e orario non stanno nel testo: stanno nell'attributo
  //      data-pre-plain-text, nella forma "[04:57, 07/08/2026] Luca: ".
  //      E' l'unico punto dove WhatsApp li mette insieme.
  //
  // EFFETTO DA SAPERE: aprire una chat la segna come letta. Vale anche
  // per una persona che clicca, ma qui e' un programma a farlo su
  // richiesta, e va detto.
  // ── Scrivere in una chat WhatsApp aperta per nome ──
  //
  // Gemello di linkedin_rispondi, e nasce da un'asimmetria trovata
  // rileggendo il codice a fine giornata.
  //
  // whatsapp_scrivi passava da sendWhatsAppMessage del Navigator, che
  // prende `existingTabs[0]`: la PRIMA scheda WhatsApp che trova. Luca ne
  // ha due aperte. Se la prima e' quella ferma sul QR o svuotata da Chrome,
  // l'invio fallisce — o peggio, scrive nella conversazione sbagliata.
  //
  // E' lo stesso difetto che ho corretto oggi in cinque punti diversi. Su
  // una lettura costa un errore; su un invio costa un messaggio mandato
  // alla persona sbagliata, e quello non si richiama.
  //
  // Con un NUMERO la strada del Navigator resta giusta: /send?phone= apre
  // la chat esatta senza ambiguita'. Con un NOME si passa di qui.

  const quanti = globalThis.Registro.area('linkedin', comandi);
  console.log(`[COBRA] linkedin: ${quanti} comandi registrati`);
})();
