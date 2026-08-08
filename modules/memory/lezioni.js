// modules/memory/lezioni.js — Imparare dal LAVORO, non solo dalle chiacchiere.
//
// IL PROBLEMA CHE RISOLVE
//
// Il 7 agosto l'archivio dei fatti aveva 15 voci, tutte vecchie, tutte su
// Luca: "Luca è responsabile commerciale", "preferisce risposte brevi". Utili,
// ma raccolte ascoltando quello che DICE.
//
// Di quello che COBRA FA non restava niente. In due giorni ha imparato e
// dimenticato almeno queste cose:
//
//   - europages.it si disegna in JavaScript e allo scraper torna vuoto
//   - ita-airways.com risponde con una schermata anti-bot
//   - su tmwe.it il banner dei cookie si chiude cliccando "impostazione cookie"
//   - per raccogliere aziende, i siti aziendali rendono, gli elenchi B2B no
//   - Google Voli mette i prezzi a nove secondi, non a quattro
//
// Ognuna è costata minuti di lavoro vero. Ognuna è stata riscoperta da capo
// il giorno dopo. Un sistema che ogni mattina ricomincia dalla stessa
// ignoranza non è un collega: è uno stagista nuovo ogni giorno.
//
// COSA C'ERA GIÀ, E COSA MANCAVA
//
// Il RegistroFonti impara già quali domini rendono e quali no, e funziona.
// Qui si impara il resto:
//
//   - COME si è superato un ostacolo su un certo sito
//   - COM'È FATTO un modulo che è già stato compilato
//   - QUALE STRADA ha funzionato per un tipo di lavoro
//   - QUANTO ci mette un sito a mostrare i dati
//
// Le lezioni sono poche e corte per costruzione: una lezione che nessuno
// legge è peso, e il peso affoga le regole che servono — è la lezione che
// abbiamo imparato sul prompt da 25.000 caratteri.

const path = require('path');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

const MAX_PER_TIPO = 40;          // oltre, le più vecchie e meno usate escono
const MIN_CONFERME = 1;           // una lezione vale dalla prima volta
const DECADIMENTO_GIORNI = 45;    // una lezione mai più usata invecchia

/** I tipi di lezione. Non se ne inventano altri: quelli ignoti si perdono. */
const TIPI = ['ostacolo', 'modulo', 'strada', 'tempo'];

function oggi() { return Date.now(); }
function giorni(ms) { return ms / 86400000; }

