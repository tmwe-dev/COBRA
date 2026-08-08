// tests/test-simmetria-canali.js — WhatsApp e LinkedIn devono avere le stesse
// protezioni.
//
// PERCHE' ESISTE
//
// Il 7 agosto ho corretto lo stesso difetto sei volte, in sei file diversi, e
// ogni volta ne restava uno. Non era distrazione: era che la stessa decisione
// stava scritta in piu' punti, e correggerne uno non correggeva gli altri.
//
// L'elenco di quelli trovati, tutti dello stesso tipo:
//
//   - la scheda giusta: elenco_chat la apriva, leggi_conversazione si arrendeva
//   - schede addormentate: gestite nell'elenco, non nella lettura
//   - il ritmo umano: su LinkedIn si', su whatsapp_elenco_chat no
//   - la verifica del destinatario: su WhatsApp c'era ma rotta (cercava
//     `#main header span[title]` e trovava "Dettagli profilo"), su LinkedIn
//     non c'era per niente
//
// L'ultimo e' il peggiore: una rete di sicurezza che risponde sempre "vai" non
// e' una rete, e sta sul percorso dove un errore manda un messaggio a uno
// sconosciuto.
//
// Questo file confronta i due canali fra loro. Non verifica che il codice sia
// giusto — quello lo dicono le prove dal vivo — verifica che sia SIMMETRICO:
// se una protezione c'e' di qua e non di la', qualcuno se n'e' dimenticato.

const fs = require('fs');
const path = require('path');

// I comandi sono usciti da background.js: 96 su 99 vivono in
// esterni/comandi/*.js. La prova guarda il COMPORTAMENTO dell'estensione, non
// un file preciso — quindi legge tutto.
const sorgente = require('./_estensione').sorgenteEstensione();

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };

function blocco(comando) {
  const { corpoDelComando } = require('./_estensione');
  const trovato = corpoDelComando(sorgente, comando);
  if (trovato !== null) return trovato;
  const i = sorgente.indexOf(`case '${comando}': {`);
  if (i === -1) return null;
  const j = sorgente.indexOf("\n      case '", i + 10);
  return sorgente.slice(i, j > 0 ? j : i + 9000);
}

const SCRIVONO = ['whatsapp_rispondi', 'linkedin_rispondi'];
const APRONO   = ['whatsapp_leggi_conversazione', 'linkedin_leggi_conversazione', ...SCRIVONO];
const TUTTI    = ['whatsapp_elenco_chat', 'linkedin_elenco_chat', ...APRONO];

console.log('\n── I comandi esistono tutti ──');
for (const c of TUTTI) ok(`${c} c'è`, blocco(c) !== null);

console.log('\n── Tutti passano dalla stessa funzione per la pagina ──');
// Cinque implementazioni diverse di "trova la scheda" erano cinque modi
// diversi di sbagliare. Adesso ce n'è una.
for (const c of TUTTI) {
  const b = blocco(c) || '';
  ok(`${c}: usa preparaPagina`, b.includes('preparaPagina'),
    'si cerca la scheda per conto suo');
  ok(`${c}: NON cerca le schede a mano`, !b.includes('chrome.tabs.query'),
    'chrome.tabs.query dentro il comando: è la strada che ha sbagliato sei volte');
}

console.log('\n── Il ritmo umano vale su entrambi ──');
for (const c of TUTTI) {
  ok(`${c}: passa dal ritmo`, (blocco(c) || '').includes('comeUnaPersona'),
    'niente coda, niente pausa, niente mouse: si vede');
}

console.log('\n── Chi apre una conversazione si ferma sugli omonimi ──');
for (const c of APRONO) {
  ok(`${c}: si ferma se il nome è ambiguo`, (blocco(c) || '').includes('ambiguo'),
    'sceglierebbe da solo fra due persone');
}

console.log('\n── Chi SCRIVE verifica a chi, e le protezioni sono le stesse ──');
for (const c of SCRIVONO) {
  const b = blocco(c) || '';
  ok(`${c}: verifica chi c'è aperto`, b.includes('combacia'),
    'scrive senza controllare in cima alla conversazione');
  ok(`${c}: se non legge il nome NON scrive`, /non scrivo|Non scrivo/.test(b),
    'nel dubbio deve perdere l\'invio, non sbagliare persona');
  ok(`${c}: svuota la casella e lo verifica`, b.includes('residuo'),
    'è il difetto del "test cobratest cobratest cobra"');
  ok(`${c}: scrive a pezzi`, b.includes('pezzo'),
    'incollare tutto in un millisecondo non lo fa nessuno');
  ok(`${c}: prova che è partito`, b.includes('ancora nella casella'),
    'un pulsante premuto non è un messaggio partito');
}

console.log('\n── E il controllo del destinatario non deve poter dire sempre "vai" ──');
// Il difetto vero del 7 agosto: `combacia: !chi || ...` lasciava passare
// proprio quando il nome non si riusciva a leggere — cioè quando il rischio
// era più alto.
for (const c of SCRIVONO) {
  const b = blocco(c) || '';
  ok(`${c}: non passa quando il nome è vuoto`, !/combacia:\s*!chi/.test(b),
    'la condizione !chi rende il controllo una decorazione');
}

console.log('\n── Nessun selettore e\' una regola: tutti passano dalla mappa ──');
//
// Il 7 agosto i selettori erano scritti a mano dentro i comandi. Funzionavano
// finche' WhatsApp e LinkedIn non cambiavano una classe — e le classi di
// WhatsApp oggi si chiamano x1n2onr6, cioe' cambiano a ogni build.
//
// Adesso il selettore lo chiede la mappa: la prima volta lo impara guardando
// la pagina, poi lo riusa, e quando non regge piu' lo ritrova da sola. I
// selettori scritti nel codice restano come PUNTO DI PARTENZA — si provano per
// primi perche' costano zero — ma non sono piu' l'unica strada.
for (const c of ['whatsapp_elenco_chat', 'linkedin_elenco_chat',
                 'whatsapp_leggi_conversazione', 'linkedin_leggi_conversazione',
                 'whatsapp_rispondi', 'linkedin_rispondi']) {
  ok(`${c}: chiede i selettori alla mappa`, (blocco(c) || '').includes('Mappa.selettorePer'),
    'ha i selettori inchiodati dentro: si rompera\' al primo cambio di interfaccia');
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  SIMMETRIA DEI CANALI: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
