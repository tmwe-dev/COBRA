#!/usr/bin/env node
// tests/test-verifica-dati.js — I controlli sono ricostruiti sul caso reale
// osservato in produzione il 5 agosto 2026, non su esempi inventati.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { importiSenzaFonte, blocchiDuplicati, fontiDelTurno, normalizzaImporto } =
  require('../modules/security/verifica-dati');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== VERIFICA DEI DATI SCRITTI NEI FILE ===');

// Testo autentico letto da Google Voli per BCN→BOG, 8-29 agosto 2026
const PAGINA_BCN = `Ordinati per voli più pertinenti
06:20 BCN 13:40 BOG 3.466 € Andata e ritorno 1 scalo 14 h 20 min KLM
12:20 BCN 19:25 BOG 3.466 € Andata e ritorno 1 scalo 14 h 5 min Air France
15:40 BCN 19:35 BOG 4.472 € Andata e ritorno Diretto 10 h 55 min Avianca`;

// Testo autentico letto per MXP→BOG: le compagnie e i prezzi sono ALTRI
const PAGINA_MXP = `Ordinati per voli più pertinenti
11:05 MXP 18:15 BOG 3.921 € Andata e ritorno 1 scalo 14 h 10 min Air Europa
18:15 MXP 18:15+1 BOG 3.155 € Andata e ritorno 1 scalo 31 h Air Europa`;

const FONTI = PAGINA_BCN + '\n' + PAGINA_MXP;

// ─────────────────────────────────────────
sezione('Normalizzazione degli importi');
// ─────────────────────────────────────────
{
  ok('il separatore delle migliaia non conta', normalizzaImporto('3.466 €') === '3466');
  ok('il simbolo prima o dopo è indifferente', normalizzaImporto('€3,466') === normalizzaImporto('3.466 €'));
  ok('gli spazi non contano', normalizzaImporto(' 4 472 € ') === '4472');
}

// ─────────────────────────────────────────
sezione('A — Un importo mai letto non si scrive');
// ─────────────────────────────────────────
{
  const veri = 'Air France | 12:20 | 19:25 | 3.466 €\nAvianca | 15:40 | 19:35 | 4.472 €';
  ok('gli importi letti passano', importiSenzaFonte(veri, FONTI).mancanti.length === 0);

  // 4.407 € è il valore che COBRA aveva scritto al posto del vero 4.472 €:
  // due cifre invertite, il tipo di errore più difficile da vedere a occhio.
  const storto = 'Avianca | 15:40 | 19:35 | 4.407 €';
  const esito = importiSenzaFonte(storto, FONTI);
  ok('una cifra con due numeri invertiti viene scoperta', esito.mancanti.length === 1, JSON.stringify(esito));
  ok('viene indicato quale importo non torna', /4\.407/.test(esito.mancanti[0] || ''));

  ok('un importo del tutto inventato viene scoperto',
     importiSenzaFonte('Iberia | 5.093 €', FONTI).mancanti.length === 1);
  ok('le cifre piccole non generano falsi allarmi',
     importiSenzaFonte('adulti 1 | bagagli 2 €', FONTI).mancanti.length === 0);
  ok('lo stesso importo ripetuto si conta una volta',
     importiSenzaFonte('3.466 € e ancora 3.466 €', FONTI).totale === 1);
  ok('senza fonti non si accusa nessuno', importiSenzaFonte('1.234 €', '').mancanti.length === 1);
}

// ─────────────────────────────────────────
sezione('B — Il caso reale: un blocco copiato sotto un altro titolo');
// ─────────────────────────────────────────
{
  // Riproduzione fedele del file prodotto: le righe di Barcellona erano vere,
  // ma erano state ricopiate anche sotto Milano.
  const righe = [
    ['Volo Milano-Bogotá', '', ''],
    ['Opzione 1: Air France', 'Partenza 12:20, Arrivo 19:25', '€3.466'],
    ['Opzione 2: Avianca', 'Partenza 15:40, Arrivo 19:35', '€4.407'],
    ['Opzione 3: Air Europa', 'Partenza 20:00, Arrivo 18:15', '€3.381'],
    ['Volo Barcellona-Bogotá', '', ''],
    ['Opzione 1: Air France', 'Partenza 12:20, Arrivo 19:25', '€3.466'],
    ['Opzione 2: Avianca', 'Partenza 15:40, Arrivo 19:35', '€4.407'],
    ['Opzione 3: Air Europa', 'Partenza 20:00, Arrivo 18:15', '€3.381'],
  ];
  const doppi = blocchiDuplicati(righe);
  ok('la copia viene individuata', doppi.length > 0);
  ok('il blocco copiato è di tre righe', doppi[0] && doppi[0].righe === 3, JSON.stringify(doppi));
  ok('vengono indicate entrambe le posizioni',
     doppi[0] && doppi[0].prima === 2 && doppi[0].seconda === 6, JSON.stringify(doppi));
}
{
  // Due tratte con risultati realmente diversi devono passare
  const righe = [
    ['Volo Milano-Bogotá', '', ''],
    ['Air Europa', '11:05 - 18:15', '€3.921'],
    ['Air Europa', '18:15 - 18:15+1', '€3.155'],
    ['Volo Barcellona-Bogotá', '', ''],
    ['KLM', '06:20 - 13:40', '€3.466'],
    ['Air France', '12:20 - 19:25', '€3.466'],
  ];
  ok('risultati diversi non vengono scambiati per copie', blocchiDuplicati(righe).length === 0);
}
{
  ok('una riga sola ripetuta non basta ad accusare',
     blocchiDuplicati([['Totale', '10'], ['a', '1'], ['Totale', '10']]).length === 0);
  ok('le righe vuote non contano come blocco',
     blocchiDuplicati([['', ''], ['', ''], ['', ''], ['', '']]).length === 0);
  ok('una tabella corta non fa crashare', Array.isArray(blocchiDuplicati([['a']])));
  ok('una tabella vuota non fa crashare', blocchiDuplicati([]).length === 0);
}

// ─────────────────────────────────────────
sezione('Le fonti del turno');
// ─────────────────────────────────────────
{
  const sessione = { _cachePagine: new Map([
    ['u1', { content: PAGINA_MXP }],
    ['u2', { content: PAGINA_BCN }],
  ]) };
  const f = fontiDelTurno(sessione);
  ok('raccoglie tutte le pagine lette', f.includes('3.921') && f.includes('4.472'));
  ok('senza cache restituisce vuoto', fontiDelTurno({}) === '');
  ok('con sessione assente non crasha', fontiDelTurno(null) === '');
}

// ─────────────────────────────────────────
sezione('Il controllo è davvero collegato a create_file');
// ─────────────────────────────────────────
{
  const handlers = require('../modules/tools/handlers');
  ok('create_file esiste', typeof handlers.create_file === 'function');
  const sorgente = require('fs').readFileSync('modules/tools/handlers/data.js', 'utf8');
  ok('create_file confronta con le fonti lette', /importiSenzaFonte/.test(sorgente));
  ok('create_file rifiuta i blocchi copiati', /blocchiDuplicati/.test(sorgente));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
