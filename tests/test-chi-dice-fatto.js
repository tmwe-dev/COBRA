#!/usr/bin/env node
// tests/test-chi-dice-fatto.js — L'Esecutore può dire "credo di aver finito".
// Non può dire "finito".
//
// PERCHÉ QUESTO FILE
//
// L'8 agosto COBRA ha dichiarato riuscite quattro cose che non erano successe.
// Quattro difetti diversi, in quattro file diversi, tutti della stessa forma:
// qualcuno decideva che una cosa era andata bene guardando qualcosa che non
// era il risultato.
//
// Ogni correzione è stata giusta e locale. Ma la quinta volta succederà in un
// quinto posto, perché il problema non era nessuno di quei quattro punti: era
// che il diritto di dichiarare finito un lavoro stava sparso ovunque.
//
// Qui si controlla che quel diritto ora stia in un posto solo, e che quel
// posto non si lasci convincere da una frase.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const { decidi, puoDirsiFatto, STATI, _dichiaraDiAverFinito } = require('../modules/collega/completamento');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== CHI HA IL DIRITTO DI DIRE "FATTO" ===');

sezione('Una frase non e una prova');
{
  // Il caso vero: il modello dice di aver finito, i criteri dicono di no.
  const v = decidi({
    valutazione: { esiti: [
      { tipo: 'soggetti_coperti', soddisfatto: false, mancante: 'non hai trattato: Madrid, Bogota' },
      { tipo: 'elementi_minimi', soddisfatto: true },
    ] },
    dettoDalModello: 'Ho completato la ricerca. Sono state trovate tre opzioni.',
  });
  ok('la dichiarazione non ribalta le prove', v.stato === STATI.MANCA);
  ok('e viene registrato che era smentita', v.dichiarazioneSmentita === true);
  ok('con l elenco preciso di cosa manca', v.mancano.some(m => /Madrid/.test(m)));
  ok('e l ordine di NON ricominciare', /NON ricominciare/.test(v.cosaFare));

  // E il verso opposto: tutto a posto ma il modello non lo dice. Conta
  // comunque quello che è successo, non come lo racconta.
  const v2 = decidi({
    valutazione: { esiti: [{ tipo: 'elementi_minimi', soddisfatto: true }] },
    files: [{ filename: 'report.html' }],
    dettoDalModello: 'non so bene se sia venuto bene',
  });
  ok('e il silenzio non toglie un lavoro riuscito', v2.stato === STATI.COMPLETO);
}

sezione('Un passo senza prova non e un passo eseguito');
{
  const v = decidi({ passi: [
    { step: 1, tool: 'read_page', ok: true },
    { step: 2, description: 'Confronta i risultati', ok: false, senzaProva: true },
  ] });
  ok('una frase in mezzo ai passi ferma la consegna', v.stato === STATI.MANCA);
  ok('e lo dice con parole comprensibili',
     v.mancano.some(m => /descrive un lavoro, non lo fa/.test(m)));
}

sezione('Un passo fallito non si nasconde');
{
  const v = decidi({ passi: [
    { step: 1, tool: 'navigate', ok: true },
    { step: 2, tool: 'create_file', ok: false, motivo: 'nessun dato da scrivere' },
  ] });
  ok('il passo caduto blocca', v.stato === STATI.MANCA);
  ok('col motivo vero', v.mancano.some(m => /nessun dato da scrivere/.test(m)));
}

sezione('Il caso che passava da tutte le maglie');
{
  // Nessun criterio verificabile, nessun passo fallito, e nemmeno un file o
  // una riga raccolta. Formalmente niente è andato storto. Sostanzialmente non
  // è successo niente — ed è così che nasce "Operazione completata" sul vuoto.
  const v = decidi({
    incarico: { criteri: [{ tipo: 'inventato' }] },
    valutazione: { esiti: [] },
    files: [], passi: [],
    dettoDalModello: 'Operazione completata con successo.',
  });
  ok('un lavoro che non ha prodotto niente non e finito', v.stato === STATI.MANCA);
  ok('e lo dice senza giri di parole',
     v.mancano.some(m => /non risulta prodotto niente/.test(m)));
  ok('e segnala che il modello diceva il contrario', v.dichiarazioneSmentita === true);
}

sezione('E quando e finito davvero, si consegna');
{
  const v = decidi({
    incarico: { criteri: [{ tipo: 'soggetti_coperti', soggetti: ['Milano', 'Madrid'] }] },
    valutazione: { esiti: [
      { tipo: 'soggetti_coperti', soddisfatto: true },
      { tipo: 'origine_verificabile', soddisfatto: true },
      { tipo: 'file_atteso', soddisfatto: true },
    ] },
    files: [{ filename: 'confronto.html' }],
    passi: [{ step: 1, tool: 'navigate', ok: true }, { step: 2, tool: 'create_file', ok: true }],
    dettoDalModello: 'Ecco il confronto.',
  });
  ok('tre criteri soddisfatti e un file: completo', v.stato === STATI.COMPLETO);
  ok('senza cose da fare', v.mancano.length === 0);
  ok('e la porta corta dice la stessa cosa', puoDirsiFatto({
    valutazione: { esiti: [{ tipo: 'elementi_minimi', soddisfatto: true }] },
    files: [{ filename: 'x.html' }],
  }) === true);
}

sezione('Riconoscere una dichiarazione di successo');
{
  for (const f of ['Ho completato la ricerca.', 'Operazione completata.', 'Fatto.',
                   'Il lavoro è terminato.', 'Task completed successfully.', 'Ecco, è pronto.']) {
    ok(`riconosce: "${f.slice(0, 32)}"`, _dichiaraDiAverFinito(f) === true);
  }
  for (const f of ['Non sono riuscito ad aprire la pagina.', 'Mancano ancora due città.',
                   'Il volo parte alle 6:40.']) {
    ok(`e non si confonde con: "${f.slice(0, 32)}"`, _dichiaraDiAverFinito(f) === false);
  }
}

sezione('Non e un sesto motore');
{
  const fs = require('fs');
  const src = fs.readFileSync('modules/collega/completamento.js', 'utf8');
  // Il rischio vero era aggiungere una sesta struttura di stato accanto a
  // Processo, Cantiere, Incarico, missioni e tasks. Questa è una funzione
  // pura: se un giorno prendesse stato, questa prova diventa rossa.
  ok('non tiene stato fra una chiamata e l altra',
     !/^(let|var)\s/m.test(src.replace(/^\s*\/\/.*$/gm, '')));
  ok('non scrive su disco', !/writeFile|appendFile/.test(src));
  ok('e lo stesso ingresso da sempre lo stesso verdetto', (() => {
    const p = { valutazione: { esiti: [{ tipo: 'x', soddisfatto: false, mancante: 'y' }] } };
    return JSON.stringify(decidi(p)) === JSON.stringify(decidi(p));
  })());
  ok('gli stati sono quattro e non di piu', Object.keys(STATI).length === 4);
}

sezione('E chi diceva "fatto" per conto suo adesso passa di qui');
{
  const fs = require('fs');
  const data = fs.readFileSync('modules/tools/handlers/data.js', 'utf8');
  ok('run_task chiede il verdetto al cancello', /require\('\.\.\/\.\.\/collega\/completamento'\)/.test(data));
  ok('e non decide piu da solo', !/const tutto = falliti\.length === 0;/.test(data));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  CHI DICE FATTO: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
