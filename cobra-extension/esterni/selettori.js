// esterni/selettori.js — Dove sono le cose nella pagina, e cosa fare quando
// non ci sono più.
//
// PERCHÉ ESISTE
//
// Tutto quello che COBRA fa su WhatsApp e LinkedIn passa da selettori CSS.
// È l'unico modo — nessuna delle due espone un'API a chi guarda dal browser —
// ma è un modo fragile, e vale la pena essere precisi su quanto.
//
// Le classi di WhatsApp oggi sono `x1n2onr6 xscbp6u`: generate da un
// compilatore, non scritte da una persona. Cambiano quando cambia il codice,
// senza preavviso e senza motivo visibile. LinkedIn è più stabile —
// `msg-conversation-listitem` è un nome pensato — ma ha riscritto la
// messaggistica due volte in tre anni.
//
// Quindi la domanda non è SE si romperà, è cosa succede QUANDO si rompe.
//
// COSA SUCCEDEVA PRIMA
//
// Un selettore che non trova niente restituisce una lista vuota. Senza
// controlli, "lista vuota" diventa "nessun messaggio" — e COBRA riferiva
// serenamente "non hai messaggi non letti" a un uomo che ne aveva otto.
// È il guasto peggiore possibile: silenzioso, e indistinguibile dalla verità.
//
// COSA SUCCEDE ADESSO
//
//   1. Ogni cosa da trovare ha PIÙ candidati, in ordine di preferenza. Se il
//      primo non c'è si prova il secondo: spesso un cambio di interfaccia ne
//      lascia in piedi uno.
//   2. Ogni gruppo dichiara quanti elementi si aspetta di trovare come
//      minimo. Zero dove ne servono molti non è un risultato: è un guasto.
//   3. Quando falliscono tutti, non si torna "vuoto": si torna un guasto
//      dichiarato, con dentro cosa c'è davvero nella pagina — così la volta
//      dopo il selettore nuovo si scrive guardando i dati, non indovinando.
//   4. `diagnosi_selettori` li prova tutti in una volta, senza toccare niente.
//      È il modo per accorgersene PRIMA che serva.