class Lezioni {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'lezioni.json');
    const letto = readJsonSafeSync(this.file, null);
    this.voci = Array.isArray(letto) ? letto : [];
  }

  _salva() {
    try { writeJsonAtomicSync(this.file, this.voci); } catch (_) { /* best-effort */ }
  }

  /**
   * Si impara una cosa.
   *
   * @param {string} tipo     ostacolo | modulo | strada | tempo
   * @param {string} chiave   il dominio, o il tipo di lavoro
   * @param {string} testo    la lezione, in una frase leggibile
   */
  impara(tipo, chiave, testo) {
    if (!TIPI.includes(tipo)) return { ok: false, motivo: `tipo "${tipo}" sconosciuto` };
    const k = String(chiave || '').trim().toLowerCase();
    const t = String(testo || '').trim();
    if (!k || t.length < 8) return { ok: false, motivo: 'lezione troppo vaga per servire' };

    // ── Due lezioni sullo stesso argomento sono UNA lezione ──
    //
    // Qui si confrontava il testo ESATTO. Risultato, letto in data/lezioni.json
    // il 7 agosto: otto voci di cui cinque erano la stessa cosa —
    //
    //   "i dati compaiono dopo 79 secondi: aspettare meno significa leggere il guscio"
    //   "i dati compaiono dopo 25 secondi: ..."
    //   "i dati compaiono dopo 80 secondi: ..."
    //   "i dati compaiono dopo 87 secondi: ..."
    //   "i dati compaiono dopo 23 secondi: ..."
    //
    // Stesso sito, stessa lezione, cinque righe. Bastava un numero diverso e
    // nasceva una voce nuova. Non e' imparare, e' accumulare: la lezione vera
    // — "su questa pagina aspetta prima di leggere" — c'era cinque volte e non
    // emergeva mai, mentre le conferme restavano a 1 e la potatura le trattava
    // come cinque cose fragili invece di una solida.
    //
    // Adesso conta l'ARGOMENTO: tipo + chiave. Se la formulazione cambia solo
    // nei numeri, si tiene il caso peggiore — che e' quello che serve sapere:
    // se una volta ci sono voluti 87 secondi, aspettarne 25 vuol dire leggere
    // il guscio.
    const soloNumeri = (x) => String(x).replace(/\d+/g, '#');
    const esistente = this.voci.find(v => v.tipo === tipo && v.chiave === k
      && (v.testo === t || soloNumeri(v.testo) === soloNumeri(t)));

    if (esistente) {
      // Una cosa vista due volte è più vera di una vista una volta sola.
      esistente.conferme++;
      esistente.ultimaVolta = oggi();

      if (esistente.testo !== t) {
        // Stessa lezione, numeri diversi: si tiene il piu' grande, perche' su
        // un'attesa il numero utile e' il peggiore, non l'ultimo.
        const max = (x) => Math.max(0, ...String(x).match(/\d+/g)?.map(Number) || [0]);
        if (max(t) > max(esistente.testo)) esistente.testo = t;
        esistente.varianti = (esistente.varianti || 0) + 1;
      }

      this._salva();
      return { ok: true, confermata: true, conferme: esistente.conferme };
    }

    this.voci.push({ tipo, chiave: k, testo: t, conferme: 1, nata: oggi(), ultimaVolta: oggi(), usata: 0 });
    this._pota(tipo);
    this._salva();
    return { ok: true, nuova: true };
  }

  /** Le più vecchie e meno confermate escono, per non affogare le utili. */
  _pota(tipo) {
    const dello = this.voci.filter(v => v.tipo === tipo);
    if (dello.length <= MAX_PER_TIPO) return;
    dello.sort((a, b) => (a.conferme - b.conferme) || (a.ultimaVolta - b.ultimaVolta));
    const daTogliere = new Set(dello.slice(0, dello.length - MAX_PER_TIPO));
    this.voci = this.voci.filter(v => !daTogliere.has(v));
  }

  /** Le lezioni che riguardano questo lavoro e questi domini. */
  pertinenti({ obiettivo = '', domini = [] } = {}) {
    const testo = String(obiettivo).toLowerCase();
    const dom = domini.map(d => String(d).toLowerCase());
    const scelte = [];

    for (const v of this.voci) {
      if (v.conferme < MIN_CONFERME) continue;
      // Una lezione mai più usata da un mese e mezzo probabilmente non vale più
      if (giorni(oggi() - v.ultimaVolta) > DECADIMENTO_GIORNI && v.conferme < 3) continue;

      const perDominio = dom.some(d => d.includes(v.chiave) || v.chiave.includes(d));
      const perLavoro = v.tipo === 'strada' && v.chiave.split(/\s+/).some(p => p.length > 3 && testo.includes(p));
      if (perDominio || perLavoro) scelte.push(v);
    }
    scelte.sort((a, b) => b.conferme - a.conferme);
    return scelte.slice(0, 12);
  }

  /** Il blocco per il prompt: quello che si sa già, e non va riscoperto. */
  perIlPrompt(contesto = {}) {
    const scelte = this.pertinenti(contesto);
    if (scelte.length === 0) return '';

    // Segnare che sono state usate: le lezioni che servono davvero restano.
    for (const v of scelte) { v.usata++; v.ultimaVolta = oggi(); }
    this._salva();

    const per = { ostacolo: [], modulo: [], strada: [], tempo: [] };
    for (const v of scelte) per[v.tipo].push(v);

    const righe = ['# QUELLO CHE HAI GIÀ IMPARATO LAVORANDO', ''];
    const titoli = {
      strada: 'Strade che hanno funzionato',
      ostacolo: 'Ostacoli già incontrati, e come si tolgono',
      modulo: 'Moduli già visti',
      tempo: 'Quanto ci mettono',
    };
    for (const tipo of ['strada', 'ostacolo', 'modulo', 'tempo']) {
      if (!per[tipo].length) continue;
      righe.push(`${titoli[tipo]}:`);
      for (const v of per[tipo]) {
        righe.push(`- ${v.chiave}: ${v.testo}${v.conferme > 1 ? ` (visto ${v.conferme} volte)` : ''}`);
      }
      righe.push('');
    }
    righe.push('Questo viene da lavori fatti davvero, non da opinioni. '
      + 'Se una cosa qui contraddice quello che vedi adesso, vince quello che vedi.');
    return righe.join('\n');
  }

  riepilogo() {
    const per = {};
    for (const v of this.voci) per[v.tipo] = (per[v.tipo] || 0) + 1;
    return { totale: this.voci.length, per, usateAlmenoUnaVolta: this.voci.filter(v => v.usata > 0).length };
  }
}

module.exports = { Lezioni, TIPI };
