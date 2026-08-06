#!/usr/bin/env node
// tests/test-incarico.js — I criteri devono cogliere i guasti VERI, quelli
// osservati in produzione il 5 agosto 2026, non casi di comodo.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { Incarico, TIPI, descriviCriterio } = require('../modules/collega/incarico');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== INCARICO CON CRITERI VERIFICABILI ===');

// Testi autentici letti da Google Voli l'8-29 agosto 2026
const PAGINA_MXP = `11:05 MXP 18:15 BOG 3.921 € 1 scalo 14 h 10 min Air Europa
18:15 MXP 18:15+1 BOG 3.155 € 1 scalo 31 h Air Europa`;
const PAGINA_BCN = `06:20 BCN 13:40 BOG 3.466 € 1 scalo 14 h 20 min KLM
12:20 BCN 19:25 BOG 3.466 € 1 scalo 14 h 5 min Air France
15:40 BCN 19:35 BOG 4.472 € Diretto 10 h 55 min Avianca`;
const PAGINA_MAD = `12:45 MAD 04:05+1 BOG 2.885 € 1 scalo 22 h 20 min Air Canada
08:10 MAD 11:35 BOG 4.097 € Diretto 10 h 25 min Avianca`;

const sessioneConFonti = { _cachePagine: new Map([
  ['a', { content: PAGINA_MXP }], ['b', { content: PAGINA_BCN }], ['c', { content: PAGINA_MAD }],
]) };

function incaricoVoli() {
  return new Incarico({
    obiettivo: 'Trovare voli in business Milano/Madrid/Barcellona verso Bogotá e produrre un report',
    criteri: [
      { tipo: 'soggetti_coperti', soggetti: ['Milano', 'Madrid', 'Barcellona'] },
      { tipo: 'elementi_minimi', quanti: 6 },
      { tipo: 'origine_verificabile' },
      { tipo: 'nessun_duplicato' },
      { tipo: 'file_atteso', estensione: 'xlsx' },
    ],
    vincoli: ['classe business', 'date 8 e 29 agosto 2026'],
    fuoriAmbito: ['prenotare', 'pagare'],
  });
}

// ─────────────────────────────────────────
sezione('Costruzione: un criterio non verificabile non entra');
// ─────────────────────────────────────────
{
  const i = new Incarico({
    obiettivo: 'prova con criteri storti',
    criteri: [
      { tipo: 'elementi_minimi' },                      // senza "quanti"
      { tipo: 'campi_obbligatori', campi: [] },         // senza campi
      { tipo: 'soggetti_coperti' },                     // senza soggetti
      { tipo: 'file_atteso' },                          // senza estensione
      { tipo: 'inventato_di_sana_pianta' },
      { tipo: 'nessun_duplicato' },                     // valido
    ],
  });
  ok('resta solo il criterio verificabile', i.criteri.length === 1, JSON.stringify(i.criteri));
  ok('ogni scarto viene segnalato', i.avvisi.length === 5, JSON.stringify(i.avvisi));
  ok('un incarico senza obiettivo non e valido', new Incarico({ criteri: [{ tipo: 'nessun_duplicato' }] }).valido() === false);
  ok('un incarico senza criteri non e valido', new Incarico({ obiettivo: 'fai qualcosa di utile' }).valido() === false);
  ok('con obiettivo e criteri e valido', incaricoVoli().valido() === true);
  ok('i tipi dichiarati sono sette', TIPI.length === 7);
}

// ─────────────────────────────────────────
sezione('IL CASO REALE: il blocco di Barcellona ricopiato sotto Milano');
// ─────────────────────────────────────────
{
  // Quello che COBRA aveva davvero consegnato. Le righe di Barcellona erano
  // vere; le stesse righe erano state messe anche sotto Milano, dove i voli
  // veri erano altri. E un importo era storto: 4.407 invece di 4.472.
  const esitoDifettoso = {
    righe: [
      ['Voli Milano-Bogotá'],
      ['Air France', '12:20 - 19:25', '3.466 €'],
      ['Avianca', '15:40 - 19:35', '4.407 €'],
      ['Voli Barcellona-Bogotá'],
      ['Air France', '12:20 - 19:25', '3.466 €'],
      ['Avianca', '15:40 - 19:35', '4.407 €'],
      ['Voli Madrid-Bogotá'],
      ['Air Canada', '12:45 - 04:05+1', '2.885 €'],
    ],
    file: [{ filename: 'report.xlsx' }],
  };
  const v = incaricoVoli().valuta(esitoDifettoso, sessioneConFonti);

  ok('l incarico NON risulta soddisfatto', v.soddisfatto === false);
  ok('la copia viene colta', v.esiti.find(e => e.tipo === 'nessun_duplicato').soddisfatto === false);
  ok('l importo storto viene colto',
     v.esiti.find(e => e.tipo === 'origine_verificabile').soddisfatto === false);
  ok('nomina proprio 4.407',
     v.mancanze.some(m => /4\.407/.test(m)), JSON.stringify(v.mancanze));
  ok('i tre soggetti risultano nominati', v.esiti.find(e => e.tipo === 'soggetti_coperti').soddisfatto === true);
  ok('il file richiesto c e', v.esiti.find(e => e.tipo === 'file_atteso').soddisfatto === true);
}

