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
const leggi = (p) => { try { return fs.readFileSync(path.join(RADICE, p), 'utf8'); } catch (_) { return ''; } };

// ── I sei registri, letti uno per uno ──────────────────────────────────

/** 1. Gli schemi: quello che il modello vede. */
function schemiDichiarati() {
  const t = leggi('modules/tools/schemas.js');
  return [...new Set([...t.matchAll(/name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))];
}

/** 2. Gli ambiti: quando la capacita' viene consegnata. */
function ambitiPerStrumento() {
  const t = leggi('modules/supermario.js');
  const blocco = t.slice(t.indexOf('const TOOL_SCOPES'), t.indexOf('full: null'));
  const mappa = {};
  // Ogni ambito e' "nome: [ ... ]": si prende il nome e poi i suoi strumenti.
  for (const m of blocco.matchAll(/^\s{2}([a-z]+):\s*\[([\s\S]*?)\],\s*$/gm)) {
    const ambito = m[1];
    for (const s of m[2].matchAll(/'([a-z0-9_]+)'/g)) {
      (mappa[s[1]] = mappa[s[1]] || []).push(ambito);
    }
  }
  return mappa;
}

/** 3. Il rischio: se serve conferma prima di eseguire. */
function conVoceDiRischio() {
  const t = leggi('modules/risk/taxonomy.js');
  return new Set([...t.matchAll(/^\s{2}([a-z0-9_]+):\s*\{\s*level/gm)].map((m) => m[1]));
}

/** 4. Gli handler: chi esegue davvero. Si carica il modulo, non si indovina. */
function handlerRegistrati() {
  try { return new Set(Object.keys(require(path.join(RADICE, 'modules/tools/handlers')))); }
  catch (e) { console.error('[matrice] handlers non caricabili:', e.message); return new Set(); }
}

/**
 * 5. I comandi dell'estensione: chi tocca la pagina.
 *
 * Si guarda in DUE posti, e non e' pignoleria. La prima versione leggeva solo
 * `esterni/comandi/`, e ha subito accusato `verify_action` di non esistere:
 * esiste, sta ancora nello switch di background.js insieme a wait_for e retry,
 * gli ultimi tre rimasti dopo lo spostamento dell'8 agosto.
 *
 * Un attrezzo che misura e' inutile se sbaglia la misura: meglio nessun
 * allarme che un allarme falso, perche' al terzo falso non li guardi piu'.
 */
function comandiEstensione() {
  const fuori = new Set();
  const d = path.join(RADICE, 'cobra-extension/esterni/comandi');
  try {
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
      for (const m of fs.readFileSync(path.join(d, f), 'utf8').matchAll(/comandi\['([a-z0-9_]+)'\]/g)) fuori.add(m[1]);
    }
  } catch (_) { /* estensione assente: si segnala a valle */ }
  // I superstiti dello switch di background.js.
  const bg = leggi('cobra-extension/background.js');
  for (const m of bg.matchAll(/case\s+'([a-z0-9_]+)'\s*:/g)) fuori.add(m[1]);
  return fuori;
}

/** 6. I comandi che gli handler chiedono davvero al ponte. */
function comandiChiestiDagliHandler() {
  const d = path.join(RADICE, 'modules/tools/handlers');
  const fuori = new Set();
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(d, f), 'utf8');
    for (const m of t.matchAll(/(?:bridgeCommand|_ponte)\(\s*(?:ctx,\s*)?'([a-z0-9_]+)'/g)) fuori.add(m[1]);
  }
  return fuori;
}

/** I gemelli dichiarati perdenti: fuori dagli ambiti normali per scelta. */
function gemelliPerdenti() {
  const t = leggi('modules/supermario.js');
  const blocco = t.slice(t.indexOf('const GEMELLI'), t.indexOf('const _PERDENTI'));
  return new Set([...blocco.matchAll(/perdono:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])));
}

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
  const schemi = schemiDichiarati();
  const ambiti = ambitiPerStrumento();
  const rischio = conVoceDiRischio();
  const handler = handlerRegistrati();
  const ext = comandiEstensione();
  const chiesti = comandiChiestiDagliHandler();
  const perdenti = gemelliPerdenti();
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
  const handlerSenzaSchema = [...handler].filter((h) => !schemi.includes(h));
  const extSenzaChiamante = [...ext].filter((c) => !chiesti.has(c));
  const chiestiSenzaExt = [...chiesti].filter((c) => !ext.has(c));

  return { righe, turni, schemi, handler, ext, handlerSenzaSchema, extSenzaChiamante, chiestiSenzaExt };
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
  L.push(`| **handler senza schema (irraggiungibili)** | **${m.handlerSenzaSchema.length}** |`);
  L.push(`| **comandi estensione che nessuno chiama** | **${m.extSenzaChiamante.length}** |`);
  L.push(`| **comandi chiesti che l'estensione non espone** | **${m.chiestiSenzaExt.length}** |`);
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
    '## Handler senza schema — esistono ma il modello non li vede', '',
    m.handlerSenzaSchema.map((x) => `- \`${x}\``).join('\n') || '_nessuno_', '',
    '## Comandi dell\'estensione che nessun handler chiama', '',
    m.extSenzaChiamante.map((x) => `- \`${x}\``).join('\n') || '_nessuno_', '',
    '## Comandi chiesti al ponte che l\'estensione non espone', '',
    m.chiestiSenzaExt.map((x) => `- \`${x}\``).join('\n') || '_nessuno_', '',
    '## Tutte le capacita\'', '', tabella(m), ''].join('\n');
  fs.writeFileSync(path.join(RADICE, 'MATRICE_CAPACITA.md'), doc);
  console.log('scritto MATRICE_CAPACITA.md');
} else {
  console.log(riepilogo(m));
  console.log('\nhandler senza schema:', m.handlerSenzaSchema.join(' ') || '—');
  console.log('comandi ext mai chiamati:', m.extSenzaChiamante.length);
  console.log('comandi chiesti e non esposti:', m.chiestiSenzaExt.join(' ') || '—');
}

module.exports = { costruisci };