var Selettori = globalThis.Selettori || (function () {

  // ── Cosa cercare, in ordine di preferenza ──
  //
  // `dove` è il contenitore: cercare dentro il posto giusto è metà del lavoro.
  // Il lettore del Navigator sbagliava proprio qui — cercava `role="row"` in
  // tutta la pagina e prendeva le bolle della conversazione aperta al posto
  // dei contatti.
  const GRUPPI = {
    wa_elenco: {
      sito: 'whatsapp',
      cosa: 'l\'elenco delle chat',
      dove: '#pane-side',
      candidati: ['[data-testid="cell-frame-container"]', '[role="row"]', '[role="listitem"]'],
      minimo: 1,
    },
    wa_nome: {
      sito: 'whatsapp',
      cosa: 'il nome del contatto in una riga',
      dove: '#pane-side [role="row"]',
      candidati: ['span[title]', '[title]'],
      minimo: 1,
    },
    wa_messaggi: {
      sito: 'whatsapp',
      cosa: 'i messaggi di una chat aperta',
      dove: '#main',
      candidati: ['[data-pre-plain-text]', '.copyable-text', 'div[data-id]'],
      minimo: 0,   // una chat può essere davvero vuota, o fatta solo di immagini
      soloSeAperta: true,
    },
    li_elenco: {
      sito: 'linkedin',
      cosa: 'l\'elenco delle conversazioni',
      dove: null,
      candidati: ['li.msg-conversation-listitem', '.msg-conversations-container__convo-item',
                  'ul.msg-conversations-container__conversations-list > li'],
      minimo: 1,
    },
    li_nome: {
      sito: 'linkedin',
      cosa: 'il nome nella riga della conversazione',
      dove: 'li.msg-conversation-listitem',
      candidati: ['.msg-conversation-listitem__participant-names', 'h3'],
      minimo: 1,
    },
    li_messaggi: {
      sito: 'linkedin',
      cosa: 'i messaggi di una conversazione aperta',
      dove: null,
      candidati: ['.msg-s-event-listitem', 'li.msg-s-message-list__event', '.msg-s-event-with-indicator'],
      minimo: 0,
      soloSeAperta: true,
    },
    li_casella: {
      sito: 'linkedin',
      cosa: 'la casella dove si scrive',
      dove: null,
      candidati: ['.msg-form__contenteditable', 'div[contenteditable="true"][role="textbox"]'],
      minimo: 0,
      soloSeAperta: true,
    },
  };

  // ── La funzione che gira DENTRO la pagina ──
  //
  // Va passata a executeScript, quindi non può chiudere su niente di esterno:
  // riceve tutto per argomento. È il motivo per cui i gruppi vengono
  // serializzati e non usati per riferimento.
  function _provaNellaPagina(gruppi, soloSito) {
    const esiti = {};
    for (const [nome, g] of Object.entries(gruppi)) {
      if (soloSito && g.sito !== soloSito) continue;

      let radice = document;
      if (g.dove) {
        radice = document.querySelector(g.dove);
        if (!radice) {
          esiti[nome] = {
            ok: false, cosa: g.cosa,
            motivo: `non trovo il contenitore "${g.dove}"`,
            saltato: !!g.soloSeAperta,
          };
          continue;
        }
      }

      let vincitore = null, quanti = 0;
      const provati = [];
      for (const sel of g.candidati) {
        let n = 0;
        try { n = radice.querySelectorAll(sel).length; } catch (e) { n = -1; }
        provati.push({ selettore: sel, trovati: n });
        if (n > 0 && n >= g.minimo) { vincitore = sel; quanti = n; break; }
      }

      if (vincitore) {
        esiti[nome] = {
          ok: true, cosa: g.cosa, selettore: vincitore, trovati: quanti,
          // Se ha vinto un candidato di riserva, l'interfaccia È cambiata:
          // funziona ancora, ma vale la pena saperlo prima che caschi anche
          // quello.
          diRiserva: vincitore !== g.candidati[0],
        };
      } else {
        // Nessuno ha funzionato. Invece di dire solo "non trovo", si guarda
        // cosa C'È: la prossima volta il selettore giusto si scrive leggendo
        // questo elenco, non tirando a indovinare. È così che ho trovato
        // [data-testid="cell-frame-container"] quando [role="listitem"] ha
        // smesso di esistere.
        const conteggio = {};
        try {
          const campione = [...radice.querySelectorAll('*')].slice(0, 4000);
          for (const el of campione) {
            const chiavi = [];
            if (el.getAttribute('role')) chiavi.push(`[role="${el.getAttribute('role')}"]`);
            if (el.getAttribute('data-testid')) chiavi.push(`[data-testid="${el.getAttribute('data-testid')}"]`);
            for (const c of (el.className && typeof el.className === 'string' ? el.className.split(/\s+/) : [])) {
              // Le classi generate (x1n2onr6) non servono a nessuno: si
              // tengono solo quelle con un nome pensato da una persona.
              if (c.length > 6 && /[a-z]-[a-z]/.test(c)) chiavi.push('.' + c);
            }
            for (const k of chiavi) conteggio[k] = (conteggio[k] || 0) + 1;
          }
        } catch (e) { /* meglio senza campione che senza risposta */ }

        esiti[nome] = {
          ok: false, cosa: g.cosa,
          motivo: g.soloSeAperta
            ? 'nessuna conversazione aperta in questo momento'
            : 'NESSUN selettore funziona: la pagina e\' cambiata',
          saltato: !!g.soloSeAperta,
          provati,
          cosaCeDentro: Object.entries(conteggio).sort((a, b) => b[1] - a[1]).slice(0, 15),
        };
      }
    }
    return esiti;
  }

  /**
   * Prova tutti i gruppi di un sito su una scheda. Non tocca niente: legge.
   */
  async function controlla(tabId, sito) {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      args: [GRUPPI, sito],
      func: _provaNellaPagina,
    });
    return r?.[0]?.result || {};
  }

  /**
   * Il quadro completo: WhatsApp e LinkedIn, con un verdetto in cima.
   */
  async function diagnosi() {
    const esito = { quando: new Date().toISOString(), siti: {} };

    for (const [sito, filtro] of [['whatsapp', 'https://web.whatsapp.com/*'],
                                  ['linkedin', 'https://www.linkedin.com/*']]) {
      const schede = await chrome.tabs.query({ url: filtro });
      if (!schede.length) {
        esito.siti[sito] = { aperto: false, nota: 'nessuna scheda aperta: non posso controllare' };
        continue;
      }
      let risultato = null;
      for (const s of schede) {
        try {
          const r = await controlla(s.id, sito);
          // Si tiene la scheda che ha trovato più roba: le altre possono
          // essere ferme sul QR o su una pagina diversa.
          const buoni = Object.values(r).filter(x => x.ok).length;
          if (!risultato || buoni > risultato.buoni) risultato = { r, buoni, url: s.url };
        } catch (e) { /* si prova la prossima */ }
      }
      esito.siti[sito] = risultato
        ? { aperto: true, url: risultato.url, gruppi: risultato.r }
        : { aperto: true, nota: 'non sono riuscito a leggere nessuna scheda' };
    }

    // ── Il verdetto ──
    const rotti = [];
    const traballanti = [];
    for (const [sito, d] of Object.entries(esito.siti)) {
      for (const [nome, g] of Object.entries(d.gruppi || {})) {
        if (!g.ok && !g.saltato) rotti.push(`${sito}: ${g.cosa}`);
        else if (g.ok && g.diRiserva) traballanti.push(`${sito}: ${g.cosa} (uso un selettore di riserva)`);
      }
    }
    esito.rotti = rotti;
    esito.traballanti = traballanti;
    esito.ok = rotti.length === 0;
    esito.verdetto = rotti.length
      ? `LA PAGINA E' CAMBIATA: ${rotti.length} cose non le trovo piu' — ${rotti.join('; ')}. `
        + 'Guarda "cosaCeDentro" nei gruppi rotti: dice cosa c\'e\' adesso al posto loro.'
      : traballanti.length
        ? `Funziona, ma con selettori di riserva: ${traballanti.join('; ')}. `
          + 'L\'interfaccia si e\' mossa: conviene aggiornare i selettori prima che caschi anche questo.'
        : 'Tutti i selettori funzionano.';

    return esito;
  }

  return { GRUPPI, controlla, diagnosi };
})();

globalThis.Selettori = Selettori;
