#!/usr/bin/env node
// tests/test-ssrf-lati.js — Chi apre l'indirizzo cambia il rischio.
//
// Rilievo di un audit esterno su COBRA v11, 6 agosto 2026:
//
//   "Quando il DNS fallisce per timeout o errore transitorio, il codice
//    permette di proseguire in modalità degradata. Sarebbe meglio distinguere
//    rigidamente fetch server-side e navigazione browser. Per le richieste
//    server-side un fallimento DNS dovrebbe essere fail-closed."
//
// Il rilievo era fondato, e il codice lo ammetteva da solo in un commento:
// "nel percorso bridge la pagina la apre comunque Chrome". Solo che quel
// ragionamento valeva per TUTTI i chiamanti, compresi i cinque che fanno una
// richiesta dal server — cioè da dentro la rete di Luca, dove un dominio che
// risolve a un indirizzo interno raggiunge il gestionale o la console del
// router.
//
// Ora la strada si divide, e il valore predefinito è quello sicuro: chi
// aggiunge un chiamante domani è protetto senza doverci pensare.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { assertSSRFSafe } = require('../modules/security/ssrf');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== CHI APRE L INDIRIZZO CAMBIA IL RISCHIO ===');

(async () => {

sezione('DNS muto: dal server no, dal browser si');
{
  // timeoutMs a 1ms costringe il fallimento transitorio senza dipendere dalla rete
  const dalServer = await assertSSRFSafe('https://esempio-qualunque.it', { timeoutMs: 1 });
  ok('una richiesta dal server viene bloccata', dalServer.safe === false, JSON.stringify(dalServer));
  ok('e il motivo spiega il pericolo vero', /rete interna/.test(dalServer.reason), dalServer.reason);
  ok('dicendo anche cosa fare', /Riprova fra poco/.test(dalServer.reason));

  const dalBrowser = await assertSSRFSafe('https://esempio-qualunque.it', { timeoutMs: 1, lato: 'browser' });
  ok('una pagina aperta da Chrome passa', dalBrowser.safe === true, JSON.stringify(dalBrowser));
  ok('ed è dichiarata degradata, non normale', dalBrowser.degradato === true);
  ok('col motivo giusto', /apre Chrome/.test(dalBrowser.reason));
}

sezione('Il valore predefinito e quello sicuro');
{
  const senzaDirlo = await assertSSRFSafe('https://esempio-qualunque.it', { timeoutMs: 1 });
  ok('chi non dichiara il lato viene trattato come server', senzaDirlo.safe === false);

  const src = fs.readFileSync('modules/security/ssrf.js', 'utf8');
  ok('e sta scritto nel codice perche', /chi aggiunge un chiamante domani è protetto/.test(src));
  ok('il predefinito e server, non browser', /lato = 'server'/.test(src));
}

sezione('La difesa vera non e stata toccata');
{
  const interno = await assertSSRFSafe('http://192.168.1.1');
  ok('un indirizzo interno resta bloccato', interno.safe === false);
  const locale = await assertSSRFSafe('http://127.0.0.1:3000');
  ok('anche il computer stesso', locale.safe === false);
  const metadati = await assertSSRFSafe('http://169.254.169.254/latest');
  ok('e i metadati cloud', metadati.safe === false);
  const brutto = await assertSSRFSafe('ftp://esempio.it/file');
  ok('un protocollo non consentito nemmeno', brutto.safe === false);

  // E nemmeno dichiarando il lato browser si passa: quelle sono difese
  // sull'indirizzo, non sul resolver.
  const internoBrowser = await assertSSRFSafe('http://192.168.1.1', { lato: 'browser' });
  ok('dire "browser" non apre la rete interna', internoBrowser.safe === false, JSON.stringify(internoBrowser));
}

sezione('Ogni chiamante usa il lato giusto');
{
  const nav = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
  ok('navigate dichiara il browser', /assertSSRFSafe\(url, \{ lato: 'browser' \}\)/.test(nav));
  ok('e dice perche', /la pagina la apre Chrome/.test(nav));

  // Tutti gli altri fanno una richiesta dal server: devono restare al valore
  // predefinito, cioè fail-closed.
  for (const f of ['modules/tools/handlers/read-scrape.js', 'modules/tools/handlers/data.js']) {
    const src = fs.readFileSync(f, 'utf8');
    const chiamate = (src.match(/assertSSRFSafe\(/g) || []).length;
    const conBrowser = (src.match(/assertSSRFSafe\([^)]*lato: 'browser'/g) || []).length;
    ok(`${path.basename(f)}: nessuna chiamata si dichiara browser`, conBrowser === 0, `${conBrowser} su ${chiamate}`);
  }
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
