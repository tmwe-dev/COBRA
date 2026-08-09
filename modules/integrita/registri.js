// modules/integrita/registri.js — Chi legge i sei registri. Uno solo.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE, E PERCHE' STA QUI E NON NELL'ATTREZZO
//
// La malattia che stiamo curando e' che la stessa cosa e' scritta in sei posti
// e nessuno li confronta. Sarebbe grottesco curarla scrivendo DUE lettori di
// quei sei posti: uno nell'attrezzo di misura e uno nel controllo d'avvio.
// Diventerebbero due, divergerebbero, e un giorno l'attrezzo direbbe "tutto a
// posto" mentre l'avvio dice il contrario — e nessuno saprebbe a chi credere.
//
// E' gia' successo con `bridgeCommand`: due copie, per giorni ho corretto
// quella che non veniva usata.
//
// Quindi: i sei registri si leggono QUI, e chiunque voglia sapere com'e' fatta
// una capacita' chiede a questo modulo. L'attrezzo `matrice-capacita.js` e il
// cancello d'avvio `verifica.js` guardano gli stessi occhi.
//
// ── I SEI REGISTRI ──
//
//   1. schemas.js              lo schema che il modello vede
//   2. TOOL_SCOPES             quando la capacita' gli viene consegnata
//   3. risk/taxonomy.js        se serve conferma prima di eseguire
//   4. handlers/index.js       la funzione che esegue
//   5. estensione: comandi     cosa tocca la pagina
//   6. handler → ponte         quale comando l'handler chiede davvero
//
// Si leggono dal SORGENTE e non da quello che il codice dichiara di se': un
// registro che si autocertifica non e' una verifica.
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const RADICE = path.resolve(__dirname, '../..');
const testo = (p) => { try { return fs.readFileSync(path.join(RADICE, p), 'utf8'); } catch (_) { return ''; } };

