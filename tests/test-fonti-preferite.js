// tests/test-fonti-preferite.js — Da dove si comincia, e chi lo decide.
//
// Il 9 agosto COBRA ha aperto ITA Airways, Expedia e TripAdvisor prima di
// arrivare a Google Voli, che e' quello che ha funzionato. Il seme e' la
// conoscenza di Luca; l'ordine se lo guadagna il campo.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FontiPreferite, tipoDiLavoro } = require('../modules/ricerca/fonti-preferite');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}
const nuova = () => new FontiPreferite(fs.mkdtempSync(path.join(os.tmpdir(), 'fonti-')));

prova('riconosce di che lavoro si tratta', () => {
  assert.ok(tipoDiLavoro('cercami un volo Milano-Madrid').includes('voli'));
  assert.ok(tipoDiLavoro('hotel 5 stelle alle Seychelles').includes('hotel'));
  assert.ok(tipoDiLavoro('tariffa DHL per un pacco').includes('spedizioni'));
  assert.deepStrictEqual(tipoDiLavoro('ciao come stai'), []);
});

prova('il seme mette Google Voli per primo, come dice Luca', () => {
  assert.ok(/google\.com\/travel\/flights/.test(nuova().ordine('voli')[0].dominio));
});

prova('e booking per primo sugli hotel', () => {
  assert.strictEqual(nuova().ordine('hotel')[0].dominio, 'booking.com');
});

prova('un sito che non rende scende, ma solo con abbastanza prove', () => {
  const f = nuova();
  const primaKayak = f.ordine('voli').findIndex((o) => /kayak/.test(o.dominio));
  f.comeEAndata('voli', 'https://kayak.it/a', false);
  f.comeEAndata('voli', 'https://kayak.it/b', false);
  assert.strictEqual(f.ordine('voli').findIndex((o) => /kayak/.test(o.dominio)), primaKayak,
    'due fallimenti non bastano a muovere un sito');
  f.comeEAndata('voli', 'https://kayak.it/c', false);
  assert.ok(f.daEvitare('voli').some((e) => /kayak/.test(e.dominio)),
    'tre tentativi a vuoto e il sito va segnalato');
});

prova('un sito che rende sempre non viene retrocesso da un inciampo', () => {
  const f = nuova();
  for (let i = 0; i < 9; i++) f.comeEAndata('voli', 'https://google.com/travel/flights', true);
  f.comeEAndata('voli', 'https://google.com/travel/flights', false);
  assert.ok(/google/.test(f.ordine('voli')[0].dominio), 'un fallimento su dieci lo ha fatto scendere');
});

prova('un posto scoperto sul campo si guadagna una riga', () => {
  const f = nuova();
  for (let i = 0; i < 4; i++) f.comeEAndata('voli', 'https://ita-airways.com/x', true);
  assert.ok(f.ordine('voli').some((o) => /ita-airways/.test(o.dominio)),
    'un sito che ha reso 4 volte su 4 non entra nell\'elenco');
});

prova('la regola di Luca sulle compagnie asiatiche compare quando serve', () => {
  const f = nuova();
  assert.ok(/DIRETTO al sito del vettore/.test(f.perIlPrompt('voli Milano Shanghai in business')));
  assert.ok(!/DIRETTO al sito del vettore/.test(f.perIlPrompt('voli Milano Madrid')));
});

prova('non e\' un recinto, e lo dice', () => {
  const p = nuova().perIlPrompt('cercami un volo');
  assert.ok(/elenco chiuso/.test(p),
    'senza questa riga il modello si ferma ai primi tre anche quando non danno niente');
});

prova('per un lavoro che non c\'entra non dice niente', () => {
  assert.strictEqual(nuova().perIlPrompt('mandami un messaggio su whatsapp a Jose'), '');
});

prova('la memoria sopravvive al riavvio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fonti-'));
  const a = new FontiPreferite(dir);
  for (let i = 0; i < 3; i++) a.comeEAndata('voli', 'https://kayak.it', false);
  assert.strictEqual(new FontiPreferite(dir).daEvitare('voli').length, 1);
});

prova('l\'esecutore registra la resa senza che nessuno glielo chieda', () => {
  const t = fs.readFileSync(path.join(__dirname, '../modules/tools/executor.js'), 'utf8');
  assert.ok(/comeEAndata/.test(t), 'executor.js non registra quale sito ha reso');
  const c = fs.readFileSync(path.join(__dirname, '../modules/routes/chat.js'), 'utf8');
  assert.ok(/_bloccoFonti/.test(c), 'l\'ordine non arriva mai al modello');
});

if (rotti.length) {
  console.log(`\n✗ fonti preferite: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ fonti preferite: ${passati} prove passate`);
}
