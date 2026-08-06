#!/usr/bin/env node
// tests/test-cursore-e-pagina-intera.js — Si deve VEDERE cosa sta facendo.
//
// Luca, 6 agosto 2026, guardando l'anteprima di tmwe.it:
//   "le pagine non si vedono mai intere e non si vede il mouse di cobra
//    muoversi e fare gli aggiornamenti. deve esserci un mouse visibile che
//    mostra il movimento durante la navigazione"
//
// Due difetti distinti, entrambi verificati a schermo:
//
//   1. La cattura chiedeva captureBeyondViewport:false, cioè solo la parte
//      a schermo. Nel monitor la pagina finiva a metà e sotto restava il
//      nero. Peggio: la cattura DIRETTA veniva provata per prima e non sa
//      fare altro che la piega, quindi la via buona non veniva mai imboccata.
//
//   2. Nessun cursore. Guardando l'anteprima non si distingueva una pagina
//      su cui COBRA stava lavorando da una pagina ferma, e non si vedeva mai
//      DOVE avesse cliccato — che è esattamente quello che serve sapere
//      quando il click finisce sul bottone sbagliato.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const ext = fs.readFileSync('cobra-extension/background.js', 'utf8');

console.log('\n=== SI DEVE VEDERE COSA STA FACENDO ===');

sezione('La pagina si fotografa intera');
{
  ok('si chiedono le misure del documento', /Page\.getLayoutMetrics/.test(ext));
  ok('e si usa la dimensione del contenuto, non della finestra',
     /cssContentSize/.test(ext) && /contentSize/.test(ext));
  ok('la cattura va oltre il bordo dello schermo', /captureBeyondViewport: !!ritaglio/.test(ext));
  ok('con un ritaglio grande quanto la pagina', /clip: ritaglio/.test(ext));
  ok('ma con un tetto, per non produrre immagini inguardabili', /ALTEZZA_MASSIMA_CATTURA = 6000/.test(ext));
  ok('e piu tempo, perche disegnare tutto costa', /9000, 'cattura ispettore'/.test(ext));
}

sezione('E si prova per prima la via che vede tutto');
{
  const posIspettore = ext.indexOf('catturaConIspettore(idScheda');
  const posDiretta = ext.indexOf('chrome.tabs.captureVisibleTab(windowId');
  ok('l ispettore viene prima della cattura diretta', posIspettore > 0 && posIspettore < posDiretta,
     `ispettore@${posIspettore} diretta@${posDiretta}`);
  ok('e si dichiara quale via ha funzionato', /via: 'ispettore \(pagina intera\)'/.test(ext));
  ok('dicendo anche quando si e visto solo un pezzo', /cattura diretta \(solo la parte visibile\)/.test(ext));
  ok('la cattura diretta resta come ripiego, non sparisce', /Ripiego: la cattura diretta/.test(ext));
}

sezione('Il cursore esiste, si muove e si vede');
{
  ok('esiste la funzione che lo disegna', /function disegnaCursore/.test(ext));
  ok('e quella che lo porta su un elemento', /async function muoviCursoreSu/.test(ext));
  ok('il movimento ha una transizione, altrimenti salta e basta', /transition: left \.45s/.test(ext));
  ok('si aspetta che il movimento finisca prima di fotografare', /il tempo della transizione/.test(ext));
  ok('il clic lascia un cerchio che si allarga', /@keyframes cresci/.test(ext));
  ok('c e un etichetta che dice cosa sta facendo', /class="etichetta"/.test(ext));
}

sezione('Il cursore e un disegno, non un ostacolo');
{
  ok('non intercetta i click', (ext.match(/pointer-events:\s*none/g) || []).length >= 3);
  ok('vive in un contenitore isolato dal CSS del sito', /attachShadow\(\{ mode: 'open' \}\)/.test(ext));
  ok('sta sopra qualunque cosa', /z-index:2147483647/.test(ext));
  ok('e se fallisce non ferma il lavoro', /il cursore è un di più: non deve mai fermare il lavoro/.test(ext));
}

sezione('Il cursore arriva prima dell azione, non dopo');
{
  // Va guardato DENTRO il case 'click', non nel file intero: realisticClick
  // compare anche nella libreria del mouse, molto piu' sopra.
  const blocco = ext.slice(ext.indexOf("case 'click': {"), ext.indexOf("case 'scroll': {"));
  const posCursore = blocco.indexOf("muoviCursoreSu(tab.id, args.selector, 'clic')");
  const posClick = blocco.indexOf('realisticClick(el)');
  ok('sul click il cursore arriva prima', posCursore > 0 && posCursore < posClick,
     `cursore@${posCursore} click@${posClick}`);
  ok('e sulla scrittura', /muoviCursoreSu\(t\.id, args\.selector, 'scrivo'\)/.test(ext));
  ok('esiste anche il comando per mostrarlo quando non si clicca', /case 'mostra_cursore'/.test(ext));
  ok('che accetta un elemento', /if \(args\.selettore\)/.test(ext));
  ok('oppure una posizione', /Number\(args\.x\) \|\| 40/.test(ext));
}

sezione('La versione e stata alzata, o Chrome non ricarica');
{
  const m = JSON.parse(fs.readFileSync('cobra-extension/manifest.json', 'utf8'));
  const [ma, mi] = m.version.split('.').map(Number);
  ok('versione oltre la 2.9.1', ma > 2 || (ma === 2 && mi >= 10), m.version);
}

sezione('Il disegno del cursore regge davvero');
{
  // Si estrae la funzione e la si esegue su un DOM finto: se ha un errore di
  // sintassi o chiama qualcosa che non esiste, qui si vede.
  const corpo = ext.match(/function disegnaCursore\(x, y, azione\) \{[\s\S]*?\n\}/)[0];
  const elementiCreati = [];
  const creaOspite = () => {
    const o = { id: '', style: { cssText: '' }, className: '', remove() {} };
    o.attachShadow = () => ({
      innerHTML: '',
      getElementById: (id) => ({ style: {}, textContent: '', id }),
      appendChild: (n) => elementiCreati.push(n),
    });
    return o;
  };
  const documentoFinto = {
    getElementById: () => null,
    createElement: () => creaOspite(),
    body: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
  };
  let esito = null, errore = null;
  try {
    const f = new Function('document', 'setTimeout', corpo + '; return disegnaCursore;')(documentoFinto, () => {});
    esito = f(120, 340, 'clic');
  } catch (e) { errore = e.message; }
  ok('la funzione gira senza errori', errore === null, errore);
  ok('e riferisce dove ha messo il cursore', esito && esito.x === 120 && esito.y === 340, JSON.stringify(esito));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
