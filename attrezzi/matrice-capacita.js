#!/usr/bin/env node
// attrezzi/matrice-capacita.js — La matrice unica delle capacita'.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Una capacita', oggi, per esistere davvero deve comparire in sei posti:
// lo schema che il modello vede, l'ambito che decide quando gliela diamo, la
// voce di rischio, l'handler che la esegue, il comando dell'estensione che
// tocca la pagina, e l'importScripts che carica quel file nel service worker.
//
// Nessuno dei sei controlla gli altri cinque. Se ne salti uno, COBRA parte lo
// stesso, i test passano lo stesso, e lo strumento semplicemente non c'e'.
// E' successo otto volte in una settimana, ogni volta scoperta in produzione
// giorni dopo.
//
// Questo attrezzo non ripara niente: MISURA. Legge i sei registri, li
// confronta fra loro e con quello che e' successo davvero in produzione, e
// dice per ogni capacita' se e' completa, dove si rompe, e se serve a qualcuno.
//
// E' la baseline da cui parte il riordino, e va rieseguito dopo ogni batch:
// se un numero peggiora, il batch ha rotto qualcosa.
//
//     node attrezzi/matrice-capacita.js            # a schermo
//     node attrezzi/matrice-capacita.js --md       # scrive MATRICE_CAPACITA.md
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const RADICE = path.resolve(__dirname, '..');
/* eslint-disable no-unused-vars */
const leggi = (p) => { try { return fs.readFileSync(path.join(RADICE, p), 'utf8'); } catch (_) { return ''; } };

// ── I registri: si leggono da modules/integrita/registri.js ──
//
// NON qui. Sarebbe grottesco curare "la stessa cosa scritta in sei posti"
// scrivendo due lettori di quei sei posti, uno per l'attrezzo e uno per il
// cancello d'avvio: divergerebbero, e un giorno l'attrezzo direbbe "tutto a
// posto" mentre l'avvio dice il contrario.
//
// E' esattamente cio' che e' successo con bridgeCommand: due copie, e per
// giorni ho corretto quella che non veniva usata.

const R = require('../modules/integrita/registri');
const { verificaCapacita } = require('../modules/integrita/verifica');

// ── Cosa e' successo davvero ───────────────────────────────────────────

function usoInProduzione() {
  const uso = {};
  let righe = 0;
  for (const nome of ['data/response_log.jsonl']) {
    const t = leggi(nome); if (!t) continue;
    for (const r of t.trim().split('\n')) {
      let d; try { d = JSON.parse(r); } catch (_) { continue; }
      righe++;
      for (const s of (d.toolsUsed || [])) {
        const u = (uso[s.name] = uso[s.name] || { chiamate: 0, falliti: 0 });
        u.chiamate++; if (s.ok === false) u.falliti++;
      }
    }
  }
  return { uso, turni: righe };
}

// ── Il giudizio ────────────────────────────────────────────────────────

function classifica(s) {
  if (s.rotture.length) return s.uso.chiamate ? 'FIX' : 'ROTTO-MAI-USATO';
  if (s.gemelloPerdente) return 'LEGACY';
  if (!s.uso.chiamate) return 'DA-PROVARE';
  if (s.uso.falliti / s.uso.chiamate > 0.5) return 'FIX';
  return 'TIENI';
}

function costruisci() {
  const reg = R.tuttiIRegistri();
  const schemi = reg.schemi;
  const ambiti = reg.ambiti;
  const rischio = reg.rischi;
  const handler = reg.handler;
  const ext = reg.comandiEstensione;
  const chiesti = reg.comandiChiesti;
  const perdenti = reg.gemelliPerdenti;
  const SENZA_SCHEMA_APPOSTA = reg.SENZA_SCHEMA_APPOSTA;
  const { uso, turni } = usoInProduzione();

  const righe = schemi.sort().map((nome) => {
    const rotture = [];
    if (!ambiti[nome] && !perdenti.has(nome)) rotture.push('FUORI-AMBITO');
    if (!rischio.has(nome)) rotture.push('NO-RISCHIO');
    if (!handler.has(nome)) rotture.push('NO-HANDLER');
    return {
      nome,
      ambiti: ambiti[nome] || [],
      rischio: rischio.has(nome),
      handler: handler.has(nome),
      gemelloPerdente: perdenti.has(nome),
      uso: uso[nome] || { chiamate: 0, falliti: 0 },
      rotture,
    };
  });
  for (const r of righe) r.classe = classifica(r);

  // Gli orfani: esistono da una parte sola.
  const handlerSenzaSchema = [...handler].filter((h) => !schemi.includes(h) && !SENZA_SCHEMA_APPOSTA[h]);
  const chiusiApposta = [...handler].filter((h) => !schemi.includes(h) && SENZA_SCHEMA_APPOSTA[h]);
  const extSenzaChiamante = [...ext].filter((c) => !chiesti.has(c));
  const chiestiSenzaExt = [...chiesti].filter((c) => !ext.has(c));

  return { righe, turni, schemi, handler, ext, handlerSenzaSchema, chiusiApposta, extSenzaChiamante, chiestiSenzaExt };
}

