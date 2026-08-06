#!/usr/bin/env node
// tests/test-sorveglianza.js — Il criterio è il progresso, non l'orologio.
//
// La versione precedente tagliava a 25 secondi qualunque cosa stesse
// succedendo: troncava una ricerca che stava caricando bene, e aspettava
// fino allo scadere una che era morta da dieci secondi. Qui si verifica che
// non succeda più né l'uno né l'altro.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { Sorveglianza, DECISIONI } = require('../modules/collega/sorveglianza');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

function guardia(opz = {}) {
  const detti = [];
  const g = new Sorveglianza({ avvisa: (m, i) => detti.push({ m, i }), ...opz });
  g._detti = detti;
  return g;
}

console.log('\n=== SORVEGLIANZA DEL LAVORO IN CORSO ===');

(async () => {

// ─────────────────────────────────────────
sezione('Un lavoro che progredisce non viene mai troncato');
// ─────────────────────────────────────────
{
  const g = guardia();
  // Venti letture che crescono: nessuna deve interrompere
  let interrotto = null;
  for (let i = 1; i <= 20; i++) {
    const e = g.segnala({ misura: i * 1500, cosa: 'google.com' });
    if (e.decisione !== 'procedi') { interrotto = { giro: i, ...e }; break; }
  }
  ok('venti letture in crescita proseguono', interrotto === null, JSON.stringify(interrotto));
  ok('il progresso viene contato', g.riepilogo().progressi === 20);
}

// ─────────────────────────────────────────
sezione('Una pagina ferma si chiude senza aspettare l orologio');
// ─────────────────────────────────────────
{
  const g = guardia({ minimoPerConcludere: 0 });
  g.segnala({ misura: 4000, cosa: 'sito.it' });
  const a = g.segnala({ misura: 4000 });
  const b = g.segnala({ misura: 4000 });
  const c = g.segnala({ misura: 4000 });
  ok('la prima immobilità non basta', a.decisione === 'procedi');
  ok('nemmeno la seconda', b.decisione === 'procedi');
  ok('alla terza si chiude', c.decisione === 'concluso', JSON.stringify(c));
  ok('e dice perché', /stabile/.test(c.motivo), c.motivo);
  ok('senza aspettare nessun tetto di tempo', c.dettagli.durata < 1000);
}

// ─────────────────────────────────────────
sezione('Stabile non vuol dire finito: il guscio di Google Voli');
// ─────────────────────────────────────────
{
  // Misurato sul campo: intestazione e filtri arrivano in 2s e restano fermi,
  // i prezzi compaiono verso il nono. Chiudere a 6s legge il guscio.
  const g = guardia();
  g.segnala({ misura: 1400, cosa: 'google.com' });
  let ultima;
  for (let i = 0; i < 4; i++) ultima = g.segnala({ misura: 1400 });
  ok('non chiude sul guscio dopo pochi secondi', ultima.decisione === 'procedi', JSON.stringify(ultima));
  ok('dice che sta aspettando i dati', /aspetto i dati/.test(ultima.motivo), ultima.motivo);

  // E se i prezzi arrivano davvero, il conteggio riparte
  const dopo = g.segnala({ misura: 2600 });
  ok('l arrivo dei prezzi fa ripartire', dopo.decisione === 'procedi');
  ok('il progresso viene registrato', g.riepilogo().progressi === 2);
}

// ─────────────────────────────────────────
sezione('Ferma E vuota: non è finita, è da cambiare strada');
// ─────────────────────────────────────────
{
  // Una pagina vuota puo' semplicemente non aver ancora finito di disegnarsi:
  // su emirates.com si e' mollato dopo QUATTRO secondi mentre la pagina aveva
  // 8.578 caratteri in arrivo. Prima si aspetta, poi si giudica.
  const veloce = guardia();
  let subito;
  for (let i = 0; i < 4; i++) subito = veloce.segnala({ misura: 0, cosa: 'emirates.com' });
  ok('non molla una pagina vuota dopo pochi secondi', subito.decisione === 'procedi', JSON.stringify(subito));
  ok('e dice che le sta dando tempo', /tempo di caricare/.test(subito.motivo), subito.motivo);

  // Passato il tempo minimo, il vuoto e' vuoto davvero
  const g = guardia({ minimoPerVuoto: 30 });
  await new Promise(r => setTimeout(r, 50));
  let ultima;
  for (let i = 0; i < 4; i++) ultima = g.segnala({ misura: 0, cosa: 'kayak.it' });
  ok('non dichiara concluso il nulla', ultima.decisione === 'cambia_strada', JSON.stringify(ultima));
  ok('spiega che non c e contenuto', /nessun contenuto/.test(ultima.motivo), ultima.motivo);
}

// ─────────────────────────────────────────
sezione('Finché la pagina dice di star caricando, si aspetta');
// ─────────────────────────────────────────
{
  const g = guardia({ minimoPerConcludere: 0 });
  let ultima;
  // Ferma da sei letture MA dichiara di stare caricando: non si molla
  for (let i = 0; i < 6; i++) ultima = g.segnala({ misura: 900, attesa: true, cosa: 'voli' });
  ok('non si interrompe una pagina che sta caricando', ultima.decisione === 'procedi', JSON.stringify(ultima));
  ok('lo dice esplicitamente', /caricando/.test(ultima.motivo));
  // Appena smette di dichiararlo e resta ferma, si chiude
  g.segnala({ misura: 900 }); g.segnala({ misura: 900 });
  ok('quando smette di caricare e resta ferma, chiude', g.segnala({ misura: 900 }).decisione === 'concluso');
}

// ─────────────────────────────────────────
sezione('Uno strumento che non risponde non si insegue');
// ─────────────────────────────────────────
{
  const g = guardia();
  g.segnala({ misura: 1200, cosa: 'sito.it' });
  const primo = g.segnala({ guasto: 'Bridge command timeout: get_page_content' });
  ok('il primo guasto non basta per mollare', primo.decisione === 'procedi', JSON.stringify(primo));
  const secondo = g.segnala({ guasto: 'Bridge command timeout: get_page_content' });
  ok('al secondo si cambia strada', secondo.decisione === 'cambia_strada', JSON.stringify(secondo));
  ok('e si riporta l errore vero', /timeout/.test(secondo.motivo), secondo.motivo);
  ok('i guasti restano nel riepilogo', g.riepilogo().guasti.length === 2);
}

// ─────────────────────────────────────────
sezione('Luca viene tenuto informato mentre succede');
// ─────────────────────────────────────────
{
  const g = guardia({ silenzioMs: 30 });
  g.segnala({ misura: 1000, cosa: 'booking.com' });
  await new Promise(r => setTimeout(r, 60));
  g.segnala({ misura: 3000, cosa: 'booking.com' });
  ok('viene avvisato che si sta ancora lavorando', g._detti.length >= 1, JSON.stringify(g._detti));
  ok('il messaggio nomina il sito', /booking\.com/.test(g._detti[0].m), g._detti[0].m);
  ok('e dice che i dati stanno arrivando', /arrivando|leggendo/.test(g._detti[0].m), g._detti[0].m);

  const f = guardia({ silenzioMs: 30 });
  f.segnala({ misura: 500, cosa: 'lento.it' });
  await new Promise(r => setTimeout(r, 60));
  f.segnala({ misura: 500, cosa: 'lento.it' });
  ok('se è fermo lo dice diversamente', /non risponde/.test(f._detti[0].m), f._detti[0].m);
}

// ─────────────────────────────────────────
sezione('Un lavoro lungo e fermo torna a Luca invece di consumare tempo');
// ─────────────────────────────────────────
{
  const g = guardia({ silenzioMs: 20, fermoMax: 99 });
  g.segnala({ misura: 2000, cosa: 'x' });
  await new Promise(r => setTimeout(r, 80));
  const e = g.segnala({ misura: 2000, attesa: true, cosa: 'x' });
  ok('resta in attesa se la pagina lo dichiara', e.decisione === 'procedi');
  const e2 = g.segnala({ misura: 2000, cosa: 'x' });
  ok('altrimenti chiede a Luca', e2.decisione === 'chiedi_a_luca', JSON.stringify(e2));
  ok('dicendo da quanto è fermo', /fermo da/.test(e2.motivo), e2.motivo);
}

// ─────────────────────────────────────────
sezione('Robustezza e contratto');
// ─────────────────────────────────────────
{
  const g = guardia();
  ok('un segnale vuoto non crasha', DECISIONI.includes(g.segnala({}).decisione));
  ok('nessun argomento non crasha', DECISIONI.includes(g.segnala().decisione));
  ok('le decisioni sono solo quelle previste', DECISIONI.length === 4);
  ok('il riepilogo è sempre disponibile', typeof g.riepilogo().durataMs === 'number');
  g.reset();
  ok('si può ricominciare', g.riepilogo().letture === 0);

  const fs = require('fs');
  const nav = fs.readFileSync('modules/tools/handlers/navigate.js', 'utf8');
  ok('navigate usa la sorveglianza', /new Sorveglianza/.test(nav));
  ok('e non ha più il tetto cieco', !/TETTO_ATTESA_MS/.test(nav));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
