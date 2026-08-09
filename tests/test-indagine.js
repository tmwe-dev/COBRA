// tests/test-indagine.js — Cerca, leggi, capisci cosa manca, cerca QUELLA cosa.
//
// Il caso che questi test difendono e' quello vero: trentuno ricerche di voli
// in cinque giorni che ripetevano le stesse domande, perche' nessuna sapeva
// cosa avevano trovato le trenta precedenti.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { Indagine, forzaDi } = require('../modules/ricerca/indagine');
const { Cantiere } = require('../modules/collega/cantiere');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}

// ── Non chiedere due volte la stessa cosa ────────────────────────────────

prova('la stessa domanda con altre parole e\' la stessa domanda', () => {
  const i = new Indagine();
  assert.strictEqual(i.cercato('voli Milano Madrid prezzi').nuova, true);
  const r = i.cercato('prezzi voli Madrid Milano');
  assert.strictEqual(r.nuova, false, 'stesse parole in altro ordine: e\' la stessa ricerca');
  assert.ok(r.gemella);
});

prova('due domande diverse restano due domande', () => {
  const i = new Indagine();
  i.cercato('voli Milano Madrid');
  assert.strictEqual(i.cercato('hotel Madrid centro').nuova, true);
});

// ── Che fonte e' ─────────────────────────────────────────────────────────

prova('il vettore e\' fonte primaria, l\'aggregatore secondaria, il forum debole', () => {
  assert.strictEqual(forzaDi('https://www.ita-airways.com/it'), 'primaria');
  assert.strictEqual(forzaDi('https://www.dhl.com/it'), 'primaria');
  assert.strictEqual(forzaDi('https://www.skyscanner.it/x'), 'secondaria');
  assert.strictEqual(forzaDi('https://www.reddit.com/r/voli'), 'debole');
});

prova('in dubbio si resta su secondaria, non si promuove per fiducia', () => {
  assert.strictEqual(forzaDi('https://sito-mai-visto.it/pagina'), 'secondaria');
});

// ── Le lacune si sottraggono, non si chiedono ────────────────────────────

prova('un soggetto nominato e mai trovato e\' una lacuna', () => {
  const c = new Cantiere({ campiAttesi: ['prezzo'], quanteVoci: 3 });
  c.annota('Milano-Madrid', { prezzo: '89 €' }, 'https://x.it');
  const l = new Indagine().lacune(c, ['Milano-Madrid', 'Milano-Tokyo'], ['prezzo']);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].cosa, 'Milano-Tokyo');
  assert.strictEqual(l[0].tipo, 'soggetto');
});

prova('un campo vuoto su un soggetto trovato e\' una lacuna diversa', () => {
  const c = new Cantiere({ campiAttesi: ['prezzo', 'durata'], quanteVoci: 1 });
  c.annota('Wizz Air', { prezzo: '89 €' }, 'https://x.it');
  const l = new Indagine().lacune(c, [], ['prezzo', 'durata']);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].tipo, 'campo');
  assert.strictEqual(l[0].cosa, 'durata');
  assert.strictEqual(l[0].soggetto, 'Wizz Air');
});

prova('senza lacune non si propone niente', () => {
  const c = new Cantiere({ campiAttesi: ['prezzo'], quanteVoci: 1 });
  c.annota('Wizz Air', { prezzo: '89 €' }, 'https://x.it');
  assert.strictEqual(new Indagine().lacune(c, ['Wizz Air'], ['prezzo']).length, 0);
});

// ── La prossima ricerca punta a una lacuna, e non si ripete ──────────────

prova('la prossima ricerca nomina la cosa che manca', () => {
  const i = new Indagine();
  const p = i.prossimeRicerche([{ tipo: 'campo', cosa: 'durata', soggetto: 'Wizz Air' }], 'settembre 2026');
  assert.ok(/Wizz Air/.test(p[0].query) && /durata/.test(p[0].query),
    `"${p[0].query}" non punta alla lacuna`);
  assert.strictEqual(p[0].giaFatta, false);
});

prova('una ricerca gia\' fatta viene marcata, non riproposta', () => {
  const i = new Indagine();
  i.cercato('Wizz Air durata settembre 2026');
  const p = i.prossimeRicerche([{ tipo: 'campo', cosa: 'durata', soggetto: 'Wizz Air' }], 'settembre 2026');
  assert.strictEqual(p[0].giaFatta, true, 'ripetere la stessa domanda non produce risposte diverse');
});

// ── I domini che non rendono ─────────────────────────────────────────────

prova('un dominio letto due volte senza cavarne niente si segnala', () => {
  const i = new Indagine();
  i.letta('https://kayak.it/a', false);
  i.letta('https://kayak.it/b', false);
  i.letta('https://ita-airways.com/x', true);
  const d = i.fontiCheNonRendono();
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].dominio, 'kayak.it');
});

