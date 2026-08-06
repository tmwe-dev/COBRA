#!/usr/bin/env node
// tests/test-fonti-rivista.js — Il registro delle fonti impara dai fatti;
// il report impaginato rifiuta gli elenchi senza consiglio.

const path = require('path');
const fs = require('fs');
const os = require('os');
process.chdir(path.resolve(__dirname, '..'));

const { RegistroFonti } = require('../modules/fonti/registro');
const { componiRivista } = require('../modules/output/rivista');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== REGISTRO FONTI E REPORT RIVISTA ===');

const dirProva = fs.mkdtempSync(path.join(os.tmpdir(), 'registro-'));

// ─────────────────────────────────────────
sezione('Il registro impara la storia vera: Kayak vuoto, Google Voli pieno');
// ─────────────────────────────────────────
{
  const r = new RegistroFonti(dirProva);
  // La giornata del 5 agosto, come è andata davvero
  for (let i = 0; i < 4; i++) r.registra('https://www.kayak.it/flights/x', { caratteri: 300 });
  for (let i = 0; i < 3; i++) r.registra('https://www.google.com/travel/flights?q=x' + i, { caratteri: 2400 });
  r.registra('https://www.skyscanner.it/voli', { caratteri: 150 });
  r.registra('https://www.skyscanner.it/voli2', { caratteri: 90 });

  ok('kayak risulta da evitare', r.giudizio('kayak.it').verdetto === 'da_evitare', JSON.stringify(r.giudizio('kayak.it')));
  ok('google risulta affidabile', r.giudizio('google.com').verdetto === 'affidabile');
  ok('una lettura sola non fa esperienza', r.giudizio('sito-mai-visto.it').nota === false);

  const { buone, cattive } = r.bilancio();
  ok('il bilancio separa buone e cattive', buone.some(b => b.dominio === 'google.com') && cattive.some(c => c.dominio === 'kayak.it'));

  const blocco = r.perIlPrompt();
  ok('il blocco per il prompt nomina le buone', /google\.com/.test(blocco));
  ok('e avverte sulle sprecate', /kayak\.it/.test(blocco) && /perdere tempo/i.test(blocco));
  ok('dichiara la propria natura empirica', /letture fatte davvero/.test(blocco));
}

// ─────────────────────────────────────────
sezione('Il registro sopravvive al riavvio');
// ─────────────────────────────────────────
{
  const r2 = new RegistroFonti(dirProva);
  ok('kayak resta da evitare dopo il riavvio', r2.giudizio('kayak.it').verdetto === 'da_evitare');
  ok('google resta affidabile', r2.giudizio('google.com').verdetto === 'affidabile');
}

// ─────────────────────────────────────────
sezione('Robustezza del registro');
// ─────────────────────────────────────────
{
  const r = new RegistroFonti(dirProva);
  r.registra('non-un-url', { caratteri: 100 });          // non deve crashare
  r.registra('https://x.it/y', { guasto: true });
  ok('un url malformato non crasha', true);
  ok('senza esperienza il prompt resta muto', new RegistroFonti(fs.mkdtempSync(path.join(os.tmpdir(), 'vuoto-'))).perIlPrompt() === '');
}

// ─────────────────────────────────────────
sezione('Il report rifiuta gli elenchi senza consiglio');
// ─────────────────────────────────────────
{
  const base = {
    titolo: 'Vacanza a Palawan',
    sezioni: [{ titolo: 'Voli', carte: [
      { nome: 'Emirates via Dubai', prezzo: 3200, dettaglio: '14-29 agosto', migliore: true },
      { nome: 'Qatar via Doha', prezzo: 3450, dettaglio: '14-29 agosto' },
    ] }],
    fonti: [{ url: 'https://www.google.com/travel/flights', title: 'Google Voli' }],
  };

  ok('senza raccomandazione viene rifiutato', componiRivista(base).ok === false);
  ok('e il motivo spiega la regola', /elenco non è il lavoro/.test(componiRivista(base).errore));

  const soloConsiglio = { ...base, raccomandazione: { consiglio: 'Prenderei Emirates via Dubai a fine agosto.' } };
  ok('un consiglio senza perche viene rifiutato', componiRivista(soloConsiglio).ok === false);
  ok('e lo dice', /manca il perché/.test(componiRivista(soloConsiglio).errore));

  const senzaFonti = { ...base, fonti: [], raccomandazione: { consiglio: 'Prenderei Emirates via Dubai a fine agosto.', perche: 'Costa 250 euro meno di Qatar a parità di orari e lo scalo è più corto.' } };
  ok('senza fonti viene rifiutato', componiRivista(senzaFonti).ok === false);

  const unaSolaCarta = { ...base, raccomandazione: senzaFonti.raccomandazione, sezioni: [{ titolo: 'Voli', carte: [{ nome: 'x' }] }] };
  ok('con un solo risultato non c e confronto', componiRivista(unaSolaCarta).ok === false);
}

