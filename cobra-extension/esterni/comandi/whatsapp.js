// cobra-extension/esterni/comandi/whatsapp.js — WhatsApp Web.
//
// Uscito da messaggistica.js, che a sua volta era uscito da background.js.
// Il primo taglio aveva portato background.js da 4.730 a 1.256 righe, ma
// messaggistica.js ne aveva prese 1.318 — cioe' il problema si era spostato,
// non risolto. Luca l'ha fatto notare: un file di 1.300 righe non e' meglio
// di uno di 4.000, se dentro ci sono due cose diverse.
//
// WhatsApp e LinkedIn si somigliano solo di nome. Cambiano in momenti diversi,
// si rompono per motivi diversi, e chi lavora su uno non deve leggere l'altro.
//
// LE REGOLE, che si vedono nel codice:
//   · prima di scrivere si LEGGE il nome in cima alla conversazione, e se non
//     si riesce a leggere NON si scrive. Meglio perdere un invio.
//   · `.click()` non apre una conversazione: serve la sequenza del puntatore.
//     Per un giorno intero e' sembrato un problema di selettori.
//   · autore e ora stanno in `data-pre-plain-text`, non nel testo.

(function () {
  'use strict';

  const comandi = {};

  comandi['whatsapp_sessione'] = async function (args) {
        return await Esterni.con('wa', (m) => m.Actions.verifySession(), args.modo || 'automatico');
  };

  // ── L'elenco delle conversazioni, letto dove sta davvero ──
  //
  // PERCHE' NON USO IL LORO readUnreadMessages
  //
  // Il 7 agosto l'ho provato sul WhatsApp vero di Luca. Ha restituito 150
  // righe in cui i messaggi erano finiti al posto dei contatti:
  //
  //     contact: "We will do tomorrow"       <- e' un messaggio
  //     lastMessage: "wds-ic-read"           <- e' il nome dell'icona
  //     avgBadge: 0, confidence: 15
  //
  // Il motivo: la loro strategia "role-row" prende ogni elemento con
  // role="row" di TUTTA la pagina, e le bolle della conversazione aperta
  // hanno lo stesso ruolo delle righe dell'elenco. Con una chat aperta,
  // legge quella e la scambia per la rubrica.
  //
  // I SELETTORI QUI SOTTO NON SONO INDOVINATI
  //
  // Vengono dal LORO Discovery, che sulla stessa pagina e nello stesso
  // momento ha misurato: sidebarSelector "pane-side", chatItems 68,
  // chatItemsMethod "cell-frame". Sono fatti rilevati dal vivo, non
  // ipotesi mie: mi limito a leggere dentro il contenitore che loro hanno
  // gia' identificato, invece che in tutta la pagina.

  comandi['whatsapp_elenco_chat'] = async function (args) {
        const _pwe = await globalThis.Pagine.preparaPagina('whatsapp_chat');
        if (!_pwe.ok) return _pwe;
        const viva = _pwe.scheda;

        // Anche leggere e' un gesto che si vede. Su LinkedIn il ritmo c'era e
        // qui no: sessantaquattro righe lette in un millisecondo, ogni volta
        // allo stesso modo, sono una firma quanto un invio raffica.
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'veloce', async () => {});

        // Il selettore lo chiede alla mappa: la prima volta lo impara guardando,
        // le volte dopo lo riusa, e se il DOM cambia lo ritrova da solo.
        let selRighe = null, comeLoSoWa = 'scritto a mano';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'elenco_conversazioni');
          if (m.ok) { selRighe = m.selettore; comeLoSoWa = m.dallaMemoria ? 'gia\' noto dalla mappa' : m.come; }
        }

        const r = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          args: [Number(args.quante) || 40, selRighe],
          func: (quante, selRighe) => {
            const elenco = document.querySelector('#pane-side');
            if (!elenco) return { ok: false, motivo: 'non trovo l\'elenco chat (#pane-side)' };

            // ── Quale selettore, lo dice la pagina ──
            //
            // Al primo tentativo avevo scelto [role="listitem"] e ho trovato
            // zero righe: WhatsApp non lo usa piu'. Indovinare un secondo
            // selettore sarebbe stato lo stesso errore due volte.
            //
            // Il selettore imparato dalla mappa ha la precedenza: se regge, si
            // usa quello e non si prova nient'altro.
            //
            // Quindi si provano i candidati e vince quello che trova piu'
            // righe. Nota che "role=row" qui e' innocuo, mentre e' proprio
            // quello che rovinava la lettura dei moduli del Navigator: la
            // differenza non e' il selettore, e' che qui si cerca DENTRO
            // #pane-side, dove le bolle della conversazione non arrivano.
            // Il selettore imparato dalla mappa va provato per primo: se regge,
            // gli altri non si guardano nemmeno. Se non regge, si ricade sui
            // candidati e la mappa imparera' quello nuovo al giro dopo.
            const candidati = [
              ...(selRighe ? [selRighe] : []),
              '[data-testid="cell-frame-container"]',
              '[role="listitem"]',
              '[role="row"]',
              '[role="gridcell"]',
              'div[data-id]',
            ];
            let scelto = null, righe = [];
            for (const sel of candidati) {
              let trovate = [...elenco.querySelectorAll(sel)];

              // ── Solo le righe piu' esterne ──
              //
              // WhatsApp annida: una riga della lista ne contiene un'altra con
              // lo stesso ruolo. Prendendole tutte, ogni conversazione viene
              // contata due volte — il 7 agosto la prova dal vivo ha restituito
              // 198 righe per 68 conversazioni, con ogni nome ripetuto.
              //
              // Contare di piu' non e' contare meglio. Si tengono solo gli
              // elementi che non stanno dentro un altro elemento gia' preso.
              trovate = trovate.filter(el => !trovate.some(altro => altro !== el && altro.contains(el)));

              if (trovate.length > righe.length) { righe = trovate; scelto = sel; }
            }

            // Nessun candidato: si riporta com'e' fatto il contenitore, cosi'
            // la prossima mossa parte da un fatto invece che da un'ipotesi.
            if (!righe.length) {
              const campione = [...elenco.querySelectorAll('*')].slice(0, 400);
              const conteggio = {};
              for (const el of campione) {
                const chiave = el.getAttribute('role') ? 'role=' + el.getAttribute('role')
                  : el.getAttribute('data-testid') ? 'data-testid=' + el.getAttribute('data-testid')
                  : null;
                if (chiave) conteggio[chiave] = (conteggio[chiave] || 0) + 1;
              }
              return {
                ok: false,
                motivo: 'dentro #pane-side non riconosco le righe',
                figli: elenco.children.length,
                elementi: campione.length,
                cosaCeDentro: Object.entries(conteggio).sort((a, b) => b[1] - a[1]).slice(0, 12),
              };
            }

            // ── Nome, anteprima e ora: da dove si prendono davvero ──
            //
            // La prima versione leggeva riga.innerText e ne ricavava tutto.
            // Provata sulle chat vere di Luca il 7 agosto: nomi giusti, ma
            // anteprima e ora VUOTE per tutte e 64 le conversazioni. WhatsApp
            // mette quei testi in nodi che innerText non restituisce.
            //
            // Verificato sulla pagina: ogni riga ha due span[title] — il primo
            // e' il contatto, il secondo l'ultimo messaggio. L'ora sta in un
            // nodo a parte e si riconosce dalla forma.
            const chat = righe.map((riga) => {
              const titoli = [...riga.querySelectorAll('span[title], [title]')]
                .map(e => (e.getAttribute('title') || '').trim());
              const nome = titoli[0] || '';
              // Il carattere invisibile che WhatsApp mette attorno all'anteprima
              // (U+202A/U+202C, direzione del testo) va tolto o si porta dietro
              // caratteri che non si vedono ma sporcano i confronti.
              const anteprima = (titoli[1] || '').replace(/[‪-‮⁦-⁩]/g, '').slice(0, 160);

              let ora = '';
              for (const n of riga.querySelectorAll('div, span')) {
                const s = (n.textContent || '').trim();
                if (s.length < 12 && /^(\d{1,2}[:.]\d{2}|ieri|oggi|yesterday|today|\d{1,2}\/\d{1,2}\/\d{2,4}|luned|marted|mercoled|gioved|venerd|sabato|domenica)/i.test(s)) {
                  ora = s; break;
                }
              }

              let nonLetti = 0;
              for (const e of riga.querySelectorAll('[aria-label]')) {
                const m = (e.getAttribute('aria-label') || '').match(/(\d+)\s*(messagg|non lett|unread)/i);
                if (m) { nonLetti = parseInt(m[1], 10); break; }
              }

              return { nome, anteprima, ora, nonLetti };
            }).filter(c => c.nome);

            // Cintura e bretelle: se due righe diverse portano lo stesso nome,
            // per Luca sono la stessa conversazione. La struttura puo' cambiare
            // ancora; il fatto che un contatto sia uno solo, no.
            const visti = new Set();
            const unici = chat.filter(c => {
              if (visti.has(c.nome)) return false;
              visti.add(c.nome);
              return true;
            });

            return {
              ok: true,
              selettore: scelto,
              righeGuardate: righe.length,
              conNome: chat.length,
              conversazioni: unici.length,
              conNonLetti: unici.filter(c => c.nonLetti > 0).length,
              chat: unici.slice(0, quante),
            };
          },
        });
        return r[0].result;
  };

  comandi['whatsapp_non_letti'] = async function (args) {
        // ── I non letti sono una VISTA dell'elenco, non un'altra lettura ──
        //
        // Qui c'era Actions.readUnreadMessages(), il lettore del Navigator.
        // Misurato sul WhatsApp vero: circa 150 righe sbagliate, perche'
        // cercava role="row" su TUTTA la pagina e prendeva insieme le righe
        // della barra laterale e le bolle della conversazione aperta. Usciva
        // roba come contact:"We will do tomorrow" (un messaggio scambiato per
        // un contatto) e lastMessage:"wds-ic-read" (un'icona scambiata per un
        // messaggio).
        //
        // whatsapp_elenco_chat quel problema non ce l'ha: cerca DENTRO
        // #pane-side, dove le bolle non arrivano, e conta gia' i non letti riga
        // per riga. Il difetto non era il selettore, era il perimetro.
        //
        // Quindi non si scrive un secondo lettore: si filtra il primo. Una
        // implementazione sola, due viste — che e' anche il modo di non
        // ritrovarsi fra un mese con due letture che divergono.
        {
          const tutte = await executeCommand('whatsapp_elenco_chat',
            { quante: Number(args.quante) || 60 });
          if (!tutte || !tutte.ok) return tutte;
          const conNonLetti = (tutte.chat || []).filter(c => Number(c.nonLetti) > 0);
          return {
            ...tutte,
            chat: conNonLetti,
            conversazioni: conNonLetti.length,
            messaggiNonLetti: conNonLetti.reduce((n, c) => n + Number(c.nonLetti || 0), 0),
            suQuante: (tutte.chat || []).length,
          };
        }
  };

  // Duplicato di whatsapp_leggi_conversazione, che passa da Pagine e Mappa.

  comandi['whatsapp_conversazione'] = async function (args) {
        return await executeCommand('whatsapp_leggi_conversazione',
          { nome: args.contatto || args.nome, quanti: args.quanti || 30 });
  };

  // ── whatsapp_scrivi: rimosso, si passa da whatsapp_rispondi ──
  //
  // Delegava a sendWhatsAppMessage, che sceglie la scheda con
  // existingTabs[0]: la PRIMA scheda WhatsApp trovata. Luca ne tiene due
  // aperte. Quella prima scheda puo' essere il codice QR, una scheda
  // sospesa, o una chat diversa da quella giusta — e il messaggio parte
  // lo stesso. Non verifica chi c'e' dall'altra parte, non ha ritmo.
  //
  // whatsapp_rispondi apre la conversazione per nome, LEGGE il nome in
  // cima e se non riesce a leggerlo NON scrive. E' la stessa regola per
  // cui esiste questo progetto: meglio non mandare che mandare a uno
  // sconosciuto.

  // ── Con un NUMERO si va diritti alla chat ──
  //
  // L'8 agosto avevo chiuso questo comando, perche' delegava a
  // sendWhatsAppMessage che sceglie la scheda con existingTabs[0] — la PRIMA
  // scheda WhatsApp trovata, che puo' essere il codice QR o una chat diversa.
  // Era giusto chiuderlo cosi' com'era.
  //
  // Ma accesso.js lo chiama ancora quando il destinatario e' un NUMERO, e per
  // ore mandare un messaggio a un numero e' stato rotto senza che nessuno se
  // ne accorgesse: nessun test esegue il service worker. E' lo stesso difetto
  // che ho passato la giornata a curare, fatto da me.
  //
  // Con un numero non c'e' ambiguita' possibile: /send?phone= apre QUELLA
  // chat, e non serve verificare chi c'e' perche' il numero E' l'identita'.
  // Quindi la strada resta, ma passa da Pagine — che la scheda se la prepara
  // da sola invece di prendere la prima che trova.
  comandi['whatsapp_scrivi'] = async function (args) {
    const numero = String(args.a || args.numero || '').replace(/[^0-9+]/g, '').replace(/^\+/, '');
    const testo = String(args.testo || '');
    if (!numero || numero.length < 7) {
      return { ok: false, motivo: 'con un nome si passa da whatsapp_rispondi, che verifica il destinatario' };
    }
    if (!testo) return { ok: false, motivo: 'serve il testo' };

    const vai = `https://web.whatsapp.com/send?phone=${numero}&text=${encodeURIComponent(testo)}`;
    const _p = await globalThis.Pagine.preparaPagina('whatsapp_chat', { vai });
    if (!_p.ok) return _p;
    const viva = _p.scheda;

    if (globalThis.Ritmo) await globalThis.Ritmo.primaDiScrivere();
    await new Promise(r => setTimeout(r, 2500));

    const inviato = await chrome.scripting.executeScript({
      target: { tabId: viva.id },
      func: async () => {
        const attendi = (ms) => new Promise(r => setTimeout(r, ms));
        const siVede = (el) => {
          try {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const st = getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
          } catch (_) { return false; }
        };
        const nomeDi = (el) => (el.getAttribute('aria-label') || el.innerText || '').trim();
        // Il pulsante si cerca per significato, non per classe: le classi di
        // WhatsApp cambiano a ogni rilascio.
        const cerca = () => [...document.querySelectorAll('button, [role="button"]')]
          .filter(siVede).find(b => /^(invia|send)\b/i.test(nomeDi(b)));
        let b = cerca();
        for (let i = 0; i < 10 && !b; i++) { await attendi(700); b = cerca(); }
        if (!b) return { ok: false, motivo: 'la chat non si e\' aperta: non trovo il pulsante Invia' };
        b.click();
        await attendi(1500);
        return { ok: true };
      },
    });
    const e = inviato?.[0]?.result;
    if (!e || !e.ok) return e || { ok: false, motivo: 'la pagina non ha risposto' };
    return { ok: true, a: numero, conNumero: true };
  };

  comandi['whatsapp_diagnosi'] = async function (args) {
        return await Esterni.con('wa', (m) => m.Actions.diagnostic(), args.modo || 'automatico');
  };

  comandi['whatsapp_rispondi'] = async function (args) {
        const chi = String(args.nome || args.a || '').trim();
        const testo = String(args.testo || '');
        if (!chi || !testo) return { ok: false, motivo: 'servono il nome e il testo' };

        const _pw = await globalThis.Pagine.preparaPagina('whatsapp_chat');
        if (!_pw.ok) return _pw;
        const viva = _pw.scheda;

        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        // 1. Aprire la chat giusta, o fermarsi.
        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const pane = document.querySelector('#pane-side');
            if (!pane) return { ok: false, motivo: 'non trovo l\'elenco chat' };
            const righe = [...pane.querySelectorAll('[role="row"]')];
            const nomeDi = (r) => { const t = r.querySelector('span[title]'); return t ? (t.getAttribute('title') || '').trim() : ''; };
            let t = righe.filter(r => piatto(nomeDi(r)) === cerca);
            if (!t.length) t = righe.filter(r => piatto(nomeDi(r)).includes(cerca));
            if (!t.length) return { ok: false, motivo: `non trovo nessuna chat con "${chi}"`,
              disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 15) };
            if (t.length > 1) return { ok: false, ambiguo: true,
              motivo: `"${chi}" corrisponde a ${t.length} chat`, candidati: t.map(nomeDi) };

            const riga = t[0];
            const bersaglio = riga.querySelector('[data-testid="cell-frame-container"]')
              || riga.querySelector('[role="gridcell"]') || riga;
            const b = bersaglio.getBoundingClientRect();
            const x = b.left + b.width / 2, y = b.top + b.height / 2;
            // La sequenza intera: col solo click la chat non si apre.
            for (const tipo of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                                'pointerup', 'mouseup', 'click']) {
              const C = tipo.startsWith('pointer') ? PointerEvent : MouseEvent;
              bersaglio.dispatchEvent(new C(tipo, { bubbles: true, cancelable: true,
                composed: true, clientX: x, clientY: y, button: 0 }));
            }
            return { ok: true, aperta: nomeDi(riga) };
          },
        });
        const a = apri?.[0]?.result;
        if (!a || !a.ok) return a || { ok: false, motivo: 'la pagina non ha risposto' };

        await new Promise(r => setTimeout(r, 2500));
        if (globalThis.Ritmo) await globalThis.Ritmo.primaDiScrivere();

        // ── 2. Verificare CHI c'e' aperto, e fermarsi se non si riesce ──
        //
        // La prima versione cercava `#main header span[title]` e trovava
        // "Dettagli profilo" — l'etichetta del bottone che apre la scheda del
        // contatto. Il nome della persona nell'header di WhatsApp NON sta in un
        // attributo: sta nel testo.
        //
        // Il difetto era doppio, e il secondo peggiore del primo: trovando una
        // stringa qualsiasi il controllo la confrontava, non combaciava mai
        // davvero, ma la condizione `!chi` lo faceva passare lo stesso. Una rete
        // di sicurezza che restituisce sempre "vai" non e' una rete: e' una
        // decorazione. E sta sul percorso peggiore, quello dove un errore manda
        // un messaggio a uno sconosciuto.
        //
        // Adesso: si legge il nome dal testo, e se non si riesce a leggerlo NON
        // si scrive. Nel dubbio si perde un invio, non si sbaglia persona.
        const conferma = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [a.aperta],
          func: (atteso) => {
            const h = document.querySelector('#main header');
            if (!h) return { chi: null, perche: 'nessuna conversazione aperta' };

            // Il nome e' il primo testo utile: si scartano le etichette dei
            // bottoni e le righe di stato ("online", "sta scrivendo...").
            const scarta = /^(online|digitando|sta scrivendo|typing|click|clicca|dettagli|profil|ultimo accesso|last seen|tocca qui)/i;
            let chi = null;
            for (const n of h.querySelectorAll('span, div, h1, h2')) {
              if (n.querySelector('span, div, h1, h2')) continue;   // solo le foglie
              const t = (n.textContent || '').trim();
              if (!t || t.length > 80 || scarta.test(t)) continue;
              chi = t; break;
            }
            if (!chi) return { chi: null, perche: 'non riesco a leggere il nome in cima alla chat' };

            const piatto = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            return { chi, combacia: piatto(chi) === piatto(atteso) };
          },
        });
        const c = conferma?.[0]?.result;
        if (!c || !c.chi) {
          return { ok: false,
            motivo: c?.perche || 'non riesco a verificare quale chat e\' aperta',
            cosaFare: 'Non scrivo senza sapere a chi: nel dubbio si perde un invio, '
              + 'non si sbaglia persona. Riprova, o aprila tu e dimmelo.' };
        }
        if (!c.combacia) {
          return { ok: false,
            motivo: `ho chiesto "${a.aperta}" ma in cima alla chat vedo "${c.chi}": non scrivo`,
            cosaFare: 'La conversazione aperta non e\' quella giusta. Riferiscilo a Luca.' };
        }

        // 3. Scrivere e mandare.
        let selCasellaWa = 'footer [contenteditable="true"][data-tab]';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'casella_scrittura');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selCasellaWa = m.selettore;
        }

        const inviato = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [testo, a.aperta, selCasellaWa],
          func: async (testo, aperta, selCasella) => {
            const attesa = (ms) => new Promise(r => setTimeout(r, ms));
            const box = document.querySelector(selCasella)
              || document.querySelector('footer [contenteditable="true"][data-tab], footer [contenteditable="true"]');
            if (!box) return { ok: false, motivo: 'non trovo la casella di scrittura' };
            box.focus();

            // Svuotare e VERIFICARE: e' il difetto che ha fatto arrivare a Jose
            // "test cobratest cobratest cobra".
            let residuo = '';
            for (let i = 0; i < 3; i++) {
              try {
                const r = document.createRange(); r.selectNodeContents(box);
                const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
                document.execCommand('delete', false);
              } catch (e) { /* si riprova */ }
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
              try {
                box.textContent = '';
                box.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
              } catch (e) { /* ignore */ }
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
            }
            if (residuo) return { ok: false, motivo: 'casella_non_vuota', residuo: residuo.slice(0, 120) };

            // Uguale, non "contiene": la differenza che produceva i doppioni.
            const uguale = () => (box.innerText || '').trim() === testo.trim();
            for (let i = 0; i < testo.length && !uguale();) {
              const pezzo = 2 + Math.floor(Math.random() * 4);
              const parte = testo.slice(i, i + pezzo);
              try { document.execCommand('insertText', false, parte); } catch (e) { break; }
              i += pezzo;
              let pausa = 45 + Math.random() * 110;
              if (/[.,;:!?]\s*$/.test(parte)) pausa += 200 + Math.random() * 400;
              if (Math.random() < 0.07) pausa += 500 + Math.random() * 900;
              await attesa(pausa);
            }
            if (!uguale()) {
              try {
                const dt = new DataTransfer(); dt.setData('text/plain', testo);
                box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
              } catch (e) { /* ignore */ }
            }
            if (!uguale()) return { ok: false, motivo: 'non riesco a scrivere nella casella',
              dentro: (box.innerText || '').slice(0, 80) };

            await attesa(700 + Math.random() * 1600);
            const bottone = document.querySelector('[data-testid="send"], [aria-label*="Invia" i], [aria-label*="Send" i]');
            if (bottone) bottone.click();
            else {
              box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            }
            await attesa(1200);

            // La prova che e' partito: la casella si e' svuotata da sola.
            return (box.innerText || '').trim()
              ? { ok: false, motivo: 'ho premuto invio ma il testo e\' ancora nella casella' }
              : { ok: true, a: aperta, testo };
          },
        });
        return inviato?.[0]?.result || { ok: false, motivo: 'la pagina non ha risposto' };
  };

  comandi['whatsapp_leggi_conversazione'] = async function (args) {
        const chi = String(args.nome || args.contact || '').trim();
        if (!chi) return { ok: false, motivo: 'non mi hai detto quale chat' };

        const _pw = await globalThis.Pagine.preparaPagina('whatsapp_chat');
        if (!_pw.ok) return _pw;
        const viva = _pw.scheda;

        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const pane = document.querySelector('#pane-side');
            if (!pane) return { ok: false, motivo: 'non trovo l\'elenco chat' };

            const righe = [...pane.querySelectorAll('[role="row"]')];
            const nomeDi = (r) => {
              const t = r.querySelector('span[title]');
              return t ? (t.getAttribute('title') || '').trim() : '';
            };
            let t = righe.filter(r => piatto(nomeDi(r)) === cerca);
            if (!t.length) t = righe.filter(r => piatto(nomeDi(r)).includes(cerca));

            if (!t.length) {
              return { ok: false, motivo: `non trovo nessuna chat con "${chi}"`,
                disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 15) };
            }
            // Due omonimi: non si sceglie. Aprire la chat sbagliata la segna
            // come letta e fa riferire le parole di un altro.
            if (t.length > 1) {
              return { ok: false, ambiguo: true,
                motivo: `"${chi}" corrisponde a ${t.length} chat`,
                candidati: t.map(nomeDi) };
            }

            const riga = t[0];
            const bersaglio = riga.querySelector('[data-testid="cell-frame-container"]')
              || riga.querySelector('[role="gridcell"]') || riga;
            const b = bersaglio.getBoundingClientRect();
            const x = b.left + b.width / 2, y = b.top + b.height / 2;
            // La sequenza intera: col solo click la chat non si apre.
            for (const tipo of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                                'pointerup', 'mouseup', 'click']) {
              const C = tipo.startsWith('pointer') ? PointerEvent : MouseEvent;
              bersaglio.dispatchEvent(new C(tipo, {
                bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0,
              }));
            }
            return { ok: true, aperta: nomeDi(riga) };
          },
        });
        const a = apri?.[0]?.result;
        if (!a || !a.ok) return a || { ok: false, motivo: 'la pagina non ha risposto' };

        await new Promise(r => setTimeout(r, 2500));

        let selMsgWa = '[data-pre-plain-text]';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'messaggi');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selMsgWa = m.selettore;
        }

        const leggi = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [Number(args.quanti) || 40, a.aperta, selMsgWa],
          func: (quanti, aperta, selMsgWa) => {
            const main = document.querySelector('#main');
            if (!main) return { ok: false, motivo: 'la chat non si e\' aperta' };

            const nodi = [...main.querySelectorAll(selMsgWa)];
            if (!nodi.length) {
              return { ok: true, conversazione: aperta, quanti: 0, messaggi: [],
                nota: 'La chat e\' aperta ma non contiene messaggi di testo: '
                  + 'puo\' essere fatta solo di immagini, audio o allegati.' };
            }

            const messaggi = [];
            for (const n of nodi.slice(-quanti)) {
              const pre = n.getAttribute('data-pre-plain-text') || '';
              const m = pre.match(/^\[([^,\]]+),\s*([^\]]+)\]\s*(.*?):\s*$/);
              const t = n.querySelector('span.selectable-text, span[dir]') || n;
              const testo = (t.innerText || '').replace(/\s+/g, ' ').trim();
              if (!testo) continue;
              messaggi.push({
                da: m ? m[3] : '(sconosciuto)',
                quando: m ? `${m[1]} ${m[2]}` : '',
                testo,
              });
            }
            return { ok: true, conversazione: aperta, quanti: messaggi.length, messaggi,
              nota: 'Aprire la chat l\'ha segnata come letta su WhatsApp.' };
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

  const quanti = globalThis.Registro.area('whatsapp', comandi);
  console.log(`[COBRA] whatsapp: ${quanti} comandi registrati`);
})();
