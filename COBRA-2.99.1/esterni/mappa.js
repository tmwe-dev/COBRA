// esterni/mappa.js — La mappa delle pagine: si impara una volta, si riusa
// sempre, si rifà quando cambia.
//
// L'IDEA
//
// Un selettore scritto a mano è una fotografia: giusta il giorno che l'hai
// scattata. WhatsApp e LinkedIn cambiano il DOM senza preavviso, e ogni volta
// qualcuno deve accorgersene e riscrivere.
//
// Qui si rovescia. La prima volta che COBRA visita una pagina la GUARDA:
// cerca, con criteri strutturali, dove sono le cose che gli servono — l'elenco
// delle conversazioni, il nome nella riga, i messaggi, la casella dove si
// scrive. Quello che trova se lo scrive. Le volte dopo non guarda più: usa
// quello che sa, e ci mette un millisecondo.
//
// Quando un selettore imparato smette di funzionare, non è un errore da
// riferire: è il segnale che la pagina è cambiata. Si riguarda, si impara di
// nuovo, si aggiorna, e il lavoro prosegue. Luca se ne accorge solo perché
// quella volta ci ha messo un secondo invece di zero.
//
// COME FA A CAPIRE DOVE SONO LE COSE
//
// Non a caso e non per nome: per struttura. Un elenco di conversazioni è
// l'unico posto della pagina dove c'è un elemento ripetuto molte volte, tutti
// fratelli, tutti con dentro del testo e alti tra i 50 e i 120 pixel. Una
// casella di scrittura è un contenteditable visibile in fondo. Un pulsante di
// invio è un bottone accanto alla casella.
//
// Questi criteri sopravvivono a un cambio di classi CSS, che è il modo in cui
// queste pagine cambiano il 90% delle volte. Non sopravvivono a una
// riprogettazione vera — ma quella la si vede, perché la diagnosi la dichiara.
//
// COSA NON FA
//
// Non impara a CLICCARE cose che non ha capito. Impara DOVE sono gli elementi
// che gli servono, che è un'altra cosa. Su una pagina dove si mandano messaggi
// veri, indovinare un bersaglio è un lusso che non ci si può permettere.