// ─────────────────────────────────────────
sezione('Lo stesso incarico, con il risultato corretto, passa');
// ─────────────────────────────────────────
{
  const esitoBuono = {
    righe: [
      ['Voli Milano-Bogotá'],
      ['Air Europa', '11:05 - 18:15', '3.921 €'],
      ['Air Europa', '18:15 - 18:15+1', '3.155 €'],
      ['Voli Madrid-Bogotá'],
      ['Air Canada', '12:45 - 04:05+1', '2.885 €'],
      ['Avianca', '08:10 - 11:35', '4.097 €'],
      ['Voli Barcellona-Bogotá'],
      ['KLM', '06:20 - 13:40', '3.466 €'],
      ['Air France', '12:20 - 19:25', '3.466 €'],
      ['Avianca', '15:40 - 19:35', '4.472 €'],
    ],
    file: [{ filename: 'report_viaggio.xlsx' }],
  };
  const v = incaricoVoli().valuta(esitoBuono, sessioneConFonti);
  ok('risulta soddisfatto', v.soddisfatto === true, JSON.stringify(v.mancanze));
  ok('tutti i criteri passano', v.soddisfatti === v.totale, `${v.soddisfatti}/${v.totale}`);
  ok('non c e nulla da rimproverare', v.mancanze.length === 0);
}

// ─────────────────────────────────────────
sezione('Un soggetto non trattato viene nominato');
// ─────────────────────────────────────────
{
  const i = new Incarico({
    obiettivo: 'voli da tre citta',
    criteri: [{ tipo: 'soggetti_coperti', soggetti: ['Milano', 'Madrid', 'Barcellona'] }],
  });
  const v = i.valuta({ righe: [['Voli Milano'], ['Air Europa', '3.921 €'], ['Voli Madrid'], ['Avianca', '4.097 €']] }, sessioneConFonti);
  ok('accorge che manca Barcellona', v.soddisfatto === false);
  ok('lo dice per nome', /Barcellona/i.test(v.mancanze.join(' ')), JSON.stringify(v.mancanze));
}

// ─────────────────────────────────────────
sezione('Senza pagine lette, i dati non hanno origine');
// ─────────────────────────────────────────
{
  const i = new Incarico({ obiettivo: 'prezzi di qualcosa', criteri: [{ tipo: 'origine_verificabile' }] });
  const v = i.valuta({ testo: 'Costa 1.250 €' }, {});
  ok('non si accontenta', v.soddisfatto === false);
  ok('spiega che non e stata aperta nessuna pagina', /nessuna pagina/i.test(v.mancanze.join(' ')), JSON.stringify(v.mancanze));
}

// ─────────────────────────────────────────
sezione('Elementi e campi');
// ─────────────────────────────────────────
{
  const i = new Incarico({
    obiettivo: 'dieci aziende con contatti',
    criteri: [
      { tipo: 'elementi_minimi', quanti: 10 },
      { tipo: 'campi_obbligatori', campi: ['email', 'settore'] },
    ],
  });
  const v = i.valuta({ righe: [['Samsung', 'vncontact@samsung.com'], ['Viettel', 'gopy@viettel.com.vn']] }, {});
  ok('conta gli elementi mancanti', /mancano 8/.test(v.mancanze.join(' ')), JSON.stringify(v.mancanze));
  ok('nomina il campo assente', /settore/.test(v.mancanze.join(' ')), JSON.stringify(v.mancanze));

  const completo = { testo: Array.from({ length: 10 }, (_, n) => `Azienda ${n + 1} | settore industria | email a${n}@x.it`).join('\n') };
  ok('con dieci elementi e i campi passa', i.valuta(completo, {}).soddisfatto === true);
}

