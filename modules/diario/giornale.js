// modules/diario/giornale.js — Il registro di cosa e' successo davvero.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Fino al 9 agosto, di 880 chiamate a strumenti e 67 fallimenti, si sapeva:
// il nome, gli argomenti, e `ok: false`. Nient'altro. Non la durata, non il
// motivo, non quale passo di quale lavoro, non cosa e' stato deciso dopo.
//
// Ogni guasto andava quindi ricostruito per indizi, incrociando quattro file,
// e ogni ricostruzione costava una sessione intera. Nel frattempo si
// continuava a costruire sopra. Non e' l'incapacita' di riparare che ci ha
// fatto girare in tondo: e' l'incapacita' di VEDERE.
//
// ── COSA C'E' DENTRO ──
//
// Una riga per esecuzione, in fondo, mai riscritta:
//
//   quando · lavoro · passo · capacita' · dove · argomenti (accorciati)
//   esito · code · famiglia · motivo · durata · tentativo · prossima mossa
//
// Da queste righe si rispondono, senza aprire un file di codice:
//   - quale strumento fallisce sempre, e sempre allo stesso modo
//   - quale sito blocca cosa
//   - se un fix ha funzionato davvero (si guarda prima e dopo)
//   - dove se ne va il tempo
//
// ── DUE REGOLE ──
//
// 1. Non blocca mai. Se scrivere fallisce, il lavoro continua: un diario che
//    ferma il paziente non e' un diario.
// 2. Non contiene segreti. Gli argomenti passano da una potatura che toglie
//    password, chiavi e testi dei messaggi. Un registro che nessuno puo'
//    mostrare e' un registro che nessuno guarda.
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const NOME = 'diario.jsonl';
const MASSIMO_BYTE = 20 * 1024 * 1024;   // oltre, si mette da parte e si riparte

/** Le chiavi che non entrano mai nel diario, per nessun motivo. */
const MAI = /^(password|pass|pwd|token|api_key|apikey|secret|chiave|authorization|cookie)$/i;

/** Le chiavi il cui contenuto e' roba di persone: si tiene la misura, non il testo. */
const SOLO_MISURA = /^(testo|text|message|messaggio|body|corpo|contenuto|content|note)$/i;

/**
 * Gli argomenti, ridotti a quello che serve per capire cosa e' stato tentato.
 *
 * Non e' pudore: e' che un diario pieno di testi di messaggi diventa illeggibile
 * in tre giorni, e impossibile da mostrare a chiunque.
 */
function potaArgomenti(args) {
  if (!args || typeof args !== 'object') return {};
  const fuori = {};
  for (const [k, v] of Object.entries(args)) {
    if (MAI.test(k)) { fuori[k] = '‹nascosto›'; continue; }
    if (SOLO_MISURA.test(k)) { fuori[k] = `‹${String(v == null ? '' : v).length} caratteri›`; continue; }
    if (v == null) { fuori[k] = null; continue; }
    if (typeof v === 'object') { fuori[k] = `‹${Array.isArray(v) ? v.length + ' voci' : 'oggetto'}›`; continue; }
    const s = String(v);
    fuori[k] = s.length > 120 ? s.slice(0, 120) + '…' : s;
  }
  return fuori;
}

class Giornale {
  constructor(cartellaDati) {
    this.percorso = path.join(cartellaDati || './data', NOME);
    this._rotto = false;          // se scrivere non riesce, si smette di provarci ogni riga
    this._scritte = 0;
  }

  _ruotaSeGrosso() {
    try {
      const s = fs.statSync(this.percorso);
      if (s.size > MASSIMO_BYTE) fs.renameSync(this.percorso, this.percorso + '.1');
    } catch (_) { /* non esiste ancora: va bene cosi' */ }
  }

