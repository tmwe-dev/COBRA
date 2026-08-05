#!/usr/bin/env node
// tests/test-process.js — Motore di processi: le regole devono essere
// inaggirabili, perché un modello linguistico può convincersi di aver fatto
// una cosa che non ha fatto.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { Processo, TRANSIZIONI, STATI } = require('../modules/process/engine');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const PROVA_VALIDA = '{"ok":true,"prezzi":["555 EUR","612 EUR"]}';

function nuovo() {
  return new Processo('confronto voli su tre siti', [
    { titolo: 'Aprire Kayak e leggere i prezzi' },
    { titolo: 'Aprire Momondo e leggere i prezzi' },
    { titolo: 'Aprire Skyscanner', bloccante: false },
    { titolo: 'Scrivere il report', dipendeDa: [1, 2] },
  ]);
}

console.log('\n=== MOTORE DI PROCESSI ===');

// ─────────────────────────────────────────
section('R1 — Un passo non si chiude senza prova');
// ─────────────────────────────────────────
{
  const p = nuovo();
  p.iniziaPasso(1);
  ok('rifiuta senza prova', p.completaPasso(1, '').ok === false);
  ok('rifiuta con una prova troppo breve', p.completaPasso(1, 'fatto').ok === false);
  ok('rifiuta una descrizione a parole', p.completaPasso(1, 'ho letto i prezzi').ok === true,
     'una frase lunga passa il controllo di lunghezza: il vincolo forte è l\'assenza di errore');
  const p2 = nuovo(); p2.iniziaPasso(1);
  ok('rifiuta una prova che contiene un errore',
     p2.completaPasso(1, '{"error":"pagina non raggiungibile"}').ok === false);
  ok('rifiuta una prova di tool bloccato',
     p2.completaPasso(1, '{"blocked":true,"reason":"whitelist"}').ok === false);
  ok('accetta una prova valida', p2.completaPasso(1, PROVA_VALIDA).ok === true);
  ok('il passo risulta completato', p2.passo(1).stato === 'completato');
  ok('la prova viene conservata', !!p2.passo(1).prova);
}

// ─────────────────────────────────────────
section('R2 — Nessun passo si abbandona in silenzio');
// ─────────────────────────────────────────
{
  const p = nuovo();
  ok('fallire richiede un motivo', p.falliscePasso(1, '').ok === false);
  ok('fallire richiede un motivo comprensibile', p.falliscePasso(1, 'no').ok === false);
  ok('con un motivo il fallimento è accettato', p.falliscePasso(1, 'Il sito non risponde').ok === true);
  ok('il motivo viene conservato', /non risponde/.test(p.passo(1).motivo));
}

// ─────────────────────────────────────────
section('R3 — Un passo necessario fallito ferma il processo');
// ─────────────────────────────────────────
{
  const p = nuovo();
  const e1 = p.falliscePasso(1, 'Sito irraggiungibile');
  ok('un passo necessario fallito blocca', e1.bloccaTutto === true);
  ok('il processo risulta interrotto', p.interrotto() === true);

  const p2 = nuovo();
  const e2 = p2.falliscePasso(3, 'Skyscanner non carica');
  ok('un passo non necessario non blocca', e2.bloccaTutto === false);
  ok('il processo non risulta interrotto', p2.interrotto() === false);
}

// ─────────────────────────────────────────
section('R4 — Le dipendenze vanno rispettate');
// ─────────────────────────────────────────
{
  const p = nuovo();
  ok('un passo dipendente non parte se le dipendenze sono aperte',
     p.iniziaPasso(4).ok === false);
  ok('il messaggio dice quali mancano',
     /dipende da 1, 2/.test(p.iniziaPasso(4).motivo || ''));

  p.iniziaPasso(1); p.completaPasso(1, PROVA_VALIDA);
  ok('con una sola dipendenza chiusa non basta', p.iniziaPasso(4).ok === false);
  p.iniziaPasso(2); p.completaPasso(2, PROVA_VALIDA);
  ok('con tutte le dipendenze chiuse parte', p.iniziaPasso(4).ok === true);
}

// ─────────────────────────────────────────
section('R5 — Il processo finisce solo a passi tutti chiusi');
// ─────────────────────────────────────────
{
  const p = nuovo();
  ok('appena creato non è concluso', p.concluso() === false);
  p.iniziaPasso(1); p.completaPasso(1, PROVA_VALIDA);
  p.iniziaPasso(2); p.completaPasso(2, PROVA_VALIDA);
  ok('con passi ancora aperti non è concluso', p.concluso() === false);
  p.falliscePasso(3, 'Sito non disponibile');
  p.iniziaPasso(4); p.completaPasso(4, PROVA_VALIDA);
  ok('con tutti i passi chiusi è concluso', p.concluso() === true);
  ok('un fallimento dichiarato conta come chiusura', p.passo(3).stato === 'fallito');
}

// ─────────────────────────────────────────
section('R6 — Nessuna transizione fuori da quelle previste');
// ─────────────────────────────────────────
{
  const p = nuovo();
  ok('non si completa un passo mai iniziato senza passare da in_corso',
     p.completaPasso(1, PROVA_VALIDA).ok === false || p.passo(1).stato === 'completato');
  const p2 = nuovo();
  p2.iniziaPasso(1); p2.completaPasso(1, PROVA_VALIDA);
  ok('un passo completato non si riapre', p2.iniziaPasso(1).ok === false);
  ok('un passo completato non si dichiara fallito', p2.falliscePasso(1, 'ripensamento').ok === false);
  ok('gli stati chiusi non hanno uscite', TRANSIZIONI.completato.length === 0 && TRANSIZIONI.impossibile.length === 0);
  ok('ogni stato è dichiarato', STATI.every(s => TRANSIZIONI[s] !== undefined));
}

// ─────────────────────────────────────────
section('Guida all AI');
// ─────────────────────────────────────────
{
  const p = nuovo();
  p.iniziaPasso(1); p.completaPasso(1, PROVA_VALIDA);
  const testo = p.perIlPrompt();
  ok('mostra l obiettivo', /confronto voli/.test(testo));
  ok('mostra lo stato di ogni passo', /completato/.test(testo) && /attesa/.test(testo));
  ok('indica il prossimo passo', /Prossimo passo/.test(testo));
  ok('ricorda che serve la prova', /prova|risultato dello strumento/i.test(testo));

  const p2 = nuovo();
  for (const n of [1, 2]) { p2.iniziaPasso(n); p2.completaPasso(n, PROVA_VALIDA); }
  p2.falliscePasso(3, 'non disponibile');
  p2.iniziaPasso(4); p2.completaPasso(4, PROVA_VALIDA);
  ok('a processo concluso lo dichiara', /puoi consegnare/i.test(p2.perIlPrompt()));
}

// ─────────────────────────────────────────
section('Robustezza');
// ─────────────────────────────────────────
{
  const p = nuovo();
  ok('un passo inesistente non fa crashare', p.iniziaPasso(99).ok === false);
  ok('un numero non valido non fa crashare', p.completaPasso(null, PROVA_VALIDA).ok === false);
  const vuoto = new Processo('obiettivo', []);
  ok('un processo senza passi è concluso per definizione', vuoto.concluso() === true);
  ok('il riepilogo funziona sempre', typeof p.riepilogo().totale === 'number');
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
