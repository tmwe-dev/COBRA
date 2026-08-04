#!/usr/bin/env node
// tests/check-ctx-methods.js — Verifica che ogni ctx.OGGETTO.METODO() usato nel
// codice esista realmente. Previene la classe di bug "manca il destructuring
// nell'import" (es. CobraSupervisor, HumanDriver) che si manifesta solo a runtime.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// Proprietà che sono legittimamente non-funzioni o create lazy a runtime
const ALLOWED_NON_FUNCTION = new Set([
  'session.humanTakeoverResolve', // callback nullable, valorizzata solo durante takeover
]);

const NL = String.fromCharCode(10);

// Raccogli i riferimenti PRIMA di caricare il server (evita interferenze)
const propsRaw = execSync("grep -rhoE 'ctx\\.[a-zA-Z_][a-zA-Z0-9_]*' modules/ | sort -u", { cwd: ROOT }).toString();
const props = [...new Set(propsRaw.trim().split(NL).map(s => s.replace('ctx.', '')))]
  .filter(p => p && !p.startsWith('_')); // le _private sono create lazy dagli handler

const methRaw = execSync("grep -rhoE 'ctx\\.[a-zA-Z_][a-zA-Z0-9_]*\\.[a-zA-Z_][a-zA-Z0-9_]*\\(' modules/ | sort -u", { cwd: ROOT }).toString();
const methods = [...new Set(methRaw.trim().split(NL).map(s => s.replace('ctx.', '').replace(/\($/, '')))]
  .filter(Boolean);

const { ctx } = require('../modules/server-slim');

const missingProps = [];
const badMethods = [];

for (const p of props) {
  if (ctx[p] === undefined) missingProps.push(p);
}

// Dipendenze opzionali: null è accettabile, gli handler degradano graziosamente
const OPTIONAL_DEPS = new Set(['puppeteer', 'nodemailer']);
const optionalMissing = [];

for (const m of methods) {
  if (ALLOWED_NON_FUNCTION.has(m)) continue;
  const dot = m.indexOf('.');
  const obj = m.slice(0, dot), meth = m.slice(dot + 1);
  const target = ctx[obj];
  if (target === undefined) continue; // già segnalato sopra
  if (target === null) {
    if (OPTIONAL_DEPS.has(obj)) { optionalMissing.push(obj); continue; }
    badMethods.push(`ctx.${obj} è null (serve .${meth})`);
    continue;
  }
  const t = typeof target;
  if (t !== 'object' && t !== 'function') continue;
  if (typeof target[meth] !== 'function') {
    badMethods.push(`ctx.${obj}.${meth} — atteso function, trovato ${typeof target[meth]}`);
  }
}

console.log('');
console.log('=== VERIFICA INTEGRITA DI CONTEXT ===');
console.log(`Proprieta controllate: ${props.length}`);
console.log(`Metodi controllati:    ${methods.length}`);
console.log('');

if (missingProps.length) {
  console.log(`\x1b[31mPROPRIETA MANCANTI (${missingProps.length}):\x1b[0m`);
  missingProps.forEach(p => console.log(`  x ctx.${p}`));
} else {
  console.log('\x1b[32mv Tutte le proprieta ctx sono presenti\x1b[0m');
}

if (badMethods.length) {
  console.log(`\x1b[31mMETODI NON CHIAMABILI (${badMethods.length}):\x1b[0m`);
  badMethods.forEach(m => console.log(`  x ${m}`));
} else {
  console.log('\x1b[32mv Tutti i metodi ctx.X.Y() sono chiamabili\x1b[0m');
}

const uniqOptional = [...new Set(optionalMissing)];
if (uniqOptional.length) {
  console.log(`\x1b[33m! Dipendenze opzionali non installate: ${uniqOptional.join(', ')} (gli handler degradano)\x1b[0m`);
}

const fail = missingProps.length + badMethods.length;
console.log('');
console.log(fail === 0 ? '\x1b[32mRISULTATO: OK\x1b[0m' : `\x1b[31mRISULTATO: ${fail} PROBLEMI\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);
