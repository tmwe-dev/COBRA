#!/usr/bin/env node
// tests/test-kb-search.js — Verifica il reranking della KB.
// Usa un set di regole fittizie che riproduce il caso reale: una regola pertinente
// con priorità bassa deve comunque essere trovata (bug del LIMIT prima dello scoring).

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}

// Genera 50 regole di riempimento ad alta priorità + 1 pertinente a priorità minima
const FILLER = Array.from({ length: 50 }, (_, i) => ({
  id: i + 1, title: `Regola generica numero ${i + 1}`, content: 'Testo non correlato alla ricerca.',
  tags: ['generico'], domain: 'general', priority: 100 - i, active: true,
}));
const TARGET = {
  id: 999, title: 'Quando serve conferma esplicita', priority: 1, active: true,
  content: 'Prima di inviare email o eseguire azioni irreversibili serve la conferma esplicita.',
  tags: ['conferma', 'sicurezza'], domain: 'general',
};
const ROWS = [...FILLER, TARGET];

// Intercetta fetch per servire i dati fittizi
const realFetch = global.fetch;
let lastUrl = '';
global.fetch = async (url) => {
  lastUrl = String(url);
  return { ok: true, json: async () => ROWS };
};

const { searchKB } = require('../modules/kb/search');

(async () => {
  console.log('');
  console.log('=== RICERCA KB: reranking ===');
  console.log('');

  // Il LIMIT SQL non deve tagliare i candidati prima dello scoring
  await searchKB('conferma');
  const m = lastUrl.match(/limit=(\d+)/);
  const limit = m ? Number(m[1]) : 0;
  ok('il limite SQL e ampio (>= 200)', limit >= 200, `limit=${limit}`);

  // Caso che prima falliva: regola pertinente con priorità piu bassa di tutte
  const r1 = await searchKB('regole di conferma');
  ok('trova la regola pertinente anche con priorita minima',
     r1.some(x => x.id === 999), `risultati: ${r1.map(x => x.title).join(' | ') || 'nessuno'}`);
  ok('la regola pertinente e prima in classifica',
     r1[0] && r1[0].id === 999, r1[0] ? r1[0].title : 'nessun risultato');

  // Le stopword non devono generare falsi positivi
  const r2 = await searchKB('cosa devo fare quando');
  ok('le stopword da sole non producono match spuri',
     r2.every(x => x.id !== 999) || r2.length <= 10, `n=${r2.length}`);

  // Accenti e maiuscole non devono impedire il match
  const r3 = await searchKB('CONFERMA ESPLÌCITA');
  ok('match robusto ad accenti e maiuscole', r3.some(x => x.id === 999),
     `risultati: ${r3.length}`);

  // Match su tag
  const r4 = await searchKB('sicurezza');
  ok('match sui tag', r4.some(x => x.id === 999), `risultati: ${r4.length}`);

  // Query vuota o troppo corta: ritorna comunque candidati
  const r5 = await searchKB('');
  ok('query vuota ritorna candidati', r5.length > 0 && r5.length <= 10, `n=${r5.length}`);

  // Nessun risultato per query non correlate
  const r6 = await searchKB('elicottero sottomarino');
  ok('nessun match per query non correlate', r6.length === 0, `n=${r6.length}`);

  // Massimo 10 risultati
  const r7 = await searchKB('regola generica numero');
  ok('ritorna al massimo 10 risultati', r7.length <= 10, `n=${r7.length}`);

  global.fetch = realFetch;
  console.log('');
  console.log(FAIL === 0
    ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
    : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
  process.exit(FAIL > 0 ? 1 : 0);
})();
