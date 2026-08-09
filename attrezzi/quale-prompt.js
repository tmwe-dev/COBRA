#!/usr/bin/env node
// attrezzi/quale-prompt.js — Quale prompt di lavoro viene davvero scelto.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Ci sono sei prompt di lavoro — searcher, navigator, communicator, admin,
// scout, full — e `resolveAgent()` prende il PRIMO che corrisponde:
//
//     if (interact || browse) → navigator
//     if (search)             → searcher
//     ...
//
// Quindi `navigator` vince ogni volta che negli ambiti c'e' interact o browse,
// e per una richiesta di viaggio gli ambiti sono quasi sempre
// [search, browse, interact, file, data]: sempre navigator, MAI scout — che e'
// quello specializzato nell'estrarre dati, cioe' esattamente il lavoro in
// corso.
//
// Prima di riscrivere i prompt bisogna sapere quali vengono usati. E' la
// lezione dei 40 strumenti mai chiamati: si misura, poi si decide.
//
//     node attrezzi/quale-prompt.js
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const RADICE = path.resolve(__dirname, '..');
const { resolveAgent } = require(path.join(RADICE, 'modules/supermario'));

const righe = (() => {
  try {
    return fs.readFileSync(path.join(RADICE, 'data/response_log.jsonl'), 'utf8')
      .trim().split('\n').map((r) => { try { return JSON.parse(r); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
})();

// ── Quale prompt e' stato scelto ──
//
// Nei turni vecchi il campo non c'e': si ricalcola dagli ambiti, che invece
// sono sempre stati registrati. E' una ricostruzione, non una misura, e va
// detto — ma su una funzione pura come resolveAgent e' esatta.
const conta = {};
const perAmbiti = {};
let ricostruiti = 0;

for (const d of righe) {
  const scopes = String(d.marioScope || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!scopes.length) continue;
  let a = d.agenteLavoro;
  if (!a) { a = resolveAgent(scopes); ricostruiti++; }
  conta[a] = (conta[a] || 0) + 1;
  const chiave = scopes.slice().sort().join(',');
  (perAmbiti[chiave] = perAmbiti[chiave] || { n: 0, agente: a })
    .n++;
}

const totale = Object.values(conta).reduce((s, n) => s + n, 0);
const TUTTI = ['full', 'searcher', 'navigator', 'communicator', 'admin', 'scout'];

console.log(`\nTurni con ambiti noti: ${totale}`
  + (ricostruiti ? ` (${ricostruiti} ricostruiti da resolveAgent, il campo non c'era)` : ''));
console.log('\n| prompt di lavoro | turni | quota |');
console.log('|---|---|---|');
for (const a of TUTTI) {
  const n = conta[a] || 0;
  const q = totale ? Math.round((1000 * n) / totale) / 10 : 0;
  console.log(`| ${a.padEnd(13)} | ${String(n).padStart(5)} | ${String(q).padStart(5)}% |`
    + (n === 0 ? '   ← mai scelto' : ''));
}

console.log('\nCombinazioni di ambiti piu\' frequenti, e chi vince:');
for (const [k, v] of Object.entries(perAmbiti).sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
  console.log(`  ${String(v.n).padStart(3)}×  [${k}]  →  ${v.agente}`);
}

const mai = TUTTI.filter((a) => !conta[a]);
if (mai.length) {
  console.log(`\nMai scelti: ${mai.join(', ')}.`);
  console.log('Un prompt che non viene mai scelto non si puo\' migliorare: prima va reso raggiungibile.');
}
