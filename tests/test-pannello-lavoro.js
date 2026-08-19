// tests/test-pannello-lavoro.js — Far vedere cosa sta facendo, e cosa ha in mano.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Nella chat, mentre COBRA lavorava, si vedeva questo:
//
//     ✓google_search ✓navigate ✓leggi_modulo ✗agisci ✗guarda_pagina
//
// Nomi di funzioni. E quello che veniva raccolto non compariva da nessuna
// parte fino alla risposta finale: per tre minuti non si poteva sapere se
// stesse lavorando o girando a vuoto, e un fallimento diceva solo "✗".
// ══════════════════════════════════════════════════════════════════════

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { descrivi, comeEAndata } = require('../modules/tools/descrizioni');
const { classifica } = require('../modules/diario/tassonomia');
const { COBRA_TOOLS } = require('../modules/tools/schemas');

const ui = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}

// ── Le frasi ─────────────────────────────────────────────────────────────

prova('ogni azione si legge in italiano, non col nome della funzione', () => {
  assert.strictEqual(descrivi('navigate', { url: 'https://www.skyscanner.it/voli' }), 'Apro skyscanner.it');
  assert.strictEqual(descrivi('google_search', { query: 'voli Milano Madrid' }), 'Cerco «voli Milano Madrid»');
  assert.strictEqual(descrivi('guarda_pagina', {}), 'Guardo cosa c\'è sulla pagina');
  assert.strictEqual(descrivi('agisci', { id: 'E7', cosa: 'scrivi', valore: 'Milano' }),
    'Scrivo «Milano» nel campo E7');
  assert.strictEqual(descrivi('agisci', { id: 'E3', cosa: 'clicca' }), 'Premo E3');
});

prova('nessuno strumento resta senza descrizione', () => {
  const muti = COBRA_TOOLS
    .map((t) => t.function.name)
    .filter((n) => { const d = descrivi(n, {}); return !d || d === n; });
  assert.deepStrictEqual(muti, [],
    `senza descrizione: ${muti.join(', ')} — comparirebbero col nome tecnico`);
});

prova('una frase lunga viene accorciata, non troncata a meta parola', () => {
  const d = descrivi('google_search', { query: 'x'.repeat(200) });
  assert.ok(d.length < 70, `${d.length} caratteri: la riga andrebbe a capo`);
  assert.ok(d.includes('…'));
});

prova('descrivere non puo\' rompere il lavoro', () => {
  for (const a of [null, undefined, {}, { url: null }, { query: {} }]) {
    assert.doesNotThrow(() => descrivi('navigate', a));
    assert.doesNotThrow(() => descrivi('strumento_che_non_esiste', a));
  }
});

// ── L'esito ──────────────────────────────────────────────────────────────

prova('quando riesce non si spiega, si e\' visto', () => {
  assert.strictEqual(comeEAndata(classifica('{"ok":true}')), '');
});

prova('quando fallisce si dice il PERCHE\', non "errore"', () => {
  const p = comeEAndata(classifica('{"ok":false,"motivo":"il browser non e\' collegato"}'));
  assert.ok(/browser/.test(p), `mostrava "${p}" invece del motivo`);
});

// ── L'aggancio ───────────────────────────────────────────────────────────

prova('le attivita partono da UN punto solo', () => {
  const e = fs.readFileSync(path.join(__dirname, '../modules/tools/executor.js'), 'utf8');
  assert.ok(/attivita_inizio/.test(e) && /attivita_fine/.test(e),
    'executor.js non annuncia le attività');
  // Prima erano nei tre provider AI: tre punti da tenere allineati, e il
  // messaggio non poteva portare né il motivo né la durata.
  for (const f of ['openai', 'anthropic', 'gemini']) {
    const t = fs.readFileSync(path.join(__dirname, `../modules/ai/${f}.js`), 'utf8');
    assert.ok(!/tool_start|tool_done/.test(t),
      `${f}.js annuncia ancora le sue: sarebbero doppie e senza motivo`);
  }
});

prova('la chat mostra la frase, non il nome della funzione', () => {
  assert.ok(/case 'attivita_inizio'/.test(ui), 'la chat non ascolta le attività');
  assert.ok(/lavoroInizia\(msg\.dice\)/.test(ui), 'non mostra la descrizione');
  assert.ok(!/case 'tool_start'/.test(ui), 'ascolta ancora il messaggio vecchio');
});

prova('il pannello mostra quello che ha in mano', () => {
  assert.ok(/id="lavoroRaccolto"/.test(ui), 'manca il pannello del raccolto');
  assert.ok(/case 'cantiere'/.test(ui), 'il cantiere non arriva al pannello');
  assert.ok(/lavoroFile\(msg\.filename\)/.test(ui), 'i file prodotti non compaiono');
});

prova('tre stati e non due: reso, a meta, vuoto', () => {
  for (const c of ['.rac.reso', '.rac.mezzo', '.rac.vuoto']) {
    assert.ok(ui.includes(c), `manca lo stato ${c}`);
  }
});

prova('il tempo che passa si vede', () => {
  assert.ok(/lavoroOraTempo/.test(ui),
    'su un\'attesa lunga il tempo è l\'unica cosa che distingue "ci mette" da "si è piantato"');
});

prova('una conversazione nuova non mostra il raccolto di quella prima', () => {
  const i = ui.indexOf('function clearChat');
  assert.ok(/lavoroAzzera\(\)/.test(ui.slice(i, i + 600)),
    'le voci vecchie resterebbero, e sembrerebbero raccolte adesso');
});

if (rotti.length) {
  console.log(`\n✗ pannello lavoro: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ pannello lavoro: ${passati} prove passate`);
}
