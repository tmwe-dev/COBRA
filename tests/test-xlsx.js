#!/usr/bin/env node
// tests/test-xlsx.js — I file Excel devono essere veri file Excel.
// COBRA produceva CSV con estensione .xlsx: Excel li rifiutava.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
process.chdir(path.resolve(__dirname, '..'));

const { creaXlsx, righeDaTesto, crc32 } = require('../modules/utils/xlsx');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== FILE EXCEL ===');

// ─────────────────────────────────────────
section('Interpretazione del contenuto');
// ─────────────────────────────────────────
ok('CSV con punto e virgola',
   JSON.stringify(righeDaTesto('a;b\n1;2')) === '[["a","b"],[1,2]]',
   JSON.stringify(righeDaTesto('a;b\n1;2')));
ok('CSV con virgola',
   JSON.stringify(righeDaTesto('a,b\n1,2')) === '[["a","b"],[1,2]]');
ok('i numeri diventano numeri, le intestazioni no',
   typeof righeDaTesto('a;b\n1;2')[1][0] === 'number'
   && typeof righeDaTesto('a;b\n1;2')[0][0] === 'string');
ok('il formato italiano 1.234,56 viene interpretato',
   righeDaTesto('p\n1.234,56')[1][0] === 1234.56,
   JSON.stringify(righeDaTesto('p\n1.234,56')));
ok('un codice non diventa numero',
   typeof righeDaTesto('c\nMXP-MAD')[1][0] === 'string');
ok('CSV con virgolette',
   righeDaTesto('a,b\n"uno, due",tre')[1][0] === 'uno, due',
   JSON.stringify(righeDaTesto('a,b\n"uno, due",tre')));
ok('JSON come array di oggetti',
   JSON.stringify(righeDaTesto('[{"nome":"Iberia","prezzo":2150}]')) === '[["nome","prezzo"],["Iberia",2150]]',
   JSON.stringify(righeDaTesto('[{"nome":"Iberia","prezzo":2150}]')));
ok('JSON come array di array',
   JSON.stringify(righeDaTesto('[["a","b"],[1,2]]')) === '[["a","b"],[1,2]]');
ok('tabella markdown',
   JSON.stringify(righeDaTesto('| Compagnia | Prezzo |\n|---|---|\n| Iberia | 2150 |'))
     === '[["Compagnia","Prezzo"],["Iberia","2150"]]',
   JSON.stringify(righeDaTesto('| Compagnia | Prezzo |\n|---|---|\n| Iberia | 2150 |')));
ok('contenuto vuoto', righeDaTesto('').length === 0 && righeDaTesto(null).length === 0);
ok('oggetti con campi diversi non perdono colonne',
   righeDaTesto('[{"a":1},{"b":2}]')[0].length === 2);

// ─────────────────────────────────────────
section('Il file prodotto è un vero Excel');
// ─────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-'));
const percorso = path.join(TMP, 'report.xlsx');
{
  const righe = righeDaTesto('Compagnia;Rotta;Prezzo\nIberia;MXP-MAD-HAV;2150\nAir Europa;MXP-MAD-HAV;1980');
  const buf = creaXlsx(righe, 'Voli');
  fs.writeFileSync(percorso, buf);

  ok('inizia con la firma zip PK', buf.slice(0, 2).toString() === 'PK',
     buf.slice(0, 2).toString('hex'));
  ok('non è un CSV travestito', buf.slice(0, 2).toString() !== 'Co');
  ok('ha una dimensione plausibile', buf.length > 1000, `${buf.length} byte`);

  // Struttura interna richiesta dallo standard
  let elenco = '';
  try { elenco = execSync(`unzip -l "${percorso}"`, { encoding: 'utf8' }); } catch { elenco = ''; }
  for (const parte of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                       'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
    ok(`contiene ${parte}`, elenco.includes(parte), 'archivio non leggibile o parte mancante');
  }

  // Il contenuto deve essere davvero dentro
  let foglio = '';
  try { foglio = execSync(`unzip -p "${percorso}" xl/worksheets/sheet1.xml`, { encoding: 'utf8' }); } catch { foglio = ''; }
  ok('il foglio contiene le intestazioni', /Compagnia/.test(foglio));
  ok('il foglio contiene i dati', /Iberia/.test(foglio) && /MXP-MAD-HAV/.test(foglio));
  ok('i numeri sono celle numeriche', /<v>2150<\/v>/.test(foglio), 'i prezzi devono essere numeri, non testo');
  ok('il nome del foglio è quello indicato',
     /name="Voli"/.test(execSync(`unzip -p "${percorso}" xl/workbook.xml`, { encoding: 'utf8' })));
}

// ─────────────────────────────────────────
section('Robustezza');
// ─────────────────────────────────────────
{
  ok('caratteri speciali non rompono il file',
     creaXlsx([['A & B', '<script>', '"virgolette"']], 'X').slice(0, 2).toString() === 'PK');
  ok('molte righe non rompono il file',
     creaXlsx(Array.from({ length: 500 }, (_, i) => [`riga ${i}`, i]), 'X').length > 5000);
  ok('righe di lunghezza diversa sono ammesse',
     creaXlsx([['a', 'b', 'c'], ['solo uno']], 'X').slice(0, 2).toString() === 'PK');
  ok('nessuna riga produce comunque un file valido',
     creaXlsx([], 'X').slice(0, 2).toString() === 'PK');
  ok('il calcolo di controllo è coerente',
     crc32(Buffer.from('test')) === crc32(Buffer.from('test'))
     && crc32(Buffer.from('test')) !== crc32(Buffer.from('altro')));
}

// ─────────────────────────────────────────
section('Il gestore rifiuta contenuti non tabellari');
// ─────────────────────────────────────────
{
  const src = fs.readFileSync('modules/tools/handlers/data.js', 'utf8');
  ok('create_file gestisce xlsx a parte', /estensione === 'xlsx'/.test(src));
  ok('rifiuta un contenuto non tabellare', /Contenuto vuoto o non tabellare/.test(src));
  ok('non scrive più testo dentro un xlsx',
     !/writeFileSync\(filePath, args\.content \|\| ''\);[\s\S]{0,50}xlsx/.test(src));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* pulizia best-effort */ }


// ─────────────────────────────────────────
section('Un foglio con la sola intestazione non e un report');
// ─────────────────────────────────────────
{
  const { righeDaTesto } = require('../modules/utils/xlsx');
  const soloTestata = righeDaTesto('Voli;Hotel;Escursioni;Prezzi;Link');
  const conDati = soloTestata.filter(r => r.join('').trim().length > 0).length;
  ok('una sola riga viene riconosciuta come vuota', conDati <= 1, `righe con dati: ${conDati}`);

  const pieno = righeDaTesto('Voli;Prezzo\nAir Tahiti;5.400 EUR');
  const conDati2 = pieno.filter(r => r.join('').trim().length > 0).length;
  ok('con almeno una riga di dati passa', conDati2 > 1, `righe con dati: ${conDati2}`);

  const sorgente = require('fs').readFileSync('modules/tools/handlers/data.js', 'utf8');
  ok('create_file rifiuta il foglio senza dati', /SCRITTURA RIFIUTATA: c\\'e solo la riga di intestazione|solo la riga di intestazione/.test(sorgente));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
