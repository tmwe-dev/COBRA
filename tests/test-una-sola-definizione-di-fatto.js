#!/usr/bin/env node
// tests/test-una-sola-definizione-di-fatto.js
//
// PERCHÉ QUESTO FILE
//
// L'8 agosto è emerso un difetto che si ripete in punti lontani del codice,
// sempre nella stessa forma: qualcuno decide che una cosa è andata bene
// guardando qualcosa che non è il risultato.
//
//   `!rawResult.includes('"error"')`  → uno strumento che risponde
//                                       {"ok":false} passa per riuscito
//   `task.status = 'completed'`       → scritto dopo il ciclo, comunque vada
//   `ok: true` fisso in fill_form     → tre campi su cinque = "riuscito"
//   step senza strumento = ok: true   → un job di sole frasi risulta fatto
//
// E la variante gemella: una regola scritta nella descrizione di uno strumento
// ("usa leggi_modulo prima di fill_form") che il modello può semplicemente non
// seguire. Un divieto scritto non è un freno.
//
// Qui si controlla che la definizione di "fatto" sia UNA, e che i freni siano
// nel codice.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');
const handlers = require('../modules/tools/handlers');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

function ctxFinto(risposte = {}) {
  const task = { id: 't1', name: 'prova', steps: [], status: 'attesa' };
  return {
    tasks: [task], _task: task,
    session: {}, persistTasks() {}, log() {},
    emitThinking() {}, emitReasoning() {}, wsBroadcast() {},
    executeTool: async (nome) => risposte[nome] ?? JSON.stringify({ ok: true }),
  };
}

(async () => {
  console.log('\n=== UNA SOLA DEFINIZIONE DI "FATTO" ===');

  sezione('run_task: un passo fallito non fa un lavoro riuscito');
  {
    const ctx = ctxFinto({ read_page: JSON.stringify({ ok: false, motivo: 'pagina vuota' }) });
    ctx._task.steps = [{ tool: 'read_page', args: {} }];
    const r = JSON.parse(await handlers.run_task({ task_id: 't1' }, ctx));
    ok('uno strumento che dice ok:false non e un passo riuscito', r.ok === false);
    ok('e il job NON risulta completato', ctx._task.status !== 'completed', ctx._task.status);
    // Il dettaglio sta in `mancano`, dove il cancello mette una riga per cosa
    // manca; `motivo` e' il riassunto. L'informazione che serve al modello per
    // riprendere e' quella dettagliata.
    ok('e dice quale passo e mancato',
       JSON.stringify(r.mancano || []).includes('read_page') || /read_page/.test(r.motivo || ''));
    ok('e gli dice di NON ricominciare da capo', /NON ricominciare/.test(r.cosaFare || ''));
  }

  sezione('run_task: una frase non e un lavoro');
  {
    const ctx = ctxFinto();
    ctx._task.steps = [
      { description: 'Cerca dieci aziende' },
      { description: 'Confrontale' },
      { description: 'Produci il report' },
    ];
    const r = JSON.parse(await handlers.run_task({ task_id: 't1' }, ctx));
    ok('tre frasi senza strumenti NON sono un job completato', r.ok === false);
    ok('lo stato non e completed', ctx._task.status !== 'completed', ctx._task.status);
    ok('ogni passo dichiara di non avere prova', (r.results || []).every(s => s.senzaProva === true));
  }

  sezione('run_task: quando e fatto davvero, lo dice');
  {
    const ctx = ctxFinto({ read_page: JSON.stringify({ ok: true, testo: 'contenuto' }) });
    ctx._task.steps = [{ tool: 'read_page', args: {} }];
    const r = JSON.parse(await handlers.run_task({ task_id: 't1' }, ctx));
    ok('un passo riuscito chiude il job', r.ok === true);
    ok('e lo stato e completed', ctx._task.status === 'completed');
  }

  sezione('fill_form: guarda il modulo prima di scriverci');
  {
    const src = fs.readFileSync('modules/tools/handlers/interaction.js', 'utf8');
    ok('il freno e nel codice, non solo nella descrizione', /_moduloLetto/.test(src));
    ok('e leggi_modulo registra cosa ha guardato', /ctx\.session\._moduloLetto = \{/.test(src));
    ok('la lettura vale per QUELLA pagina', /_stessaPagina/.test(src));

    const nav = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
    ok('cambiando pagina la lettura decade', /_moduloLetto = null/.test(nav));

    // Il comportamento vero: senza lettura non si scrive.
    const ctx = {
      session: {}, log() {}, emitThinking() {}, emitReasoning() {},
      isBridgeReady: () => true, getState: () => null,
    };
    const r = JSON.parse(await handlers.fill_form({ fields: { '#nome': 'Luca' } }, ctx));
    ok('senza aver letto il modulo NON compila', r.ok === false);
    ok('e spiega che i selettori inventati danno un modulo vuoto',
       /inventati/.test(r.cosaFare || ''));

    // Con la lettura fatta sulla stessa pagina, il freno non ostacola.
    const ctx2 = {
      session: { _moduloLetto: { quando: Date.now(), pagina: 'https://x.it/form', campi: ['#nome'] },
                 lastPage: { url: 'https://x.it/form' } },
      log() {}, emitThinking() {}, emitReasoning() {},
      isBridgeReady: () => false, getState: () => null,
    };
    const r2 = JSON.parse(await handlers.fill_form({ fields: { '#nome': 'Luca' } }, ctx2));
    ok('col modulo letto il freno non ostacola', !/non ho ancora guardato/.test(JSON.stringify(r2)));
  }

  sezione('fill_form: un modulo compilato a meta non e compilato');
  {
    const src = fs.readFileSync('modules/tools/handlers/interaction.js', 'utf8');
    ok('il ripiego non dichiara piu ok:true fisso',
       !/return JSON\.stringify\(\{ ok: true, filled: results\.filter/.test(src));
    ok('l esito nasce dai campi non riusciti', /nonRiusciti\.length === 0/.test(src));
    ok('e dice quali campi mancano', /non sono stati compilati/.test(src));
  }

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  UNA SOLA DEFINIZIONE DI FATTO: ${pass} PASS, ${fail} FAIL`);
  console.log(`╚══════════════════════════════════════════╝`);
  process.exit(fail ? 1 : 0);
})();