// ─────────────────────────────────────────
sezione('Il report completo esce impaginato');
// ─────────────────────────────────────────
{
  const esito = componiRivista({
    titolo: 'Vacanza a Palawan, 14-29 agosto 2026',
    sottotitolo: 'Tre gruppi, tre periodi, business class',
    raccomandazione: {
      consiglio: 'Partite a settembre: stesso resort, voli più larghi, quasi un terzo di spesa in meno.',
      perche: 'A metà agosto i voli business superano i 4.000 € a persona e il Marriott è quasi pieno; a settembre gli stessi voli scendono sotto i 3.000 € e la stagione dei monsoni è agli sgoccioli.',
    },
    sezioni: [
      { titolo: 'Voli da Milano', commento: 'Tutte le rotte passano da un solo scalo mediorientale.',
        carte: [
          { nome: 'Emirates via Dubai', prezzo: 3200, dettaglio: 'MXP → PPS, 1 scalo', nota: 'Bagaglio incluso', link: 'https://emirates.com', migliore: true },
          { nome: 'Qatar via Doha', prezzo: 3450, dettaglio: 'MXP → PPS, 1 scalo' },
        ],
        immagine: { src: 'https://esempio.it/palawan.jpg', didascalia: 'El Nido, Palawan' } },
      { titolo: 'Hotel', carte: [
          { nome: 'Marriott Palawan', prezzo: 210, valuta: '€/notte', migliore: true },
          { nome: 'Four Seasons (non presente a Palawan)', nota: 'Il più vicino è a Bali' },
        ] },
    ],
    fonti: [
      { url: 'https://www.google.com/travel/flights?q=PPS', title: 'Google Voli' },
      { url: 'https://www.marriott.com/palawan', title: 'Marriott' },
    ],
  });

  ok('il report viene prodotto', esito.ok === true, esito.errore);
  const h = esito.html || '';
  ok('ha la copertina col titolo', /<h1>Vacanza a Palawan/.test(h));
  ok('la raccomandazione apre il documento', h.indexOf('La raccomandazione') < h.indexOf('Voli da Milano'));
  ok('il perche c e', /monsoni/.test(h));
  ok('la carta consigliata e marcata', /carta migliore/.test(h));
  ok('l immagine e inclusa con didascalia', /palawan\.jpg/.test(h) && /El Nido/.test(h));
  ok('le fonti chiudono il documento', /Fonti consultate/.test(h) && /marriott\.com/.test(h));
  ok('c e il foglio di stile di stampa', /@media print/.test(h));
  ok('il testo pericoloso viene neutralizzato',
     !componiRivista({ titolo: '<script>alert(1)</script>', raccomandazione: { consiglio: 'Consiglio abbastanza lungo per passare.', perche: 'Motivazione abbastanza lunga per passare il controllo.' }, sezioni: [{ titolo: 'x', carte: [{ nome: 'a' }, { nome: 'b' }] }], fonti: ['https://a.it'] }).html.includes('<script>alert'));
}

// ─────────────────────────────────────────
sezione('Il collegamento c e davvero');
// ─────────────────────────────────────────
{
  const handlers = require('../modules/tools/handlers');
  ok('crea_report e un tool', typeof handlers.crea_report === 'function');
  const { COBRA_TOOLS } = require('../modules/tools/schemas');
  ok('ha uno schema dichiarato', COBRA_TOOLS.some(t => t.function.name === 'crea_report'));
  const { computeEffectiveRisk } = require('../modules/risk/calculator');
  ok('non richiede conferma', computeEffectiveRisk('crea_report', {}).requires_confirmation === false);
  const nav = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
  ok('navigate alimenta il registro', /registroFonti\.registra/.test(nav));
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('il registro entra nel prompt', /registroFonti\.perIlPrompt/.test(chat));
  const core = require('fs').readFileSync('modules/prompts/cobra-core.js', 'utf8');
  ok('la ricognizione e la fase zero', /RICOGNIZIONE/.test(core));
  ok('con la scelta esplicita fra insistere e accontentarsi', /accontentarti e proseguire/.test(core));
}


// ─────────────────────────────────────────
sezione('I gusci non passano per risultati');
// ─────────────────────────────────────────
{
  const fs2 = require('fs');
  const rs = fs2.readFileSync('modules/tools/handlers/read-scrape.js', 'utf8');
  ok('scrape_url passa da solo al browser sui gusci', /passo al browser/.test(rs));
  ok('e registra gli esiti nel registro', /registroFonti\.registra/.test(rs));
  const dj = fs2.readFileSync('modules/tools/handlers/data.js', 'utf8');
  ok('batch_scrape dichiara i gusci', /pagineDaAprireNelBrowser/.test(dj));
  ok('e dice di aprirli con navigate', /aprile una per una con navigate/.test(dj));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