// ─────────────────────────────────────────
sezione('File richiesto e non prodotto');
// ─────────────────────────────────────────
{
  const i = new Incarico({ obiettivo: 'un report in excel', criteri: [{ tipo: 'file_atteso', estensione: '.xlsx' }] });
  ok('un csv non vale per un xlsx', i.valuta({ file: [{ filename: 'dati.csv' }] }, {}).soddisfatto === false);
  ok('il punto iniziale e indifferente', i.valuta({ file: [{ filename: 'r.xlsx' }] }, {}).soddisfatto === true);
  ok('senza file lo dice', /manca il file/.test(i.valuta({}, {}).mancanze.join(' ')));
}

// ─────────────────────────────────────────
sezione('L istruzione di insistenza nomina il buco');
// ─────────────────────────────────────────
{
  const i = incaricoVoli();
  const v = i.valuta({ righe: [['Voli Milano'], ['Air Europa', '3.921 €']] }, sessioneConFonti);
  const istr = i.istruzioneInsistenza(v);
  ok('esiste quando qualcosa manca', typeof istr === 'string' && istr.length > 50);
  ok('riporta l obiettivo', istr.includes(i.obiettivo));
  ok('elenca cosa manca', /Madrid/.test(istr) && /Barcellona/.test(istr), istr.substring(0, 200));
  ok('vieta di rifare il lavoro gia fatto', /non rifare|gia' fatto|già fatto/i.test(istr));

  // La mancanza senza la mossa lascia il modello a girare: davanti a
  // "manca il file .html" ha chiesto l'intervento umano invece di produrlo.
  const iFile = new Incarico({ obiettivo: 'report con file', criteri: [{ tipo: 'file_atteso', estensione: 'html' }] });
  const vFile = iFile.valuta({ testo: 'ho i dati' }, sessioneConFonti);
  const istrFile = iFile.istruzioneInsistenza(vFile);
  ok('la mancanza del file .html indica crea_report', /crea_report/.test(istrFile), istrFile);
  const iXls = new Incarico({ obiettivo: 'foglio excel', criteri: [{ tipo: 'file_atteso', estensione: 'xlsx' }] });
  const istrXls = iXls.istruzioneInsistenza(iXls.valuta({ testo: 'dati' }, sessioneConFonti));
  ok('la mancanza del file .xlsx indica create_file', /create_file/.test(istrXls), istrXls);
  ok('ammette la dichiarazione di impossibilita', /impossibile/i.test(istr));

  const buono = i.valuta({
    righe: [['Milano'], ['Air Europa', '3.921 €'], ['Air Europa', '3.155 €'], ['Madrid'], ['Air Canada', '2.885 €'],
            ['Avianca', '4.097 €'], ['Barcellona'], ['KLM', '3.466 €'], ['Avianca', '4.472 €']],
    file: [{ filename: 'x.xlsx' }],
  }, sessioneConFonti);
  ok('non insiste se e tutto a posto', i.istruzioneInsistenza(buono) === null, JSON.stringify(buono.mancanze));
}

// ─────────────────────────────────────────
sezione('Il testo che arriva all Esecutore');
// ─────────────────────────────────────────
{
  const t = incaricoVoli().perIlPrompt();
  ok('dichiara l obiettivo', /# INCARICO/.test(t) && /Bogotá/.test(t));
  ok('elenca i criteri in parole', /almeno 6 elementi/.test(t));
  ok('nomina i soggetti', /Milano, Madrid, Barcellona/.test(t));
  ok('riporta i vincoli', /classe business/.test(t));
  ok('riporta il fuori ambito', /prenotare/.test(t));
  ok('dice che a verificare e il codice', /verifica il codice/.test(t));
  ok('lascia la via della dichiarazione onesta', /dichiaralo/.test(t));
  ok('ogni tipo ha una descrizione a parole',
     TIPI.every(tp => typeof descriviCriterio({ tipo: tp, quanti: 1, campi: ['a'], soggetti: ['b'], estensione: 'x' }) === 'string'));
}

// ─────────────────────────────────────────
sezione('Robustezza');
// ─────────────────────────────────────────
{
  const i = incaricoVoli();
  ok('esito vuoto non fa crashare', typeof i.valuta({}, {}).soddisfatto === 'boolean');
  ok('esito nullo non fa crashare', typeof i.valuta(undefined, undefined).soddisfatto === 'boolean');
  ok('sessione senza cache non fa crashare', i.valuta({ testo: 'niente' }, {}).totale === 5);
  ok('valutazione nulla non produce insistenza', i.istruzioneInsistenza(null) === null);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
