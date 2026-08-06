#!/usr/bin/env node
// tests/test-pagina-giusta.js — Si lavora sulla pagina che si crede.
//
// Caccia del 6 agosto 2026. La cache di turno di navigate serve il testo
// letto prima, ma NON muove la scheda del browser: il return è prima della
// navigazione vera. Finché nessuno tocca niente va bene. Ma:
//
//   navigate(booking.com)         → testo in cache, browser sulla homepage
//   fill_form + click             → ora il browser è sui risultati di MILANO
//   navigate(booking.com)         → CACHE HIT: torna la homepage, e il
//                                   modello crede di essere lì
//   fill_form                     → compila i risultati di Milano
//
// È il modo meccanico — non allucinato — in cui i prezzi di una città
// finiscono sotto il nome di un'altra. Il modello non poteva accorgersene:
// via:'cache-turno' gli diceva che la pagina era quella giusta.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== SI LAVORA SULLA PAGINA CHE SI CREDE ===');

(async () => {

sezione('Chi tocca la pagina lascia l ora');
{
  const i = fs.readFileSync('modules/tools/handlers/interaction.js', 'utf8');
  ok('esiste il segno', /function pagineToccata/.test(i));
  ok('e scrive quando', /_ultimaAzionePagina = Date\.now\(\)/.test(i));
  ok('lo lascia il click', /async function clickElement\(args, ctx\) \{\s*\n\s*pagineToccata\(ctx\);/.test(i));
  ok('lo lascia la compilazione', /async function fillForm\(args, ctx\) \{\s*\n\s*pagineToccata\(ctx\);/.test(i));
  ok('lo lascia la scelta in un elenco', /async function selectOption\(args, ctx\) \{\s*\n\s*pagineToccata\(ctx\);/.test(i));

  // Il segno viene lasciato PRIMA di agire: se l'azione fallisce a metà, la
  // pagina puo' essere cambiata lo stesso.
  const n = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
  ok('e la cache registra quando e stata riempita', /quando: Date\.now\(\)/.test(n));
}

sezione('La scorciatoia vale solo se non e successo niente in mezzo');
{
  const n = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
  ok('si confronta l ora dell azione con quella della lettura', /_ultimaAzionePagina > \(ctx\.session\._cachePagine\.get\(chiave\)\.quando \|\| 0\)/.test(n));
  ok('e se la pagina e stata toccata si naviga davvero', /ci torno per davvero invece di riusare la cache/.test(n));
  ok('la voce vecchia viene buttata, non riusata', /_cachePagine\.delete\(chiave\)/.test(n));
  ok('e al modello si dice che la scheda non si e mossa', /la scheda del browser non si è mossa/.test(n));

  // La regola, eseguita
  const regola = (ultimaAzione, quandoLetta) => {
    const session = { _ultimaAzionePagina: ultimaAzione, _cachePagine: new Map([['u', { quando: quandoLetta }]]) };
    return !!(session._ultimaAzionePagina && session._cachePagine.has('u')
      && session._ultimaAzionePagina > (session._cachePagine.get('u').quando || 0));
  };
  ok('letta e mai toccata: la cache va bene', regola(null, 1000) === false);
  ok('toccata PRIMA della lettura: la cache va ancora bene', regola(500, 1000) === false);
  ok('toccata DOPO la lettura: la cache non vale piu', regola(2000, 1000) === true);
}

sezione('La rilettura preferisce i dati, non la lunghezza');
{
  const n = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
  ok('si guarda se il testo nuovo porta dei dati', /haDati\(freshText\) && !haDati\(content\)/.test(n));

  // La regola vera, estratta ed eseguita sul caso di Google Voli: lo
  // scheletro con filtri e compagnie è più LUNGO del risultato coi prezzi.
  const corpo = n.match(/const haDati = \(t\) => .*;/)[0];
  const haDati = new Function(corpo + ' return haDati;')();
  const scheletro = 'Filtri · Scali · Compagnie · Bagaglio · Orari · ' + 'x'.repeat(2000);
  const risultati = 'ITA Airways 08:15 diretto 1.150 €';
  ok('lo scheletro non ha dati', haDati(scheletro) === false);
  ok('i risultati sì', haDati(risultati) === true);
  const tieneNuovo = (nuovo, vecchio) => nuovo.length > vecchio.length || (haDati(nuovo) && !haDati(vecchio));
  ok('coi prezzi si tiene il nuovo anche se piu corto', tieneNuovo(risultati, scheletro) === true);
  ok('e senza dati vince ancora il piu lungo', tieneNuovo('poco', scheletro) === false);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
