#!/usr/bin/env node
// tests/test-consegna.js — Lo standard di consegna, provato sul documento
// vero che non era presentabile: il report della vacanza a Bora Bora.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { componiDocumento, verificaFormato, normalizzaCella, ripulisci, TITOLO_FONTI, TITOLO_REPORT } =
  require('../modules/output/consegna');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== STANDARD DI CONSEGNA ===');

// Il documento realmente consegnato il 5 agosto 2026
const BORA_BORA = [
  ['Categoria', 'Dettagli', 'Prezzo (€)', 'Link'],
  ['**Volo**', 'Milano - Bora Bora, Business Class', '1.698', 'https://www.skyscanner.it/rotte/mila/bob/'],
  ['**Hotel**', 'Four Seasons Resort, Overwater Bungalow', '5.226', 'https://www.tripadvisor.it/x.html'],
  ['**Escursione**', 'Sunset Cruise', '300', 'https://lostbetweenoceans.com/'],
  ['**Escursione**', 'Snorkeling', '80-120', 'https://lostbetweenoceans.com/'],
];

// ─────────────────────────────────────────
sezione('Il markdown non entra nelle celle');
// ─────────────────────────────────────────
{
  ok('gli asterischi spariscono', ripulisci('**Volo**') === 'Volo');
  ok('il corsivo sparisce', ripulisci('*nota*') === 'nota');
  ok('gli apici spariscono', ripulisci('`codice`') === 'codice');
  ok('i cancelletti spariscono', ripulisci('## Titolo') === 'Titolo');
  ok('il testo normale non viene toccato', ripulisci('Four Seasons Resort') === 'Four Seasons Resort');
  ok('valori vuoti non fanno crashare', ripulisci(null) === '' && ripulisci(undefined) === '');
}

// ─────────────────────────────────────────
sezione('I prezzi diventano numeri sommabili');
// ─────────────────────────────────────────
{
  ok('1.698 diventa il numero 1698', normalizzaCella('1.698') === 1698);
  ok('con il simbolo davanti', normalizzaCella('€ 1.698') === 1698);
  ok('con i decimali italiani', normalizzaCella('1.698,50') === 1698.5);
  ok('un intervallo resta testo', normalizzaCella('80-120') === '80-120');
  ok('una descrizione resta testo', normalizzaCella('Sunset Cruise') === 'Sunset Cruise');
  ok('un anno resta leggibile', typeof normalizzaCella('2026') === 'number');
}

// ─────────────────────────────────────────
sezione('Il documento di Bora Bora non era presentabile');
// ─────────────────────────────────────────
{
  const v = verificaFormato(BORA_BORA);
  ok('viene bocciato', v.conforme === false);
  ok('segnala l intestazione mancante', v.problemi.some(p => /intestazione/.test(p)), JSON.stringify(v.problemi));
  ok('segnala le fonti mancanti', v.problemi.some(p => /fonti/.test(p)), JSON.stringify(v.problemi));
  ok('segnala il markdown nelle celle', v.problemi.some(p => /formattazione/.test(p)), JSON.stringify(v.problemi));
}

// ─────────────────────────────────────────
sezione('Lo stesso contenuto, messo nello standard, passa');
// ─────────────────────────────────────────
{
  const doc = componiDocumento({
    titolo: 'Vacanza a Bora Bora, 14-29 agosto 2026',
    righe: BORA_BORA,
    fonti: [
      { url: 'https://www.google.com/travel/flights?q=...', title: 'Google Voli' },
      { url: 'https://www.booking.com/...', title: 'Booking' },
    ],
  });
  const v = verificaFormato(doc);
  ok('adesso è conforme', v.conforme === true, JSON.stringify(v.problemi));

  const piatto = doc.map(r => r.join(' ')).join('\n');
  ok('porta l intestazione', piatto.includes(TITOLO_REPORT));
  ok('porta l oggetto della richiesta', /Bora Bora, 14-29 agosto/.test(piatto));
  ok('porta la data di preparazione', /Preparato il/.test(piatto));
  ok('chiude con le fonti', piatto.includes(TITOLO_FONTI));
  ok('elenca gli indirizzi letti', /google\.com\/travel/.test(piatto) && /booking\.com/.test(piatto));
  ok('gli asterischi sono spariti', !/\*\*/.test(piatto), piatto.substring(0, 200));

  // Il prezzo deve essere un numero VERO dentro la tabella, non una stringa
  const rigaVolo = doc.find(r => r.some(c => String(c).includes('Business Class')));
  ok('il prezzo del volo è un numero', rigaVolo && rigaVolo.some(c => c === 1698), JSON.stringify(rigaVolo));
}

// ─────────────────────────────────────────
sezione('Un documento senza fonti lo dice apertamente');
// ─────────────────────────────────────────
{
  const doc = componiDocumento({ titolo: 'prova', righe: [['a', 'b'], ['1', '2'], ['3', '4']], fonti: [] });
  const piatto = doc.map(r => r.join(' ')).join('\n');
  ok('la sezione fonti c e comunque', piatto.includes(TITOLO_FONTI));
  ok('e dichiara che non ce ne sono', /nessuna pagina consultata/i.test(piatto));
}

// ─────────────────────────────────────────
sezione('Un documento vuoto non passa');
// ─────────────────────────────────────────
{
  const soloTestata = componiDocumento({ titolo: 'vuoto', righe: [['Voli', 'Hotel', 'Prezzi']], fonti: [] });
  ok('la sola intestazione viene bocciata', verificaFormato(soloTestata).conforme === false);
  ok('lo dice con parole chiare',
     verificaFormato(soloTestata).problemi.some(p => /vuoto|contenuto/.test(p)),
     JSON.stringify(verificaFormato(soloTestata).problemi));
}

// ─────────────────────────────────────────
sezione('Robustezza');
// ─────────────────────────────────────────
{
  ok('righe assenti non fanno crashare', Array.isArray(componiDocumento({})));
  ok('verifica su vuoto non crasha', verificaFormato([]).conforme === false);
  ok('verifica su null non crasha', verificaFormato(null).conforme === false);
  const irregolare = componiDocumento({ titolo: 't', righe: [['a'], ['b', 'c', 'd']], fonti: [] });
  const larghezze = new Set(irregolare.map(r => r.length));
  ok('tutte le righe hanno la stessa larghezza', larghezze.size === 1, [...larghezze].join(','));
}

// ─────────────────────────────────────────
sezione('E collegato dove serve');
// ─────────────────────────────────────────
{
  const fs = require('fs');
  const data = fs.readFileSync('modules/tools/handlers/data.js', 'utf8');
  ok('create_file applica lo standard', /componiDocumento/.test(data));
  ok('e non riscrive un documento gia conforme', /giaConforme/.test(data));

  const { Incarico, TIPI } = require('../modules/collega/incarico');
  ok('esiste il criterio formato_consegna', TIPI.includes('formato_consegna'));
  const i = new Incarico({ obiettivo: 'report presentabile', criteri: [{ tipo: 'formato_consegna' }] });
  ok('il criterio boccia il documento grezzo', i.valuta({ righe: BORA_BORA }, {}).soddisfatto === false);
  const buono = componiDocumento({ titolo: 'x', righe: BORA_BORA, fonti: [{ url: 'https://a.it' }] });
  ok('e promuove quello nello standard', i.valuta({ righe: buono }, {}).soddisfatto === true,
     JSON.stringify(i.valuta({ righe: buono }, {}).mancanze));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
