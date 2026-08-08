#!/usr/bin/env node
// tests/test-una-fonte-sola.js — Una regola, una copia. E la domanda giusta
// alla conoscenza.
//
// PERCHÉ QUESTO FILE
//
// I sette criteri vivevano in tre posti: incarico.js (l'unico che conta,
// perché è quello che valuta), il prompt del Collega, e manuali/criteri.md.
// Oggi dicono la stessa cosa — ma niente lo garantisce. Il giorno in cui il
// codice ne conosce sette e il prompt ne descrive otto, il Collega chiede un
// criterio che il codice scarta in silenzio, e l'incarico risulta "senza
// verifica" senza che nessuno capisca perché.
//
// È la malattia dell'8 agosto in un'altra stanza: due copie della stessa cosa,
// e vince quella sbagliata.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');
const { TIPI, CRITERI, elencoCriteriPerPrompt } = require('../modules/collega/incarico');
const { promptIncarico } = require('../modules/collega/prompt');
const { domandaPerLaConoscenza } = require('../modules/collega/comando');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== UNA FONTE SOLA ===');

sezione('I criteri: il prompt li genera, non li ricopia');
{
  ok('ogni criterio del codice ha una descrizione',
     TIPI.every(t => CRITERI[t] && CRITERI[t].forma && CRITERI[t].spiega));

  const prompt = promptIncarico();
  const mancanti = TIPI.filter(t => !prompt.includes(t));
  ok(`tutti i ${TIPI.length} criteri arrivano nel prompt`, mancanti.length === 0,
     'assenti: ' + mancanti.join(', '));

  // Il verso che conta davvero: il prompt non deve nominare criteri che il
  // codice non sa valutare. Sarebbero istruzioni a vuoto.
  const nominati = [...prompt.matchAll(/"tipo":\s*"([a-z_]+)"/g)].map(m => m[1]);
  const inventati = [...new Set(nominati)].filter(t => !TIPI.includes(t));
  ok('e il prompt non ne inventa altri', inventati.length === 0,
     'il codice non li conosce: ' + inventati.join(', '));

  // La prova che la generazione è viva: cambiando il codice cambia il prompt.
  ok('l elenco nasce dal codice', elencoCriteriPerPrompt().includes(TIPI[0]));
  const sorgente = fs.readFileSync('modules/collega/prompt.js', 'utf8');
  ok('e il prompt lo chiede a chi valuta', /elencoCriteriPerPrompt/.test(sorgente));
}

sezione('Il manuale non si allontana dal codice');
{
  const manuale = fs.readFileSync('modules/collega/manuali/criteri.md', 'utf8');
  const mancanti = TIPI.filter(t => !manuale.includes(t));
  ok('il manuale li descrive tutti', mancanti.length === 0, 'assenti: ' + mancanti.join(', '));

  const nominati = [...manuale.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map(m => m[1]);
  const sospetti = [...new Set(nominati)]
    .filter(t => /^(elementi|campi|soggetti|origine|file|nessun|formato)_/.test(t))
    .filter(t => !TIPI.includes(t));
  ok('e non ne descrive di inesistenti', sospetti.length === 0,
     'nel manuale ma non nel codice: ' + sospetti.join(', '));
}

sezione('La conoscenza si interroga sull incarico, non sul messaggio');
{
  const incarico = {
    obiettivo: 'Confrontare DHL UPS e FedEx per una spedizione verso gli Stati Uniti',
    criteri: [
      { tipo: 'soggetti_coperti', soggetti: ['DHL', 'UPS', 'FedEx'] },
      { tipo: 'campi_obbligatori', campi: ['tariffa', 'tempi'] },
    ],
  };

  // Il caso vero: dopo una domanda del Collega, la risposta è una parola.
  for (const risposta of ['vai', 'ok', 'procedi', 'sì']) {
    const d = domandaPerLaConoscenza(incarico, risposta);
    ok(`"${risposta}" non diventa la domanda alla KB`, !d.startsWith(risposta) && d.includes('DHL'));
  }

  const d = domandaPerLaConoscenza(incarico, 'vai');
  ok('la domanda porta l obiettivo', /spedizione/.test(d));
  ok('e i soggetti', /DHL/.test(d) && /FedEx/.test(d));
  ok('e i campi che servono', /tariffa/.test(d));

  // Un messaggio che dice qualcosa, invece, si tiene.
  const lungo = domandaPerLaConoscenza(incarico, 'aggiungi anche TNT se costa meno');
  ok('un messaggio con sostanza resta dentro', /TNT/.test(lungo));

  // Senza incarico non c'è niente di meglio del messaggio.
  ok('senza incarico si torna al messaggio',
     domandaPerLaConoscenza(null, 'cercami i voli per Tokyo') === 'cercami i voli per Tokyo');
  ok('e non esplode sul vuoto', domandaPerLaConoscenza(null, '') === '');

  const sorgente = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('e chat.js la usa davvero', /searchKB\(_domandaKB\)/.test(sorgente));
}

sezione('La difficolta e un numero, non un colpo d occhio');
{
  const { modelloPer, difficoltaDi } = require('../modules/collega/comando');

  const messaggio = { criteri: [{ tipo: 'elementi_minimi', quanti: 1 }] };
  const voliDue = { criteri: [
    { tipo: 'soggetti_coperti', soggetti: ['Milano', 'Madrid'] },
    { tipo: 'origine_verificabile' }] };
  const grosso = { criteri: [
    { tipo: 'soggetti_coperti', soggetti: ['a','b','c','d','e','f','g','h'] },
    { tipo: 'origine_verificabile' },
    { tipo: 'campi_obbligatori', campi: ['prezzo','frequenza','aereo'] },
    { tipo: 'file_atteso', estensione: 'html' },
    { tipo: 'formato_consegna' }] };

  ok('mandare un messaggio resta un lavoro semplice', modelloPer(messaggio).tier === 'standard');
  ok('due citta con prezzi da verificare no', modelloPer(voliDue).tier === 'power');

  // L'ordine conta: il conto deve DISTINGUERE, non solo classificare.
  ok('e otto compagnie pesano piu di due citta',
     difficoltaDi(grosso).punteggio > difficoltaDi(voliDue).punteggio);
  ok('che pesano piu di un messaggio',
     difficoltaDi(voliDue).punteggio > difficoltaDi(messaggio).punteggio);

  // Deterministico: lo stesso incarico da sempre lo stesso numero.
  ok('lo stesso incarico da sempre lo stesso numero',
     difficoltaDi(grosso).punteggio === difficoltaDi(grosso).punteggio);

  // Il numero di soggetti conta davvero, non solo la presenza del criterio.
  const due = { criteri: [{ tipo: 'soggetti_coperti', soggetti: ['a','b'] }] };
  const otto = { criteri: [{ tipo: 'soggetti_coperti', soggetti: ['a','b','c','d','e','f','g','h'] }] };
  ok('otto soggetti pesano piu di due', difficoltaDi(otto).punteggio > difficoltaDi(due).punteggio);

  ok('il punteggio non sfonda il tetto', difficoltaDi(grosso).punteggio <= 100);
  ok('senza criteri il conto e zero', difficoltaDi({ criteri: [] }).punteggio === 0);
  ok('e non esplode sul vuoto', difficoltaDi(null).punteggio === 0);

  // E si spiega a voce: chi legge il registro deve capire senza aprire il file.
  ok('il motivo si legge ad alta voce', /difficolt/.test(modelloPer(grosso).perche));
  ok('e nomina la cosa che pesa di piu', /verificat/.test(modelloPer(grosso).perche));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  UNA FONTE SOLA: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
