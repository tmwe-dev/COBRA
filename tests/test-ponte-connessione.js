#!/usr/bin/env node
// tests/test-ponte-connessione.js — Il ponte fra estensione e server.
//
// Il 6 agosto 2026 Chrome segnalava un errore sulla riga "new WebSocket".
// Causa concreta trovata: il server ascolta SOLO su 127.0.0.1, mentre
// l'estensione chiamava "localhost", che su macOS risolve prima in ::1.
// Verificato: http://[::1]:3000 non risponde, http://127.0.0.1:3000 sì.
// La connessione dipendeva dal ripiego IPv4 del browser.

const path = require('path');
const fs = require('fs');
const http = require('http');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const ext = fs.readFileSync('cobra-extension/background.js', 'utf8');
const srv = fs.readFileSync('modules/server-slim.js', 'utf8');

console.log('\n=== IL PONTE: ESTENSIONE ↔ SERVER ===');

sezione('Estensione e server si parlano sullo stesso indirizzo');
{
  ok('l estensione usa l indirizzo IPv4 esplicito', /ws:\/\/127\.0\.0\.1:3000/.test(ext));
  ok('anche per le chiamate http', /http:\/\/127\.0\.0\.1:3000/.test(ext));
  ok('non chiama piu localhost per connettersi', !/(ws|http):\/\/localhost:3000/.test(ext));
  ok('il server ascolta sullo stesso indirizzo', /listen\(PORT, '127\.0\.0\.1'/.test(srv));
}

sezione('Un server spento non diventa un errore rosso dell estensione');
{
  ok('si verifica che il server risponda prima di aprire la socket', /async function serverVivo/.test(ext));
  ok('e il controllo precede la new WebSocket',
     ext.indexOf('await serverVivo()') < ext.indexOf('new WebSocket(COBRA_WS_URL)'));
  ok('lo dice in chiaro invece di allarmare', /Non è un errore dell'estensione/.test(ext));
  ok('si riprova con attesa crescente', /Math\.min\(2000 \* _tentativiConnessione, 30000\)/.test(ext));
  ok('e il contatore si azzera quando entra', /_tentativiConnessione = 0;/.test(ext));
  ok('onerror non lascia eccezioni scoperte', /onerror = \(\) => \{ try \{ ws\.close\(\)/.test(ext));
}

sezione('Il tab di COBRA non viene scambiato per un tab di lavoro');
{
  ok('esiste un solo riconoscitore', /function eIlTabDiCobra/.test(ext));
  ok('accetta entrambe le forme dell indirizzo',
     /localhost:3000'\) \|\| url\.includes\('127\.0\.0\.1:3000/.test(ext));
  const usi = (ext.match(/eIlTabDiCobra\(/g) || []).length;
  ok('viene usato ovunque servisse (5 punti)', usi >= 5, `trovati ${usi}`);
  const grezzi = (ext.match(/includes\('localhost:3000'\)/g) || []).length;
  ok('nessun confronto grezzo rimasto in giro', grezzi === 1, `${grezzi} confronti`);

  // Il riconoscitore, estratto ed eseguito davvero
  const corpo = ext.match(/function eIlTabDiCobra\(url\) \{[\s\S]*?\n\}/)[0];
  const riconosce = new Function(corpo + '; return eIlTabDiCobra;')();
  ok('riconosce localhost', riconosce('http://localhost:3000/index.html'));
  ok('riconosce 127.0.0.1', riconosce('http://127.0.0.1:3000/index.html'));
  ok('non scambia un sito di lavoro per COBRA', !riconosce('https://www.google.com/travel/flights'));
  ok('non si rompe su url mancante', riconosce(undefined) === false && riconosce('') === false);
}

sezione('La versione è stata alzata perché Chrome ricarichi davvero');
{
  const m = JSON.parse(fs.readFileSync('cobra-extension/manifest.json', 'utf8'));
  const [ma, mi, pa] = m.version.split('.').map(Number);
  ok('versione oltre la 2.9.0', ma > 2 || (ma === 2 && (mi > 9 || (mi === 9 && pa >= 1))), m.version);
}

sezione('Il server risponde davvero su IPv4 (prova dal vivo)');
{
  const { spawn } = require('child_process');
  const log = fs.openSync('/tmp/test-ponte.log', 'w');
  const S = spawn('node', ['modules/server-slim.js'], { stdio: ['ignore', log, log] });
  const chiedi = (host) => new Promise((r) => {
    const req = http.get({ host, port: 3000, path: '/api/status', timeout: 3000 }, (res) => {
      res.resume(); r(res.statusCode);
    });
    req.on('error', () => r(0));
    req.on('timeout', () => { req.destroy(); r(0); });
  });
  (async () => {
    await new Promise(r => setTimeout(r, 6000));
    const v4 = await chiedi('127.0.0.1');
    ok('127.0.0.1 risponde', v4 === 200, `http ${v4}`);
    const v6 = await chiedi('::1');
    ok('::1 NON risponde: ecco perche localhost era una scommessa', v6 === 0, `http ${v6}`);
    S.kill();
    console.log('');
    console.log(FAIL === 0
      ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
      : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
    process.exit(FAIL > 0 ? 1 : 0);
  })();
}
