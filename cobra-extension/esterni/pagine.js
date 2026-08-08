// esterni/pagine.js — Portarsi sulla pagina giusta, da soli.
//
// PERCHÉ ESISTE
//
// Ogni comando si cercava la scheda per conto suo. Cinque implementazioni
// della stessa cosa, ognuna sbagliata a modo suo:
//
//   linkedin_elenco_chat        cercava /messaging/, e se non c'era la apriva
//   linkedin_leggi_conversazione cercava /messaging/, e se non c'era si arrendeva
//   linkedin_rispondi            idem — e il modello "rimediava" navigando sulla
//                                ricerca profili, spostando la scheda dove il
//                                tentativo dopo non l'avrebbe trovata. Tre giri
//                                a vuoto e il messaggio mai partito.
//   whatsapp_elenco_chat         prendeva la prima scheda "complete", che poteva
//                                essere ferma sul QR
//   whatsapp_leggi_conversazione guardava dentro le schede, ma non le svegliava
//
// Ogni volta che ne correggevo una, le altre restavano com'erano. Non è
// distrazione: è che la stessa decisione era scritta in cinque punti, e
// aggiornarne uno non aggiorna gli altri.
//
// Qui la decisione è scritta UNA volta.
//
// COSA GARANTISCE
//
// `preparaPagina(scopo)` restituisce una scheda su cui si può lavorare
// SUBITO, oppure dice perché non è stato possibile. Per arrivarci fa, in
// quest'ordine e fermandosi al primo che riesce:
//
//   1. una scheda già sulla pagina giusta, con dentro quello che serve
//   2. una scheda sulla pagina giusta ma addormentata → la sveglia
//   3. una scheda sullo stesso sito ma altrove → NON la dirotta: apre una
//      scheda nuova in secondo piano. Portare via a Luca la pagina che sta
//      guardando è un prezzo che non ha chiesto di pagare.
//   4. niente del sito → lo dice, perché lì serve che entri lui
//
// E prima di restituirla CONTROLLA che la pagina contenga davvero quello che
// serve. Una pagina caricata non è una pagina pronta: LinkedIn risponde
// "complete" molto prima di aver disegnato le conversazioni, e leggere in
// quel momento significa concludere "non hai messaggi".