/** 1. Gli schemi: quello che il modello vede. */
function schemi() {
  const t = testo('modules/tools/schemas.js');
  const tutti = [...t.matchAll(/name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  const visti = new Set();
  const doppi = [];
  for (const n of tutti) { if (visti.has(n)) doppi.push(n); visti.add(n); }
  return { elenco: [...visti], doppi: [...new Set(doppi)] };
}

/** 2. Gli ambiti: per ogni strumento, in quali ambiti viene consegnato. */
function ambiti() {
  const t = testo('modules/supermario.js');
  const blocco = t.slice(t.indexOf('const TOOL_SCOPES'), t.indexOf('full: null'));
  const mappa = {};
  for (const m of blocco.matchAll(/^\s{2}([a-z]+):\s*\[([\s\S]*?)\],\s*$/gm)) {
    for (const s of m[2].matchAll(/'([a-z0-9_]+)'/g)) {
      (mappa[s[1]] = mappa[s[1]] || []).push(m[1]);
    }
  }
  return mappa;
}

/** 3. Il rischio. */
function rischi() {
  const t = testo('modules/risk/taxonomy.js');
  return new Set([...t.matchAll(/^\s{2}([a-z0-9_]+):\s*\{\s*level/gm)].map((m) => m[1]));
}

/**
 * 4. Gli handler. Solo le funzioni: `A_SESSIONE` e' una costante esportata, e
 * contarla produceva un handler-fantasma senza schema.
 */
function handler() {
  try {
    const m = require(path.join(RADICE, 'modules/tools/handlers'));
    return new Set(Object.entries(m).filter(([, v]) => typeof v === 'function').map(([k]) => k));
  } catch (e) {
    return { errore: e.message, [Symbol.iterator]: function* () {} };
  }
}

/**
 * 5. I comandi dell'estensione, letti in DUE posti.
 *
 * `esterni/comandi/*.js` e lo switch superstite di background.js, dove sono
 * rimasti wait_for, verify_action e retry dopo lo spostamento dell'8 agosto.
 * Guardando solo il primo, verify_action risultava inesistente: un allarme
 * falso, e al terzo falso non si guardano piu'.
 */
function comandiEstensione() {
  const fuori = new Set();
  const d = path.join(RADICE, 'cobra-extension/esterni/comandi');
  try {
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
      for (const m of fs.readFileSync(path.join(d, f), 'utf8').matchAll(/comandi\['([a-z0-9_]+)'\]/g)) fuori.add(m[1]);
    }
  } catch (_) { /* estensione assente */ }
  for (const m of testo('cobra-extension/background.js').matchAll(/case\s+'([a-z0-9_]+)'\s*:/g)) fuori.add(m[1]);
  return fuori;
}

/** 6. Per ogni handler, quali comandi chiede al ponte. */
function comandiChiesti() {
  const d = path.join(RADICE, 'modules/tools/handlers');
  const perHandler = {};
  const tutti = new Set();
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(d, f), 'utf8');
    const qui = [...t.matchAll(/(?:bridgeCommand|_ponte)\(\s*(?:ctx,\s*)?'([a-z0-9_]+)'/g)].map((m) => m[1]);
    if (qui.length) perHandler[f] = [...new Set(qui)];
    for (const c of qui) tutti.add(c);
  }
  return { perHandler, tutti };
}

/** I file che il service worker carica davvero. */
function fileCaricatiDalWorker() {
  const dentro = new Set();
  for (const f of ['cobra-extension/background.js', 'cobra-extension/esterni/ponte.js']) {
    for (const m of testo(f).matchAll(/importScripts\(\s*[`'"]([^`'"]+)[`'"]/g)) dentro.add(m[1]);
    // Anche quelli costruiti in ciclo: importScripts(`esterni/comandi/${area}.js`)
    for (const m of testo(f).matchAll(/for\s*\(const\s+\w+\s+of\s+\[([^\]]+)\]/g)) {
      for (const a of m[1].matchAll(/'([a-z0-9_-]+)'/g)) dentro.add(`esterni/comandi/${a[1]}.js`);
    }
  }
  return dentro;
}

/** I gemelli che perdono il confronto: fuori dagli ambiti per scelta. */
function gemelliPerdenti() {
  const t = testo('modules/supermario.js');
  const blocco = t.slice(t.indexOf('const GEMELLI'), t.indexOf('const _PERDENTI'));
  return new Set([...blocco.matchAll(/perdono:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])));
}

/**
 * Gli handler che NON devono avere uno schema, e perche'.
 *
 * Non e' una lista di perdoni: e' la differenza fra "manca" e "e' stato chiuso
 * apposta". Senza, le due porte d'invio senza regole sembrano dimenticanze —
 * e prima o poi qualcuno le "aggiusta" riaprendole.
 */
const SENZA_SCHEMA_APPOSTA = {
  whatsapp_send:         'seconda strada senza regole d\'invio: il 7 agosto ne uscirono sette fuori conteggio',
  linkedin_send_message: 'idem, lato LinkedIn',
  send_whatsapp:         'alias interno della vecchia strada',
  send_linkedin:         'alias interno della vecchia strada',
  web_search:            'alias interno di google_search',
  execute_js:            'esecuzione arbitraria: resta per i flussi interni, mai in mano al modello',
  read_inbox:            'alias interno di check_emails',
};

/** Tutto in una volta, cosi' chi legge non deve sapere l'ordine. */
function tuttiIRegistri() {
  const s = schemi();
  const c = comandiChiesti();
  return {
    schemi: s.elenco, schemiDoppi: s.doppi,
    ambiti: ambiti(),
    rischi: rischi(),
    handler: handler(),
    comandiEstensione: comandiEstensione(),
    comandiChiesti: c.tutti, comandiChiestiPerFile: c.perHandler,
    fileCaricati: fileCaricatiDalWorker(),
    gemelliPerdenti: gemelliPerdenti(),
    SENZA_SCHEMA_APPOSTA,
  };
}

module.exports = {
  tuttiIRegistri, schemi, ambiti, rischi, handler,
  comandiEstensione, comandiChiesti, fileCaricatiDalWorker, gemelliPerdenti,
  SENZA_SCHEMA_APPOSTA, RADICE,
};
