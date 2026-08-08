#!/usr/bin/env node
// tests/test-giro-a-vuoto.js — Perché il turno girava a vuoto.
//
// Prova fisica del 6 agosto 2026, richiesta Tokyo. Dal log del server:
//
//   [Supervisore] INTERROTTO: LOOP DI SEQUENZA
//     [scrape_url→scrape_url→google_search] ripetuto 3x sugli stessi argomenti
//   [Supervisore] INTERROTTO: circular_loop
//     google_search({"query":"voli Milano Tokyo 14-28 settembre 2026"}) x4
//
// Due cause, tutte e due verificate nel log:
//   1. l'Esecutore girava su gpt-4o-mini, perché il tier veniva scelto dal
//      messaggio di Luca — che era "25.000 in tutto, 4 doppie, date fisse.
//      Vai." — invece che dall'incarico, che aveva SEI criteri;
//   2. navigate aveva una cache di turno, google_search no: la stessa query
//      partiva quattro volte e ogni volta riportava allo stesso muro.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== IL TURNO CHE GIRAVA A VUOTO ===');

(async () => {

sezione('Il modello lo decide il lavoro, non la lunghezza del messaggio');
{
  // La scelta del modello non sta piu' sparsa nel turno: e' una deduzione
  // dell'ordine di lavoro, in un posto solo. Il rattoppo e' stato tolto
  // apposta il 7 agosto, quando i sette comandanti sono diventati uno.
  const c = fs.readFileSync('modules/routes/chat.js', 'utf8');
  const cmd = fs.readFileSync('modules/collega/comando.js', 'utf8');
  ok('l incarico decide il modello', /function modelloPer/.test(cmd));
  ok('conta il numero di criteri', /criteri\.length >= 3/.test(cmd));
  ok('e conta anche il tipo di criterio impegnativo',
     /'origine_verificabile', 'file_atteso', 'soggetti_coperti', 'campi_obbligatori'/.test(cmd));
  ok('col motivo scritto', /NON si guarda la lunghezza del messaggio/.test(cmd));
  ok('e il turno obbedisce invece di rattoppare',
     /ctx\._ordineDiLavoro\s*\n?\s*\? \{ tier: ctx\._ordineDiLavoro\.tier/.test(c));

  // Il tier "standard" non è una via di mezzo: è lo stesso modello del "lite"
  const sm = fs.readFileSync('modules/supermario.js', 'utf8');
  const tiers = sm.match(/const MODEL_TIERS = \{[\s\S]*?\n\};/)[0];
  ok('standard e lite sono lo STESSO modello openai: standard non protegge',
     (tiers.match(/openai: 'gpt-4o-mini'/g) || []).length === 2);
  ok('solo power porta al modello grande', /power:.*openai: 'gpt-4o'/.test(tiers));
}

sezione('La stessa ricerca non si fa due volte nello stesso turno');
{
  const s = fs.readFileSync('modules/tools/handlers/search.js', 'utf8');
  ok('esiste la cache delle ricerche', /_cacheRicerche/.test(s));
  ok('la chiave ignora maiuscole e spazi doppi', /toLowerCase\(\)\.replace\(\/\\s\+\/g, ' '\)/.test(s));
  ok('il risultato viene messo in cache', /_cacheRicerche\.set\(chiave, esito\)/.test(s));

  const c = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('e la cache dura un turno solo', /ctx\.session\._cacheRicerche = new Map\(\)/.test(c));

  // Il punto vero: non basta riservire, bisogna DIRLO
  ok('al modello viene detto che la ricerca era gia stata fatta', /giaCercata: true/.test(s));
  ok('e che ripeterla non porta niente', /Ripeterla non porta niente di nuovo/.test(s));
  ok('con l invito esplicito a cambiare strada', /oppure cambia strada/.test(s));
  ok('Luca lo vede succedere', /Questa ricerca l'ho già fatta/.test(s));
}

sezione('La cache funziona davvero');
{
  const handler = require('../modules/tools/handlers/search');
  let ricercheVere = 0;
  const ctx = {
    session: {},
    log: () => {},
    emitReasoning: () => {},
    emitThinking: () => {},
    HumanDriver: { checkAndDelay: async () => { ricercheVere++; return { allowed: false, reason: 'stop' }; } },
  };
  ctx.session._cacheRicerche = new Map();
  // Prima chiamata: passa (e si ferma sul HumanDriver finto, va bene:
  // quello che conta è che abbia PROVATO a cercare davvero)
  await handler.google_search({ query: 'voli Milano Tokyo' }, ctx);
  ok('la prima ricerca viene fatta', ricercheVere === 1);

  // Ora si simula un risultato in cache e si riprova
  ctx.session._cacheRicerche.set('voli milano tokyo', { ok: true, results: [{ url: 'x' }], count: 1 });
  const r2 = JSON.parse(await handler.google_search({ query: '  VOLI   Milano Tokyo ' }, ctx));
  ok('la seconda NON tocca la rete', ricercheVere === 1, `chiamate: ${ricercheVere}`);
  ok('nonostante maiuscole e spazi diversi', r2.giaCercata === true);
  ok('i risultati ci sono comunque', r2.count === 1);
  ok('e l avvertenza dice cosa fare', /cambia strada/.test(r2.avvertenza));
}

sezione('Il pannello non resta su "Working" quando il lavoro e finito');
{
  const h = fs.readFileSync('public/index.html', 'utf8');
  ok('un thinking vuoto spegne il pannello', /if \(msg\.text\) setMonitorBusy\(msg\.text\);\s*\n\s*else setMonitorIdle\(\);/.test(h));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