var Pagine = globalThis.Pagine || (function () {

  // Cosa serve, dove sta, e come si riconosce che c'è davvero.
  //
  // `conferma` gira dentro la pagina e deve tornare true solo quando la roba
  // è a schermo. Non "il documento è pronto": la roba.
  const SCOPI = {
    linkedin_messaggi: {
      cosa: 'la messaggistica di LinkedIn',
      sito: 'https://www.linkedin.com/*',
      pagina: 'https://www.linkedin.com/messaging/*',
      vai: 'https://www.linkedin.com/messaging/',
      conferma: () => document.querySelectorAll(
        'li.msg-conversation-listitem, .msg-conversations-container__convo-item').length > 0,
      seNonCe: 'Apri LinkedIn in una scheda e fai l\'accesso.',
    },
    // Un profilo preciso: l'indirizzo cambia ogni volta, quindi `vai` e
    // `pagina` arrivano da chi chiama (preparaPagina(scopo, {vai})).
    linkedin_profilo: {
      cosa: 'un profilo LinkedIn',
      sito: 'https://www.linkedin.com/*',
      pagina: 'https://www.linkedin.com/in/*',
      vai: 'https://www.linkedin.com/',
      conferma: () => !!document.querySelector('h1') && /\/in\//.test(location.pathname),
      seNonCe: 'Apri LinkedIn in una scheda e fai l\'accesso.',
    },
    whatsapp_chat: {
      cosa: 'l\'elenco chat di WhatsApp',
      sito: 'https://web.whatsapp.com/*',
      pagina: 'https://web.whatsapp.com/*',
      vai: 'https://web.whatsapp.com/',
      conferma: () => {
        const p = document.querySelector('#pane-side');
        return !!p && p.querySelectorAll('[role="row"], [data-testid="cell-frame-container"]').length > 0;
      },
      seNonCe: 'Apri web.whatsapp.com: se mostra il QR, inquadralo dal telefono '
        + '(WhatsApp > Dispositivi collegati).',
    },
  };

  /** La pagina contiene quello che serve? */
  async function _pronta(tabId, conferma) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func: conferma });
      return !!r?.[0]?.result;
    } catch (_) {
      // Tipico di una scheda che Chrome ha scaricato: l'errore parla di
      // permessi, ma i permessi ci sono. Chi chiama la sveglia e riprova.
      return false;
    }
  }

  /** Aspetta che la pagina finisca di disegnarsi. */
  async function _aspettaChePronta(tabId, conferma, secondi = 15) {
    for (let i = 0; i < secondi * 2; i++) {
      if (await _pronta(tabId, conferma)) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  async function _sveglia(scheda) {
    try {
      const t = await chrome.tabs.get(scheda.id);
      if (t.status !== 'unloaded' && !t.discarded) return t;
      await chrome.tabs.reload(t.id);
      return await chrome.tabs.get(t.id);
    } catch (_) { return scheda; }
  }

  /**
   * Una scheda pronta per lo scopo chiesto.
   *
   * @returns {{ok:true, scheda, come}} oppure {{ok:false, motivo, cosaFare}}
   */
  async function preparaPagina(nomeScopo, opzioni = {}) {
    const base = SCOPI[nomeScopo];
    if (!base) return { ok: false, motivo: `scopo sconosciuto: ${nomeScopo}` };

    // Quando lo scopo riguarda UNA pagina precisa — il profilo di Brandon, non
    // "un profilo" — chi chiama passa l'indirizzo, e da quello si ricava anche
    // il modello con cui riconoscere una scheda gia' aperta su quella pagina.
    const S = opzioni && opzioni.vai
      ? { ...base, vai: opzioni.vai, pagina: String(opzioni.vai).split('?')[0].replace(/\/$/, '') + '*' }
      : base;

    const provate = [];

    // 1-2. Schede già sulla pagina giusta.
    const suPagina = await chrome.tabs.query({ url: S.pagina });
    for (const s of suPagina) {
      if (await _pronta(s.id, S.conferma)) {
        return { ok: true, scheda: s, come: 'era gia\' aperta e pronta' };
      }
      provate.push({ id: s.id, url: s.url, esito: 'non pronta, provo a svegliarla' });
      const sv = await _sveglia(s);
      if (await _aspettaChePronta(sv.id, S.conferma, 12)) {
        return { ok: true, scheda: sv, come: 'era addormentata, l\'ho svegliata' };
      }
      provate[provate.length - 1].esito = 'svegliata ma resta vuota';
    }

    // 3. Il sito c'è ma siamo altrove: si apre una scheda nuova, in secondo
    //    piano. Non si dirotta quella che Luca sta guardando.
    const sulSito = await chrome.tabs.query({ url: S.sito });
    if (sulSito.length) {
      let nuova;
      try {
        nuova = await chrome.tabs.create({ url: S.vai, active: false });
      } catch (e) {
        return { ok: false, motivo: `non riesco ad aprire ${S.cosa}: ${e.message}` };
      }
      if (await _aspettaChePronta(nuova.id, S.conferma, 20)) {
        return { ok: true, scheda: nuova, come: 'l\'ho aperta io: eri su un\'altra pagina', apertaDaMe: true };
      }
      // Non ha funzionato: si richiude invece di lasciarne in giro una a ogni
      // tentativo fallito.
      try { await chrome.tabs.remove(nuova.id); } catch (_) {}
      return {
        ok: false,
        motivo: `ho aperto ${S.cosa} ma non si e' caricata`,
        cosaFare: S.seNonCe,
        schedeProvate: provate,
      };
    }

    // 4. Il sito non è aperto da nessuna parte: serve una persona.
    return {
      ok: false,
      motivo: `${S.cosa} non e' raggiungibile: il sito non e' aperto in nessuna scheda`,
      cosaFare: S.seNonCe,
      NON_FARE: 'NON navigare e NON cercare la pagina per conto tuo: se sposti una '
        + 'scheda, il tentativo dopo non la trova piu\'. Riferisci questo motivo e basta.',
      schedeProvate: provate,
    };
  }

  return { SCOPI, preparaPagina };
})();

globalThis.Pagine = Pagine;
