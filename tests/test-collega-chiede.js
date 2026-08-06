#!/usr/bin/env node
// tests/test-collega-chiede.js — Il Collega deve poter CHIEDERE.
//
// Luca, 6 agosto 2026: "perché il collega non si ferma e mi chiede ulteriori
// chiarimenti se ritiene di non avere sufficienti info? il collega non fa il
// collega".
//
// Aveva ragione, e la causa era doppia:
//   1. il prompt gli diceva SEI VOLTE di non fare domande;
//   2. non esisteva un modo per chiedere senza buttare via l'incarico appena
//      preparato — chiedere costava tutto il lavoro, quindi non chiedeva mai.
//
// Qui si verifica che entrambe le cause siano rimosse.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { Collega } = require('../modules/collega/collega');
const { promptIncarico } = require('../modules/collega/prompt');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const finto = (risposta) => new Collega(async () => risposta, () => {});
const P = promptIncarico();

console.log('\n=== IL COLLEGA CHIEDE, GUIDA, E NON PERDE IL LAVORO ===');

(async () => {

sezione('Il prompt non gli vieta piu di chiedere');
{
  ok('non dice piu "porti soluzioni, non domande"', !/Porti soluzioni, non domande/.test(P));
  ok('non dice piu che una domanda e la cosa peggiore', !/la cosa peggiore è una domanda in più/.test(P));
  ok('non liquida piu le domande come lavoro scaricato addosso',
     !/Dieci domande di chiarimento sono un lavoro che stai facendo fare a lui/.test(P));
  ok('spiega invece il conto vero fra domanda e lavoro sprecato',
     /una domanda costa venti secondi/.test(P) && /si butta via tutto/.test(P));
}

sezione('Il prompt gli dice COSA chiedere: le cose che cambiano il risultato');
{
  ok('il budget', /IL BUDGET/.test(P));
  ok('come si divide un gruppo', /COME SI DIVIDE UN GRUPPO/.test(P));
  ok('vincolo rigido o preferenza', /RIGIDO O PREFERIBILE/.test(P));
  ok('a cosa gli serve il risultato', /A COSA GLI SERVE/.test(P));
  ok('al massimo due domande', /Al massimo due/.test(P));
  ok('ogni domanda arriva con l ipotesi gia pronta', /con la\s*\n?\s*tua ipotesi già pronta/.test(P));
  ok('c e l esempio di domanda vuota contro domanda utile', /Male:\s*"Qual è il tuo budget\?"/.test(P));
}

sezione('Il prompt gli chiede di guidare, non solo di eseguire');
{
  ok('esiste la sezione sul guidare', /# GUIDARE, NON SOLO ESEGUIRE/.test(P));
  ok('deve dire le domande che Luca non si e fatto', /quali\s*\n?sono le domande che il capo non si è fatto/.test(P));
  ok('distingue farsi dire cosa fare da consigliare', /quello è farsi dire cosa fare/.test(P));
  ok('una osservazione per volta, non una lezione', /Non una lezione/.test(P));
}

sezione('Chiedere non costa piu il lavoro preparato');
{
  const risposta = JSON.stringify({
    modo: 'proposta',
    risposta: 'Otto persone Milano-Tokyo a settembre. Assumo quattro doppie. Il tetto sta sui 25.000 o devo stare più stretto?',
    incarico: {
      obiettivo: 'Confronto voli e hotel per Tokyo, 8 persone, 14-28 settembre 2026',
      criteri: [
        { tipo: 'origine_verificabile' },
        { tipo: 'elementi_minimi', quanti: 3 },
        { tipo: 'file_atteso', estensione: 'html' },
      ],
    },
  });
  const a = await finto(risposta).ascolta('Organizza un viaggio a Tokyo per 8 persone');
  ok('il modo proposta viene riconosciuto', a.modo === 'proposta', a.modo);
  ok('la domanda arriva a Luca', /25\.000/.test(a.risposta));
  ok('e il lavoro NON viene perso', !!a.incarico, 'incarico assente');
  ok('l obiettivo e completo, non una bozza', /Tokyo/.test(a.incarico.obiettivo) && /8 persone/.test(a.incarico.obiettivo));
  ok('i criteri sono gia stati scelti', a.incarico.criteri.length === 3);
  ok('e sono verificabili dal codice', a.incarico.valido());
}

sezione('Chi non ha niente da chiedere parte e basta');
{
  const a = await finto(JSON.stringify({
    modo: 'incarico',
    risposta: 'Guardo i voli e ti preparo il confronto.',
    incarico: { obiettivo: 'Voli Milano-Madrid domani', criteri: [{ tipo: 'origine_verificabile' }] },
  })).ascolta('voli per madrid domani');
  ok('un lavoro chiaro parte senza domande', a.modo === 'incarico');

  const b = await finto(JSON.stringify({ modo: 'conversazione', risposta: 'Sono le 14:30.' })).ascolta('che ore sono');
  ok('una domanda semplice resta una chiacchiera', b.modo === 'conversazione');
}

sezione('Una proposta senza incarico non rompe niente');
{
  const a = await finto(JSON.stringify({ modo: 'proposta', risposta: 'Quante persone siete?' })).ascolta('vado a Tokyo');
  ok('resta una proposta', a.modo === 'proposta');
  ok('senza incarico, e non esplode', a.incarico === undefined);
}

sezione('Il lavoro in sospeso viene ripreso, non ricominciato');
{
  const c = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('il lavoro in sospeso viene messo da parte', /session\.incaricoInSospeso = \{/.test(c));
  ok('con la domanda che era stata fatta', /domanda: ascolto\.risposta/.test(c));
  ok('e con l obiettivo gia scritto', /obiettivo: ascolto\.incarico \? ascolto\.incarico\.obiettivo/.test(c));
  ok('al giro dopo torna al Collega', /IL LAVORO CHE HAI GIÀ PREPARATO E NON È ANCORA PARTITO/.test(c));
  ok('con l istruzione di non ricominciare', /NON richiedere niente e NON ricominciare/.test(c));
  ok('un "vai" secco basta a farlo partire', /anche solo "vai", "ok", "procedi" o una cifra/.test(c));
  ok('dopo mezz ora il discorso e chiuso', /30 \* 60 \* 1000/.test(c));
  ok('quando il lavoro parte, il sospeso si azzera', /incaricoInSospeso = null;\s*\/\/ il lavoro parte/.test(c));
  ok('mentre si aspetta, l Esecutore non viene svegliato',
     c.indexOf("modo === 'proposta'") < c.indexOf("modo === 'incarico' && ascolto.incarico"));
  ok('e la risposta esce dichiarando che si aspetta', /inAttesa: true/.test(c));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
