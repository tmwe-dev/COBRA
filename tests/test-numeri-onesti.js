#!/usr/bin/env node
// tests/test-numeri-onesti.js — Un numero senza fonte non si consegna.
//
// Caccia del 6 agosto 2026 lungo il percorso pagina → report. Tre difetti,
// tutti nella parte che DOVREBBE garantire che i dati siano veri:
//
//   1. La verifica di provenienza riduceva pagine e importi a stringhe di
//      sole cifre e cercava l'una dentro l'altra. Le cifre della pagina si
//      incollano fra loro e nascono corrispondenze inesistenti. Provato:
//        fonte   "Iberia · 1 scalo · 3 h 46 min · 6 posti rimasti"
//        importo "3.466 €"  → RISULTAVA VERIFICATO
//      Su una pagina da 12.000 caratteri qualunque prezzo si "trovava".
//      Una verifica che dice sempre di sì è peggio di nessuna verifica.
//
//   2. crea_report — il percorso che il sistema stesso raccomanda — non
//      chiamava nessuno dei due controlli, mentre in fondo alla pagina
//      firmava "ogni dato proviene dalle pagine elencate sopra".
//
//   3. normalizzaCella leggeva "$1,234.56" come 1.23456: lo stesso errore di
//      tre ordini di grandezza già corretto sul formato italiano, rimasto
//      vivo su quello inglese. Booking ed Expedia scrivono così.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { importiSenzaFonte, valoreImporto, numeriDi, fontiDelTurno } = require('../modules/security/verifica-dati');
const { normalizzaCella } = require('../modules/output/consegna');
const handlers = require('../modules/tools/handlers/data');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== UN NUMERO SENZA FONTE NON SI CONSEGNA ===');

