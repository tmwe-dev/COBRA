#!/usr/bin/env node
// tests/test-promesse-mantenibili.js — Il sistema non promette ciò che non può dare.
//
// Famiglia di bug scoperta il 6 agosto 2026 partendo dal fallimento di Tokyo:
// il Collega scrive criteri che l'Esecutore non ha modo di soddisfare, e poi
// il sistema spende insistenze e cambi di strada per chiedere l'impossibile.
//
// Quattro casi trovati, tutti verificati sul codice:
//
//   1. formato_consegna veniva giudicato sul MESSAGGIO IN CHAT invece che sul
//      documento: righeUltimoFile lo scriveva solo il ramo xlsx, mai il report
//      .html. E il prompt del Collega ordina di mettere formato_consegna
//      SEMPRE insieme a file_atteso, preferendo l'html — cioè la combinazione
//      consigliata era quella che non poteva riuscire. È la riga
//      "il documento non e' presentabile" ripetuta tre volte nel log di Tokyo.
//
//   2. file_atteso accettava qualunque estensione: con "pdf", create_file
//      scriveva testo grezzo chiamandolo .pdf, il criterio passava, e Luca
//      riceveva un file che nessun lettore apre. Il fallimento peggiore:
//      quello che si dichiara riuscito.
//
//   3. origine_verificabile su un obiettivo che nomina "documento" perdeva
//      search e browse, e all'insistenza si leggeva "i dati si leggono
//      aprendo le pagine con navigate()" — navigate che non era fra gli
//      strumenti consegnati.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { Incarico } = require('../modules/collega/incarico');
const handlers = require('../modules/tools/handlers/data');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const ctxFinto = () => ({
  session: { _cachePagine: new Map(), pagineDelTurno: [] },
  dataDir: '/tmp/prova-promesse', log: () => {}, wsBroadcast: () => {},
  broadcastFile: () => {}, emitReasoning: () => {}, emitThinking: () => {},
});

console.log('\n=== NON PROMETTERE CIÒ CHE NON PUOI DARE ===');

(async () => {

sezione('Il report impaginato soddisfa il criterio che lo giudica');
{
  const ctx = ctxFinto();
  ctx.session._cachePagine.set('g', { url: 'https://www.google.com/travel/flights', title: 'Google Voli' });

  const r = JSON.parse(await handlers.crea_report({
    filename: 'tokyo',
    titolo: 'Viaggio a Tokyo, 14-28 settembre 2026',
    raccomandazione: {
      consiglio: 'ITA diretto: otto persone su un volo solo.',
      perche: 'Costa 200 euro in più a testa dello scalo, ma con otto persone un ritardo spezza il gruppo.',
    },
    sezioni: [{ titolo: 'Voli', carte: [
      { nome: 'ITA Airways', prezzo: 1150, dettaglio: 'MXP-HND diretto', migliore: true },
      { nome: 'Lufthansa via Monaco', prezzo: 950, dettaglio: '1 scalo' },
    ] }],
  }, ctx));
  ok('il report viene prodotto', r.ok === true, r.error);

  const i = new Incarico({ obiettivo: 'Report viaggio Tokyo', criteri: [
    { tipo: 'file_atteso', estensione: 'html' },
    { tipo: 'formato_consegna' },
  ] });
  const v = i.valuta({
    testo: 'Ecco il confronto.',            // il messaggio in chat, che NON è il documento
    righe: ctx.session.righeUltimoFile,
    file: ctx.session.fileDelTurno,
    pagine: [],
  }, ctx.session);
  ok('entrambi i criteri sono soddisfatti', v.soddisfatto === true, v.mancanze.join('; '));

  // Il criterio deve ancora saper dire di no
  const vuoto = i.valuta({ testo: 'Ho trovato dei voli, costano sui mille euro.', righe: null, file: [], pagine: [] }, {});
  ok('senza documento il criterio fallisce ancora', vuoto.soddisfatto === false);
  ok('e dice cosa manca', /manca il file \.html/.test(vuoto.mancanze.join('; ')));
}

sezione('Un formato che non sappiamo produrre non viene promesso');
{
  const i = new Incarico({ obiettivo: 'Preparare la relazione', criteri: [{ tipo: 'file_atteso', estensione: 'pdf' }] });
  ok('il pdf diventa html', i.criteri[0].estensione === 'html', JSON.stringify(i.criteri));
  ok('e la sostituzione resta scritta', /non è un formato producibile/.test(i.avvisi.join('; ')));

  const d = new Incarico({ obiettivo: 'Preparare la relazione', criteri: [{ tipo: 'file_atteso', estensione: 'docx' }] });
  ok('lo stesso per il docx', d.criteri[0].estensione === 'html');

  for (const buona of ['html', 'xlsx', 'csv', 'txt', 'json', 'md']) {
    const x = new Incarico({ obiettivo: 'Preparare il file', criteri: [{ tipo: 'file_atteso', estensione: buona }] });
    ok(`.${buona} resta com'era`, x.criteri[0].estensione === buona && x.avvisi.length === 0);
  }
}

sezione('E un file finto non viene scritto');
{
  const ctx = ctxFinto();
  const pdf = JSON.parse(await handlers.create_file({ filename: 'relazione.pdf', content: 'Ecco la relazione' }, ctx));
  ok('un .pdf di testo viene rifiutato', !!pdf.error, JSON.stringify(pdf));
  ok('spiegando che non si aprirebbe', /file che non si apre/.test(pdf.error));
  ok('e dicendo cosa fare invece', /crea_report/.test(pdf.error));
  ok('il file NON viene creato', !fs.existsSync('/tmp/prova-promesse/files/relazione.pdf'));

  for (const finto of ['docx', 'doc', 'pptx']) {
    const r = JSON.parse(await handlers.create_file({ filename: `x.${finto}`, content: 'testo' }, ctx));
    ok(`anche .${finto} viene rifiutato`, !!r.error);
  }

  const html = JSON.parse(await handlers.create_file({ filename: 'nota.html', content: '<p>ciao</p>' }, ctx));
  ok('ma i formati veri si scrivono ancora', html.ok === true, JSON.stringify(html));
}

sezione('Chi pretende una fonte ha il browser, comunque sia scritto l obiettivo');
{
  const c = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('il criterio origine_verificabile viene guardato', /pretendeFonti/.test(c));
  ok('e batte le parole dell obiettivo', /const soloFileLocali = !pretendeFonti/.test(c));

  // La regola vera, eseguita: si estrae dal file e si applica ai casi
  // concreti, invece di riscriverla nel test (dove non proverebbe niente).
  const corpo = c.match(/const soloFileLocali = !pretendeFonti[\s\S]*?\.test\(incaricoCorrente\.obiettivo\);/)[0];
  const regola = new Function('pretendeFonti', 'incaricoCorrente',
    corpo + ' return soloFileLocali;');

  const tariffe = { obiettivo: 'Preparare un documento con le tariffe dei corrieri espressi' };
  ok('senza criterio delle fonti quell obiettivo perdeva il browser',
     regola(false, tariffe) === true);
  ok('col criterio delle fonti il browser resta',
     regola(true, tariffe) === false);

  const veroFileLocale = { obiettivo: 'Rinominare i file nella cartella dei preventivi' };
  ok('ma un lavoro davvero locale non si porta dietro il browser per niente',
     regola(false, veroFileLocale) === true);

  const ricercaEvidente = { obiettivo: 'Cercare i voli per Tokyo e fare un documento' };
  ok('e un obiettivo che parla di cercare ha il browser comunque',
     regola(false, ricercaEvidente) === false);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
