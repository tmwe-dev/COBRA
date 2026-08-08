#!/usr/bin/env node
// tests/test-sguardo.js — Guardare la pagina, e poterne nominare i pezzi.
//
// PERCHÉ QUESTO FILE
//
// Per agire su una pagina il modello doveva produrre un selettore CSS, e il
// selettore se lo inventava. Un selettore inventato non dà errore: dà zero
// elementi trovati, quindi zero campi compilati e un modulo che parte vuoto.
// È il difetto che l'8 agosto ha lasciato moduli vuoti senza che nessuno se ne
// accorgesse — perché nessuno dei due lati diceva niente.
//
// Adesso il modello guarda prima, riceve E1..En, e agisce su quelli. Non può
// nominare una cosa che non esiste: i nomi glieli diamo noi.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');
const handlers = require('../modules/tools/handlers');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const SGUARDO = fs.readFileSync('cobra-extension/esterni/sguardo.js', 'utf8');
// I commenti raccontano anche le cose che NON si fanno — "nth-child smette di
// significare qualcosa", "offsetParent e' nullo sui fixed". Cercare quelle
// parole nel testo intero fa fallire la prova proprio dove il codice e' giusto.
const CODICE = SGUARDO.replace(/\/\/[^\n]*/g, '');

(async () => {
  console.log('\n=== LO SGUARDO ===');

  sezione('La catena completa: handler, schema, rischio, ambito');
  {
    const { COBRA_TOOLS } = require('../modules/tools/schemas');
    const { TOOL_RISK_TAXONOMY } = require('../modules/risk/taxonomy');
    const { TOOL_SCOPES } = require('../modules/supermario');
    const raggiungibili = new Set();
    for (const [n, l] of Object.entries(TOOL_SCOPES || {})) {
      if (n === 'full' || !Array.isArray(l)) continue;
      l.forEach(t => raggiungibili.add(t));
    }
    // È l'anello che è saltato sei volte: uno strumento fuori dagli ambiti non
    // esiste, per quanto sia ben scritto.
    for (const t of ['guarda_pagina', 'agisci']) {
      ok(`${t}: ha un handler`, typeof handlers[t] === 'function');
      ok(`${t}: ha uno schema`, COBRA_TOOLS.some(x => x.function.name === t));
      ok(`${t}: ha un rischio dichiarato`, !!TOOL_RISK_TAXONOMY[t]);
      ok(`${t}: è raggiungibile da un ambito`, raggiungibili.has(t));
    }
  }

  sezione('Guarda prima di agire: un freno, non un consiglio');
  {
    const ctx = { session: {}, log() {}, emitReasoning() {}, isBridgeReady: () => true,
      bridgeCommand: async () => ({ result: { ok: true } }) };
    const r = JSON.parse(await handlers.agisci({ id: 'E7', cosa: 'clicca' }, ctx));
    ok('senza aver guardato non agisce', r.ok === false);
    ok('e dice cosa fare', /guarda_pagina/.test(r.cosaFare || ''));

    // Guardato un'altra pagina: gli id sono di un altro posto.
    const ctx2 = { session: { _paginaGuardata: { url: 'https://a.it/x' }, lastPage: { url: 'https://b.it/y' } },
      log() {}, emitReasoning() {}, isBridgeReady: () => true,
      bridgeCommand: async () => ({ result: { ok: true } }) };
    const r2 = JSON.parse(await handlers.agisci({ id: 'E7' }, ctx2));
    ok('gli id di un altra pagina non valgono', r2.ok === false);
    ok('e lo dice chiaramente', /altra pagina/.test(r2.motivo || ''));
  }

  sezione('Dopo un click la pagina non e piu quella di prima');
  {
    const ctx = { session: { _paginaGuardata: { url: 'https://x.it' }, lastPage: { url: 'https://x.it' } },
      log() {}, emitReasoning() {}, isBridgeReady: () => true,
      bridgeCommand: async () => ({ result: { ok: true, premuto: 'Cerca' } }) };
    const r = JSON.parse(await handlers.agisci({ id: 'E7', cosa: 'clicca' }, ctx));
    ok('il click riesce', r.ok === true);
    ok('lo sguardo decade', ctx.session._paginaGuardata === null);
    ok('e il modello viene avvisato', /guarda di nuovo/i.test(r.attenzione || ''));
  }

  sezione('Come si vede un elemento: la regola giusta');
  {
    // offsetParent è nullo per QUALUNQUE elemento position:fixed — cioè per i
    // riquadri modali e i banner, che sono proprio le cose su cui bisogna
    // agire. È il difetto che teneva a schermo i cookie e che avrebbe fatto
    // fallire la richiesta di collegamento LinkedIn.
    ok('non si usa offsetParent per decidere la visibilita', !/offsetParent/.test(CODICE));
    ok('si misura lo spazio occupato', /getBoundingClientRect/.test(SGUARDO));
    ok('e si legge lo stile calcolato', /getComputedStyle/.test(SGUARDO));
    ok('opacita zero conta come invisibile', /Number\(st\.opacity\) === 0/.test(SGUARDO));
  }

  sezione('Dove guarda');
  {
    ok('entra negli shadow root', /shadowRoot/.test(SGUARDO));
    ok('e negli iframe della stessa origine', /contentDocument/.test(SGUARDO));
    ok('ordina come si legge, non come e scritto il DOM', /r\.top \/ 24/.test(SGUARDO));
    ok('e porta il rettangolo per ragionare sulla posizione', /area:/.test(SGUARDO));
  }

  sezione('Come si ritrova un elemento quando la pagina si ridisegna');
  {
    // L'ordine conta: prima le cose stabili, poi il significato, e la
    // posizione sullo schermo solo come ultima spiaggia.
    const i1 = SGUARDO.indexOf("come = 'id'");
    const i2 = SGUARDO.indexOf("come = 'significato'");
    const i3 = SGUARDO.indexOf("come = 'posizione sullo schermo'");
    ok('prima l id HTML', i1 > 0 && i1 < i2);
    ok('poi il significato: ruolo piu nome', i2 > 0 && i2 < i3);
    ok('e la posizione solo come ultima spiaggia', i3 > i2);
    ok('non si salvano selettori CSS fragili', !/nth-child/.test(CODICE));
  }

  sezione('Cliccare e scrivere come una persona');
  {
    ok('il click manda la sequenza del puntatore, non solo click',
       /pointerdown/.test(SGUARDO) && /mouseup/.test(SGUARDO));
    ok('prima di scrivere si svuota', /non si e\\' svuotata|svuotata/.test(SGUARDO));
    ok('e si VERIFICA che sia vuota prima di scrivere sopra',
       /non scrivo sopra a quello che c/.test(SGUARDO));
    ok('dopo aver scritto si rilegge il campo', /Si RILEGGE/.test(SGUARDO));
    ok('e si riferisce cio che c e davvero, non cio che si voleva',
       /ma nel campo c'e'/.test(SGUARDO));
    ok('un elenco a tendina dice quali opzioni esistono', /opzioni:/.test(SGUARDO));
  }

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  LO SGUARDO: ${pass} PASS, ${fail} FAIL`);
  console.log(`╚══════════════════════════════════════════╝`);
  process.exit(fail ? 1 : 0);
})();
