// tests/test-cambio-agente.js — Cambiare interlocutore dicendolo, senza sbagliare.
//
// Il rischio di questa funzione non e' non riconoscere: e' riconoscere TROPPO.
// "traduci in inglese questa mail" contiene "inglese" ed e' un lavoro, non un
// cambio di voce. Se scattasse, l'incarico verrebbe mangiato e Luca vedrebbe
// solo "From now on I answer in English" al posto della sua mail tradotta.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { riconosci, conferma } = require('../modules/config/scelta-agente');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}

// ── Quando DEVE scattare ─────────────────────────────────────────────────

prova('per lingua', () => {
  assert.strictEqual(riconosci('parla in inglese').agente.lingua, 'en');
  assert.strictEqual(riconosci('voglio lo spagnolo').agente.lingua, 'es');
  assert.strictEqual(riconosci('metti l\'inglese').agente.lingua, 'en');
});

prova('per mestiere', () => {
  assert.ok(/ANALISTA/.test(riconosci('passa all\'analista').agente.nome));
});

prova('per nome, e vince il piu\' specifico', () => {
  // "COBRA" e' contenuto in "COBRA ES": in ordine naturale la richiesta di
  // spagnolo faceva rispondere l'italiano.
  assert.strictEqual(riconosci('COBRA ES').agente.nome, 'COBRA ES');
  assert.strictEqual(riconosci('COBRA EN').agente.nome, 'COBRA EN');
  assert.strictEqual(riconosci('COBRA ANALISTA').agente.nome, 'COBRA ANALISTA');
  assert.strictEqual(riconosci('COBRA').agente.nome, 'COBRA');
});

prova('per ritorno', () => {
  assert.strictEqual(riconosci('torna a cobra').agente.nome, 'COBRA');
  assert.strictEqual(riconosci('torna normale').agente.nome, 'COBRA');
});

// ── Quando NON deve scattare — la parte che conta ────────────────────────

prova('un lavoro che nomina una lingua resta un lavoro', () => {
  for (const t of [
    'traduci in inglese questa mail',
    'scrivi a Brandon in inglese che il carico parte lunedì',
    'manda un messaggio in spagnolo a Jose',
    'cerca documenti in inglese sulla dogana USA',
  ]) {
    assert.strictEqual(riconosci(t), null, `"${t}" e' stato scambiato per un cambio di agente`);
  }
});

prova('un lavoro che nomina i numeri non chiama l\'analista', () => {
  for (const t of ['analizza i numeri del trimestre', 'fammi un\'analisi dei costi']) {
    assert.strictEqual(riconosci(t), null, `"${t}" ha cambiato agente`);
  }
});

prova('una frase lunga e\' un incarico, non una preferenza', () => {
  const lunga = 'passa all\'analista dei dati di vendita del trimestre scorso e '
    + 'confrontali con quelli dell\'anno precedente per capire se il calo è stagionale';
  assert.strictEqual(riconosci(lunga), null);
});

prova('il vuoto non cambia niente', () => {
  for (const t of ['', '   ', null, undefined]) assert.strictEqual(riconosci(t), null);
});

// ── La conferma ──────────────────────────────────────────────────────────

prova('si conferma nella lingua nuova', () => {
  assert.ok(/English/.test(conferma(riconosci('parla in inglese').agente)));
  assert.ok(/español/.test(conferma(riconosci('parla in spagnolo').agente)));
});

// ── E' agganciato prima del routing ──────────────────────────────────────

prova('il cambio arriva prima che il messaggio diventi un incarico', () => {
  const c = fs.readFileSync(path.join(__dirname, '../modules/routes/chat.js'), 'utf8');
  const iCambio = c.indexOf('scelta-agente');
  const iRouting = c.indexOf('SuperMario.routeIntent(message)');
  assert.ok(iCambio > 0, 'chat.js non riconosce il cambio agente');
  assert.ok(iCambio < iRouting,
    'il cambio agente sta dopo il routing: "parla in inglese" diventerebbe un lavoro da fare');
  assert.ok(/agente_scelto\.json/.test(c), 'il cambio detto a voce non viene ricordato');
});

// ── La misura: quale prompt di lavoro viene scelto ───────────────────────

prova('assemble dichiara quale prompt di lavoro ha usato', () => {
  const s = fs.readFileSync(path.join(__dirname, '../modules/supermario.js'), 'utf8');
  assert.ok(/agenteLavoro: agent/.test(s), 'assemble non dice quale prompt ha scelto');
  const c = fs.readFileSync(path.join(__dirname, '../modules/routes/chat.js'), 'utf8');
  assert.ok(/agenteLavoro: marioResult\.agenteLavoro/.test(c),
    'il registro non conserva quale prompt e\' stato usato');
});

if (rotti.length) {
  console.log(`\n✗ cambio agente: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ cambio agente: ${passati} prove passate`);
}
