#!/usr/bin/env node
// tests/test-checklist-e-recupero.js — Contare quello che è stato chiesto, e
// capire perché una cosa non è riuscita.
//
// PERCHÉ QUESTO FILE
//
// Due difetti diversi, stessa radice: si decideva a occhio.
//
//   1. Il Collega scrive i criteri guardando la richiesta, e a occhio si
//      perdono pezzi. "Cina → PHX, SAN e LAS con aeroporti, frequenze e
//      aircraft" diventava "cerca voli, confronta, fai il report": tre passi
//      che si possono dichiarare fatti senza che nessuno sappia dire se manca
//      LAS.
//
//   2. Quando qualcosa falliva, il ripiego era una sequenza fissa: metodo 1,
//      metodo 2, metodo 3, mi arrendo. Funziona se il guasto è quello
//      previsto. L'8 agosto `linkedin_connect` andava in timeout perché
//      NESSUNO ascoltava su quel canale, e sono stati fatti quattro tentativi
//      identici: riprovare non poteva funzionare, perché il problema non era
//      il tentativo.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');
const { requisitiMancanti, checklistInChiaro, soggettiNominati, campiChiesti } = require('../modules/collega/requisiti');
const { checosaE, comeRecuperare, TIPI } = require('../modules/collega/recupero');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== LA CHECKLIST E IL RECUPERO ===');

const RICHIESTA = 'Cercami tutte le compagnie con voli diretti dalla Cina verso PHX, SAN e LAS, '
  + 'indicami aeroporti, frequenze, aircraft e crea un confronto';

sezione('Contare quello che la richiesta chiedeva');
{
  const s = soggettiNominati(RICHIESTA);
  ok('trova tutte e tre le destinazioni', ['PHX', 'SAN', 'LAS'].every(x => s.includes(x)), s.join(','));

  const c = campiChiesti(RICHIESTA);
  ok('trova i campi chiesti', ['frequenza', 'aeromobile', 'aeroporto'].every(x => c.includes(x)), c.join(','));

  const lista = checklistInChiaro(RICHIESTA, []);
  ok('la checklist si legge a colpo d occhio', /☐ PHX/.test(lista) && /☐ LAS/.test(lista));
  ok('e include il documento finale', /documento finale/.test(lista));
}

sezione('I criteri mancanti si aggiungono');
{
  // Il caso reale: il Collega ha messo un criterio generico e basta.
  const r = requisitiMancanti(RICHIESTA, [{ tipo: 'elementi_minimi', quanti: 3 }]);
  const tipi = r.mancanti.map(m => m.tipo);
  ok('aggiunge i soggetti', tipi.includes('soggetti_coperti'));
  ok('aggiunge i campi', tipi.includes('campi_obbligatori'));
  ok('aggiunge la fonte', tipi.includes('origine_verificabile'));
  ok('aggiunge il documento', tipi.includes('file_atteso'));
  ok('e il divieto di duplicati', tipi.includes('nessun_duplicato'));
  ok('col motivo scritto per ognuno', r.mancanti.every(m => m.perche && m.perche.length > 10));
}

sezione('Il caso peggiore: il criterio che c e ma e INCOMPLETO');
{
  // Sembra controllato, e non lo è: tre soggetti su quattro passano la
  // verifica, e il lavoro risulta finito senza LAS.
  const r = requisitiMancanti(RICHIESTA, [
    { tipo: 'soggetti_coperti', soggetti: ['PHX', 'SAN'] },
    { tipo: 'campi_obbligatori', campi: ['aeroporto'] },
  ]);
  const sog = r.mancanti.find(m => m.tipo === 'soggetti_coperti');
  ok('si accorge del soggetto che manca', !!sog && sog.soggetti.includes('LAS'));
  ok('senza perdere quelli che c erano', sog.soggetti.includes('PHX') && sog.soggetti.includes('SAN'));
  ok('e lo dice', /LAS/.test(sog.perche));

  const cam = r.mancanti.find(m => m.tipo === 'campi_obbligatori');
  ok('e dei campi che mancano', !!cam && cam.campi.includes('frequenza') && cam.campi.includes('aeroporto'));
}

