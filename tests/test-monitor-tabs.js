#!/usr/bin/env node
// tests/test-monitor-tabs.js — La navigazione non deve aprire schede nuove e le
// pagine lette devono restare consultabili dal monitor.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const ext = fs.readFileSync('cobra-extension/background.js', 'utf8');
const front = fs.readFileSync('public/index.html', 'utf8');
const manifest = JSON.parse(fs.readFileSync('cobra-extension/manifest.json', 'utf8'));

console.log('\n=== SCHEDE E ARCHIVIO DELLE PAGINE ===');

// ─────────────────────────────────────────
section('La scheda di lavoro sopravvive alla sospensione');
// ─────────────────────────────────────────
ok('l identificativo viene persistito', /chrome\.storage\.(session|local)\.set\(\{\s*cobraWorkTabId/.test(ext),
   'senza persistenza il service worker dimentica la scheda e ne apre una nuova');
ok('viene riletto al risveglio', /recuperaWorkTab/.test(ext) && /storage\.session\.get\('cobraWorkTabId'\)/.test(ext));
ok('getWorkTab usa il valore persistito', /async function getWorkTab[\s\S]{0,900}recuperaWorkTab\(\)/.test(ext));
ok('getActiveTab usa il valore persistito', /async function getActiveTab[\s\S]{0,400}recuperaWorkTab\(\)/.test(ext));
ok('alla chiusura della scheda il valore viene cancellato',
   /onRemoved[\s\S]{0,400}storage\.session\.remove\('cobraWorkTabId'\)/.test(ext));
ok('il permesso storage e dichiarato',
   (manifest.permissions || []).includes('storage') || /chrome\.storage/.test(ext) === false,
   `permessi: ${(manifest.permissions || []).join(', ')}`);

// ─────────────────────────────────────────
section('Nessuna scheda portata in primo piano');
// ─────────────────────────────────────────
{
  const navBlocco = ext.slice(ext.indexOf("case 'navigate':"), ext.indexOf("case 'navigate':") + 4000);
  ok('navigate aggiorna la scheda in secondo piano',
     /tabs\.update\([^)]*active:\s*false/.test(navBlocco),
     'con active:true la scheda ruba il fuoco ad ogni pagina');
  ok('navigate non forza active:true',
     !/tabs\.update\(tab\.id,\s*\{\s*url:\s*args\.url,\s*active:\s*true/.test(navBlocco));
}
{
  // Le creazioni di scheda ammesse: la scheda di lavoro (una sola) e il tool esplicito
  const creazioni = [...ext.matchAll(/chrome\.tabs\.create\(/g)];
  ok('al massimo due punti creano schede', creazioni.length <= 2, `trovati ${creazioni.length}`);
  ok('la scheda di lavoro nasce in secondo piano',
     /tabs\.create\(\{\s*url:\s*'about:blank',\s*active:\s*false\s*\}\)/.test(ext));
}

// ─────────────────────────────────────────
section('L anteprima delle pagine continua a funzionare');
// ─────────────────────────────────────────
{
  const shot = ext.slice(ext.indexOf("case 'screenshot':"), ext.indexOf("case 'screenshot':") + 1600);
  ok('lo screenshot recupera la scheda persistita', /recuperaWorkTab\(\)/.test(shot),
     'con la variabile azzerata fotograferebbe la scheda sbagliata');
  ok('rende attiva la scheda nella SUA finestra', /tabs\.update\(idScheda, \{ active: true \}\)/.test(shot),
     'Chrome fotografa solo la scheda attiva di una finestra');
  ok('passa il windowId alla cattura', /captureVisibleTab\(windowId/.test(shot));
  ok('non ruba il fuoco alla finestra dell utente',
     !/windows\.update\([^)]*focused:\s*true/.test(shot));
  ok('segnala i fallimenti invece di restituire un vuoto',
     /return \{ ok: false, error:/.test(shot));
}
{
  // La scheda di lavoro deve stare in una finestra propria, altrimenti
  // renderla attiva per la foto cambierebbe la vista dell'utente
  ok('la scheda di lavoro nasce in una finestra dedicata',
     /windows\.create\(\{[\s\S]{0,120}focused: false/.test(ext),
     'senza finestra propria, fotografare significa cambiare scheda all utente');
}
{
  const bc = fs.readFileSync('modules/tools/handlers/browser-control.js', 'utf8');
  const s = bc.slice(bc.indexOf('async function screenshot'), bc.indexOf('async function screenshot') + 1600);
  ok('il server registra il motivo se l anteprima non arriva',
     /\[Screenshot\]/.test(s), 'il fallimento spariva senza lasciare traccia');
}

// ─────────────────────────────────────────
section('La webapp non apre schede da sola');
// ─────────────────────────────────────────
ok('open_url non chiama piu window.open',
   !/case 'open_url':[\s\S]{0,300}window\.open/.test(front),
   'la webapp apriva una scheda senza chiedere');
ok('open_url propone un collegamento cliccabile',
   /case 'open_url':[\s\S]{0,600}addBubble/.test(front));
// window.open è ammesso solo dove lo chiede l'utente: scarico di un export e
// apertura di un file prodotto. Mai per la navigazione automatica.
ok('window.open resta confinato a export e apertura file',
   (front.match(/window\.open\(/g) || []).length <= 2,
   `occorrenze: ${(front.match(/window\.open\(/g) || []).length}`);
ok('i file prodotti hanno un pulsante di scarico in chat',
   /function mostraFileScaricabile/.test(front) && /api\/files\//.test(front),
   'un file su disco che non si può scaricare non serve a nulla');

// ─────────────────────────────────────────
section('Archivio delle pagine nel monitor');
// ─────────────────────────────────────────
ok('esiste l elenco delle pagine lette', /const paginheLette = \[\]/.test(front));
ok('c e un limite alla memoria', /MAX_PAGINE/.test(front));
ok('rileggere la stessa pagina non la duplica',
   /findIndex\(p => p\.url === url\)/.test(front));
ok('esiste la barra di navigazione', /id="monPages"/.test(front));
ok('le pagine sono cliccabili', /chip\.onclick = \(\) => mostraPagina\(i\)/.test(front));
ok('ogni pagina ha il collegamento per aprirla nel browser',
   /apri nel browser/.test(front));
ok('lo stile della barra e definito', /\.mon-page-chip/.test(front));
ok('la barra compare solo con piu di una pagina',
   /paginheLette\.length <= 1[\s\S]{0,120}remove\('visible'\)/.test(front));

// ─────────────────────────────────────────
section('Coerenza del codice');
// ─────────────────────────────────────────
{
  // Il valore in memoria e quello salvato non devono divergere. Sono ammessi
  // solo: azzeramento, ripristino dal valore persistito, e l'assegnazione
  // interna alla funzione che salva.
  const ammesse = /^(null|salvato|tabId)\b/;
  const assegnazioni = [...ext.matchAll(/_workTabId = ([^;]+);/g)]
    .map(m => m[1].trim())
    .filter(v => !ammesse.test(v));
  ok('nessuna assegnazione che salti la persistenza',
     assegnazioni.length === 0, assegnazioni.join(' | '));

  // La funzione che salva deve fare entrambe le cose
  const fn = ext.slice(ext.indexOf('async function ricordaWorkTab'));
  const corpo = fn.slice(0, fn.indexOf('\n}') + 2);
  ok('ricordaWorkTab aggiorna la memoria', /_workTabId = tabId/.test(corpo));
  ok('ricordaWorkTab salva su storage', /storage\.session\.set/.test(corpo));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