var Mappa = globalThis.Mappa || (function () {

  const CHIAVE = 'cobra_mappa_pagine_v1';

  // I ruoli: cosa serve trovare, e come si riconosce. `candidati` sono le
  // scorciatoie note (velocissime, si provano per prime); `comeSiRiconosce`
  // è il criterio strutturale che entra in gioco quando i candidati falliscono.
  const RUOLI = {
    elenco_conversazioni: {
      cosa: 'l\'elenco delle conversazioni',
      candidati: ['li.msg-conversation-listitem', '[data-testid="cell-frame-container"]',
                  '[role="row"]', '.msg-conversations-container__convo-item', '[role="listitem"]'],
      strategia: 'ripetuto',
      minimo: 3,
    },
    nome_nella_riga: {
      cosa: 'il nome del contatto dentro una riga',
      candidati: ['span[title]', '.msg-conversation-listitem__participant-names', 'h3', '[title]'],
      strategia: 'dentroRiga',
      minimo: 1,
    },
    messaggi: {
      cosa: 'i messaggi di una conversazione aperta',
      candidati: ['[data-pre-plain-text]', '.msg-s-event-listitem', '.copyable-text',
                  'li.msg-s-message-list__event'],
      strategia: 'ripetuto',
      minimo: 1,
    },
    casella_scrittura: {
      cosa: 'la casella dove si scrive',
      candidati: ['.msg-form__contenteditable', 'footer [contenteditable="true"]',
                  'div[contenteditable="true"][role="textbox"]'],
      strategia: 'scrivibile',
      minimo: 1,
      // "una casella di testo che invita a scrivere un messaggio": vale su
      // WhatsApp, su LinkedIn e su una chat che non abbiamo mai visto.
      significato: { ruolo: 'textbox', nome: /messagg|message|scrivi|write|type a|aa$/i },
    },
    pulsante_invia: {
      cosa: 'il pulsante per mandare',
      candidati: ['.msg-form__send-button', 'button[aria-label*="Invia" i]',
                  'button[aria-label*="Send" i]', '[data-testid="send"]'],
      strategia: 'bottoneInvio',
      minimo: 1,
      // Come si riconosce se i candidati non reggono: per significato.
      // "Un bottone che si chiama Invia" e' una descrizione che sopravvive a
      // qualunque cambio di classi, e vale su un sito mai visto.
      significato: { ruolo: 'button', nome: /^(invia|send|manda|inviare)$/i },
    },
    nome_conversazione_aperta: {
      cosa: 'il nome della persona con cui e\' aperta la conversazione',
      candidati: ['.msg-entity-lockup__entity-title', '.msg-title-bar h2',
                  '[class*="entity-title"]'],
      strategia: 'intestazione',
      minimo: 1,
      dove: null,
    },
  };

  /** La chiave con cui si ricorda una pagina: sito + sezione, non l'URL intero. */
  function chiavePagina(url) {
    try {
      const u = new URL(url);
      // Il numero della conversazione cambia a ogni chat: tenerlo dentro
      // vorrebbe dire imparare da capo per ogni contatto.
      const sezione = u.pathname.split('/').filter(Boolean).slice(0, 1).join('/') || 'home';
      return `${u.hostname}/${sezione}`;
    } catch (_) { return String(url || 'sconosciuta'); }
  }

  async function _leggiTutto() {
    try {
      const d = await chrome.storage.local.get([CHIAVE]);
      return d[CHIAVE] || {};
    } catch (_) { return {}; }
  }

  async function _scriviTutto(m) {
    try { await chrome.storage.local.set({ [CHIAVE]: m }); } catch (_) { /* best-effort */ }
  }

  // ── La scoperta, che gira DENTRO la pagina ──
  //
  // Riceve tutto per argomento: viene serializzata e iniettata, non può
  // chiudere su niente di esterno.
  function _scopriNellaPagina(ruoli, ruoloCercato) {
    const R = ruoli[ruoloCercato];
    if (!R) return { ok: false, motivo: 'ruolo sconosciuto' };

    const visibile = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // Un selettore stabile per un elemento: si preferisce ciò che ha un nome
    // pensato da una persona (data-testid, role, classi con trattini) e si
    // scartano le classi generate tipo x1n2onr6.
    const firma = (el) => {
      if (el.getAttribute && el.getAttribute('data-testid')) {
        return `[data-testid="${el.getAttribute('data-testid')}"]`;
      }
      const classi = (el.className && typeof el.className === 'string')
        ? el.className.split(/\s+/).filter(c => c.length > 6 && /[a-z]-[a-z]/.test(c) && !/^x[0-9a-z]{6,}$/.test(c))
        : [];
      if (classi.length) return el.tagName.toLowerCase() + '.' + classi[0];
      if (el.getAttribute && el.getAttribute('role')) return `[role="${el.getAttribute('role')}"]`;
      return null;
    };

    // 1. Le scorciatoie note: velocissime, si provano per prime.
    for (const sel of R.candidati) {
      try {
        const n = document.querySelectorAll(sel);
        if (n.length >= R.minimo && [...n].some(visibile)) {
          return { ok: true, selettore: sel, trovati: n.length, come: 'candidato noto' };
        }
      } catch (_) { /* selettore non valido su questa pagina */ }
    }

    // 2. Nessuna scorciatoia regge: si guarda la struttura.
    if (R.strategia === 'ripetuto') {
      // Un elenco è un gruppo di fratelli uguali. Si contano le firme dei
      // figli di ogni contenitore e si tiene quella che si ripete di più con
      // una forma da riga: alta il giusto, larga, con del testo dentro.
      const punteggi = new Map();
      const tutti = document.querySelectorAll('div, li, section, ul');
      for (const cont of tutti) {
        const figli = [...cont.children];
        if (figli.length < R.minimo) continue;
        const conteggio = new Map();
        for (const f of figli) {
          const s = firma(f);
          if (!s) continue;
          conteggio.set(s, (conteggio.get(s) || 0) + 1);
        }
        for (const [s, quanti] of conteggio) {
          if (quanti < R.minimo) continue;
          const campione = cont.querySelector(':scope > ' + s);
          if (!campione || !visibile(campione)) continue;
          const r = campione.getBoundingClientRect();
          const testo = (campione.innerText || '').trim();
          if (!testo) continue;
          // Una riga di elenco: più larga che alta, non minuscola, non enorme.
          const formaGiusta = r.height >= 30 && r.height <= 200 && r.width >= 120;
          const punti = quanti * (formaGiusta ? 3 : 1);
          const chiave = s;
          if (!punteggi.has(chiave) || punteggi.get(chiave).punti < punti) {
            punteggi.set(chiave, { punti, quanti, selettore: s });
          }
        }
      }
      const migliore = [...punteggi.values()].sort((a, b) => b.punti - a.punti)[0];
      if (migliore) {
        return { ok: true, selettore: migliore.selettore, trovati: migliore.quanti,
          come: 'scoperto dalla struttura: e\' l\'elemento ripetuto piu\' volte con la forma di una riga' };
      }
    }

    if (R.strategia === 'dentroRiga') {
      // Il nome sta in un elemento con `title` (WhatsApp) o in un'intestazione
      // (LinkedIn). Si cerca il primo che compaia in quasi tutte le righe.
      for (const sel of ['span[title]', '[title]', 'h3', 'h4', 'strong']) {
        try {
          const n = document.querySelectorAll(sel);
          if (n.length >= R.minimo) {
            return { ok: true, selettore: sel, trovati: n.length, come: 'primo elemento che porta un nome' };
          }
        } catch (_) { /* avanti */ }
      }
    }

    if (R.strategia === 'scrivibile') {
      const caselle = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(visibile);
      if (caselle.length) {
        // Se ce n'è più d'una, quella in basso è la casella di scrittura:
        // le altre sono barre di ricerca.
        caselle.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        const s = firma(caselle[0]) || '[contenteditable="true"]';
        return { ok: true, selettore: s, trovati: caselle.length,
          come: 'la casella scrivibile piu\' in basso: le altre sono ricerche' };
      }
    }

    if (R.strategia === 'bottoneInvio') {
      const bottoni = [...document.querySelectorAll('button, [role="button"]')].filter(visibile);
      const invio = bottoni.find(b => /invia|send/i.test(
        (b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')));
      if (invio) {
        const s = firma(invio) || 'button[aria-label*="Invia" i]';
        return { ok: true, selettore: s, trovati: 1, come: 'bottone che dice Invia o Send' };
      }
    }

    if (R.strategia === 'intestazione') {
      // Il nome della persona in cima a una conversazione aperta. Su LinkedIn
      // e' in chiaro in un elemento con un nome parlante; su WhatsApp NON e'
      // in un attributo — sta nel testo dell'header, e l'unico [title] li'
      // dentro dice "Dettagli profilo", che e' l'etichetta di un bottone.
      //
      // Verificato sulle pagine vere il 7 agosto, dopo aver scoperto che il
      // controllo "sto scrivendo alla persona giusta?" leggeva proprio quella
      // etichetta e quindi non controllava niente.
      const testa = document.querySelector('#main header')
        || document.querySelector('.msg-title-bar')
        || document.querySelector('[class*="msg-thread"] header');
      if (testa) {
        const scarta = /^(online|digitando|sta scrivendo|typing|click|clicca|dettagli|profil|ultimo accesso|last seen|tocca qui|stato:)/i;
        for (const n of testa.querySelectorAll('span, div, h1, h2')) {
          if (n.querySelector('span, div, h1, h2')) continue;
          const t = (n.textContent || '').trim();
          if (!t || t.length > 80 || scarta.test(t)) continue;
          return { ok: true, selettore: '__TESTO_INTESTAZIONE__', trovati: 1, testo: t,
            come: 'primo testo utile in cima alla conversazione (scartate le etichette dei bottoni)' };
        }
      }
    }

    // ── L'ultima spiaggia: il SIGNIFICATO ──
    //
    // Se i candidati non reggono e la struttura non basta, si cerca come
    // cercherebbe una persona: non "l'elemento con questa classe" ma "il
    // bottone che si chiama Invia", "il campo etichettato Messaggio".
    //
    // E' il modo di ragionare di Claude in Chrome, e il motivo per cui
    // funziona su siti che nessuno ha programmato: ruolo + nome accessibile
    // sopravvivono a qualunque riscrittura del CSS.
    //
    // Qui il ruolo e il nome si ricavano dal DOM (role, aria-label, label
    // collegata, placeholder, testo) invece che dal protocollo di Chrome:
    // stessa informazione, senza attaccare l'ispettore alla pagina.
    if (R.significato) {
      const nomeDi = (el) => (
        el.getAttribute('aria-label')
        || (el.labels && el.labels[0] && el.labels[0].textContent)
        || el.getAttribute('placeholder')
        || el.getAttribute('title')
        || el.innerText
        || ''
      ).replace(/\s+/g, ' ').trim();

      const ruoloDi = (el) => {
        const r = el.getAttribute('role');
        if (r) return r;
        const tag = el.tagName.toLowerCase();
        if (tag === 'button' || (tag === 'input' && /^(submit|button)$/i.test(el.type))) return 'button';
        if (tag === 'a' && el.getAttribute('href')) return 'link';
        if (tag === 'textarea' || (tag === 'input' && !/^(hidden|submit|button)$/i.test(el.type))) return 'textbox';
        if (el.getAttribute('contenteditable') === 'true') return 'textbox';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        return null;
      };

      for (const el of document.querySelectorAll('*')) {
        if (!visibile(el)) continue;
        if (ruoloDi(el) !== R.significato.ruolo) continue;
        if (R.significato.nome && !R.significato.nome.test(nomeDi(el))) continue;
        const s = firma(el);
        if (s) {
          return { ok: true, selettore: s, trovati: 1,
            come: `riconosciuto dal significato: ${R.significato.ruolo} che si chiama "${nomeDi(el).slice(0, 30)}"` };
        }
      }
    }

    // 3. Niente. Si riporta cosa C'È, così il prossimo tentativo parte da un
    //    dato invece che da un'ipotesi.
    const conteggio = {};
    for (const el of [...document.querySelectorAll('*')].slice(0, 4000)) {
      const s = firma(el);
      if (s) conteggio[s] = (conteggio[s] || 0) + 1;
    }
    return {
      ok: false,
      motivo: `non trovo ${R.cosa}`,
      cosaCeDentro: Object.entries(conteggio).sort((a, b) => b[1] - a[1]).slice(0, 15),
    };
  }

  /** Verifica al volo che un selettore imparato funzioni ancora. */
  async function _reggeAncora(tabId, selettore, minimo) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId }, args: [selettore, minimo],
        func: (sel, min) => {
          try {
            const n = document.querySelectorAll(sel);
            if (n.length < min) return false;
            return [...n].some(e => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
          } catch (_) { return false; }
        },
      });
      return !!r?.[0]?.result;
    } catch (_) { return false; }
  }

  /**
   * Il selettore per un ruolo su questa pagina.
   *
   * Primo giro: guarda, impara, scrive. Giri successivi: legge quello che sa e
   * lo verifica in un millisecondo. Se non regge più — cioè se il DOM è
   * cambiato — riguarda da capo e aggiorna, senza far fallire il lavoro.
   *
   * @returns {{ok, selettore?, come?, riscoperto?, motivo?, cosaCeDentro?}}
   */
  async function selettorePer(tabId, url, ruolo) {
    const chiave = chiavePagina(url);
    const mappa = await _leggiTutto();
    const pagina = mappa[chiave] || { chiave, scoperta: Date.now(), ruoli: {} };
    const noto = pagina.ruoli[ruolo];

    // Già imparato: si controlla che regga ancora. Costa un millisecondo, e
    // risparmia l'intera scansione.
    if (noto && noto.selettore) {
      if (await _reggeAncora(tabId, noto.selettore, RUOLI[ruolo].minimo)) {
        noto.usato = (noto.usato || 0) + 1;
        noto.ultimoUso = Date.now();
        mappa[chiave] = pagina;
        await _scriviTutto(mappa);
        return { ok: true, selettore: noto.selettore, come: 'gia\' noto', dallaMemoria: true };
      }
      // Non regge più: il DOM è cambiato. Non è un errore da riferire, è il
      // momento di rimparare.
      pagina.ruoli[ruolo] = { ...noto, rotto: true, rottoIl: Date.now() };
    }

    const r = await chrome.scripting.executeScript({
      target: { tabId }, args: [RUOLI, ruolo], func: _scopriNellaPagina,
    });
    const esito = r?.[0]?.result || { ok: false, motivo: 'la pagina non ha risposto' };

    if (esito.ok) {
      const eraRotto = !!(noto && noto.selettore && noto.selettore !== esito.selettore);
      pagina.ruoli[ruolo] = {
        selettore: esito.selettore,
        come: esito.come,
        imparatoIl: Date.now(),
        usato: 1,
        ultimoUso: Date.now(),
        precedente: eraRotto ? noto.selettore : (noto ? noto.precedente : null),
      };
      pagina.aggiornata = Date.now();
      mappa[chiave] = pagina;
      await _scriviTutto(mappa);
      return { ok: true, selettore: esito.selettore, come: esito.come,
        riscoperto: eraRotto || !!noto,
        prima: eraRotto ? noto.selettore : undefined };
    }

    pagina.ruoli[ruolo] = { ...(noto || {}), rotto: true, rottoIl: Date.now(),
      cosaCeDentro: esito.cosaCeDentro };
    mappa[chiave] = pagina;
    await _scriviTutto(mappa);
    return esito;
  }

  /** Cosa ha imparato finora, in chiaro. */
  async function quelloCheSo() {
    const m = await _leggiTutto();
    const pagine = Object.values(m).map(p => ({
      pagina: p.chiave,
      imparataIl: p.scoperta ? new Date(p.scoperta).toISOString() : null,
      aggiornataIl: p.aggiornata ? new Date(p.aggiornata).toISOString() : null,
      ruoli: Object.entries(p.ruoli || {}).map(([nome, r]) => ({
        ruolo: nome,
        selettore: r.selettore || null,
        come: r.come || null,
        usatoVolte: r.usato || 0,
        rotto: !!r.rotto,
        prima: r.precedente || null,
      })),
    }));
    return {
      quantePagine: pagine.length,
      pagine,
      nota: pagine.length
        ? 'Questi selettori sono stati imparati guardando le pagine, non scritti a mano. '
          + 'Se una pagina cambia, il primo uso dopo il cambio li riscopre da solo.'
        : 'Non ho ancora visitato nessuna pagina: la mappa si riempie al primo uso.',
    };
  }

  /** Dimentica tutto, o una pagina sola. Il prossimo uso riparte guardando. */
  async function dimentica(pagina = null) {
    if (!pagina) { await _scriviTutto({}); return { ok: true, cancellate: 'tutte' }; }
    const m = await _leggiTutto();
    const chiavi = Object.keys(m).filter(k => k.includes(pagina));
    for (const k of chiavi) delete m[k];
    await _scriviTutto(m);
    return { ok: true, cancellate: chiavi };
  }

  return { RUOLI, chiavePagina, selettorePer, quelloCheSo, dimentica };
})();

globalThis.Mappa = Mappa;