sezione('Non inventa requisiti che nessuno ha chiesto');
{
  const r = requisitiMancanti('mandami un messaggio a Sara su LinkedIn', []);
  ok('un messaggio non diventa un progetto', r.mancanti.length === 0, JSON.stringify(r.mancanti.map(m => m.tipo)));
  const r2 = requisitiMancanti('che ore sono?', []);
  ok('e una domanda nemmeno', r2.mancanti.length === 0);
  const r3 = requisitiMancanti('', []);
  ok('e il vuoto non esplode', r3.mancanti.length === 0);
}

sezione('Che tipo di guasto e');
{
  ok('un login e una dipendenza', checosaE('Devi effettuare il login').tipo === TIPI.DIPENDENZA);
  ok('e non si riprova', checosaE('Devi effettuare il login').riprovare === false);
  ok('un pulsante che non c e e strategia', checosaE('non trovo il pulsante Collegati').tipo === TIPI.STRATEGIA);
  ok('nessun risultato e impossibile', checosaE('Nessun volo trovato').tipo === TIPI.IMPOSSIBILE);
  ok('un timeout la prima volta e passeggero', checosaE('Extension timeout (25s)', 0).tipo === TIPI.PASSEGGERO);
  ok('e si riprova', checosaE('Extension timeout (25s)', 0).riprovare === true);
}

sezione('IL PUNTO: un guasto passeggero che si ripete NON e passeggero');
{
  // È il caso dell'8 agosto, quattro volte di fila.
  const r = checosaE('Extension timeout (25s)', 3);
  ok('al terzo giro cambia diagnosi', r.tipo === TIPI.STRATEGIA);
  ok('e smette di dire "riprova"', r.riprovare === false);
  ok('dicendo che sembrava altro', r.eraSembrato === TIPI.PASSEGGERO);
  ok('e che riprovare uguale non porta niente', /non porta da nessuna parte/.test(r.cosaFare));

  const c = comeRecuperare('non trovo il campo destinazione', 1);
  ok('per un guasto di strategia arriva la scaletta', !!c.scaletta);
  ok('che comincia dal caricamento', /finito di caricare/.test(c.scaletta));
  ok('e finisce con un altra strada', /un'altra strada|altra strada/i.test(c.scaletta));
  ok('e dice di fermarsi appena una risponde', /Fermati appena una risponde/.test(c.scaletta));
}

sezione('Il recupero e codice, non un altro modello');
{
  const src = fs.readFileSync('modules/collega/recupero.js', 'utf8');
  ok('non chiama nessun modello', !/callAI|chiamaModello|openai|anthropic/i.test(src));
  ok('lo stesso errore da sempre la stessa diagnosi',
     checosaE('timeout', 1).tipo === checosaE('timeout', 1).tipo);
}

sezione('Il turno li usa davvero');
{
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('la checklist entra nei criteri', /requisitiMancanti\(/.test(chat));
  ok('e i criteri aggiunti finiscono nell incarico', /incaricoCorrente\.criteri = criteriNuovi/.test(chat));
  ok('con il motivo nel registro', /\[Checklist\] \+ \$\{m\.tipo\}/.test(chat));
  ok('e se la checklist salta si lavora lo stesso', /Checklist\] saltata/.test(chat));

  const rip = fs.readFileSync('modules/collega/ripresa.js', 'utf8');
  ok('il foglio di ripresa dice CHE TIPO di guasto era', /comeRecuperare\(/.test(rip));
  ok('e conta quante volte lo stesso guasto si ripete', /_quanteVolte/.test(rip));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  CHECKLIST E RECUPERO: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
