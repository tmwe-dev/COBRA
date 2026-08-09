// tests/test-chi-parla.js — Con quale voce, e con quale carattere.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Luca, 9 agosto: "il collega usa una voce che non e' del presidente e non
// usa l'agente cobra".
//
// Aveva ragione, e i difetti erano tre in fila:
//
//   1. `ctx._agenteScelto` partiva VUOTO. Sia tts.js sia supermario.js
//      facevano `if (ctx._agenteScelto)`, quindi con quel campo vuoto non
//      entrava in gioco nessun agente.
//   2. La voce cadeva su ELEVENLABS_VOICE_ID nelle costanti —
//      uScy1bXtKz8vPzfdFsFw — che non e' la voce di NESSUNO dei quattro
//      agenti. COBRA parla con 18ZMGuois2TnhI0bJ7nn.
//   3. Anche scegliendo dal menu, la scelta viveva in memoria: un riavvio e
//      si tornava alla voce di prima. Dieci riavvii in una notte.
//
// In piu' il blocco "# CHI SEI ADESSO" era dentro `if (ag && !ag.predefinito)`:
// quindi l'agente COBRA, che E' il predefinito, non veniva applicato MAI, per
// costruzione.
// ══════════════════════════════════════════════════════════════════════

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const A = require('../modules/config/agenti');
const { COBRA_DEFAULTS } = require('../modules/config');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}

prova('esiste un agente predefinito, ed e\' COBRA', () => {
  const p = A.predefinito();
  assert.ok(p, 'nessun agente predefinito');
  assert.strictEqual(p.nome, 'COBRA');
  assert.strictEqual(p.lingua, 'it');
});

prova('ogni agente ha una voce sua', () => {
  for (const a of A.AGENTI) {
    assert.ok(a.voce && a.voce.length > 8, `${a.nome} non ha una voce`);
  }
  const voci = A.AGENTI.map((a) => a.voce);
  assert.strictEqual(new Set(voci).size, voci.length, 'due agenti condividono la stessa voce');
});

prova('nessuno chiede la voce senza dire chi e\'', () => {
  // La costante resta come ultimissima rete, ma non deve essere la voce che
  // si sente normalmente: non appartiene a nessuno.
  const diNessuno = COBRA_DEFAULTS.ELEVENLABS_VOICE_ID;
  const diQualcuno = A.AGENTI.some((a) => a.voce === diNessuno);
  assert.strictEqual(diQualcuno, false,
    'la costante coincide con la voce di un agente: allora si dichiari quella');
});

prova('senza scelta si parla comunque con la voce di COBRA', () => {
  assert.strictEqual(A.quello(undefined).voce, A.predefinito().voce);
  assert.strictEqual(A.quello(null).voce, A.predefinito().voce);
  assert.strictEqual(A.quello('id-che-non-esiste').voce, A.predefinito().voce);
});

prova('il TTS prende la voce da un agente, non da una costante', () => {
  const t = fs.readFileSync(path.join(__dirname, '../modules/routes/tts.js'), 'utf8');
  assert.ok(/quello\(ctx\._agenteScelto\)\.voce/.test(t),
    'tts.js non parte dalla voce dell\'agente');
  assert.ok(!/let voiceId = ctx\.aiKeys\.elevenlabsVoiceId \|\| COBRA_DEFAULTS/.test(t),
    'e\' tornata la vecchia riga che sceglieva una voce di nessuno');
});

prova('il carattere dell\'agente arriva al modello anche se e\' il predefinito', () => {
  const s = fs.readFileSync(path.join(__dirname, '../modules/supermario.js'), 'utf8');
  assert.ok(!/if \(ag && !ag\.predefinito\)/.test(s),
    'il blocco salta il predefinito: COBRA non verrebbe mai applicato');
  assert.ok(/CHI SEI ADESSO/.test(s), 'il blocco non c\'e\' piu\'');
});

prova('la scelta dell\'agente viene scritta su disco', () => {
  const m = fs.readFileSync(path.join(__dirname, '../modules/routes/monitoring.js'), 'utf8');
  assert.ok(/agente_scelto\.json/.test(m),
    'la scelta resta in memoria e muore al riavvio');
});

prova('e viene ripresa all\'avvio', () => {
  const s = fs.readFileSync(path.join(__dirname, '../modules/server-slim.js'), 'utf8');
  assert.ok(/agente_scelto\.json/.test(s), 'server-slim non rilegge la scelta');
  assert.ok(/_agenti\.predefinito\(\)\.id/.test(s),
    'senza scelta salvata non parte dal predefinito');
  assert.ok(/_agenteScelto,/.test(s), '_agenteScelto non e\' nel contesto');
});

if (rotti.length) {
  console.log(`\n✗ chi parla: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ chi parla: ${passati} prove passate`);
}
