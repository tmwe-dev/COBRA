// modules/cantiere/raccolta.js — Quello che si trova si posa da solo.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Il Cantiere e' il posto dove si appoggia quello che si raccoglie mentre si
// lavora, e funziona: sopravvive al turno, sta su disco, dice cosa manca.
//
// Ha un difetto solo, ed e' fatale: si riempie soltanto se il modello chiama
// `annota`. Misura del 9 agosto, su 880 chiamate a strumenti:
//
//     annota chiamato                5 volte  (0,6%)
//     voci nel cantiere              0
//
// Zero. Un ponteggio perfetto su cui nessuno ha mai posato un mattone.
//
// Non e' pigrizia del modello. E' che annotare non produce niente di visibile:
// e' una spesa immediata a fronte di un beneficio che si vedra' fra tre passi.
// Un modello, come una persona di fretta, salta esattamente quelle cose.
//
// ── IL PRINCIPIO ──
//
// Un dato che il sistema HA GIA' IN MANO non si chiede a nessuno di ricordarsi
// di scriverlo. Quando `read_table` restituisce otto righe con intestazioni,
// quelle otto righe esistono gia', strutturate, dentro il risultato. Chiedere
// al modello di ricopiarle con `annota` e' chiedergli un favore — e i favori
// non si ottengono nello 0,6% dei casi, si ottengono mai.
//
// Qui le prende il codice.
//
// ── COSA SI PUO' RACCOGLIERE DA SOLI, E COSA NO ──
//
// Si puo', in modo deterministico:
//   read_table    righe con intestazioni  → una voce per riga
//   extract_data  tabelle dentro la pagina → idem
//   create_file   un file prodotto         → un esito del lavoro
//   crea_report   idem
//
// NON si puo': da `scrape_url` di una pagina di testo non si estraggono
// "otto aziende di packaging" senza capire il testo, e capire il testo e'
// esattamente il mestiere del modello. Fingere di saperlo fare produrrebbe
// voci sbagliate, che sono peggio di nessuna voce.
//
// Per quelle pagine si registra un fatto diverso e altrettanto utile: LETTA E
// NIENTE RACCOLTO. Cosi' "ho aperto sette pagine e il cantiere e' vuoto"
// smette di essere invisibile e diventa un numero che il Collega puo' leggere.
// Il 6 agosto quel numero sarebbe stato 7, e avremmo saputo subito dove
// guardare invece di scoprirlo tre giorni dopo.
// ══════════════════════════════════════════════════════════════════════

/** Gli strumenti da cui si raccoglie senza chiedere niente a nessuno. */
const DANNO_RIGHE = ['read_table', 'extract_data'];

/** Gli strumenti che producono qualcosa di consegnabile. */
const DANNO_UN_FILE = ['create_file', 'crea_report', 'save_local_file'];

/** Gli strumenti che leggono una pagina: se non se ne cava niente, si dice. */
const LEGGONO = ['scrape_url', 'read_page', 'batch_scrape', 'crawl_website'];

/** Il valore di una cella, ripulito. Vuoto se non dice niente. */
function _cella(v) {
  const t = String(v == null ? '' : v).trim();
  return t.length > 300 ? t.slice(0, 300) : t;
}

/**
 * Le intestazioni, rese nomi di campo utilizzabili.
 *
 * Quando mancano si usa `col1, col2...`: brutto ma onesto. Inventare nomi
 * ("nome", "prezzo") su colonne di cui non si sa niente significa mettere un
 * prezzo dentro un campo chiamato prezzo senza averlo verificato.
 */
function _nomiColonne(headers, quante) {
  const fuori = [];
  for (let i = 0; i < quante; i++) {
    const h = _cella(headers && headers[i]);
    fuori.push(h ? h.toLowerCase().replace(/\s+/g, '_').slice(0, 40) : `col${i + 1}`);
  }
  return fuori;
}

/**
 * Una tabella diventa voci.
 *
 * Il NOME della voce e' la prima cella non vuota della riga: e' la convenzione
 * di qualunque tabella scritta da esseri umani — la colonna che identifica sta
 * a sinistra. Se non ce n'e' nessuna, la riga si scarta: una voce senza nome
 * non si puo' ne' cercare ne' completare.
 */
