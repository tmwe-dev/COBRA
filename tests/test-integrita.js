// tests/test-integrita.js — Le invarianti dell'architettura, non delle funzioni.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' QUESTO TEST E' DIVERSO DAGLI ALTRI
//
// Gli altri sessantasette provano che un pezzo fa la cosa giusta. Questo prova
// che i pezzi sono ATTACCATI. E' la differenza che ci e' costata la settimana:
//
//   unit test ✓   unit test ✓   unit test ✓   sistema reale ✗
//
// `guarda_pagina` aveva il suo test, ed era verde. Aveva lo schema, l'handler,
// il rischio, tre ambiti. Ha fallito tre volte su tre alla prima uscita vera,
// perche' nessuno verificava la GIUNZIONE.
//
// Le prove qui sotto non chiamano nessuna funzione di COBRA: contano i registri
// e li confrontano fra loro. Se una fallisce, non c'e' un bug in una funzione —
// c'e' una capacita' che non esiste davvero.
// ══════════════════════════════════════════════════════════════════════

const assert = require('assert');
const R = require('../modules/integrita/registri');
const { verificaCapacita, verificaPonte, NUCLEO } = require('../modules/integrita/verifica');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}

const reg = R.tuttiIRegistri();

// ── Le invarianti ────────────────────────────────────────────────────────

prova('i registri si leggono tutti', () => {
  assert.ok(reg.schemi.length > 50, `solo ${reg.schemi.length} schemi: il lettore e' rotto`);
  assert.ok(reg.handler.size > 50, `solo ${reg.handler.size} handler`);
  assert.ok(reg.comandiEstensione.size > 50, `solo ${reg.comandiEstensione.size} comandi estensione`);
  assert.ok(Object.keys(reg.ambiti).length > 30, 'gli ambiti non si leggono');
});

prova('nessuna capacità è dichiarata due volte', () => {
  assert.deepStrictEqual(reg.schemiDoppi, [],
    `dichiarate due volte: ${reg.schemiDoppi.join(', ')} — il modello legge una descrizione e ne chiama un'altra`);
});

prova('ogni capacità dichiarata ha un handler', () => {
  const senza = reg.schemi.filter((n) => !reg.handler.has(n));
  assert.deepStrictEqual(senza, [], `dichiarate al modello ma senza esecutore: ${senza.join(', ')}`);
});

prova('ogni capacità dichiarata ha una voce di rischio', () => {
  const senza = reg.schemi.filter((n) => !reg.rischi.has(n));
  assert.deepStrictEqual(senza, [],
    `senza voce di rischio: ${senza.join(', ')} — passerebbero le guardie senza essere classificate`);
});

prova('ogni handler senza schema è dichiarato chiuso apposta', () => {
  const orfani = [...reg.handler].filter((n) => !reg.schemi.includes(n) && !reg.SENZA_SCHEMA_APPOSTA[n]);
  assert.deepStrictEqual(orfani, [],
    `handler orfani: ${orfani.join(', ')} — o si dichiarano fra i chiusi apposta, o si tolgono`);
});

prova('le porte chiuse apposta restano chiuse', () => {
  // whatsapp_send e linkedin_send_message sono le strade senza regole d'invio
  // da cui il 7 agosto uscirono sette messaggi fuori conteggio. Se un giorno
  // ricompaiono negli schemi, quel giorno si riapre quella porta.
  for (const n of ['whatsapp_send', 'linkedin_send_message']) {
    assert.ok(!reg.schemi.includes(n),
      `${n} è tornato fra gli schemi: è la strada d'invio senza regole, non deve essere in mano al modello`);
  }
});

prova('ogni comando chiesto al ponte esiste nell\'estensione', () => {
  const fantasmi = [...reg.comandiChiesti].filter((c) => !reg.comandiEstensione.has(c));
  assert.deepStrictEqual(fantasmi, [],
    `handler che chiedono comandi inesistenti: ${fantasmi.join(', ')} — falliranno sempre`);
});

