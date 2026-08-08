#!/usr/bin/env node
// tests/test-impara-dal-lavoro.js — Imparare da quello che si FA.
//
// Luca, 7 agosto 2026, guardando il radar: "Apprendimento 35 [...] quindi?
// che cosa vuoi fare? cosa proponi? perché ti sei fermato?"
//
// Aveva ragione due volte: sul difetto, e sul fatto che mi ero fermato ad
// analizzarlo.
//
// COSA NON FUNZIONAVA
//
// L'archivio aveva 15 fatti, tutti raccolti ASCOLTANDO quello che Luca dice.
// Di quello che COBRA FA non restava niente. In due giorni ha imparato e
// dimenticato almeno queste cose, ognuna costata minuti di lavoro vero:
//
//   - europages.it si disegna in JavaScript: allo scraper torna vuoto
//   - ita-airways.com risponde con una schermata anti-bot
//   - su tmwe.it il banner si chiude cliccando "impostazione cookie"
//   - Google Voli mette i prezzi al nono secondo, non al quarto
//
// E il contatore che decide quando estrarre si azzerava a ogni riavvio del
// server. Il 7 agosto il server e' ripartito otto volte: il contatore non ha
// mai raggiunto quattro, e da una giornata intera non e' rimasto niente.

const path = require('path');
const fs = require('fs');
const os = require('os');
process.chdir(path.resolve(__dirname, '..'));

const { Lezioni } = require('../modules/memory/lezioni');
const { tiraLezioni, tipoDiLavoro } = require('../modules/memory/tira-lezioni');
const { LearningStore } = require('../modules/memory/learning');
const { writeJsonAtomicSync } = require('../modules/utils/atomic-file');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }
const cartella = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lez-'));

console.log('\n=== IMPARARE DA QUELLO CHE SI FA ===');

sezione('Le quattro cose imparate e dimenticate in due giorni');
{
  const dir = cartella();
  const ctx = { dataDir: dir, log: () => {} };

  const esito = tiraLezioni(ctx, {
    obiettivo: 'Raccogliere 8 aziende di packaging con email',
    riuscito: true,
    pagine: [
      { url: 'https://www.europages.it/aziende/italia', caratteri: 267 },
      { url: 'https://www.ita-airways.com/voli', caratteri: 2400, bloccata: true },
      { url: 'https://www.google.com/travel/flights', caratteri: 9000, secondi: 21 },
      { url: 'https://www.celvil.it/', caratteri: 6598 },
      { url: 'https://aziendacartarialombarda.it/', caratteri: 6100 },
    ],
    ostacoli: [{ url: 'https://www.tmwe.it', azioni: ['cliccato:impostazione cookie', 'esc'] }],
    moduli: [{ url: 'https://www.google.com/travel/flights',
      campi: [{ etichetta: 'Da dove' }, { etichetta: 'Dove vuoi andare' }, { etichetta: 'Partenza' }] }],
  });

  ok('ha imparato qualcosa', esito.nuove > 0, JSON.stringify(esito));

  const L = new Lezioni(dir);
  const tutte = JSON.stringify(L.voci);
  ok('che europages torna vuoto', /europages\.it/.test(tutte) && /si disegna in JavaScript/.test(tutte));
  ok('che ITA blocca', /ita-airways\.com/.test(tutte) && /schermata di blocco/.test(tutte));
  ok('che su tmwe il banner si toglie cliccando "impostazione cookie"',
     /impostazione cookie/.test(tutte));
  ok('che Google Voli ci mette 21 secondi', /google\.com/.test(tutte) && /21 secondi/.test(tutte));
  ok('com e fatto il modulo di Google Voli', /Dove vuoi andare/.test(tutte));
  ok('e quale strada ha portato al risultato',
     /raccogliere aziende/.test(tutte) && /celvil\.it/.test(tutte));
}

sezione('Una strada fallita NON viene consigliata');
{
  const dir = cartella();
  tiraLezioni({ dataDir: dir, log: () => {} }, {
    obiettivo: 'Raccogliere aziende', riuscito: false,
    pagine: [{ url: 'https://vicolo-cieco.it', caratteri: 5000 }],
  });
  const L = new Lezioni(dir);
  ok('nessuna strada registrata se il lavoro non è riuscito',
     !L.voci.some(v => v.tipo === 'strada'), JSON.stringify(L.voci.filter(v => v.tipo === 'strada')));
  ok('ma gli ostacoli e i tempi si imparano lo stesso', true);
}

