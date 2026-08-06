#!/usr/bin/env node
// tests/test-strumenti-promessi.js — Chi promette, deve poter mantenere.
//
// Prova fisica del 6 agosto 2026, richiesta Tokyo. Dal log del server:
//
//   [SuperMario] Scope: [search,browse] → 19 tools: [navigate, google_search,
//     read_page, scrape_url, ... processo_stato]
//   [Collega] Insisto (1/2): ... manca il file .html richiesto
//   [Collega] Insisto (2/2): manca il file .html richiesto
//   [Collega] Verdetto: 3/6 criteri — manca il file .html richiesto
//
// Il Collega aveva promesso un report .html mettendo il criterio file_atteso.
// Ma fra i 19 strumenti dell'Esecutore non ce n'era NESSUNO capace di
// scrivere un file: crea_report e create_file vivono negli ambiti "data" e
// "file", che non erano attivi.
//
// Risultato: due insistenze e un cambio di strada spesi a ripetere "manca il
// file" a un modello che non aveva modo di produrlo. Tre giri di lavoro per
// chiedere l'impossibile.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { Incarico } = require('../modules/collega/incarico');
const SuperMario = require('../modules/supermario');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== CHI PROMETTE UN FILE DEVE AVERE DI CHE SCRIVERLO ===');

sezione('Il buco che ha fatto fallire Tokyo');
{
  const sm = fs.readFileSync('modules/supermario.js', 'utf8');
  const scopeSearch = sm.match(/\n  search: \[[\s\S]*?\],/);
  const scopeBrowse = sm.match(/\n  browse: \[[\s\S]*?\],/);
  const insieme = (scopeSearch ? scopeSearch[0] : '') + (scopeBrowse ? scopeBrowse[0] : '');
  ok('search+browse NON contengono di che scrivere un file',
     !/crea_report/.test(insieme) && !/create_file/.test(insieme));
  ok('gli strumenti per scrivere stanno nell ambito file', /  file: \[[\s\S]*?crea_report/.test(sm));
}

sezione('Il criterio decide gli strumenti, come per la ricerca');
{
  const c = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('un criterio file_atteso viene riconosciuto', /c\.tipo === 'file_atteso'/.test(c));
  ok('e fa aggiungere l ambito file', /routing\.scopes\.push\('file'\)/.test(c));
  ok('senza duplicarlo se c era gia', /!routing\.scopes\.includes\('file'\)/.test(c));
  ok('la cosa viene scritta nel log', /promette un file ma mancavano gli strumenti/.test(c));
  ok('e Luca la vede succedere', /Mi serve di che scrivere il documento/.test(c));

  // L'ordine conta: l'ambito va aggiunto PRIMA che gli strumenti vengano scelti
  ok('l ambito si aggiunge prima di assemblare gli strumenti',
     c.indexOf("routing.scopes.push('file')") < c.indexOf('SuperMario.assemble'));
}

sezione('Con l ambito giusto lo strumento c e davvero');
{
  const conFile = SuperMario.assemble
    ? null
    : null;
  // Si guarda direttamente la mappa degli ambiti: è quella che decide
  const sm = fs.readFileSync('modules/supermario.js', 'utf8');
  const mappaFile = sm.match(/  file: \[[\s\S]*?\],/)[0];
  ok('l ambito file porta crea_report', /crea_report/.test(mappaFile));
  ok('e porta anche create_file', /create_file/.test(mappaFile));
}

sezione('Il criterio che era stato promesso, esiste ed e verificabile');
{
  const i = new Incarico({
    obiettivo: 'Report viaggio Tokyo',
    criteri: [{ tipo: 'file_atteso', estensione: 'html' }],
  });
  ok('file_atteso e un criterio valido', i.criteri.length === 1 && i.valido());

  const senzaFile = i.valuta({ testo: 'ecco i voli', file: [], pagine: [] }, {});
  ok('senza file il criterio non e soddisfatto', senzaFile.soddisfatto === false);
  ok('e lo dice chiaramente', /file \.html/.test(senzaFile.mancanze.join(' ')), senzaFile.mancanze.join('; '));

  // Il campo si chiama "filename": è quello che scrivono i tre punti in cui
  // data.js registra un file prodotto. Scriverlo diverso qui farebbe passare
  // un test su un contratto che non esiste.
  const conFile = i.valuta({ testo: 'ecco', file: [{ filename: 'tokyo.html' }], pagine: [] }, {});
  ok('col file il criterio e soddisfatto', conFile.soddisfatto === true, conFile.mancanze.join('; '));

  const altraEstensione = i.valuta({ testo: 'ecco', file: [{ filename: 'tokyo.xlsx' }], pagine: [] }, {});
  ok('un file di un altro tipo non basta', altraEstensione.soddisfatto === false);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
