#!/usr/bin/env node
// tests/test-mani-vuote.js — Nessun lavoro parte a mani vuote.
//
// Trovato il 6 agosto 2026 setacciando la mappa degli scope. Alcuni scope
// dicono DI COSA si parla, non COSA bisogna saper fare: "logistics", "sales",
// "tmwe", "findair", "memory" servono a scegliere i capitoli di conoscenza e
// in TOOL_SCOPES non esistono. Se erano gli unici rilevati, l'Esecutore
// partiva con ZERO strumenti e poteva solo inventare:
//
//   "memorizza che il codice cliente di Rossi è 4471" → [sales,memory] → 0
//   "quali documenti servono in dogana per gli USA"   → [logistics]    → 0
//
// Nel primo caso la beffa: save_memory esisteva, ma viveva nello scope
// "admin". Lo strumento c'era ed era irraggiungibile proprio dall'intento
// che porta il suo nome.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const sm = require('../modules/supermario');
const { COBRA_TOOLS } = require('../modules/tools/schemas');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const strumentiPer = (msg) => {
  const r = sm.routeIntent(msg);
  return { scopes: r.scopes, nomi: sm.selectTools(r.scopes, COBRA_TOOLS).map(t => t.function.name) };
};

console.log('\n=== NESSUN LAVORO PARTE A MANI VUOTE ===');

sezione('I due casi veri che partivano senza niente');
{
  const a = strumentiPer('memorizza che il codice cliente di Rossi è 4471');
  ok('la richiesta di memorizzare ha degli strumenti', a.nomi.length > 0, `scopes=[${a.scopes}]`);
  ok('e fra questi c e proprio save_memory', a.nomi.includes('save_memory'), a.nomi.slice(0, 8).join(','));

  const b = strumentiPer('quali documenti servono in dogana per gli USA');
  ok('la domanda di logistica ha degli strumenti', b.nomi.length > 0, `scopes=[${b.scopes}]`);
  ok('e puo andare a guardare', b.nomi.includes('navigate') || b.nomi.includes('google_search'));
}

sezione('Ogni scope di argomento dichiara di che mani ha bisogno');
{
  for (const s of ['memory', 'logistics', 'sales', 'tmwe', 'findair']) {
    const nomi = sm.selectTools([s], COBRA_TOOLS).map(t => t.function.name);
    ok(`lo scope "${s}" non lascia a mani vuote`, nomi.length > 0);
  }
  ok('memory porta gli strumenti della memoria',
     sm.selectTools(['memory'], COBRA_TOOLS).some(t => t.function.name === 'save_memory'));
  ok('logistics porta di che guardare',
     sm.selectTools(['logistics'], COBRA_TOOLS).some(t => t.function.name === 'navigate'));
}

sezione('La chiacchiera resta senza strumenti, come deve');
{
  const c = strumentiPer('ciao come stai');
  ok('parlare non richiede strumenti', c.nomi.length === 0, `${c.nomi.length} strumenti`);
  ok('anche chiedendolo esplicitamente', sm.selectTools(['chat'], COBRA_TOOLS).length === 0);
  ok('e "chat" vince anche se accompagnato', sm.selectTools(['chat', 'browse'], COBRA_TOOLS).length === 0);
}

sezione('La rete di sicurezza regge anche uno scope mai visto');
{
  const nomi = sm.selectTools(['uno_scope_inventato_domani'], COBRA_TOOLS).map(t => t.function.name);
  ok('uno scope sconosciuto non lascia a mani vuote', nomi.length > 0, `${nomi.length}`);
  ok('e quello che arriva sono le mani di base', nomi.includes('google_search'));
}

sezione('Gli scope veri non sono stati toccati');
{
  const soloBrowse = sm.selectTools(['browse'], COBRA_TOOLS).map(t => t.function.name);
  ok('browse resta browse', soloBrowse.includes('navigate') && !soloBrowse.includes('save_memory'));
  const soloFile = sm.selectTools(['file'], COBRA_TOOLS).map(t => t.function.name);
  ok('file resta file', soloFile.includes('crea_report') && !soloFile.includes('navigate'));
  ok('full continua a dare tutto', sm.selectTools(['full'], COBRA_TOOLS).length === COBRA_TOOLS.length);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