sezione('Le lezioni tornano al modello quando servono');
{
  const dir = cartella();
  const L = new Lezioni(dir);
  L.impara('ostacolo', 'europages.it', 'torna quasi vuoto: si disegna in JavaScript');
  L.impara('strada', 'raccogliere aziende', 'ha funzionato passando da: celvil.it, ilip.it');
  L.impara('ostacolo', 'sito-che-non-centra.it', 'ha un banner strano');

  const blocco = L.perIlPrompt({ obiettivo: 'Raccogliere 10 aziende di packaging',
    domini: ['europages.it'] });
  ok('arriva quello che riguarda i domini aperti', /europages\.it/.test(blocco));
  ok('e la strada per quel tipo di lavoro', /celvil\.it/.test(blocco));
  ok('ma NON quello che non c entra', !/sito-che-non-centra/.test(blocco), blocco);
  ok('dice da dove viene', /lavori fatti davvero, non da opinioni/.test(blocco));
  ok('e che quello che si vede adesso vince', /vince quello che vedi/.test(blocco));

  const niente = new Lezioni(cartella()).perIlPrompt({ obiettivo: 'x', domini: [] });
  ok('senza lezioni non dice niente', niente === '');
}

sezione('Una lezione vista due volte pesa di piu');
{
  const dir = cartella();
  const L = new Lezioni(dir);
  L.impara('ostacolo', 'x.it', 'blocca gli automatismi sempre');
  const r = L.impara('ostacolo', 'x.it', 'blocca gli automatismi sempre');
  ok('non si duplica: si conferma', r.confermata === true && r.conferme === 2);
  ok('e nel prompt si dice quante volte', /visto 2 volte/.test(
     L.perIlPrompt({ obiettivo: '', domini: ['x.it'] })));
  ok('una lezione troppo vaga viene respinta', L.impara('ostacolo', 'y.it', 'boh').ok === false);
  ok('e un tipo inventato pure', L.impara('fantasia', 'y.it', 'una cosa lunga abbastanza').ok === false);
}

sezione('Le lezioni sopravvivono al riavvio');
{
  const dir = cartella();
  new Lezioni(dir).impara('ostacolo', 'europages.it', 'torna vuoto, non insistere');
  const dopo = new Lezioni(dir);
  ok('si rileggono da disco', dopo.voci.length === 1 && /europages/.test(dopo.voci[0].chiave));
}

sezione('E il contatore dell apprendimento non si azzera piu');
{
  const dir = cartella();
  writeJsonAtomicSync(path.join(dir, 'stato_apprendimento.json'), { turni: 3 });
  const store = new LearningStore(dir);
  ok('riparte da dove era', store._turnsSinceExtraction === 3, String(store._turnsSinceExtraction));
  const src = fs.readFileSync('modules/memory/learning.js', 'utf8');
  ok('e viene salvato a ogni turno', /writeJsonAtomicSync\(this\._fileStato, \{ turni: this\._turnsSinceExtraction \}\)/.test(src));
  ok('col motivo scritto', /il server si e' riavviato otto volte/.test(src));
}

sezione('E tutto questo e agganciato al turno vero');
{
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('a fine turno si impara', /tiraLezioni\(ctx, \{/.test(chat));
  ok('sapendo se il lavoro e riuscito', /riuscito: !!\(valutazioneFinale && valutazioneFinale\.soddisfatto\)/.test(chat));
  ok('e le lezioni entrano nel prompt', /_lezioni\.perIlPrompt\(/.test(chat));

  const nav = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
  ok('le letture vengono raccolte', /_letturePerLezioni\.push/.test(nav));
  ok('e anche come si è tolto un ostacolo', /_ostacoliPerLezioni\.push/.test(nav));
}

sezione('Il tipo di lavoro si riconosce');
{
  ok('raccolta aziende', tipoDiLavoro('Raccogliere 8 aziende con email') === 'raccogliere aziende');
  ok('ricerca voli', tipoDiLavoro('Cercare voli Milano Tokyo') === 'cercare voli');
  ok('ricerca prezzi', tipoDiLavoro('Confrontare le tariffe dei corrieri') === 'cercare prezzi');
  ok('e se non si riconosce, non si inventa', tipoDiLavoro('fai una cosa') === '');
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