// ── Stampa ─────────────────────────────────────────────────────────────

function riepilogo(m) {
  const per = {};
  for (const r of m.righe) per[r.classe] = (per[r.classe] || 0) + 1;
  const L = [];
  L.push('| misura | valore |');
  L.push('|---|---|');
  L.push(`| schemi dichiarati | ${m.schemi.length} |`);
  L.push(`| handler registrati | ${m.handler.size} |`);
  L.push(`| comandi estensione | ${m.ext.size} |`);
  L.push(`| turni analizzati | ${m.turni} |`);
  L.push(`| **capacita' con un anello rotto** | **${m.righe.filter((r) => r.rotture.length).length}** |`);
  L.push(`| **handler senza schema, non voluti** | **${m.handlerSenzaSchema.length}** |`);
  L.push(`| handler chiusi apposta (documentati) | ${m.chiusiApposta.length} |`);
  L.push(`| **comandi estensione che nessuno chiama** | **${m.extSenzaChiamante.length}** |`);
  L.push(`| **comandi chiesti che l'estensione non espone** | **${m.chiestiSenzaExt.length}** |`);
  const g = verificaCapacita();
  L.push(`| **il cancello d'avvio disabiliterebbe** | **${g.daDisabilitare.length}** |`);
  L.push(`| **il cancello d'avvio bloccherebbe** | **${g.bloccanti.length}** |`);
  L.push('');
  L.push('| classe | quante |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(per).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  return L.join('\n');
}

function tabella(m) {
  const L = ['| capacita\' | classe | ambiti | handler | rischio | chiamate | falliti | rotture |', '|---|---|---|---|---|---|---|---|'];
  for (const r of m.righe) {
    L.push(`| \`${r.nome}\` | ${r.classe} | ${r.ambiti.join(' ') || '—'} | ${r.handler ? '✓' : '✗'} | `
      + `${r.rischio ? '✓' : '✗'} | ${r.uso.chiamate} | ${r.uso.falliti} | ${r.rotture.join(' ') || '—'} |`);
  }
  return L.join('\n');
}

const m = costruisci();

if (process.argv.includes('--md')) {
  const doc = ['# Matrice delle capacita\'', '',
    `*generata il ${new Date().toISOString().slice(0, 16).replace('T', ' ')} da \`attrezzi/matrice-capacita.js\`*`, '',
    '## Riepilogo', '', riepilogo(m), '',
    '## Handler senza schema — non voluti', '',
    m.handlerSenzaSchema.map((x) => `- \`${x}\``).join('\n') || '_nessuno_', '',
    '## Handler chiusi apposta — il modello non deve vederli', '',
    m.chiusiApposta.map((x) => `- \`${x}\` — ${R.SENZA_SCHEMA_APPOSTA[x]}`).join('\n') || '_nessuno_', '',
    '## Comandi dell\'estensione che nessun handler chiama', '',
    m.extSenzaChiamante.map((x) => `- \`${x}\``).join('\n') || '_nessuno_', '',
    '## Comandi chiesti al ponte che l\'estensione non espone', '',
    m.chiestiSenzaExt.map((x) => `- \`${x}\``).join('\n') || '_nessuno_', '',
    '## Tutte le capacita\'', '', tabella(m), ''].join('\n');
  fs.writeFileSync(path.join(RADICE, 'MATRICE_CAPACITA.md'), doc);
  console.log('scritto MATRICE_CAPACITA.md');
} else {
  console.log(riepilogo(m));
  console.log('\nhandler senza schema NON voluti:', m.handlerSenzaSchema.join(' ') || '—');
  console.log('chiusi apposta:', m.chiusiApposta.length);
  console.log('comandi ext mai chiamati:', m.extSenzaChiamante.length);
  console.log('comandi chiesti e non esposti:', m.chiestiSenzaExt.join(' ') || '—');
}

module.exports = { costruisci };
