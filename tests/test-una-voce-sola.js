// tests/test-una-voce-sola.js — La voce appartiene all'agente, e a nessun altro.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Luca, 9 agosto: "il collega usa una voce che non e' del presidente".
//
// La prima causa l'avevo trovata lato server — ctx._agenteScelto vuoto e la
// voce che cadeva su una costante. Ma ce n'era una SECONDA, nell'interfaccia,
// e da sola sarebbe bastata a rimettere tutto come prima:
//
// C'era un menu con 250 voci ElevenLabs. La scelta finiva in localStorage
// (`cobra_voce`) e il client la rimandava al server a OGNI sintesi. Il server
// la accetta e la fa vincere sulla voce dell'agente.
//
// Quindi bastava aver toccato quel menu una volta, mesi fa, per sentire per
// sempre una voce che non e' quella di COBRA — e nessuna correzione lato
// server avrebbe potuto rimediare, perche' il client sovrascriveva dopo.
//
// Due controlli per la stessa cosa, e vinceva quello che non sapeva chi
// stesse parlando. E' il difetto dei sei registri, spostato nell'interfaccia.
// ══════════════════════════════════════════════════════════════════════

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const A = require('../modules/config/agenti');

let passati = 0;
const rotti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { rotti.push(`${nome}: ${e.message}`); }
}

prova('il menu delle 250 voci non c\'e\' piu\'', () => {
  assert.ok(!/id="sceltaVoce"/.test(html), 'il select delle voci ElevenLabs e\' tornato');
  assert.ok(!/api\/tts\/voices/.test(html),
    'l\'interfaccia carica di nuovo tutte le voci: una di quelle scavalcherebbe l\'agente');
});

prova('la scelta vecchia viene ripulita, non solo ignorata', () => {
  // Lasciarla in localStorage significa che continua ad essere rimandata al
  // server a ogni riavvio del browser.
  assert.ok(/removeItem\('cobra_voce'\)/.test(html),
    'la vecchia scelta resta salvata e continua a scavalcare l\'agente');
});

prova('resta un solo posto dove si sceglie chi parla', () => {
  assert.ok(/agenteElenco/.test(html), 'il menu degli agenti non c\'e\'');
  assert.ok(/api\/agenti\/scegli/.test(html), 'la scelta dell\'agente non viene mandata al server');
});

prova('ogni lingua ha il suo fondo, e non e\' bianco', () => {
  for (const l of ['it', 'en', 'es']) {
    assert.ok(new RegExp(`\\.agente-voce\\[data-lingua="${l}"\\]`).test(html),
      `la lingua ${l} non ha un fondo suo`);
  }
  assert.ok(/data-lingua="\$\{a\.lingua\}"/.test(html),
    'le righe non dichiarano la lingua: il colore non si applica a niente');
});

prova('ogni agente ha una bandiera da mostrare', () => {
  for (const a of A.AGENTI) {
    assert.ok(a.bandiera && a.bandiera.length > 1, `${a.nome} non ha bandiera`);
  }
  assert.ok(/class="bandiera"/.test(html), 'la bandiera non viene disegnata');
});

prova('quello in uso si distingue da lontano', () => {
  assert.ok(/\.agente-voce\.attuale/.test(html));
  assert.ok(/in uso/.test(html), 'niente dice quale sta parlando adesso');
});

if (rotti.length) {
  console.log(`\n✗ una voce sola: ${passati} passate, ${rotti.length} fallite`);
  for (const r of rotti) console.log('   ' + r);
  process.exitCode = 1;
} else {
  console.log(`✓ una voce sola: ${passati} prove passate`);
}
