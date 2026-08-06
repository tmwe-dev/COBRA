#!/usr/bin/env node
// tests/test-piano-stabile.js — Il piano non si ricomincia da capo.
//
// Prova fisica del 6 agosto 2026, richiesta Tokyo. Dal log:
//
//   [Processo] Avviato: "Organizzare viaggio a Tokyo ... con voli e hotel" 3 passi
//   [Processo] Avviato: "Organizzare viaggio a Tokyo ... con voli e hotel" 3 passi
//   [Processo] Avviato: "Cercare voli da Milano a Tokyo ... e creare un report" 4 passi
//   [Processo] Avviato: "Creare un report per il viaggio a Tokyo ..." 3 passi
//   [Processo] Avviato: "Raccolta e confronto di voli e hotel ..." 3 passi
//   [Processo] Passo 1 fallito: Il passo è in stato di attesa e non può essere completato.
//
// Cinque piani in un turno solo. Ognuno azzerava i progressi del precedente,
// quindi non si arrivava in fondo a nessuno, e sullo schermo si accatastavano
// pannelli che dicevano tutti "0/3 in corso".
//
// E l'ultima riga è peggio delle altre: dice "fallito" un passo che non era
// fallito affatto — era solo mai stato aperto formalmente. Un problema di
// registro raccontato come un lavoro andato male.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const handlers = require('../modules/tools/handlers/process');
const { Processo } = require('../modules/process/engine');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const finto = () => ({ session: {}, log: () => {}, emitReasoning: () => {}, wsBroadcast: () => {} });

console.log('\n=== IL PIANO NON SI RICOMINCIA DA CAPO ===');

(async () => {

sezione('Lo stesso obiettivo non fa ripartire il piano');
{
  const ctx = finto();
  const primo = JSON.parse(await handlers.processo_avvia({
    obiettivo: 'Organizzare viaggio a Tokyo per 8 persone con voli e hotel',
    passi: ['Cercare voli', 'Cercare hotel', 'Creare report'],
  }, ctx));
  ok('il primo piano parte', primo.ok === true && !primo.giaAvviato);

  // Si lavora: un passo viene chiuso
  await handlers.processo_inizia_passo({ passo: 1 }, ctx);
  await handlers.processo_completa_passo({ passo: 1, prova: 'trovati 3 voli su google flights con prezzi' }, ctx);
  ok('un passo viene completato', ctx.session.processo.riepilogo().completati === 1);

  // Ora arriva lo stesso piano riformulato — è il caso vero del log
  const secondo = JSON.parse(await handlers.processo_avvia({
    obiettivo: 'Organizzare un viaggio a Tokyo per 8 persone con dettagli sui voli',
    passi: ['Cercare voli', 'Cercare hotel', 'Creare report'],
  }, ctx));
  ok('lo stesso obiettivo NON crea un piano nuovo', secondo.giaAvviato === true, JSON.stringify(secondo).slice(0, 120));
  ok('e il lavoro già fatto non viene buttato', ctx.session.processo.riepilogo().completati === 1);
  ok('al modello viene detto di riprendere, non di rifare', /riprendi dal primo passo non ancora completato/.test(secondo.promemoria));
}

sezione('Un lavoro davvero diverso puo sostituire il piano');
{
  const ctx = finto();
  await handlers.processo_avvia({ obiettivo: 'Organizzare viaggio a Tokyo per 8 persone', passi: ['a', 'b'] }, ctx);
  const altro = JSON.parse(await handlers.processo_avvia({
    obiettivo: 'Preparare la fattura per il cliente Rossi di marzo',
    passi: ['Aprire il gestionale', 'Compilare la fattura'],
  }, ctx));
  ok('un obiettivo diverso avvia un piano nuovo', !altro.giaAvviato && altro.ok === true);
  ok('ed e quello nuovo a comandare', /fattura/i.test(ctx.session.processo.obiettivo));
}

sezione('Un piano finito non blocca il successivo');
{
  const ctx = finto();
  await handlers.processo_avvia({ obiettivo: 'Cercare voli per Madrid domani', passi: ['Cercare', 'Riferire'] }, ctx);
  for (const n of [1, 2]) {
    await handlers.processo_inizia_passo({ passo: n }, ctx);
    await handlers.processo_completa_passo({ passo: n, prova: 'fatto, ecco il risultato con i dati' }, ctx);
  }
  ok('il piano risulta concluso', ctx.session.processo.concluso() === true);
  const nuovo = JSON.parse(await handlers.processo_avvia({ obiettivo: 'Cercare voli per Madrid domani', passi: ['Cercare', 'Riferire'] }, ctx));
  ok('finito quello, se ne puo avviare un altro uguale', !nuovo.giaAvviato);
}

sezione('Un passo con la prova in mano non e un passo fallito');
{
  const p = new Processo('Cercare voli', [{ titolo: 'Cercare' }, { titolo: 'Riferire' }]);
  // Si chiude il passo SENZA averlo aperto: è il caso del log
  const esito = p.completaPasso(1, 'trovati tre voli su google flights, prezzi da 1029 euro');
  ok('viene accettato invece di essere respinto', esito.ok === true, esito.motivo);
  ok('il passo risulta completato', p.passo(1).stato === 'completato');
  ok('e resta scritto che era stato chiuso senza aprirlo',
     p.avvisi.some(a => /chiuso senza essere stato aperto/.test(a)), JSON.stringify(p.avvisi));
}

sezione('Ma una prova che non e una prova viene ancora respinta');
{
  const p = new Processo('Cercare voli', [{ titolo: 'Cercare' }, { titolo: 'Riferire' }]);
  ok('senza prova non si chiude', p.completaPasso(1, '').ok === false);
  ok('con una prova troppo corta nemmeno', p.completaPasso(1, 'ok').ok === false);
  ok('e una prova che contiene un errore va dichiarata fallimento',
     p.completaPasso(1, '{"error":"blocked by anti-bot protection"}').ok === false);
  ok('un passo che non esiste resta un errore', p.completaPasso(99, 'una prova abbastanza lunga').ok === false);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
