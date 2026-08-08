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
  const estensione = require('./_estensione').sorgenteEstensione();
  const comandi = new Set(
    require('./_estensione').nomiDeiComandi(estensione)
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
  const estensione = require('./_estensione').sorgenteEstensione();
  const comandi = new Set(
    require('./_estensione').nomiDeiComandi(estensione)
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

// ── 4. Il codice vendorizzato puo' LEGGERE, non puo' AGIRE ──
//
// In cobra-extension/esterni/{wa,li}/ ci sono le estensioni del Navigator
// copiate byte per byte: migliaia di righe che sanno gia' fare cose. Utili,
// ma scritte prima delle regole di questo progetto — non verificano chi c'e'
// dall'altra parte, non hanno ritmo umano, e cercano i pulsanti con
// offsetParent, che sui riquadri `position: fixed` non funziona.
//
// L'8 agosto si e' scoperto che bastava passare un INDIRIZZO invece di un
// nome perche' la scrittura LinkedIn uscisse dal percorso controllato e
// finisse li'. Una porta di servizio aperta dal formato di un argomento.
//
// La riga che si tiene: leggere si', agire no. I comandi che mandano
// qualcosa fuori — scrivere, invitare — devono stare sul percorso nuovo,
// quello che passa da Pagine, Mappa e Ritmo.
{
  const ext = require('./_estensione').sorgenteEstensione();

  // Per ogni `case '...':` si guarda il pezzo di codice fino al case dopo.
  const pezzi = [];
  const trovati = [...ext.matchAll(/comandi\['([a-z_0-9]+)'\] = async function|^ {6}case '([a-z_0-9]+)':/gm)]
    .map(m => ({ index: m.index, 1: m[1] || m[2] }));
  for (let i = 0; i < trovati.length; i++) {
    const da = trovati[i].index;
    const a = i + 1 < trovati.length ? trovati[i + 1].index : ext.length;
    pezzi.push({ nome: trovati[i][1], corpo: ext.slice(da, a) });
  }

  const CHE_AGISCONO = /^(linkedin|whatsapp)_(scrivi|rispondi|collegati|invia)/;
  const colpevoli = pezzi
    .filter(p => CHE_AGISCONO.test(p.nome) && /Esterni\.con\(/.test(p.corpo))
    .map(p => p.nome);
  ok('nessun comando che AGISCE passa dal codice vendorizzato', colpevoli.length === 0,
    'agiscono col codice vecchio: ' + colpevoli.join(', '));

  // E chi scrive deve verificare il destinatario: la regola per cui esiste
  // meta' di questo progetto.
  for (const nome of ['linkedin_rispondi', 'whatsapp_rispondi', 'linkedin_collegati']) {
    const p = pezzi.find(x => x.nome === nome);
    ok(`${nome} verifica chi c'e' prima di agire`,
      !!p && /non riesco a leggere|non scrivo|non procedo|combacia|conferma/i.test(p.corpo));
  }

  // Il ritmo umano, che Luca ha imposto come tassativo.
  for (const nome of ['linkedin_rispondi', 'linkedin_collegati', 'whatsapp_rispondi']) {
    const p = pezzi.find(x => x.nome === nome);
    ok(`${nome} rispetta il ritmo umano`, !!p && /Ritmo\./.test(p.corpo));
  }
}

// ── 5. Lo stesso lavoro non si fa in due modi ──
//
// I comandi che facevano il doppio di un altro sono stati fatti convergere:
// chi chiedeva il vecchio nome ora arriva sul percorso nuovo. Il controllo
// verifica che non tornino a essere due implementazioni separate.
{
  const ext = require('./_estensione').sorgenteEstensione();
  const COPPIE = [
    ['linkedin_posta', 'linkedin_elenco_chat'],
    ['linkedin_conversazione', 'linkedin_leggi_conversazione'],
    ['whatsapp_conversazione', 'whatsapp_leggi_conversazione'],
    ['whatsapp_non_letti', 'whatsapp_elenco_chat'],
  ];
  // Si guarda il CORPO del comando, ovunque stia adesso: i comandi sono usciti
  // da background.js e la vecchia espressione cercava `case 'x':` in un file
  // che non li contiene piu'.
  const { corpoDelComando } = require('./_estensione');
  for (const [vecchio, nuovo] of COPPIE) {
    const corpo = corpoDelComando(ext, vecchio) || '';
    ok(`${vecchio} rimanda a ${nuovo} invece di rifarlo`,
      corpo.includes(nuovo), 'ha ancora un\'implementazione sua');
  }
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  UN PONTE SOLO: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
