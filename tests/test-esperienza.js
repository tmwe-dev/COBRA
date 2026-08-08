#!/usr/bin/env node
// tests/test-esperienza.js — Quello che si impara usando un sito, e le
// procedure che si imparano una volta sola.
//
// PERCHÉ QUESTO FILE
//
// È il posto dove COBRA può essere migliore di un agente generalista, e non
// perché sia più intelligente: perché ci è già stato.
//
// Un agente generico arriva su booking.com per la millesima volta e non sa
// niente più della prima. COBRA lavora sempre sugli stessi venti portali —
// TMWE, DHL, UPS, LinkedIn — e su quelli può ricordare cosa ha funzionato e
// cosa no.
//
// L'8 agosto: quattro tentativi identici di mandare una richiesta di
// collegamento, quattro "Extension timeout". Ognuno dei quattro sapeva quanto
// il primo. Se il primo fallimento fosse rimasto scritto, il secondo sarebbe
// partito da un'altra parte.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');
const os = require('os');
const { MemoriaSiti, dominioDi } = require('../modules/memory/siti');
const { Procedure, buchiIn, riempi } = require('../modules/memory/procedure');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'esp-')); }

console.log('\n=== L ESPERIENZA ===');

sezione('Il dominio e la chiave giusta');
{
  ok('toglie il www', dominioDi('https://www.linkedin.com/in/x') === 'linkedin.com');
  ok('e il percorso', dominioDi('https://ups.com/it/quote?a=1') === 'ups.com');
  ok('accetta anche un dominio nudo', dominioDi('dhl.com') === 'dhl.com');
  ok('e non esplode sulla spazzatura', dominioDi('questo non e un url') === '');
}

sezione('IL PUNTO: A non funziona, B si');
{
  const tmp = tmpDir();
  const M = new MemoriaSiti(tmp);
  M.imparaDalFallimento('https://www.linkedin.com/in/brandon-dvorak/', {
    fallito: 'linkedin_connect via extRelay',
    riuscito: 'guarda_pagina + agisci',
    perche: 'su quel canale non ascolta nessuno',
  });

  const s = M.cosaSoDi('https://linkedin.com/feed');
  ok('la strada fallita resta scritta', s.nonFunziona.some(n => /extRelay/.test(n.cosa)));
  ok('col motivo', s.nonFunziona.some(n => /non ascolta nessuno/.test(n.dettaglio)));
  ok('e quella che ha funzionato pure', s.funziona.some(n => /guarda_pagina/.test(n.cosa)));

  const blocco = M.perIlPrompt('https://www.linkedin.com/in/altro/');
  ok('il prompt dice cosa NON riprovare', /NON ha funzionato/.test(blocco));
  ok('e cosa ha funzionato', /Ha funzionato/.test(blocco));
  ok('su un altro indirizzo dello STESSO sito', /LINKEDIN\.COM/.test(blocco));

  fs.rmSync(tmp, { recursive: true, force: true });
}

sezione('Le note si fondono, non si accumulano');
{
  const tmp = tmpDir();
  const M = new MemoriaSiti(tmp);
  for (let i = 0; i < 20; i++) M.annota('https://x.it', { cosa: 'banner cookie in fondo', tipo: 'ostacolo' });
  const s = M.cosaSoDi('x.it');
  ok('venti volte la stessa cosa fa UNA nota', s.ostacoli.length === 1);
  ok('con venti conferme', s.ostacoli[0].conferme === 20);
  // Senza questo la memoria diventa un registro illeggibile: è già successo
  // con le lezioni, cinque voci identiche per lo stesso fatto.
  ok('e il prompt resta corto', M.perIlPrompt('x.it').split('\n').length < 8);
  fs.rmSync(tmp, { recursive: true, force: true });
}

sezione('Un sito mai visto non inventa esperienza');
{
  const tmp = tmpDir();
  const M = new MemoriaSiti(tmp);
  ok('dice che non lo conosce', M.cosaSoDi('https://maivisto.it').conosciuto === false);
  ok('e non mette niente nel prompt', M.perIlPrompt('https://maivisto.it') === '');
  fs.rmSync(tmp, { recursive: true, force: true });
}