prova('un dominio che ha reso non finisce fra quelli inutili', () => {
  const i = new Indagine();
  i.letta('https://ita-airways.com/a', true);
  i.letta('https://ita-airways.com/b', false);
  assert.strictEqual(i.fontiCheNonRendono().length, 0);
});

// ── Una strategia fallita si registra prima di cambiarla ─────────────────

prova('la stessa strategia fallita due volte si conta, non si duplica', () => {
  const i = new Indagine();
  i.fallita('read_page', 'https://skyscanner.it/x', 'PAGINA_VUOTA');
  const s = i.fallita('read_page', 'https://skyscanner.it/y', 'PAGINA_VUOTA');
  assert.strictEqual(s.volte, 2, 'stesso strumento sullo stesso dominio: e\' la stessa strategia');
});

// ── Il blocco nel prompt: concreto, o assente ────────────────────────────

prova('a indagine pulita il prompt non dice niente', () => {
  const c = new Cantiere({ campiAttesi: [], quanteVoci: 0 });
  assert.strictEqual(new Indagine().perIlPrompt(c, [], []), '',
    'un avviso che compare sempre non si legge');
});

prova('il prompt dice cosa manca e con quale ricerca chiuderlo', () => {
  const c = new Cantiere({ campiAttesi: ['prezzo'], quanteVoci: 2 });
  c.annota('Milano-Madrid', { prezzo: '89 €' }, 'https://x.it');
  const p = new Indagine().perIlPrompt(c, ['Milano-Madrid', 'Milano-Tokyo'], ['prezzo'], 'settembre');
  assert.ok(/Milano-Tokyo/.test(p), 'non nomina la lacuna');
  assert.ok(/Ricerche che chiuderebbero/.test(p), 'non propone come chiuderla');
});

prova('il prompt avvisa quando si ripetono le ricerche', () => {
  const i = new Indagine();
  i.cercato('voli Milano Madrid'); i.cercato('Madrid Milano voli'); i.cercato('voli Madrid Milano');
  const c = new Cantiere({ campiAttesi: [], quanteVoci: 0 });
  const p = i.perIlPrompt(c, [], []);
  assert.ok(/ripetuto/.test(p), 'non segnala le ripetizioni');
  assert.ok(/compilando il suo modulo/.test(p), 'non dice cosa fare invece');
});

prova('il prompt sconsiglia i domini che non hanno mai reso', () => {
  const i = new Indagine();
  i.letta('https://kayak.it/a', false); i.letta('https://kayak.it/b', false);
  const c = new Cantiere({ campiAttesi: ['prezzo'], quanteVoci: 1 });
  const p = i.perIlPrompt(c, ['Tokyo'], ['prezzo']);
  assert.ok(/kayak\.it/.test(p) && /Non tornarci/.test(p));
});

// ── Sopravvive, e non e' uno strumento in piu' ───────────────────────────

prova('l\'indagine sopravvive a un riavvio', () => {
  const i = new Indagine();
  i.cercato('x'); i.letta('https://a.it', true); i.fallita('read_page', 'https://b.it', 'X');
  const d = Indagine.daDisco(i.perIlDisco());
  assert.strictEqual(d.ricerche.length, 1);
  assert.strictEqual(d.fonti.size, 1);
  assert.strictEqual(d.strategieFallite.length, 1);
});

prova('non e\' stato aggiunto nessuno strumento nuovo', () => {
  // 40 strumenti su 83 non sono mai stati chiamati in 132 turni. Aggiungerne
  // uno che chiede al modello di ricordarsi di usarlo significa costruire il
  // quarantunesimo orfano, sapendolo.
  const s = fs.readFileSync(path.join(__dirname, '../modules/tools/schemas.js'), 'utf8');
  for (const n of ['indaga', 'indagine', 'ricerca_mirata', 'prossima_ricerca']) {
    assert.ok(!new RegExp(`name:\\s*'${n}'`).test(s),
      `${n} e' diventato uno strumento: doveva essere automatico`);
  }
});

prova('la contabilita\' si riempie dall\'esecutore e si legge dal prompt', () => {
  const e = fs.readFileSync(path.join(__dirname, '../modules/tools/executor.js'), 'utf8');
  assert.ok(/session\.indagine/.test(e), 'executor.js non registra le ricerche');
  assert.ok(/ind\.cercato|\.cercato\(/.test(e), 'le ricerche non vengono registrate');
  assert.ok(/ind\.letta|\.letta\(/.test(e), 'le fonti lette non vengono registrate');
  const c = fs.readFileSync(path.join(__dirname, '../modules/routes/chat.js'), 'utf8');
  assert.ok(/_bloccoRicerca/.test(c), 'il blocco non arriva mai al modello');
});

if (rotti.length) {
  console.log(`\n✗ indagine: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ indagine: ${passati} prove passate`);
}
