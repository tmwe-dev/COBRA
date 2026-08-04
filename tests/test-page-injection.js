#!/usr/bin/env node
// tests/test-page-injection.js — Verifica che il codice iniettato nelle pagine
// possa davvero girare.
//
// chrome.scripting.executeScript serializza la funzione e la esegue nel contesto
// della pagina: le variabili di closure del service worker NON sopravvivono.
// Qui si riproduce quel comportamento in un contesto isolato.

const path = require('path');
const fs = require('fs');
const vm = require('vm');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const ext = fs.readFileSync('cobra-extension/background.js', 'utf8');

console.log('\n=== CODICE INIETTATO NELLE PAGINE ===');

// ─────────────────────────────────────────
section('Nessun riferimento a variabili del service worker');
// ─────────────────────────────────────────
// Le funzioni passate a run() girano nella pagina: possono usare solo i propri
// parametri e le API del browser, mai le costanti del service worker.
// RESOLVE_CODE e MOUSE_CODE sono ammesse perché run() le ricrea nello scope
// della pagina prima di invocare la funzione (vedi eseguiNellaPagina).
const COSTANTI_SW = ['_workTabId', '_cobraTabId', 'VERSION', '_actionLog'];

// Estrae i corpi delle funzioni passate a run(...)
const blocchi = [...ext.matchAll(/run\(\s*tab\.id,\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)];
ok('sono state trovate funzioni iniettate', blocchi.length > 0, `${blocchi.length}`);

let riferimentiIllegali = [];
for (const m of blocchi) {
  const inizio = m.index + m[0].length;
  // Ritaglia il corpo bilanciando le graffe
  let profondita = 1, i = inizio;
  while (i < ext.length && profondita > 0) {
    if (ext[i] === '{') profondita++;
    else if (ext[i] === '}') profondita--;
    i++;
  }
  const corpo = ext.slice(inizio, i);
  for (const c of COSTANTI_SW) {
    if (new RegExp(`\\b${c}\\b`).test(corpo)) {
      const riga = ext.slice(0, inizio).split('\n').length;
      riferimentiIllegali.push(`riga ~${riga}: usa ${c}`);
    }
  }
}
ok('nessuna funzione iniettata usa costanti del service worker',
   riferimentiIllegali.length === 0,
   riferimentiIllegali.slice(0, 6).join(' | ') + (riferimentiIllegali.length > 6 ? ` … e altri ${riferimentiIllegali.length - 6}` : ''));

// ─────────────────────────────────────────
section('run() ricrea gli helper nella pagina');
// ─────────────────────────────────────────
ok('esiste la funzione ponte', /function eseguiNellaPagina\(/.test(ext));
ok('definisce RESOLVE_CODE nello scope della pagina',
   /globalThis\.RESOLVE_CODE = resolveCode/.test(ext));
ok('definisce MOUSE_CODE nello scope della pagina',
   /globalThis\.MOUSE_CODE = mouseCode/.test(ext));
ok('run passa il codice degli helper come argomento',
   /args: \[func\.toString\(\), RESOLVE_CODE, MOUSE_CODE, args\]/.test(ext));
{
  const usi = (ext.match(/func: eseguiNellaPagina/g) || []).length;
  ok('tutte e tre le varianti di iniezione usano il ponte', usi === 3, `trovate ${usi}`);
}
ok('le costanti sono dichiarate prima dell avvio',
   ext.indexOf('const RESOLVE_CODE') < ext.indexOf('\nconnect();'));

// ─────────────────────────────────────────
section('Simulazione: la closure sopravvive?');
// ─────────────────────────────────────────
{
  // Riproduce il meccanismo di Chrome su una funzione di prova
  const RESOLVE_CODE = 'function resolveElement(s){ return {tagName:"DIV"}; }';
  const fnConClosure = (sel) => { eval(RESOLVE_CODE); return resolveElement(sel); };

  const contesto = vm.createContext({});
  let errore = null;
  try {
    const f = vm.runInContext('(' + fnConClosure.toString() + ')', contesto);
    f('#x');
  } catch (e) { errore = e.message; }
  ok('una closure NON sopravvive alla serializzazione (comportamento di Chrome)',
     !!errore && /RESOLVE_CODE is not defined/.test(errore), errore || 'nessun errore');

  // La stessa funzione con il codice passato per argomento funziona
  const fnConArgomento = (sel, codice) => { eval(codice); return resolveElement(sel); };
  const contesto2 = vm.createContext({});
  let risultato = null, errore2 = null;
  try {
    const f2 = vm.runInContext('(' + fnConArgomento.toString() + ')', contesto2);
    risultato = f2('#x', RESOLVE_CODE);
  } catch (e) { errore2 = e.message; }
  ok('passando il codice per argomento funziona', risultato && risultato.tagName === 'DIV',
     errore2 || JSON.stringify(risultato));
}

// ─────────────────────────────────────────
section('Il server non deve dichiarare successi non verificati');
// ─────────────────────────────────────────
{
  const bc = fs.readFileSync('modules/tools/handlers/browser-control.js', 'utf8');
  const scroll = bc.slice(bc.indexOf('async function scrollPage'), bc.indexOf('async function scrollPage') + 1200);
  ok('scroll_page controlla l esito del comando bridge',
     /const\s+\w+\s*=\s*await ctx\.bridgeCommand\('scroll'/.test(scroll),
     'il risultato veniva ignorato e si restituiva ok comunque');
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
