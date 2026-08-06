// modules/fonti/registro.js — Il registro delle fonti: dove cercare, imparato
// dall'esperienza e non riscoperto ogni volta.
//
// IL PROBLEMA CHE RISOLVE
//
// Il 5 agosto 2026 è servita mezza giornata per scoprire che Kayak, Momondo e
// Skyscanner rispondono "0 risultati" alle ricerche costruite via URL, mentre
// Google Voli risponde con i dati. Quella scoperta è costata decine di
// navigazioni a vuoto — e il giorno dopo sarebbe andata persa, perché non
// veniva scritta da nessuna parte.
//
// Qui ogni lettura lascia una traccia: dominio, esito, quanti caratteri sono
// arrivati. Alla decima volta che kayak.it dà zero, il registro lo sa, e lo
// dice PRIMA che si perda tempo a riprovarci.
//
// COME LAVORA
//
//   1. Ogni navigate registra l'esito: piena / vuota / bloccata.
//   2. Prima di un incarico, il registro dice cosa si sa già delle fonti.
//   3. Quello che non si sa ancora si scopre con la ricognizione (fase 0
//      dell'incarico) e da quel momento resta scritto.
//
// Il registro giudica i FATTI (quante volte ha risposto, con quanto), non le
// reputazioni: un sito famoso che risponde vuoto è una fonte cattiva.

const path = require('path');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

const SOGLIA_PIENA = 800;   // sotto, la pagina è arrivata ma senza sostanza

class RegistroFonti {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'registro_fonti.json');
    this.fonti = readJsonSafeSync(this.file, {}) || {};
    this._sporco = false;
  }

  _salva() {
    if (!this._sporco) return;
    writeJsonAtomicSync(this.file, this.fonti);
    this._sporco = false;
  }

  /**
   * Una lettura è avvenuta: si registra com'è andata.
   * @param {string} url
   * @param {object} esito { caratteri, bloccata, guasto }
   */
  registra(url, { caratteri = 0, bloccata = false, guasto = false, dati } = {}) {
    let dominio;
    try { dominio = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
    const f = this.fonti[dominio] || { piene: 0, vuote: 0, bloccate: 0, guaste: 0, caratteriTotali: 0 };

    // Il volume non è utilità: Trivago aperto sulla homepage ha reso 12.000
    // caratteri di risultati su PALERMO per una ricerca su Tokyo, e contava
    // come fonte buona. Una lettura è "piena" solo se lunga E con dati dentro
    // (prezzi, orari, numeri): chi chiama lo dichiara con "dati".
    const utile = caratteri >= SOGLIA_PIENA && dati !== false;
    if (guasto) f.guaste++;
    else if (bloccata) f.bloccate++;
    else if (utile) { f.piene++; f.caratteriTotali += caratteri; }
    else f.vuote++;

    f.ultimaVolta = new Date().toISOString();
    this.fonti[dominio] = f;
    this._sporco = true;
    this._salva();
  }

  /** Cosa si sa di un dominio. */
  giudizio(dominio) {
    const f = this.fonti[dominio];
    if (!f) return { nota: false };
    const tentativi = f.piene + f.vuote + f.bloccate + f.guaste;
    if (tentativi < 2) return { nota: false };   // un caso solo non è esperienza
    const resa = f.piene / tentativi;
    return {
      nota: true,
      tentativi,
      resa,
      verdetto: resa >= 0.6 ? 'affidabile' : resa >= 0.25 ? 'incerta' : 'da_evitare',
      mediaCaratteri: f.piene ? Math.round(f.caratteriTotali / f.piene) : 0,
    };
  }

  /** Le fonti che l'esperienza dice buone e quelle che dice sprecate. */
  bilancio() {
    const buone = [], cattive = [];
    for (const [dominio, f] of Object.entries(this.fonti)) {
      const g = this.giudizio(dominio);
      if (!g.nota) continue;
      if (g.verdetto === 'affidabile') buone.push({ dominio, ...g });
      if (g.verdetto === 'da_evitare') cattive.push({ dominio, ...g });
    }
    buone.sort((a, b) => b.resa - a.resa || b.tentativi - a.tentativi);
    cattive.sort((a, b) => b.tentativi - a.tentativi);
    return { buone, cattive };
  }

  /**
   * Il blocco per il prompt: quello che l'esperienza ha già insegnato,
   * perché non venga riscoperto a spese del tempo di Luca.
   */
  perIlPrompt() {
    const { buone, cattive } = this.bilancio();
    if (buone.length === 0 && cattive.length === 0) return '';
    const righe = ['# FONTI: QUELLO CHE L\'ESPERIENZA HA GIÀ INSEGNATO'];
    if (buone.length) {
      righe.push('\nHanno risposto con dati veri (usale per prime):');
      for (const b of buone.slice(0, 10)) {
        righe.push(`- ${b.dominio} — ${b.tentativi} letture, risponde ${Math.round(b.resa * 100)}% delle volte`);
      }
    }
    if (cattive.length) {
      righe.push('\nHanno fatto perdere tempo (aprile solo se non c\'è altro, e dillo):');
      for (const c of cattive.slice(0, 10)) {
        righe.push(`- ${c.dominio} — ${c.tentativi} letture, quasi sempre vuote o bloccate`);
      }
    }
    righe.push('\nQuesto elenco nasce dalle letture fatte davvero, non da opinioni. '
      + 'Se una fonte non è in elenco, nessuno l\'ha ancora provata: la ricognizione serve a questo.');
    return righe.join('\n');
  }
}

module.exports = { RegistroFonti, SOGLIA_PIENA };