sezione('La memoria sopravvive al riavvio');
{
  const tmp = tmpDir();
  new MemoriaSiti(tmp).annota('https://dhl.com', { cosa: 'il tracking sta sotto Spedizioni', tipo: 'funziona' });
  const dopo = new MemoriaSiti(tmp);
  ok('riaprendo, c e ancora', /tracking/.test(dopo.perIlPrompt('dhl.com')));
  fs.rmSync(tmp, { recursive: true, force: true });
}

sezione('Le procedure: una forma con dei buchi, non una macro');
{
  const tmp = tmpDir();
  const P = new Procedure(tmp);
  const r = P.registra('preventivo UPS', {
    quando: 'quando serve una quotazione UPS',
    sito: 'ups.com',
    passi: [
      { cosa: 'vai su ups.com/quote' },
      { cosa: 'scrivi la citta di partenza', dove: 'origine', valore: '{{partenza}}' },
      { cosa: 'scrivi il peso in kg', dove: 'peso', valore: '{{peso}}' },
      { cosa: 'leggi il prezzo' },
    ],
  });
  ok('si registra', r.ok);
  ok('e riconosce da sola i parametri', r.parametri.includes('partenza') && r.parametri.includes('peso'));

  ok('la ritrova da una richiesta normale',
     P.simili('fammi un preventivo UPS Milano New York 25 kg').length === 1);
  ok('e non la tira fuori a sproposito',
     P.simili('mandami un messaggio a Sara su LinkedIn').length === 0);

  // Il punto: se manca un valore NON si inventa. Un preventivo con un peso
  // inventato è peggio di nessun preventivo.
  const meta = P.preparaPer('preventivo UPS', { partenza: 'Milano' });
  ok('senza un valore non parte', meta.ok === false);
  ok('e dice quale manca', meta.serveSapere.includes('peso'));
  ok('con l ordine di non inventarlo', /Non inventarli/.test(meta.cosaFare));

  const piena = P.preparaPer('preventivo UPS', { partenza: 'Milano', peso: '25' });
  ok('coi valori parte', piena.ok === true);
  ok('e i buchi sono riempiti', piena.passi[2].valore === '25');
  ok('senza buchi rimasti', !JSON.stringify(piena.passi).includes('{{'));

  fs.rmSync(tmp, { recursive: true, force: true });
}

sezione('Una procedura che non regge piu lo dice');
{
  const tmp = tmpDir();
  const P = new Procedure(tmp);
  P.registra('cosa fragile', { passi: [{ cosa: 'clicca' }] });
  for (let i = 0; i < 4; i++) { P.preparaPer('cosa fragile'); P.esito('cosa fragile', false); }
  const blocco = P.perIlPrompt('cosa fragile');
  ok('avverte che ultimamente fallisce', /ATTENZIONE/.test(blocco));
  ok('e dice cosa fare', /guarda la pagina e aggiorna/.test(blocco));
  fs.rmSync(tmp, { recursive: true, force: true });
}

sezione('I buchi');
{
  ok('si riconoscono', JSON.stringify(buchiIn('da {{partenza}} a {{arrivo}}')) === '["partenza","arrivo"]');
  ok('si riempiono', riempi('da {{a}}', { a: 'Milano' }).testo === 'da Milano');
  ok('e quelli vuoti si segnalano', riempi('{{x}}', {}).mancanti[0] === 'x');
  ok('senza inventare niente', riempi('{{x}}', {}).testo === '{{x}}');
}

sezione('La catena completa e il prompt');
{
  const H = require('../modules/tools/handlers');
  for (const t of ['cosa_so_del_sito', 'annota_sul_sito', 'impara_procedura', 'usa_procedura', 'elenco_procedure']) {
    ok(`${t} ha un handler`, typeof H[t] === 'function');
  }
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('il sito conosciuto entra nel prompt da solo', /_memoriaSiti\.perIlPrompt/.test(chat));
  ok('e la procedura pure', /_procedure\.perIlPrompt/.test(chat));
  // Uno strumento che bisogna ricordarsi di chiamare viene chiamato metà delle
  // volte: list_local_files in due giorni non è stato usato mai.
  ok('senza che il modello debba ricordarsene',
     /bisogna ricordarsi di chiamare viene chiamato meta/.test(chat));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  L ESPERIENZA: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
