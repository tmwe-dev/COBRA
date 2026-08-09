// tests/test-raccolta.js — Quello che si trova si posa da solo.
//
// La regola che questi test difendono e' una sola: un dato che il sistema HA
// GIA' IN MANO non deve dipendere dal fatto che il modello si ricordi di
// scriverlo. Misura del 9 agosto: `annota` chiamato 5 volte su 880, cantiere
// a zero voci. Un ponteggio perfetto su cui nessuno ha mai posato un mattone.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { daRisultato, posaNelCantiere } = require('../modules/cantiere/raccolta');
const { Cantiere } = require('../modules/collega/cantiere');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}

const nuovo = (o = {}) => new Cantiere({ campiAttesi: o.campi || [], quanteVoci: o.quante || 0 });

// ── Le forme vere che gli strumenti restituiscono ────────────────────────

prova('read_table: ogni riga diventa una voce, con la fonte', () => {
  const grezzo = JSON.stringify({ ok: true, headers: ['Compagnia', 'Prezzo', 'Durata'],
    rows: [['Wizz Air', '89 €', '2h 10m'], ['ITA Airways', '142 €', '2h 05m']] });
  const r = daRisultato('read_table', {}, grezzo, 'https://skyscanner.it/voli');
  assert.strictEqual(r.voci.length, 2);
  assert.strictEqual(r.voci[0].nome, 'Wizz Air');
  assert.strictEqual(r.voci[0].campi.prezzo, '89 €');
  assert.strictEqual(r.voci[0].fonte, 'https://skyscanner.it/voli',
    'una voce senza fonte non si puo\' verificare');
});

prova('extract_data: le tabelle dentro la pagina diventano voci', () => {
  const grezzo = JSON.stringify({ ok: true, url: 'https://x.it/tariffe',
    data: { tables: [[['Corriere', 'Tempo'], ['DHL', '24h'], ['UPS', '48h']]] } });
  const r = daRisultato('extract_data', {}, grezzo, null);
  assert.strictEqual(r.voci.length, 2, 'la riga di intestazione non e\' un dato');
  assert.strictEqual(r.voci[0].nome, 'DHL');
  assert.strictEqual(r.voci[0].campi.tempo, '24h');
});

prova('una riga senza nome si scarta', () => {
  const grezzo = JSON.stringify({ ok: true, headers: ['A', 'B'], rows: [['', ''], ['Vero', 'x']] });
  const r = daRisultato('read_table', {}, grezzo, 'https://x.it');
  assert.strictEqual(r.voci.length, 1, 'una voce senza nome non si puo\' ne\' cercare ne\' completare');
});

prova('un fallimento non produce voci inventate', () => {
  for (const g of ['{"ok":false,"motivo":"niente"}', '{"error":"boom"}', 'testo', '']) {
    const r = daRisultato('read_table', {}, g, 'https://x.it');
    assert.strictEqual(r.voci.length, 0, `${g} ha prodotto voci`);
  }
});

prova('un file prodotto viene registrato', () => {
  const r = daRisultato('crea_report', { filename: 'voli.html' },
    JSON.stringify({ ok: true, file: '/tmp/voli.html' }), null);
  assert.strictEqual(r.file.length, 1);
  assert.strictEqual(r.file[0].percorso, '/tmp/voli.html');
});

prova('da una pagina di testo NON si inventano voci', () => {
  // Estrarre "otto aziende" da un testo richiede capirlo, ed e' il mestiere
  // del modello. Fingere di saperlo fare produrrebbe voci sbagliate, che sono
  // peggio di nessuna voce.
  const r = daRisultato('scrape_url', { url: 'https://x.it/chi-siamo' },
    JSON.stringify({ ok: true, markdown: 'Siamo leader nel packaging dal 1975...' }), null);
  assert.strictEqual(r.voci.length, 0);
  assert.strictEqual(r.lettaSenzaRaccolto, 'https://x.it/chi-siamo',
    'ma si deve sapere che e\' stata letta e non ha dato niente');
});

// ── Il cantiere si riempie da solo ───────────────────────────────────────