prova('ogni file dell\'estensione con dei comandi viene caricato dal worker', () => {
  // Il sospetto su guarda_pagina era proprio questo: file sul disco, mai
  // caricato. Se un file di comandi non compare in nessun importScripts, i
  // suoi comandi non esistono per il service worker.
  const fs = require('fs');
  const path = require('path');
  const d = path.join(R.RADICE, 'cobra-extension/esterni/comandi');
  const conComandi = fs.readdirSync(d).filter((f) => f.endsWith('.js')
    && /comandi\['/.test(fs.readFileSync(path.join(d, f), 'utf8')));
  const nonCaricati = conComandi.filter((f) => !reg.fileCaricati.has(`esterni/comandi/${f}`));
  assert.deepStrictEqual(nonCaricati, [],
    `file di comandi mai caricati dal worker: ${nonCaricati.join(', ')}`);
});

prova('il nucleo è completo', () => {
  for (const n of NUCLEO) {
    assert.ok(reg.schemi.includes(n), `${n} non è dichiarato`);
    assert.ok(reg.handler.has(n), `${n} non ha handler`);
    assert.ok(reg.ambiti[n], `${n} non è in nessun ambito`);
  }
});

// ── Il cancello ──────────────────────────────────────────────────────────

prova('il cancello non ha bloccanti sul codice attuale', () => {
  const e = verificaCapacita(reg);
  assert.strictEqual(e.bloccanti.length, 0,
    'bloccanti: ' + e.bloccanti.map((b) => `${b.capacita} (${b.guasto})`).join(', '));
});

prova('il cancello disabilita una capacità rotta ma raggiungibile', () => {
  const finto = { ...reg, schemi: [...reg.schemi, 'strumento_finto'],
    ambiti: { ...reg.ambiti, strumento_finto: ['search'] } };
  const e = verificaCapacita(finto);
  const d = e.daDisabilitare.find((x) => x.capacita === 'strumento_finto');
  assert.ok(d, 'una capacità senza handler e raggiungibile deve essere disabilitata');
  assert.ok(d.manca.includes('handler'), 'deve dire cosa manca');
  assert.strictEqual(e.bloccanti.length, 0, 'ma non deve impedire l\'avvio');
});

prova('il cancello ferma l\'avvio solo se manca il nucleo', () => {
  const senzaNavigate = { ...reg, handler: new Set([...reg.handler].filter((h) => h !== 'navigate')) };
  const e = verificaCapacita(senzaNavigate);
  assert.ok(e.bloccanti.some((b) => b.capacita === 'navigate'), 'navigate rotto deve bloccare');
  assert.strictEqual(e.ok, false);
});

prova('una capacità rotta e già fuori uso è solo un avviso', () => {
  const finto = { ...reg, schemi: [...reg.schemi, 'roba_vecchia'] };  // in nessun ambito
  const e = verificaCapacita(finto);
  assert.ok(e.avvisi.some((a) => a.capacita === 'roba_vecchia'));
  assert.ok(!e.daDisabilitare.some((d) => d.capacita === 'roba_vecchia'),
    'nessuno può chiamarla: disabilitarla non aggiunge niente');
});

// ── Il confronto con l'estensione viva ───────────────────────────────────

prova('il ponte segnala i comandi che l\'estensione viva non sa fare', () => {
  const p = verificaPonte(['navigate', 'click'], reg);
  assert.strictEqual(p.ok, false);
  assert.ok(p.mancanti.length > 0);
  assert.ok(/chrome:\/\/extensions/.test(p.dice), 'deve dire cosa fare, non solo cosa manca');
});

prova('un\'estensione completa passa', () => {
  const p = verificaPonte([...reg.comandiChiesti], reg);
  assert.strictEqual(p.ok, true, `mancanti: ${p.mancanti.join(', ')}`);
});

prova('un\'estensione muta non viene accusata', () => {
  // Nessuna capabilities dichiarata = protocollo vecchio, non estensione rotta.
  const p = verificaPonte([], reg);
  assert.strictEqual(p.ok, true);
});

// ── Il cancello è davvero agganciato ─────────────────────────────────────

prova('il cancello gira all\'avvio e toglie le capacità disabilitate', () => {
  const fs = require('fs');
  const path = require('path');
  const t = fs.readFileSync(path.join(__dirname, '../modules/server-slim.js'), 'utf8');
  assert.ok(/verificaCapacita\(\)/.test(t), 'server-slim non chiama la verifica');
  assert.ok(/daDisabilitare/.test(t) && /COBRA_TOOLS\.splice/.test(t),
    'la verifica gira ma le capacità rotte vengono consegnate lo stesso');
});

prova('il confronto col ponte gira all\'aggancio dell\'estensione', () => {
  const fs = require('fs');
  const path = require('path');
  const t = fs.readFileSync(path.join(__dirname, '../modules/ws/server.js'), 'utf8');
  assert.ok(/verificaPonte/.test(t), 'ws/server.js non confronta le capacità dichiarate dall\'estensione');
});

prova('c\'è un solo lettore dei registri', () => {
  // Se l'attrezzo si rileggesse i sorgenti per conto suo, un giorno direbbe
  // "tutto a posto" mentre l'avvio dice il contrario. E' successo con
  // bridgeCommand: due copie, e correggevo quella sbagliata.
  const fs = require('fs');
  const path = require('path');
  const t = fs.readFileSync(path.join(__dirname, '../attrezzi/matrice-capacita.js'), 'utf8');
  assert.ok(/require\('\.\.\/modules\/integrita\/registri'\)/.test(t),
    'la matrice non usa il lettore comune');
  assert.ok(!/const t = leggi\('modules\/tools\/schemas\.js'\)/.test(t),
    'la matrice si è rifatta un lettore suo');
});

// ── Esito ────────────────────────────────────────────────────────────────

if (rotti.length) {
  console.log(`\n✗ integrità: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ integrità: ${passati} invarianti verificate`);
}
