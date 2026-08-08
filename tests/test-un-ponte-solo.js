#!/usr/bin/env node
// tests/test-un-ponte-solo.js — Verso il browser si passa da UN ponte solo.
//
// PERCHÉ QUESTO FILE
//
// C'erano due ponti. `ctx.bridgeCommand` parla con l'estensione COBRA, quella
// collegata, quella che si vede lavorare. `ctx.extRelay` parlava con un'ALTRA
// estensione, via postMessage su `direction: from-webapp-li` — e su quel canale
// non ascoltava nessuno.
//
// Un comando mandato lì non falliva: spariva. Nessun errore, nessuna pagina che
// si apre, solo un'attesa fino al timeout. L'8 agosto sono serviti quattro
// tentativi e un'ora per capirlo, e a vederlo per primo è stato Luca: "io non
// vedo cercare su linkedin la pagina corretta". Non la cercava nessuno.
//
// Tre strumenti passavano SOLO di lì — non potevano riuscire, mai. Altri
// quattro lo tenevano come riserva, cioè un minuto e mezzo buttato prima di
// arrendersi.
//
// Questo controllo esiste perché quella strada non si riapra per distrazione.

const fs = require('fs');
const path = require('path');

const CARTELLA = path.resolve(__dirname, '../modules/tools/handlers');
const ESTENSIONE = path.resolve(__dirname, '../cobra-extension/background.js');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}

console.log('\n── Un ponte solo verso il browser ──');

// ── 1. Nessun handler chiama più il ponte fantasma ──
{
  const colpevoli = [];
  for (const f of fs.readdirSync(CARTELLA).filter(x => x.endsWith('.js'))) {
    const testo = fs.readFileSync(path.join(CARTELLA, f), 'utf8');
    // Si contano le CHIAMATE, non le parole nei commenti: il commento che
    // racconta la storia deve poter restare.
    const chiamate = (testo.match(/ctx\.extRelay\s*\(/g) || []).length;
    if (chiamate) colpevoli.push(`${f} (${chiamate})`);
  }
  ok('nessun handler chiama ctx.extRelay', colpevoli.length === 0,
    'ancora sul ponte fantasma: ' + colpevoli.join(', '));
}

// ── 2. Gli strumenti raggiungibili hanno un comando VERO nell'estensione ──
//
// Non basta non usare il fantasma: bisogna che dall'altra parte del ponte buono
// ci sia davvero qualcuno che risponde a quel nome.
{
  const estensione = fs.readFileSync(ESTENSIONE, 'utf8');
  const comandi = new Set(
    [...estensione.matchAll(/case\s+'([a-z_0-9]+)'/g)].map(m => m[1])
  );

  const SERVONO = [
    'linkedin_cerca', 'linkedin_profilo', 'linkedin_collegati',
    'linkedin_elenco_chat', 'linkedin_leggi_conversazione', 'linkedin_rispondi',
    'whatsapp_non_letti', 'whatsapp_leggi_conversazione', 'whatsapp_rispondi',
  ];
  for (const c of SERVONO) {
    ok(`l'estensione risponde a "${c}"`, comandi.has(c));
  }
}

// ── 3. I nomi chiamati dagli handler esistono nell'estensione ──
//
// Il verso opposto, ed è quello che non dà nessun errore: un nome scritto male
// in bridgeCommand non è un guasto, è un comando che nessuno raccoglie —
// esattamente il difetto di partenza, con un'altra faccia.
{
  const estensione = fs.readFileSync(ESTENSIONE, 'utf8');
  const comandi = new Set(
    [...estensione.matchAll(/case\s+'([a-z_0-9]+)'/g)].map(m => m[1])
  );
  // I comandi generici del ponte (navigate, click, fill_form…) stanno altrove.
  const GENERICI = new Set(['navigate', 'click', 'fill_form', 'screenshot', 'scrape',
    'read_page', 'scroll', 'type', 'wait', 'get_page_elements', 'inspect', 'eval']);

  const inventati = [];
  for (const f of fs.readdirSync(CARTELLA).filter(x => x.endsWith('.js'))) {
    const testo = fs.readFileSync(path.join(CARTELLA, f), 'utf8');
    for (const m of testo.matchAll(/bridgeCommand\s*\(\s*'([a-z_0-9]+)'/g)) {
      const nome = m[1];
      if (!comandi.has(nome) && !GENERICI.has(nome)) inventati.push(`${f}: ${nome}`);
    }
  }
  ok('ogni comando chiamato esiste dall\'altra parte', inventati.length === 0,
    'nomi che nessuno raccoglie: ' + inventati.join(', '));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  UN PONTE SOLO: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