prova('le voci finiscono nel cantiere senza che nessuno chiami annota', () => {
  const c = nuovo({ campi: ['prezzo'], quante: 2 });
  const r = daRisultato('read_table', {},
    JSON.stringify({ ok: true, headers: ['Nome', 'Prezzo'], rows: [['A', '10'], ['B', '20']] }),
    'https://x.it');
  const conto = posaNelCantiere(c, r);
  assert.strictEqual(conto.annotate, 2);
  assert.strictEqual(c.voci.size, 2);
  assert.strictEqual(c.complete(), 2, 'con il prezzo dentro, le voci sono complete');
});

prova('una tabella enorme non seppellisce il cantiere', () => {
  const righe = Array.from({ length: 200 }, (_, i) => [`Riga ${i}`, `${i}`]);
  const c = nuovo();
  const conto = posaNelCantiere(c, daRisultato('read_table', {},
    JSON.stringify({ ok: true, headers: ['Nome', 'N'], rows: righe }), 'https://x.it'));
  assert.ok(conto.annotate <= 50, `posate ${conto.annotate}: il prompt diventerebbe illeggibile`);
});

prova('le pagine lette a vuoto si contano, e non si contano due volte', () => {
  const c = nuovo();
  for (const u of ['https://a.it/x?q=1', 'https://a.it/x?q=2', 'https://b.it']) {
    posaNelCantiere(c, daRisultato('scrape_url', { url: u }, '{"ok":true}', null));
  }
  assert.strictEqual(c.letteAVuoto.length, 2, 'la stessa pagina con query diverse e\' la stessa pagina');
});

prova('senza cantiere aperto non succede niente e non si rompe niente', () => {
  const conto = posaNelCantiere(null, daRisultato('read_table', {},
    JSON.stringify({ ok: true, rows: [['A', '1']] }), 'https://x.it'));
  assert.strictEqual(conto.annotate, 0);
});

// ── Quello che il Collega deve poter leggere ─────────────────────────────

prova('zero voci dopo tre pagine dice "cambia strada", non "comincia"', () => {
  const c = nuovo({ campi: ['prezzo'], quante: 3 });
  for (const u of ['https://a.it', 'https://b.it', 'https://c.it']) {
    posaNelCantiere(c, daRisultato('read_page', { url: u }, '{"ok":true}', null));
  }
  const p = c.perIlPrompt();
  assert.ok(/ATTENZIONE/.test(p), 'il prompt non avvisa');
  assert.ok(/3 pagine/.test(p), 'non dice quante');
  assert.ok(/cambia strada/i.test(p), 'non dice cosa fare invece');
});

prova('a cantiere davvero nuovo non si avvisa di niente', () => {
  const p = nuovo({ quante: 3 }).perIlPrompt();
  assert.ok(!/ATTENZIONE/.test(p), 'un lavoro appena iniziato non e\' un lavoro in difficolta\'');
});

prova('il conto delle pagine lette sopravvive a un riavvio', () => {
  const c = nuovo();
  c.letta('https://a.it'); c.letta('https://b.it');
  const dopo = Cantiere.daDisco(c.perIlDisco());
  assert.strictEqual(dopo.letteAVuoto.length, 2);
});

prova('il riepilogo dice quante pagine non hanno reso', () => {
  const c = nuovo();
  c.letta('https://a.it');
  assert.strictEqual(c.riepilogo().pagineLetteSenzaRaccolto, 1);
});

// ── E' agganciata dove passano tutte le esecuzioni ───────────────────────

prova('la raccolta gira nell\'esecutore, non nei singoli handler', () => {
  const t = fs.readFileSync(path.join(__dirname, '../modules/tools/executor.js'), 'utf8');
  assert.ok(/posaNelCantiere/.test(t), 'executor.js non raccoglie');
  const d = path.join(__dirname, '../modules/tools/handlers');
  const negliHandler = fs.readdirSync(d).filter((f) => f.endsWith('.js')
    && /posaNelCantiere/.test(fs.readFileSync(path.join(d, f), 'utf8')));
  assert.strictEqual(negliHandler.length, 0,
    `raccolgono anche: ${negliHandler.join(', ')} — tornerebbero 90 posti da ricordarsi`);
});

if (rotti.length) {
  console.log(`\n✗ raccolta: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ raccolta: ${passati} prove passate`);
}
