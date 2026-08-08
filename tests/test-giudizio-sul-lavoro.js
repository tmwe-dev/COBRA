#!/usr/bin/env node
// tests/test-giudizio-sul-lavoro.js — Si giudica il lavoro, non la frase.
//
// Prova del 7 agosto 2026, raccolta di otto aziende. Il file consegnato aveva
// tutte e otto le righe complete — nome, città, sito, email. Il verdetto:
//
//   Verdetto: 4/6 criteri — mancano: non hai trattato: Lombardia, Emilia;
//   non compaiono i campi: sito, email
//
// Tre difetti dello stesso tipo, tutti "controlli che leggono nel posto
// sbagliato":
//
//   1. campi_obbligatori cercava le parole "sito" ed "email" nel MESSAGGIO di
//      accompagnamento, non nei dati raccolti. Bocciava un lavoro riuscito.
//   2. soggetti_coperti cercava "Lombardia" ed "Emilia" nella chat, mentre nel
//      foglio c'erano le CITTÀ — Milano, Valsamoggia, Reggio Emilia.
//   3. "citta: Non specificata" contava come campo pieno: il buco spariva dai
//      radar e nessuno tornava a cercarlo.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { Incarico } = require('../modules/collega/incarico');
const { Cantiere, valoreVero } = require('../modules/collega/cantiere');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const CHAT = 'Ecco le aziende che ho trovato, il file è pronto da scaricare.';

console.log('\n=== SI GIUDICA IL LAVORO, NON LA FRASE ===');

sezione('Un valore finto non chiude un buco');
{
  for (const finto of ['Non specificata', 'n/d', 'N/A', '—', 'sconosciuto', '?', 'non disponibile', 'null']) {
    ok(`"${finto}" resta un buco`, valoreVero(finto) === '');
  }
  ok('ma "Milano" vale', valoreVero('Milano') === 'Milano');
  ok('e "0" pure: e un numero, non un vuoto', valoreVero('0') === '0');

  const c = new Cantiere({ campiAttesi: ['citta', 'email'], quanteVoci: 2 });
  c.annota('Pluricart', { citta: 'Non specificata', email: 'i@p.it' });
  ok('la voce NON risulta completa', c.complete() === 0, String(c.complete()));
  ok('e la città resta fra le cose da cercare',
     JSON.stringify(c.buchi()).includes('citta'), JSON.stringify(c.buchi()));
}

sezione('I campi si contano nei dati, non nel messaggio');
{
  const c = new Cantiere({ campiAttesi: ['citta', 'sito', 'email'], quanteVoci: 2 });
  c.annota('Celvil', { citta: 'Milano', sito: 'https://celvil.it', email: 'i@celvil.it' });
  c.annota('ILIP', { citta: 'Valsamoggia', sito: 'https://ilip.it', email: 'i@ilip.it' });

  const i = new Incarico({ obiettivo: 'Aziende packaging',
    criteri: [{ tipo: 'campi_obbligatori', campi: ['citta', 'sito', 'email'] }] });

  const senza = i.valuta({ testo: CHAT, file: [], pagine: [] }, {});
  ok('senza cantiere bocciava il lavoro riuscito', senza.soddisfatto === false);

  const con = i.valuta({ testo: CHAT, file: [], pagine: [] }, { cantiere: c });
  ok('col cantiere lo riconosce', con.soddisfatto === true, JSON.stringify(con.mancanze));
  ok('e lo dice contando le voci', /tutte le 2 voci/.test(JSON.stringify(con.esiti || con)),
     JSON.stringify(con.esiti ? con.esiti[0] : con));

  c.annota('Pluricart', { sito: 'https://p.it' });
  const buco = i.valuta({ testo: CHAT, file: [], pagine: [] }, { cantiere: c });
  ok('ma una voce davvero incompleta la trova', buco.soddisfatto === false);
  ok('dicendo QUALE e cosa le manca',
     /Pluricart/.test(buco.mancanze.join(' ')) && /citta|email/.test(buco.mancanze.join(' ')),
     buco.mancanze.join('; '));
}

sezione('I soggetti si cercano anche dentro i dati raccolti');
{
  const c = new Cantiere({ campiAttesi: ['citta'], quanteVoci: 3 });
  c.annota('Celvil', { citta: 'Milano' }, 'https://celvil.it');
  c.annota('Istituto Stampa', { citta: 'Reggio Emilia' }, 'https://istitutostampa.it');

  const i = new Incarico({ obiettivo: 'Aziende',
    criteri: [{ tipo: 'soggetti_coperti', soggetti: ['Milano', 'Reggio Emilia'] }] });

  ok('senza cantiere non li trovava nella chat',
     i.valuta({ testo: CHAT, file: [], pagine: [] }, {}).soddisfatto === false);
  ok('col cantiere li trova nei dati',
     i.valuta({ testo: CHAT, file: [], pagine: [] }, { cantiere: c }).soddisfatto === true);

  const mancante = new Incarico({ obiettivo: 'Aziende',
    criteri: [{ tipo: 'soggetti_coperti', soggetti: ['Milano', 'Bari'] }] });
  const v = mancante.valuta({ testo: CHAT, file: [], pagine: [] }, { cantiere: c });
  ok('ma un soggetto davvero mancante resta segnalato', v.soddisfatto === false);
  ok('e si dice quale', /Bari/.test(v.mancanze.join(' ')) && !/Milano/.test(v.mancanze.join(' ')),
     v.mancanze.join('; '));
}

sezione('Senza cantiere il vecchio comportamento resta');
{
  const i = new Incarico({ obiettivo: 'Voli',
    criteri: [{ tipo: 'campi_obbligatori', campi: ['prezzo'] }] });
  ok('un testo che nomina il campo passa',
     i.valuta({ testo: 'il prezzo è 1150 euro', file: [], pagine: [] }, {}).soddisfatto === true);
  ok('e uno che non lo nomina no',
     i.valuta({ testo: 'ho trovato dei voli', file: [], pagine: [] }, {}).soddisfatto === false);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
