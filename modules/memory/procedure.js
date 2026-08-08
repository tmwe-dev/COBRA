// modules/memory/procedure.js — Insegnare una procedura una volta sola.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// Ci sono cose che Luca fa ogni settimana e che hanno sempre la stessa forma:
// un preventivo UPS, il controllo delle spedizioni in ritardo su DHL, la
// verifica delle eccezioni. Ogni volta COBRA le riscopre da zero: apre il
// sito, cerca i campi, sbaglia una tendina, riprova.
//
// ── COSA REGISTRA, E COSA NO ──
//
// NON registra i gesti:
//
//     click x=320 y=450
//     type "MIL"
//     click x=512 y=610
//
// Quella è una macro, e una macro si rompe al primo cambio di layout — cioè
// alla prima settimana. Registra l'INTENZIONE:
//
//     obiettivo: ottenere un preventivo UPS
//     1. vai su ups.com/quote
//     2. nel campo che significa "origine"     scrivi {{partenza}}
//     3. nel campo che significa "destinazione" scrivi {{arrivo}}
//     4. nel campo che significa "peso"         scrivi {{peso}}
//     5. premi il pulsante che significa "calcola"
//     6. leggi il prezzo
//
// I passi puntano al SIGNIFICATO degli elementi, non alla loro posizione, e i
// valori sono buchi da riempire. È la stessa idea dello sguardo: si nomina
// quello che una cosa È, non dove sta.
//
// ── PERCHÉ È DIVERSO DA UN JOB ──
//
// Un job (`create_task`) è una sequenza di strumenti con argomenti fissi: fa
// sempre esattamente quella cosa. Una procedura è una FORMA con dei buchi:
// "preventivo UPS" vale per Milano-New York 25 kg e per Roma-Tokyo 3 kg.
//
// E non è un motore di stato: chi la esegue è l'Esecutore di sempre, con gli
// strumenti di sempre. Questa è solo la memoria di come si fa.
// ══════════════════════════════════════════════════════════════════════

const path = require('path');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

const MASSIME = 100;

/** I buchi in un testo: {{partenza}}, {{peso}}. */
function buchiIn(testo) {
  return [...new Set([...String(testo || '').matchAll(/\{\{\s*([a-zà-ù0-9_]+)\s*\}\}/gi)]
    .map(m => m[1].toLowerCase()))];
}

/** Riempie i buchi. Quelli che restano vuoti si segnalano, non si inventano. */
function riempi(testo, valori = {}) {
  const mancanti = [];
  const fuori = String(testo || '').replace(/\{\{\s*([a-zà-ù0-9_]+)\s*\}\}/gi, (_, nome) => {
    const k = nome.toLowerCase();
    const v = valori[k] !== undefined ? valori[k] : valori[nome];
    if (v === undefined || v === null || v === '') { mancanti.push(k); return `{{${k}}}`; }
    return String(v);
  });
  return { testo: fuori, mancanti: [...new Set(mancanti)] };
}

class Procedure {
  constructor(dataDir) {
    this.file = path.join(dataDir || './data', 'procedure.json');
    this.voci = readJsonSafeSync(this.file, []) || [];
    if (!Array.isArray(this.voci)) this.voci = [];
  }

  _salva() {
    try { writeJsonAtomicSync(this.file, this.voci); } catch (_) { /* non blocca il lavoro */ }
  }

  /**
   * Si registra una procedura.
   *
   * @param {string} nome     "preventivo UPS"
   * @param {string} quando   quando usarla, in una frase
   * @param {Array}  passi    [{ cosa, dove?, valore? }] — cosa fare, in ordine
   */
  registra(nome, { quando = '', passi = [], sito = '' } = {}) {
    const n = String(nome || '').trim();
    if (!n) return { ok: false, motivo: 'serve un nome' };
    if (!Array.isArray(passi) || !passi.length) return { ok: false, motivo: 'serve almeno un passo' };

    const parametri = [...new Set(passi.flatMap(p => [
      ...buchiIn(p.cosa), ...buchiIn(p.valore), ...buchiIn(p.dove),
    ]))];

    const voce = {
      nome: n,
      quando: String(quando || '').slice(0, 200),
      sito: String(sito || '').slice(0, 80),
      passi: passi.map((p, i) => ({
        n: i + 1,
        cosa: String(p.cosa || '').slice(0, 200),
        dove: p.dove ? String(p.dove).slice(0, 120) : undefined,
        valore: p.valore !== undefined ? String(p.valore).slice(0, 200) : undefined,
      })),
      parametri,
      creata: Date.now(),
      usata: 0,
      riuscite: 0,
    };

    const i = this.voci.findIndex(v => v.nome.toLowerCase() === n.toLowerCase());
    if (i >= 0) {
      // Si aggiorna, conservando quante volte è servita: quel numero dice se
      // vale la pena tenerla.
      voce.usata = this.voci[i].usata || 0;
      voce.riuscite = this.voci[i].riuscite || 0;
      voce.creata = this.voci[i].creata || voce.creata;
      this.voci[i] = voce;
    } else {
      this.voci.push(voce);
      if (this.voci.length > MASSIME) {
        this.voci.sort((a, b) => (b.usata - a.usata) || (b.creata - a.creata));
        this.voci = this.voci.slice(0, MASSIME);
      }
    }
    this._salva();
    return { ok: true, nome: n, passi: voce.passi.length, parametri };
  }

