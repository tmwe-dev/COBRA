// cobra-extension/esterni/comandi/diagnosi.js — Guardare come sta il sistema.
//
// Spostato da background.js senza modifiche. Servono a rispondere a "perche'
// non ha funzionato" con un fatto invece che con un'ipotesi — ed e' la
// domanda che l'8 agosto e' rimasta senza risposta per sei ore.

(function () {
  'use strict';

  const comandi = {};

  // ── Come stanno WhatsApp e LinkedIn, per il badge in alto ──
  //
  // COMPLETAMENTE PASSIVO. Questo comando non tocca le pagine, non inietta
  // niente, non manda una sola richiesta di rete. Se WhatsApp e LinkedIn
  // fossero due persone che ci guardano, da qui non vedrebbero nulla.
  //
  // Il primo tentativo non era cosi': leggevo il DOM ogni venti secondi.
  // Nessuna richiesta di rete, d'accordo, ma comunque uno script iniettato
  // in continuazione in una pagina che non me lo aveva chiesto — per
  // accendere una spia. Luca ha avuto ragione a fermarmi: "meno grave"
  // non e' "zero", e su una spia decorativa il costo giusto e' zero.
  //
  // Da dove viene l'informazione, adesso:
  //
  //   1. chrome.tabs.query — dice se la scheda esiste e se e' caricata.
  //      E' l'elenco che Chrome tiene per conto suo: leggerlo non tocca
  //      nessun sito.
  //
  //   2. chrome.cookies — per LinkedIn c'e' il cookie `li_at`, che esiste
  //      solo se la sessione e' aperta. Chrome ce l'ha gia' sul disco:
  //      leggerlo e' come guardare in tasca, non come bussare alla porta.
  //
  //   3. La MEMORIA dell'ultima operazione vera. Quando COBRA fa davvero
  //      qualcosa — legge le chat, verifica la sessione — l'esito resta
  //      registrato. Il badge mostra quello, e dice quanto e' vecchio.
  //
  // WhatsApp non ha un cookie che dica "sei dentro" (la sessione vive in
  // IndexedDB, che senza toccare la pagina non si legge). Quindi per
  // WhatsApp il badge si fida della memoria, e se e' vecchia lo dichiara
  // invece di fingere di sapere. Dire "verificato venti minuti fa" e'
  // piu' onesto che dire "collegato" senza aver guardato.

  comandi['stato_canali'] = async function (args) {
        const schede = await chrome.tabs.query({});
        const ricordo = (await chrome.storage.local.get(['cobra_canali'])).cobra_canali || {};

        const cerca = (regex) => {
          const t = schede.filter(x => regex.test(x.url || ''));
          if (!t.length) return { scheda: false, caricata: false };
          const viva = t.find(x => x.status === 'complete');
          return { scheda: true, caricata: !!viva, quante: t.length,
            titolo: (viva || t[0]).title || '' };
        };

        const eta = (quando) => {
          if (!quando) return null;
          const m = Math.round((Date.now() - quando) / 60000);
          if (m < 1) return 'adesso';
          if (m < 60) return `${m} minuti fa`;
          const o = Math.round(m / 60);
          return o < 24 ? `${o} ore fa` : `${Math.round(o / 24)} giorni fa`;
        };

        // ── LinkedIn: il cookie dice la verita' senza chiedere niente ──
        const li = cerca(/linkedin\.com/i);
        let liDentro = null;
        try {
          const c = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
          liDentro = !!(c && c.value);
        } catch (_) { liDentro = null; }

        const linkedin = {
          scheda: li.scheda,
          connesso: liDentro === true,
          perche: liDentro === true ? null
            : liDentro === false ? 'sessione non attiva: devi entrare tu'
            : li.scheda ? 'non riesco a leggere lo stato della sessione'
            : 'nessuna scheda aperta',
          come: 'cookie di sessione — nessun contatto con LinkedIn',
          ultimoLavoro: eta(ricordo.li?.quando),
        };

        // ── WhatsApp: memoria, piu' quello che dice la scheda ──
        //
        // Il titolo della scheda e' l'unica cosa che WhatsApp scrive fuori
        // dalla pagina: diventa "(3) WhatsApp" quando ci sono non letti. Non
        // dice se sei dentro, ma dice che l'applicazione sta girando.
        const wa = cerca(/web\.whatsapp\.com/i);
        const nonLetti = (wa.titolo.match(/^\((\d+)\)/) || [])[1];
        const memoriaWa = ricordo.wa || {};
        const recente = memoriaWa.quando && (Date.now() - memoriaWa.quando) < 30 * 60000;

        const whatsapp = {
          scheda: wa.scheda,
          connesso: !!(wa.caricata && (recente ? memoriaWa.dentro : nonLetti !== undefined)),
          perche: !wa.scheda ? 'nessuna scheda aperta'
            : !wa.caricata ? 'scheda scaricata da Chrome'
            : recente ? (memoriaWa.dentro ? null : (memoriaWa.perche || 'non risultavi dentro'))
            : nonLetti !== undefined ? null
            : 'non verifico da un po\': lo sapro\' al prossimo lavoro',
          nonLetti: nonLetti ? Number(nonLetti) : null,
          come: recente ? 'ultimo lavoro vero' : 'titolo della scheda — nessun contatto con WhatsApp',
          ultimoLavoro: eta(memoriaWa.quando),
        };

        return { whatsapp, linkedin, passivo: true };
  };

  // ── "La pagina e' cambiata?" ──
  //
  // Domanda di Luca, 7 agosto: se il DOM cambia, COBRA se ne deve
  // accorgere. Giusto, e prima non se ne accorgeva: un selettore che non
  // trova niente restituisce una lista vuota, e "lista vuota" diventava
  // "non hai messaggi" — detto serenamente a chi ne aveva otto.
  //
  // Questo comando prova tutti i selettori su entrambi i siti e dice
  // quali reggono, quali stanno andando di riserva e quali sono morti.
  // Legge soltanto: non apre, non clicca, non manda niente.
  // ── Cosa ha imparato la mappa ──

  comandi['mappa_pagine'] = async function (args) {
        if (!globalThis.Mappa) return { ok: false, motivo: 'mappa.js non caricato' };
        return await globalThis.Mappa.quelloCheSo();
  };

  // Dimentica quello che sa: il prossimo uso riparte guardando la pagina.
  // Serve quando si vuole forzare una riscoperta senza aspettare un guasto.

  comandi['mappa_dimentica'] = async function (args) {
        if (!globalThis.Mappa) return { ok: false, motivo: 'mappa.js non caricato' };
        return await globalThis.Mappa.dimentica(args.pagina || null);
  };

  comandi['diagnosi_selettori'] = async function (args) {
        if (!globalThis.Selettori) return { ok: false, motivo: 'selettori.js non caricato' };
        return await globalThis.Selettori.diagnosi();
  };

  comandi['stato_ritmo'] = async function (args) {
        return globalThis.Ritmo ? await globalThis.Ritmo.stato() : { errore: 'ritmo non caricato' };
  };

  // ── Come sono messi i permessi del browser ──
  //
  // Non riporta cosa abbiamo tentato di impostare: CHIEDE a Chrome com'e'
  // adesso. Un modulo che si autocertifica non e' una verifica.
  comandi['stato_permessi'] = async function (args) {
        if (!globalThis.Permessi) {
          return { ok: false, motivo: 'permessi.js non caricato nel service worker',
            cosaFare: 'Ricarica l\'estensione da chrome://extensions' };
        }
        const s = await globalThis.Permessi.stato(args && args.url);
        return { ok: !!s.tuttoAPosto, ...s };
  };

  comandi['stato_moduli_esterni'] = async function (args) {
        return Esterni.stato();
  };

  // ════════════════════════════════════════
  // STATO DELLA PAGINA — si chiede, non si indovina
  // ════════════════════════════════════════
  //
  // Contare i secondi e' indovinare. Una pagina sa dire da sola se ha
  // finito di caricare, se sta ancora scaricando dati, e se c'e' qualcosa
  // che copre il contenuto. Questi sono fatti, non stime.
  //
  // Un ostacolo si riconosce da COSA FA, non da come si chiama: un
  // elemento che sta davanti a tutto, copre mezzo schermo e blocca lo
  // scorrimento e' un ostacolo, che sia un banner cookie, una newsletter,
  // un invito a scaricare l'app o un avviso di eta'.

  comandi['stato_pagina'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
          const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
          const areaSchermo = Math.max(vw * vh, 1);

          // Un ostacolo e' qualcosa che sta sopra e copre. Si guarda la
          // posizione, non il nome della classe.
          const ostacoli = [];
          const visti = new Set();
          for (const el of document.querySelectorAll('div,section,aside,dialog,iframe')) {
            if (visti.has(el)) continue;
            let st;
            try { st = getComputedStyle(el); } catch (_) { continue; }
            const fisso = st.position === 'fixed' || st.position === 'sticky';
            const modale = el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG';
            if (!fisso && !modale) continue;
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') < 0.05) continue;
            const r = el.getBoundingClientRect();
            const copertura = (r.width * r.height) / areaSchermo;
            if (copertura < 0.12) continue;                 // troppo piccolo per bloccare
            if (r.bottom < 0 || r.top > vh) continue;       // fuori schermo
            const z = parseInt(st.zIndex, 10) || 0;
            // Le barre di navigazione sono fisse ma non bloccano: si distingue
            // per la copertura e per la presenza di pulsanti di chiusura.
            const testo = (el.innerText || '').trim().substring(0, 200);
            ostacoli.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || '', classe: String(el.className || '').substring(0, 60),
              copertura: Math.round(copertura * 100), z,
              modale, testo,
            });
            visti.add(el);
          }

          // Lo scorrimento bloccato e' il segno piu' affidabile di un modale
          const corpo = getComputedStyle(document.body);
          const scorrimentoBloccato = corpo.overflow === 'hidden' || corpo.position === 'fixed'
            || getComputedStyle(document.documentElement).overflow === 'hidden';

          const testo = (document.body.innerText || '').trim();
          return {
            ok: true,
            pronta: document.readyState === 'complete',
            statoDocumento: document.readyState,
            caratteri: testo.length,
            // La pagina dichiara lei stessa di stare lavorando
            dichiaraAttesa: /caricamento|sto cercando|loading|searching|please wait|ricerca in corso|attendere/i.test(testo.substring(0, 3000)),
            ostacoli,
            scorrimentoBloccato,
            bloccata: ostacoli.length > 0 || scorrimentoBloccato,
            titolo: document.title,
          };
        });
  };

  comandi['get_action_log'] = async function (args) {
        return { ok: true, log: actionLog.slice(-(args.limit || 50)) };
  };

  comandi['clear_action_log'] = async function (args) {
        actionLog.length = 0;
        return { ok: true };
  };

  const quanti = globalThis.Registro.area('diagnosi', comandi);
  console.log(`[COBRA] diagnosi: ${quanti} comandi registrati`);
})();
