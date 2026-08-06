#!/usr/bin/env node
// tests/test-avvio-porta.js — La porta occupata è una coda, non una morte.
//
// Il 5 agosto 2026 COBRA.app e il server del guardiano si sono ammazzati a
// vicenda per un'ora: ognuno moriva con EADDRINUSE, il guardiano rilanciava,
// e l'utente vedeva "failed to fetch". Il primo tentativo di correzione
// (server.once('error')) NON ha funzionato — verificato dal vivo, l'errore
// sfuggiva lo stesso all'uncaughtException. Serviva sondare la porta prima.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== AVVIO: LA PORTA OCCUPATA È UNA CODA ===');

sezione('Il codice sonda invece di sperare');
{
  const s = fs.readFileSync('modules/server-slim.js', 'utf8');
  ok('esiste la sonda della porta', /_portaLibera/.test(s));
  ok('la sonda apre una connessione di prova', /require\('net'\)\.connect/.test(s));
  ok('connessione riuscita significa porta occupata', /once\('connect'.*chiudi\(false\)/.test(s));
  ok('errore significa porta libera', /once\('error'.*chiudi\(true\)/.test(s));
  ok('la sonda ha un tempo massimo', /setTimeout\(\(\) => chiudi\(true\)/.test(s));
  ok('si riprova invece di morire', /aspetto il mio turno/.test(s));
  ok('EADDRINUSE non è più causa di shutdown', !/EADDRINUSE'\)[\s\S]{0,80}process\.exit/.test(s));
  ok('la memoria esaurita resta fatale', /out of memory[\s\S]{0,120}process\.exit/.test(s));
}

sezione('Due server sulla stessa porta: il secondo aspetta e subentra');
{
  const avvia = (out) => execFile('node', ['modules/server-slim.js'], { cwd: process.cwd() },
    () => {}) && null;
  const spawn = require('child_process').spawn;
  const logA = fs.openSync('/tmp/test-porta-a.log', 'w');
  const logB = fs.openSync('/tmp/test-porta-b.log', 'w');
  const A = spawn('node', ['modules/server-slim.js'], { stdio: ['ignore', logA, logA] });

  const attendi = (ms) => new Promise(r => setTimeout(r, ms));
  (async () => {
    await attendi(5000);
    const B = spawn('node', ['modules/server-slim.js'], { stdio: ['ignore', logB, logB] });
    await attendi(6000);
    const bIniziale = fs.readFileSync('/tmp/test-porta-b.log', 'utf8');
    ok('il secondo non muore: aspetta', /aspetto il mio turno/.test(bIniziale), bIniziale.substring(0, 160));
    ok('e non finisce in uncaughtException', !/Uncaught exception/.test(bIniziale));

    A.kill();
    await attendi(9000);
    const bDopo = fs.readFileSync('/tmp/test-porta-b.log', 'utf8');
    ok('quando il primo lascia, il secondo prende la porta', /Server ready/.test(bDopo));
    B.kill();

    console.log('');
    console.log(FAIL === 0
      ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
      : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
    process.exit(FAIL > 0 ? 1 : 0);
  })();
}
