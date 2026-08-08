#!/usr/bin/env node
// tests/test-fonti-e-accessi.js — Imparare la lezione giusta, e non firmare
// niente al posto di Luca.
//
// Due cose trovate durante la prova fisica del 6 agosto, giro Tokyo completo.
//
// 1. IL REGISTRO IMPARAVA AL CONTRARIO.
//    Diceva "ita-airways.com affidabile, 7 letture su 7". Quelle sette volte
//    erano sette schermate di blocco anti-bot: la pagina di blocco è lunga (la
//    stessa frase in sei lingue) e contiene numeri (il codice di riferimento),
//    quindi passava per fonte piena. Il registro consigliava per primo proprio
//    il sito che non ci fa entrare, e il capitolo voli del report è rimasto
//    vuoto. Un registro che impara al contrario è peggio di nessun registro,
//    perché ci si fida.
//
// 2. I MURI DI ACCESSO fermavano il lavoro.
//    Il riquadro "Continua con Google" va tolto di mezzo — sotto la pagina è
//    quasi sempre leggibile. Ma NON si preme: quel gesto concede a un sito
//    l'accesso all'account di Luca, e su molti siti resta valido finché non lo
//    revoca a mano. È una decisione sua.

const path = require('path');
const fs = require('fs');
const os = require('os');
process.chdir(path.resolve(__dirname, '..'));

const { RegistroFonti } = require('../modules/fonti/registro');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const nav = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
const ext = fs.readFileSync('cobra-extension/background.js', 'utf8');

console.log('\n=== LA LEZIONE GIUSTA, E NIENTE FIRME AL POSTO DI LUCA ===');

sezione('Una schermata di blocco viene riconosciuta per quello che è');
{
  ok('esiste il riconoscimento', /testoBlocco/.test(nav));
  ok('e viene passato al registro', /bloccata,/.test(nav) && /dati: haDati && !bloccata/.test(nav));
  ok('la cosa resta scritta nel log', /ha risposto con una schermata di blocco/.test(nav));
  ok('col motivo per chi legge domani', /Un registro che impara al contrario/.test(nav));

  // La regola vera, estratta ed eseguita sul testo autentico di ITA Airways
  const corpo = nav.match(/const testoBlocco = \/[^\n]*\/i;/)[0];
  const testoBlocco = new Function(corpo + ' return testoBlocco;')();

  const bloccoVero = 'Blocked BLOCKED Reference: #a26b9f1cb9a61428 ClientIP: 2a0e:431:3adf:0:15b5 '
    + 'Security check We apologise for the interruption. We detected unusual behaviour from your '
    + 'browser, which resembles that of a bot.';
  ok('la schermata vera di ITA Airways', testoBlocco.test(bloccoVero) === true);
  ok('un controllo Cloudflare', testoBlocco.test('Checking your browser before accessing the site') === true);
  ok('un accesso negato in italiano', testoBlocco.test('Accesso negato: verifica di sicurezza') === true);

  const prezziVeri = 'ITA Airways MXP-HND diretto 1.150 € · partenza 08:15 · Lufthansa via Monaco 950 €';
  ok('ma una pagina coi prezzi non viene scambiata per un blocco', testoBlocco.test(prezziVeri) === false);
}

sezione('E il registro ne trae la conclusione giusta');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const r = new RegistroFonti(dir);
  // Sette letture, tutte schermate di blocco: lunghe e con numeri dentro
  for (let i = 0; i < 7; i++) {
    r.registra('https://www.ita-airways.com/it_it/voli/milano-tokyo', {
      caratteri: 2400, bloccata: true, dati: false,
    });
  }
  const g = r.giudizio('ita-airways.com');
  ok('sette blocchi non fanno una fonte affidabile', g.verdetto === 'da_evitare', JSON.stringify(g));

  for (let i = 0; i < 5; i++) {
    r.registra('https://www.google.com/travel/flights?q=' + i, { caratteri: 9000, bloccata: false, dati: true });
  }
  ok('mentre una fonte che risponde resta affidabile', r.giudizio('google.com').verdetto === 'affidabile');

  const blocco = r.perIlPrompt();
  ok('e il prompt dice a chi rivolgersi', /google\.com/.test(blocco));
  ok('e chi evitare', /ita-airways\.com/.test(blocco));
  ok('il consigliato viene prima dello sconsigliato',
     blocco.indexOf('google.com') < blocco.indexOf('ita-airways.com'));
}

sezione('I muri di accesso si chiudono');
{
  ok('vengono riconosciuti', /const testiAccesso/.test(ext));
  ok('in italiano e in inglese', /'accedi con google'/.test(ext) && /'continue with google'/.test(ext));
  ok('e per i principali fornitori', /facebook/.test(ext) && /apple/.test(ext) && /linkedin/.test(ext));
  ok('prima si cerca la X, che e il modo pulito', /chiuso il riquadro di accesso/.test(ext));
  ok('e se non c e, si toglie il riquadro', /tolto il riquadro di accesso/.test(ext));
  ok('un riquadro troppo lungo non e un popup di accesso', /t\.length > 600/.test(ext));
}

sezione('Ma NON si concede l accesso all account di Luca');
{
  // Il punto che conta: fra le azioni possibili non deve esserci il click sul
  // pulsante che concede i permessi.
  const blocco = ext.slice(ext.indexOf('const testiAccesso'), ext.indexOf('// 2. Esc'));
  ok('nessun click su "continua con Google"',
     !/click\(\)[^\n]*google/i.test(blocco) && !/continua con google[^\n]*click/i.test(blocco));
  ok('i testi di accesso servono a TROVARE il riquadro, non a premerlo',
     /testiAccesso\.some\(x => t\.includes\(x\)\)/.test(blocco));
  ok('e viene dichiarato che l accesso non e stato fatto', /non ho fatto l\\'accesso/.test(blocco));
  ok('il motivo e scritto per chi leggera domani', /È una decisione sua/.test(ext));
  ok('e si dice cosa fare quando serve davvero', /si chiede a lui/.test(ext));

  // I testi di chiusura non devono contenere per sbaglio un consenso
  const chiusura = ext.match(/const chiusuraTesti = \[[\s\S]*?\];/)[0];
  ok('la lista dei pulsanti da premere non contiene "google"', !/google/i.test(chiusura));
  ok('ne "accedi" o "login"', !/\baccedi\b|\blogin\b|\bsign in\b/i.test(chiusura));
}

sezione('La versione e stata alzata');
{
  const m = JSON.parse(fs.readFileSync('cobra-extension/manifest.json', 'utf8'));
  const [ma, mi] = m.version.split('.').map(Number);
  ok('oltre la 2.11', ma > 2 || (ma === 2 && mi >= 12), m.version);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