(async () => {

sezione('Le corrispondenze fantasma non passano piu');
{
  const orari = importiSenzaFonte('Milano-Bogota 3.466 €', 'Iberia · 1 scalo · 3 h 46 min a Madrid · 6 posti rimasti · bagaglio 23 kg');
  ok('un prezzo trovato dentro un orario viene respinto', orari.mancanti.length === 1, JSON.stringify(orari));

  const tassa = importiSenzaFonte('Totale 3.466 €', 'tassa bagaglio 34,66 €');
  ok('una tassa da 34,66 non valida un volo da 3.466', tassa.mancanti.length === 1);

  const partenza = importiSenzaFonte('Hotel 815 €', 'Partenza 08:15 · arrivo 19:25 · durata 15h 10m');
  ok('un orario di partenza non valida il prezzo di un hotel', partenza.mancanti.length === 1);
}

sezione('Ma i prezzi letti davvero passano, in qualunque formato');
{
  ok('stesso formato', importiSenzaFonte('Volo 1.150 €', 'ITA Airways diretto 1.150 € A/R').mancanti.length === 0);
  ok('numero nudo contro formato italiano', importiSenzaFonte('Volo 1150 €', 'ITA Airways 1.150 EUR').mancanti.length === 0);
  ok('formato inglese sulla pagina', importiSenzaFonte('Hotel 1.234,56 €', 'Marriott $1,234.56 per night').mancanti.length === 0);
  ok('un arrotondamento entro l uno per cento e tollerato',
     importiSenzaFonte('circa 1.150 €', 'prezzo finale 1.149 €').mancanti.length === 0);
  ok('ma il due per cento no', importiSenzaFonte('1.150 €', 'prezzo 1.127 €').mancanti.length === 1);
}

sezione('I numeri si leggono come li scrive il mondo');
{
  const casi = [
    ['1.698', 1698], ['1.234,56 €', 1234.56], ['0,99 €', 0.99],
    ['$1,234.56', 1234.56], ['$1,234', 1234], ['12,50', 12.5],
  ];
  for (const [scritto, atteso] of casi) {
    ok(`${scritto} vale ${atteso}`, normalizzaCella(scritto) === atteso, String(normalizzaCella(scritto)));
  }
  ok('e cio che non e un numero resta testo', normalizzaCella('80-120') === '80-120');
}

sezione('Le fonti comprendono le pagine lette in ogni modo');
{
  const soloCache = fontiDelTurno({ _cachePagine: new Map([['a', { content: 'prezzo 1.150 €' }]]) });
  ok('la cache di navigate', /1\.150/.test(soloCache));
  const senzaCache = fontiDelTurno({ lastPage: { markdown: 'letto con read_page: 980 €' } });
  ok('la pagina letta senza estensione', /980/.test(senzaCache), JSON.stringify(senzaCache));
  ok('e nessuna pagina resta stringa vuota, non un errore', fontiDelTurno({}) === '');
  ok('ne una sessione assente', fontiDelTurno(null) === '');
}

sezione('Il report impaginato ora verifica quello che firma');
{
  const base = () => ({
    session: { _cachePagine: new Map([['g', { url: 'https://www.google.com/travel/flights',
      content: 'ITA Airways diretto 1.150 € · Lufthansa via Monaco 950 € · Hotel Ginza 320 €' }]]), pagineDelTurno: [] },
    dataDir: '/tmp/prova-numeri', log: () => {}, wsBroadcast: () => {},
    broadcastFile: () => {}, emitReasoning: () => {}, emitThinking: () => {},
  });
  const R = { consiglio: 'ITA diretto, otto persone su un volo solo.',
    perche: 'Costa di più dello scalo ma con otto persone un ritardo spezza il gruppo in due.' };

  const veri = JSON.parse(await handlers.crea_report({ filename: 'a', titolo: 'Tokyo', raccomandazione: R,
    sezioni: [{ titolo: 'Voli', carte: [{ nome: 'ITA Airways', prezzo: 1150, migliore: true }, { nome: 'Lufthansa via Monaco', prezzo: 950 }] }] }, base()));
  ok('i prezzi letti davvero vengono accettati', veri.ok === true, veri.error);

  const inventato = JSON.parse(await handlers.crea_report({ filename: 'b', titolo: 'Tokyo', raccomandazione: R,
    sezioni: [{ titolo: 'Voli', carte: [{ nome: 'ITA', prezzo: 4499, migliore: true }, { nome: 'Lufthansa', prezzo: 950 }] }] }, base()));
  ok('un prezzo che non sta in nessuna pagina viene rifiutato', !!inventato.error, JSON.stringify(inventato).slice(0, 90));
  ok('e viene detto quale', /4499/.test(inventato.error));

  const ricopiato = JSON.parse(await handlers.crea_report({ filename: 'c', titolo: 'Tokyo', raccomandazione: R,
    sezioni: [
      { titolo: 'Voli Milano', carte: [{ nome: 'ITA', prezzo: 1150 }, { nome: 'Lufthansa', prezzo: 950 }] },
      { titolo: 'Voli Madrid', carte: [{ nome: 'ITA', prezzo: 1150 }, { nome: 'Lufthansa', prezzo: 950 }] },
    ] }, base()));
  ok('due sezioni identiche vengono rifiutate', !!ricopiato.error, JSON.stringify(ricopiato).slice(0, 90));
  ok('dicendo che una ricerca non e stata fatta', /non è stata fatta/.test(ricopiato.error));

  const diverse = JSON.parse(await handlers.crea_report({ filename: 'd', titolo: 'Tokyo', raccomandazione: R,
    sezioni: [
      { titolo: 'Voli', carte: [{ nome: 'ITA', prezzo: 1150 }, { nome: 'Lufthansa', prezzo: 950 }] },
      { titolo: 'Hotel', carte: [{ nome: 'Ginza', prezzo: 320 }, { nome: 'Marunouchi', prezzo: 320 }] },
    ] }, base()));
  ok('ma sezioni davvero diverse passano', diverse.ok === true, diverse.error);

  // Senza pagine lette non si può verificare: il report non deve nemmeno
  // uscire, e infatti rivista.js lo rifiuta per mancanza di fonti.
  const alBuio = JSON.parse(await handlers.crea_report({ filename: 'e', titolo: 'Tokyo', raccomandazione: R,
    sezioni: [{ titolo: 'Voli', carte: [{ nome: 'ITA', prezzo: 9999 }, { nome: 'x', prezzo: 8888 }] }] },
    { session: { _cachePagine: new Map(), pagineDelTurno: [] }, dataDir: '/tmp/prova-numeri',
      log: () => {}, wsBroadcast: () => {}, broadcastFile: () => {}, emitReasoning: () => {}, emitThinking: () => {} }));
  ok('senza nessuna pagina letta il report non esce', !!alBuio.error, JSON.stringify(alBuio).slice(0, 90));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
