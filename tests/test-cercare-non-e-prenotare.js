#!/usr/bin/env node
// tests/test-cercare-non-e-prenotare.js
//
// Prova fisica del 6 agosto 2026 su Google Voli. Richiesta:
//   "compila il modulo di ricerca: da Milano a Tokyo, 14-28 settembre, 8
//    passeggeri, economy"
// Nel log del server:
//   [SuperMario] Sola lettura: esclusi fill_form, type_human
//   [Collega] Verdetto: 1/6 criteri
//
// COBRA ha aperto Google Voli e non ha potuto scrivere una parola nei campi.
// Non per incapacità: gli era stato tolto lo strumento.
//
// La regola che lo toglieva nasce giusta — impedire che una richiesta di
// viaggio finisca per premere "Conferma prenotazione" — ma guardava il
// DOMINIO invece dell'INTENZIONE: bastava la parola "volo" o "hotel". Su
// qualunque ricerca di viaggio, cioè metà del lavoro di Luca, il modulo di
// ricerca era inaccessibile per costruzione.
//
// Secondo difetto trovato dal test stesso: scritta come "acquist\b", la
// regola non trovava "acquista" — la parola continua, quindi il confine non
// c'è. Lasciava passare proprio il caso che deve fermare.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
const regola = new Function('return ' + chat.match(/const vuolePrenotare = (\/.*\/i);/)[1] + ';')();

console.log('\n=== CERCARE NON È PRENOTARE ===');

sezione('Il lavoro di tutti i giorni non viene piu bloccato');
{
  const lavori = [
    'compila il modulo di ricerca su Google Voli, da Milano a Tokyo',
    'cerca i voli Milano Tokyo a settembre',
    'confronta gli hotel 5 stelle a Tokyo',
    'trova il volo più economico per Madrid',
    'guarda le disponibilità dell hotel per il 14 settembre',
    'quanto costa un volo per Bogotà a marzo',
  ];
  for (const m of lavori) ok(`lavora: "${m.slice(0, 44)}"`, regola.test(m.toLowerCase()) === false);
}

sezione('Ma l irreversibile si ferma ancora');
{
  const stop = [
    'prenota il volo delle 8:15',
    'acquista il biglietto Milano Tokyo',
    'compra due biglietti',
    'conferma l ordine e paga',
    'procedi al checkout',
    'emetti il biglietto',
    'paga con la carta salvata',
    'fai la prenotazione dell hotel',
  ];
  for (const m of stop) ok(`si ferma: "${m.slice(0, 44)}"`, regola.test(m.toLowerCase()) === true);
}

sezione('I prefissi funzionano davvero');
{
  // Il difetto che il test ha trovato: "acquist\b" non trova "acquista".
  ok('acquista, acquistare, acquisto', ['acquista', 'acquistare', 'acquisto'].every(w => regola.test(w)));
  ok('prenota, prenotare, prenotazione', ['prenota', 'prenotare', 'prenotazione'].every(w => regola.test(w)));
  ok('paga, pagamento', ['paga', 'pagamento'].every(w => regola.test(w)));
  ok('e il motivo resta scritto', /non trova\s*\n?\s*\/\/ "acquista"|"acquist\\b" non trova/.test(chat));
}

sezione('E non si ferma su parole che assomigliano');
{
  // Falsi positivi: parole che contengono le stesse lettere ma non c'entrano
  ok('"paganesimo" non è un pagamento', regola.test('storia del paganesimo') === false);
  ok('"comprensione" non è comprare', regola.test('serve comprensione del mercato') === false);
  ok('"impaginare" non è pagare', regola.test('impaginare il report') === false);
}

sezione('La protezione vera resta dove deve stare');
{
  ok('la regola non tocca il livello di rischio degli strumenti',
     !/vuolePrenotare[\s\S]{0,300}TOOL_RISK/.test(chat));
  const rischio = fs.readFileSync('modules/risk/taxonomy.js', 'utf8');
  ok('esiste ancora la classificazione del rischio', /confirm/.test(rischio));

  const inter = fs.readFileSync('modules/tools/handlers/interaction.js', 'utf8');
  ok('e i campi di pagamento restano vietati sempre', /Non posso compilare campi di pagamento/.test(inter));
  ok('anche in sola ricerca', /PAYMENT_SELECTORS/.test(inter));
}

sezione('Il motivo e scritto per chi leggera domani');
{
  ok('si spiega cosa e successo a schermo', /Sola lettura: esclusi fill_form, type_human/.test(chat));
  ok('e perche la regola vecchia sbagliava', /guardava il DOMINIO/.test(chat));
  ok('e dove resta la protezione', /la classificazione del rischio e la conferma esplicita/.test(chat));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
