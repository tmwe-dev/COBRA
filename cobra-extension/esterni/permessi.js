// esterni/permessi.js — I popup del browser non si cliccano: si decidono prima.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Quando un sito chiede la posizione, Chrome mostra una bolla sopra la barra
// degli indirizzi. Quella bolla NON e' nella pagina: non sta nel DOM, quindi
// `guarda_pagina` non la vede, `agisci` non la puo' premere, e uno screenshot
// del contenuto non la contiene. Finche' resta li', il sito aspetta.
//
// E' l'ostacolo peggiore che ci sia: COBRA e' cieco e fermo insieme, e dal
// registro sembra soltanto che una pagina "non abbia caricato".
//
// ── COSA C'ERA PRIMA, E PERCHE' NON BASTAVA ──
//
// In `schede.js`, dentro `navigate`, si iniettava uno script che sostituiva
// `navigator.geolocation.getCurrentPosition` con un rifiuto. Due buchi:
//
//   1. partiva DOPO `waitForTabLoad`, cioe' a pagina gia' caricata. Skyscanner,
//      Booking e Kayak la posizione la chiedono DURANTE il caricamento: quando
//      arrivava la patch, la bolla era gia' sullo schermo.
//   2. viveva solo in quel documento. Un redirect, o la SPA che si ridisegna
//      dopo "Cerca", e l'override spariva.
//
// ── COSA SI FA ADESSO ──
//
// `chrome.contentSettings` decide una volta per tutte, a livello di BROWSER,
// prima ancora che una pagina si apra. Nessuna bolla puo' comparire, e non
// dipende da quando parte uno script.
//
// ── PERCHE' LA POSIZIONE SI CONCEDE, E VERA ──
//
// La prima versione di questo file rispondeva ai siti con le coordinate di
// Milano, cucite nel codice. Luca l'ha fermata, e aveva ragione: una posizione
// scritta a mano e' una bugia che regge finche' non ti muovi. Il giorno che
// lavora da Madrid, o che serve una tariffa per un cliente altrove, il sito
// risponde su Milano e nessuno capisce perche'.
//
// `allow` da' al sito la posizione VERA, quella che Chrome gia' conosce.
// Niente bolla, niente finzione, e i prezzi che arrivano sono quelli giusti
// per dove si trova davvero.
//
// Notifiche, microfono e telecamera invece si bloccano: non servono a
// lavorare, e la loro bolla e' un ostacolo identico.
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  /**
   * Cosa si decide, e perche' proprio cosi'.
   *
   * Il valore non e' un'opinione: e' la risposta a "questa cosa serve per
   * lavorare?". La posizione serve — i siti di viaggio ci calcolano sopra
   * valuta, lingua e aeroporto di partenza. Le altre tre no.
   */
  const REGOLE = {
    location:      { setting: 'allow', perche: 'i siti di viaggio ci calcolano valuta, lingua e aeroporto: negarla li fa sbagliare' },
    notifications: { setting: 'block', perche: 'non servono a lavorare e la bolla blocca la pagina' },
    camera:        { setting: 'block', perche: 'non serve, e non si concede una telecamera senza che lo decida una persona' },
    microphone:    { setting: 'block', perche: 'come sopra' },
  };

  /**
   * La decisione, applicata al browser.
   *
   * Si prova voce per voce e si va avanti: non tutte le versioni di Chrome
   * espongono tutte le voci, e una che manca non deve impedire le altre.
   */
  async function avvia() {
    if (!chrome.contentSettings) {
      console.warn('[COBRA permessi] chrome.contentSettings non disponibile: '
        + 'manca il permesso "contentSettings" nel manifest, oppure l\'estensione va ricaricata.');
      return { ok: false, motivo: 'contentSettings non disponibile' };
    }

    const fatte = [];
    const saltate = [];
    for (const [voce, regola] of Object.entries(REGOLE)) {
      try {
        await chrome.contentSettings[voce].set({
          primaryPattern: '<all_urls>',
          setting: regola.setting,
        });
        fatte.push(`${voce}=${regola.setting}`);
      } catch (e) {
        saltate.push(`${voce} (${e.message})`);
      }
    }

    console.log(`[COBRA permessi] ${fatte.join(' · ')}`
      + (saltate.length ? ` — non riuscite: ${saltate.join(', ')}` : ''));
    return { ok: fatte.length > 0, fatte, saltate };
  }

  /**
   * Com'e' messo davvero, chiesto al browser.
   *
   * Non si riporta cosa abbiamo TENTATO di impostare: si legge cosa risulta
   * adesso. Un modulo che si autocertifica non e' una verifica — e' la
   * lezione del campo `capabilities`, che esisteva da una parte sola.
   */
  async function stato(url = 'https://www.skyscanner.it/') {
    if (!chrome.contentSettings) return { disponibile: false };
    const fuori = { disponibile: true, url, voci: {} };
    for (const [voce, regola] of Object.entries(REGOLE)) {
      try {
        const d = await chrome.contentSettings[voce].get({ primaryUrl: url });
        fuori.voci[voce] = { adesso: d && d.setting, atteso: regola.setting,
          giusto: !!d && d.setting === regola.setting, perche: regola.perche };
      } catch (e) {
        fuori.voci[voce] = { errore: e.message, atteso: regola.setting };
      }
    }
    fuori.tuttoAPosto = Object.values(fuori.voci).every((v) => v.giusto);
    return fuori;
  }

  globalThis.Permessi = { avvia, stato, REGOLE };

  // Si parte da soli. Un modulo che aspetta di essere chiamato e' un modulo
  // che un giorno nessuno chiama: e' successo otto volte questa settimana.
  avvia().catch((e) => console.warn('[COBRA permessi] avvio:', e.message));
})();
