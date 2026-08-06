#!/usr/bin/env node
// tests/test-riavvio.js — Riavviare senza aprire il Terminale.
//
// Ogni modifica al codice richiede di rilanciare il server. Finora l'unico
// modo era che Luca aprisse il Terminale e incollasse un comando: su una
// giornata di lavoro sono decine di interruzioni, e ogni volta il lavoro si
// ferma ad aspettare lui.

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

function chiama(metodo, percorso, corpo) {
  return new Promise((r) => {
    const dati = corpo === undefined ? null : JSON.stringify(corpo);
    const req = http.request({
      host: '127.0.0.1', port: 3000, path: percorso, method: metodo, timeout: 4000,
      headers: dati ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dati) } : {},
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { r({ stato: res.statusCode, corpo: JSON.parse(d) }); } catch { r({ stato: res.statusCode, corpo: d }); } });
    });
    req.on('error', () => r({ stato: 0 }));
    req.on('timeout', () => { req.destroy(); r({ stato: 0 }); });
    if (dati) req.write(dati);
    req.end();
  });
}
const attendi = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\n=== RIAVVIO SENZA TERMINALE ===');

(async () => {

sezione('Il bottone c e, e sa aspettare che il server torni');
{
  const h = fs.readFileSync('public/index.html', 'utf8');
  ok('esiste il bottone', /id="btnRiavvia"/.test(h));
  ok('chiama la rotta giusta con la conferma', /conferma: 'riavvia'/.test(h));
  ok('il server che sparisce mentre risponde non e un errore', /il server se ne va mentre risponde: è previsto/.test(h));
  ok('la pagina aspetta che torni a rispondere', /if \(r\.ok\) \{ location\.reload\(\); return; \}/.test(h));
  ok('e non aspetta all infinito', /tentativo > 30/.test(h));
}

sezione('La rotta pretende una conferma esplicita');
{
  // Se qualcun altro tiene già la porta, questo test misura il server
  // SBAGLIATO e fallisce in modo incomprensibile: è successo davvero, e ci
  // sono voluti due giri per capirlo. Meglio dirlo subito.
  const occupata = await chiama('GET', '/api/status');
  if (occupata.stato !== 0) {
    console.log('  \x1b[33m!\x1b[0m La porta 3000 è già occupata da un altro processo.');
    console.log('    Chiudilo prima di questo test: misurerebbe quello, non il mio.');
    process.exit(1);
  }

  const log = fs.openSync('/tmp/test-riavvio.log', 'w');
  const S = spawn('node', ['modules/server-slim.js'], { stdio: ['ignore', log, log] });
  await attendi(6000);

  const vivo = await chiama('GET', '/api/status');
  ok('il server e su', vivo.stato === 200, `http ${vivo.stato}`);

  const vuoto = await chiama('POST', '/api/riavvia', {});
  ok('senza conferma non riavvia', vuoto.stato === 400, `http ${vuoto.stato}`);
  ok('e dice cosa serve', /conferma/.test(JSON.stringify(vuoto.corpo)));

  const sbagliata = await chiama('POST', '/api/riavvia', { conferma: 'forse' });
  ok('una conferma sbagliata nemmeno', sbagliata.stato === 400);

  const ancoraVivo = await chiama('GET', '/api/status');
  ok('dopo i tentativi rifiutati il server e ancora in piedi', ancoraVivo.stato === 200);

  const buona = await chiama('POST', '/api/riavvia', { conferma: 'riavvia' });
  ok('con la conferma giusta risponde ok', buona.stato === 200 && buona.corpo.ok === true, JSON.stringify(buona));
  ok('e risponde PRIMA di uscire, cosi il pannello lo sa', /Riavvio in corso/.test(JSON.stringify(buona.corpo)));

  await attendi(2500);
  const dopo = await chiama('GET', '/api/status');
  ok('poi esce davvero', dopo.stato === 0, `http ${dopo.stato}`);

  const testo = fs.readFileSync('/tmp/test-riavvio.log', 'utf8');
  ok('e lascia detto perche', /\[Riavvio\] Richiesto dal pannello/.test(testo));
  try { S.kill(); } catch (_) { /* già uscito */ }
}

sezione('Uscire con codice 0 e il segnale giusto per il guardiano');
{
  // Il guardiano rilancia in ogni caso, ma il codice 0 distingue un riavvio
  // voluto da un crash quando si va a leggere il log.
  const m = fs.readFileSync('modules/routes/monitoring.js', 'utf8');
  ok('esce con codice 0', /process\.exit\(0\)/.test(m));
  ok('e non subito, per fare in tempo a rispondere', /setTimeout\(\(\) => process\.exit\(0\), 300\)/.test(m));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