  /**
   * Registra un'esecuzione.
   *
   * @param {object} v
   * @param {string} v.capacita   il nome dello strumento
   * @param {object} v.argomenti
   * @param {object} v.esito      quello che torna da tassonomia.classifica()
   * @param {number} v.durataMs
   * @param {string} [v.lavoro]   id del lavoro in corso
   * @param {string|number} [v.passo]
   * @param {number} [v.tentativo]
   * @param {string} [v.rischio]
   * @param {string} [v.pagina]   dove si trovava il browser
   */
  registra(v = {}) {
    if (this._rotto) return;
    const e = v.esito || {};
    const riga = {
      quando: new Date().toISOString(),
      lavoro: v.lavoro || null,
      passo: v.passo != null ? v.passo : null,
      capacita: v.capacita || '?',
      argomenti: potaArgomenti(v.argomenti),
      ok: e.ok === true,
      code: e.code || (e.ok ? 'OK' : 'SCONOSCIUTO'),
      famiglia: e.famiglia || null,
      motivo: e.reason ? String(e.reason).slice(0, 300) : null,
      dove: e.layer || null,
      durataMs: Number(v.durataMs) || 0,
      tentativo: Number(v.tentativo) || 1,
      riprovabile: e.retryable === true,
      tipoRiprova: e.retry_type || null,
      prossimaMossa: e.suggested_next ? String(e.suggested_next).slice(0, 200) : null,
      dichiarato: e.dichiarato === true,   // l'handler ha detto lui il codice?
      rischio: v.rischio || null,
      pagina: v.pagina ? String(v.pagina).split('?')[0].slice(0, 160) : null,
    };
    try {
      if (this._scritte % 200 === 0) this._ruotaSeGrosso();
      fs.mkdirSync(path.dirname(this.percorso), { recursive: true });
      fs.appendFileSync(this.percorso, JSON.stringify(riga) + '\n');
      this._scritte++;
    } catch (err) {
      // Una volta sola: se il disco non collabora, il lavoro va avanti lo stesso.
      this._rotto = true;
      try { console.error('[Diario] non riesco a scrivere, smetto:', err.message); } catch (_) { /* console morta */ }
    }
  }

  /** Le righe, per chi vuole leggerle. Le ultime N, perche' il file cresce. */
  leggi(quante = 500) {
    try {
      const t = fs.readFileSync(this.percorso, 'utf8').trim();
      if (!t) return [];
      return t.split('\n').slice(-quante)
        .map((r) => { try { return JSON.parse(r); } catch (_) { return null; } })
        .filter(Boolean);
    } catch (_) { return []; }
  }

  /**
   * Il riassunto che serve davvero: cosa fallisce, come, e quanto costa.
   *
   * @param {number} ore  la finestra da guardare
   */
  riepilogo(ore = 24) {
    const da = Date.now() - ore * 3600 * 1000;
    const righe = this.leggi(5000).filter((r) => new Date(r.quando).getTime() >= da);
    if (!righe.length) return { righe: 0 };

    const perCapacita = {};
    const perCodice = {};
    let falliti = 0, tempo = 0, sconosciuti = 0;

    for (const r of righe) {
      const c = (perCapacita[r.capacita] = perCapacita[r.capacita] || { n: 0, ko: 0, ms: 0, codici: {} });
      c.n++; c.ms += r.durataMs; tempo += r.durataMs;
      if (!r.ok) {
        falliti++; c.ko++;
        c.codici[r.code] = (c.codici[r.code] || 0) + 1;
        perCodice[r.code] = (perCodice[r.code] || 0) + 1;
        if (r.code === 'SCONOSCIUTO') sconosciuti++;
      }
    }

    return {
      ore,
      righe: righe.length,
      falliti,
      percentualeFallimenti: Math.round((1000 * falliti) / righe.length) / 10,
      // Quanti fallimenti non sappiamo ancora spiegare: e' il numero da far
      // scendere, ed e' la misura di quanto il diario e' ancora cieco.
      sconosciuti,
      tempoTotaleSec: Math.round(tempo / 1000),
      peggiori: Object.entries(perCapacita)
        .filter(([, c]) => c.ko)
        .sort((a, b) => b[1].ko - a[1].ko)
        .slice(0, 10)
        .map(([nome, c]) => ({ nome, chiamate: c.n, falliti: c.ko,
          secondi: Math.round(c.ms / 1000), codici: c.codici })),
      codici: Object.entries(perCodice).sort((a, b) => b[1] - a[1])
        .map(([code, n]) => ({ code, n })),
      // Dove se ne va il tempo, a prescindere dagli errori.
      piuLente: Object.entries(perCapacita).sort((a, b) => b[1].ms - a[1].ms).slice(0, 5)
        .map(([nome, c]) => ({ nome, secondi: Math.round(c.ms / 1000), chiamate: c.n })),
    };
  }
}

module.exports = { Giornale, potaArgomenti };
