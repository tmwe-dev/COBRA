#!/usr/bin/env node
// tests/test-fabrication-guard.js — Guardia contro i dati inventati.
// I casi negativi sono risposte realmente prodotte da COBRA durante una ricerca
// voli: tabelle di prezzi e durate costruite senza aver consultato nulla.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { analizzaRisposta, rispostaOnesta } = require('../modules/security/fabrication-guard');
const SM = require('../modules/supermario');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const SENZA_FONTE = { intent: 'task', toolsUsed: [], kbSnippets: [], hasPageContent: false };
const CON_FONTE = { intent: 'task', toolsUsed: [{ name: 'google_search', ok: true }], kbSnippets: [], hasPageContent: false };

console.log('\n=== GUARDIA ANTI-INVENZIONE ===');

// ─────────────────────────────────────────
section('Risposte realmente inventate da COBRA');
// ─────────────────────────────────────────
const INVENTATE = [
  ['tabella voli con prezzi',
   'Ecco i risultati:\n1. Volo diretto con Air Europa 800 € Durata: 12 ore\n2. Iberia 650 € Durata: 15 ore\n3. KLM 700 € Durata: 16 ore'],
  ['elenco compagnie con prezzi',
   'Volo 1: Air Europa\nPrezzo: 800 €\nDurata: 12 ore\nScalo: Nessuno'],
  ['prezzi business inventati',
   'Risultati per voli business:\nAir Europa 1.500 € 12 ore Diretto\nIberia 1.200 € 15 ore Madrid'],
  ['promessa di cercare seguita da dati',
   'Procedo a cercare informazioni sui voli. Un momento.\n\nAir Europa 800 €, durata 12 ore.'],
];
for (const [nome, testo] of INVENTATE) {
  const r = analizzaRisposta(testo, SENZA_FONTE);
  ok(`intercetta: ${nome}`, r.sospetta && r.gravita === 'invenzione',
     `gravita=${r.gravita} motivi=${r.motivi.join('; ')}`);
}

{
  const r = analizzaRisposta('Procedo a cercare i voli. Un momento.', SENZA_FONTE);
  ok('intercetta la promessa vuota senza dati', r.sospetta && r.gravita === 'promessa',
     `gravita=${r.gravita}`);
}

// ─────────────────────────────────────────
section('Le stesse risposte con una fonte reale passano');
// ─────────────────────────────────────────
for (const [nome, testo] of INVENTATE) {
  const r = analizzaRisposta(testo, CON_FONTE);
  ok(`consentita con tool riuscito: ${nome}`, !r.sospetta, r.motivi.join('; '));
}
{
  const conPagina = { ...SENZA_FONTE, hasPageContent: true };
  ok('consentita se una pagina è stata letta',
     !analizzaRisposta('Il volo costa 555 € e dura 14 ore.', conPagina).sospetta);
  const conKb = { ...SENZA_FONTE, kbSnippets: [{ title: 'tariffe' }] };
  ok('consentita se viene dalla knowledge base',
     !analizzaRisposta('La tariffa è 120 €.', conKb).sospetta);
  const toolFallito = { ...SENZA_FONTE, toolsUsed: [{ name: 'google_search', ok: false }] };
  ok('NON consentita se il tool è fallito',
     analizzaRisposta('Il volo costa 555 €.', toolFallito).sospetta,
     'un tool fallito non è una fonte');
}

// ─────────────────────────────────────────
section('Risposte oneste non vengono toccate');
// ─────────────────────────────────────────
const LECITE = [
  ['ammette di non sapere', 'Non ho questo dato. Lo cerco adesso.'],
  ['dichiara il limite', 'Non riesco a consultare la fonte, quindi non posso darti i prezzi.'],
  ['conversazione normale', 'Ciao Luca, come posso aiutarti?'],
  ['spiega cosa può fare', 'Posso cercare voli, leggere pagine e prepararti un riepilogo.'],
  ['testo vuoto', ''],
];
for (const [nome, testo] of LECITE) {
  ok(`lascia passare: ${nome}`, !analizzaRisposta(testo, SENZA_FONTE).sospetta,
     analizzaRisposta(testo, SENZA_FONTE).motivi.join('; '));
}

// ─────────────────────────────────────────
section('La sostituzione è onesta e utile');
// ─────────────────────────────────────────
{
  const t = rispostaOnesta('invenzione', ['riporta prezzo']);
  ok('ammette di non avere la fonte', /non ho consultato/i.test(t));
  ok('dice che si starebbe inventando', /inventando/i.test(t));
  ok('indica come procedere', /cercare|cerca/i.test(t));
  ok('non contiene numeri inventati', !/\d+\s?€/.test(t));
}

// ─────────────────────────────────────────
section('Continuità: i seguiti non perdono gli strumenti');
// ─────────────────────────────────────────
{
  const primo = SM.routeIntent('cerca un volo milano havana sabato prossimo, prezzi e durata');
  ok('la richiesta iniziale è operativa', primo.intent === 'task', primo.intent);

  const seguiti = [
    'dammi 3 voli e prezzi precisi',
    'voglio dettagli e compagnie aeree',
    'voglio solo le opzioni business',
    'e in economy?',
    'quanto dura il piu veloce',
  ];
  for (const s of seguiti) {
    const r = SM.routeIntent(s);
    ok(`resta operativo: "${s.substring(0, 32)}"`, r.intent === 'task',
       `intent=${r.intent} scopes=[${r.scopes.join(',')}]`);
  }
}
{
  // Dopo un task, una vera conversazione deve tornare chat
  SM.routeIntent('cerca voli per Milano');
  for (const saluto of ['ciao', 'grazie', 'chi sei']) {
    ok(`"${saluto}" resta conversazione`, SM.routeIntent(saluto).intent === 'chat');
  }
}

// ─────────────────────────────────────────
section('La regola è scritta nel prompt');
// ─────────────────────────────────────────
{
  const { COBRA_CORE } = require('../modules/prompts/cobra-core');
  ok('la regola anti-invenzione è la prima del prompt',
     COBRA_CORE.indexOf('REGOLA ZERO') >= 0 && COBRA_CORE.indexOf('REGOLA ZERO') < 200,
     `posizione: ${COBRA_CORE.indexOf('REGOLA ZERO')}`);
  ok('vieta i dati non letti da una fonte', /non hai letto da una fonte NON ESISTE/i.test(COBRA_CORE));
  ok('vieta di annunciare ricerche non fatte', /procedo a cercare/i.test(COBRA_CORE));
  ok('vieta le tabelle riempite di valori plausibili', /valori plausibili/i.test(COBRA_CORE));
  ok('indica la risposta corretta da dare', /Non ho questo dato/i.test(COBRA_CORE));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