function _daTabella(righe, headers, fonte) {
  const voci = [];
  if (!Array.isArray(righe) || !righe.length) return voci;

  // Se la prima riga sembra un'intestazione e headers manca, la si usa.
  let corpo = righe;
  let intestazioni = headers;
  if (!intestazioni || !intestazioni.length) {
    const prima = righe[0] || [];
    const sembraIntestazione = prima.length > 1
      && prima.every((c) => { const t = _cella(c); return t && t.length < 40 && !/^[\d.,€$%\s]+$/.test(t); });
    if (sembraIntestazione) { intestazioni = prima; corpo = righe.slice(1); }
  }

  for (const riga of corpo) {
    if (!Array.isArray(riga) || !riga.length) continue;
    const nomi = _nomiColonne(intestazioni, riga.length);
    const campi = {};
    let nome = '';
    for (let i = 0; i < riga.length; i++) {
      const v = _cella(riga[i]);
      if (!v) continue;
      if (!nome) { nome = v; continue; }   // la prima cella piena identifica
      campi[nomi[i]] = v;
    }
    if (!nome) continue;
    voci.push({ nome, campi, fonte });
  }
  return voci;
}

/** L'oggetto dentro un risultato, comunque sia arrivato. */
function _oggetto(grezzo) {
  if (grezzo && typeof grezzo === 'object') return grezzo;
  try { const d = JSON.parse(String(grezzo || '')); return (d && typeof d === 'object') ? d : null; }
  catch (_) { return null; }
}

/**
 * Cosa si raccoglie da questa esecuzione.
 *
 * Pura: non scrive niente, non tocca il cantiere. Chi la chiama decide.
 *
 * @returns {{voci: Array, file: Array, lettaSenzaRaccolto: string|null}}
 */
function daRisultato(nome, args, grezzo, pagina) {
  const vuoto = { voci: [], file: [], lettaSenzaRaccolto: null };
  const d = _oggetto(grezzo);
  if (!d || d.ok === false || d.error) return vuoto;

  const fonte = d.url || (args && args.url) || pagina || '';

  if (DANNO_RIGHE.includes(nome)) {
    // read_table: { headers, rows }
    if (Array.isArray(d.rows)) return { ...vuoto, voci: _daTabella(d.rows, d.headers, fonte) };
    // extract_data: { data: { tables: [ [riga, riga] ] } }
    const tabelle = d.data && Array.isArray(d.data.tables) ? d.data.tables : null;
    if (tabelle) {
      const voci = [];
      for (const t of tabelle) voci.push(..._daTabella(t, null, fonte));
      return { ...vuoto, voci };
    }
    return vuoto;
  }

  if (DANNO_UN_FILE.includes(nome)) {
    const percorso = d.file || d.path || d.percorso || d.filename || (args && (args.filename || args.nome));
    if (percorso) return { ...vuoto, file: [{ percorso: String(percorso), fonte }] };
    return vuoto;
  }

  if (LEGGONO.includes(nome) && fonte) {
    // Non si estrae: si segna che e' stata letta. Chi guarda il cantiere
    // vedra' quante pagine sono passate senza lasciare niente.
    return { ...vuoto, lettaSenzaRaccolto: fonte };
  }

  return vuoto;
}

/**
 * Posa quello che si e' raccolto nel cantiere aperto.
 *
 * Non lancia mai: se il cantiere non c'e' — perche' non c'e' un lavoro in
 * corso — non succede niente. Raccogliere e' un servizio, non una condizione
 * per lavorare.
 *
 * @returns {{annotate: number, file: number, letta: boolean}}
 */
function posaNelCantiere(cantiere, raccolto) {
  const conto = { annotate: 0, file: 0, letta: false };
  if (!cantiere || !raccolto) return conto;

  try {
    for (const v of raccolto.voci) {
      // Un tetto per esecuzione: una tabella da duecento righe seppellirebbe
      // il cantiere e il prompt che lo riassume. Chi ne vuole di piu' le
      // annota a mano, consapevolmente.
      if (conto.annotate >= 50) break;
      const r = cantiere.annota(v.nome, v.campi, v.fonte);
      if (r && r.ok) conto.annotate++;
    }
    for (const f of raccolto.file) {
      if (typeof cantiere.nota === 'function') cantiere.nota(`file prodotto: ${f.percorso}`);
      conto.file++;
    }
    if (raccolto.lettaSenzaRaccolto && typeof cantiere.letta === 'function') {
      cantiere.letta(raccolto.lettaSenzaRaccolto);
      conto.letta = true;
    }
  } catch (_) { /* la raccolta non deve mai fermare uno strumento */ }

  return conto;
}

module.exports = { daRisultato, posaNelCantiere, DANNO_RIGHE, DANNO_UN_FILE, LEGGONO };