  /**
   * Le procedure che potrebbero servire per questa richiesta.
   *
   * Il NOME pesa più della descrizione. La prima versione li pesava uguale, e
   * "fammi un preventivo UPS Milano New York 25 kg" non riconosceva la
   * procedura "preventivo UPS": le parole del nome c'erano tutte, ma annegate
   * fra quelle del "quando" che nella richiesta non compaiono mai — nessuno
   * scrive "quando serve una quotazione" mentre la chiede.
   */
  simili(richiesta) {
    const parole = (x) => new Set(String(x || '').toLowerCase()
      .replace(/[^a-zà-ù0-9\s.]/g, ' ').split(/\s+/).filter(p => p.length > 2));
    const dentro = parole(richiesta);
    if (!dentro.size) return [];

    const quante = (testo) => {
      const p = [...parole(testo)];
      if (!p.length) return 0;
      return p.filter(x => dentro.has(x)).length / p.length;
    };

    return this.voci
      .map(v => ({
        v,
        // Il nome vale il triplo: è la cosa che una persona nomina davvero.
        punti: quante(v.nome) * 3 + quante(v.quando) + quante(v.sito),
      }))
      .filter(x => x.punti >= 1.2)
      .sort((a, b) => b.punti - a.punti)
      .map(x => x.v);
  }

  /**
   * La procedura pronta per essere eseguita, coi buchi riempiti.
   *
   * Se manca un valore NON si inventa: si dice quale manca. Un preventivo con
   * un peso inventato è peggio di nessun preventivo.
   */
  preparaPer(nome, valori = {}) {
    const v = this.voci.find(x => x.nome.toLowerCase() === String(nome || '').toLowerCase());
    if (!v) return { ok: false, motivo: `non conosco la procedura "${nome}"`,
      disponibili: this.voci.map(x => x.nome).slice(0, 10) };

    const mancanti = new Set();
    const passi = v.passi.map(p => {
      const c = riempi(p.cosa, valori); c.mancanti.forEach(m => mancanti.add(m));
      const d = riempi(p.dove || '', valori); d.mancanti.forEach(m => mancanti.add(m));
      const x = riempi(p.valore || '', valori); x.mancanti.forEach(m => mancanti.add(m));
      return { n: p.n, cosa: c.testo, dove: d.testo || undefined, valore: x.testo || undefined };
    });

    if (mancanti.size) {
      return { ok: false, serveSapere: [...mancanti], nome: v.nome,
        motivo: `per "${v.nome}" mi manca: ${[...mancanti].join(', ')}`,
        cosaFare: 'Chiedi a Luca questi valori, poi richiama la procedura. Non inventarli.' };
    }

    v.usata = (v.usata || 0) + 1;
    this._salva();
    return { ok: true, nome: v.nome, sito: v.sito, passi };
  }

  /** Com'è andata: serve a sapere se la procedura regge ancora. */
  esito(nome, riuscita) {
    const v = this.voci.find(x => x.nome.toLowerCase() === String(nome || '').toLowerCase());
    if (!v) return { ok: false };
    if (riuscita) v.riuscite = (v.riuscite || 0) + 1;
    this._salva();
    // Una procedura che fallisce più di quanto riesce è peggio di niente:
    // manda l'Esecutore su una strada che non c'è più.
    const affidabile = !v.usata || (v.riuscite / v.usata) >= 0.5;
    return { ok: true, usata: v.usata, riuscite: v.riuscite, affidabile };
  }

  /** Il blocco per il prompt, quando una procedura calza. */
  perIlPrompt(richiesta) {
    const trovate = this.simili(richiesta);
    if (!trovate.length) return '';
    const v = trovate[0];
    const righe = [`# QUESTA COSA L'HAI GIÀ FATTA: "${v.nome}"`];
    if (v.quando) righe.push(v.quando);
    righe.push('Segui questi passi invece di riscoprirli:');
    for (const p of v.passi) {
      righe.push(`  ${p.n}. ${p.cosa}`
        + (p.dove ? ` — nel campo che significa "${p.dove}"` : '')
        + (p.valore ? ` = ${p.valore}` : ''));
    }
    if (v.parametri.length) righe.push(`Ti servono: ${v.parametri.join(', ')}.`);
    if (v.usata) {
      righe.push(`Usata ${v.usata} volte, riuscita ${v.riuscite || 0}.`
        + (v.usata >= 3 && (v.riuscite || 0) / v.usata < 0.5
          ? ' ATTENZIONE: ultimamente fallisce più di quanto riesce — se non torna, il sito è cambiato: guarda la pagina e aggiorna la procedura.'
          : ''));
    }
    return righe.join('\n');
  }

  elenco() {
    return this.voci.map(v => ({ nome: v.nome, passi: v.passi.length,
      parametri: v.parametri, usata: v.usata, riuscite: v.riuscite, sito: v.sito }));
  }
}

module.exports = { Procedure, buchiIn, riempi };
