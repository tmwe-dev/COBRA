#!/usr/bin/env node
// tests/test-registro-comandi.js — Il trasloco non deve perdere niente.
//
// PERCHÉ QUESTO FILE
//
// background.js era 146 KB con dentro un `switch` di 3.804 righe e
// novantanove `case`. Non è un problema estetico: l'8 agosto ho scritto
// `linkedin_collegati` senza accorgermi che `esterni/li/actions.js` — caricato
// nello stesso service worker — aveva già un `sendConnectionRequest`. In un
// file di quelle dimensioni non vedi cosa c'è già.
//
// Lo stesso file conteneva il difetto opposto: comandi scritti e mai
// collegati, che nessuno poteva chiamare. Da fuori le due cose sono
// indistinguibili — silenzio in tutti e due i casi.
//
// Spostare 1.268 righe a mano è il momento in cui si perde un comando senza
// accorgersene, e NESSUNO dei 2.174 test esegue il service worker: un comando
// sparito resterebbe verde fino al primo uso vero. Questo controllo esiste
// per quello.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const EXT = 'cobra-extension';
const bg = fs.readFileSync(`${EXT}/background.js`, 'utf8');

/** I comandi ancora nel vecchio switch: `case 'x':` a sei spazi. */
function nelloSwitch() {
  return [...bg.matchAll(/^ {6}case '([a-z_0-9]+)':/gm)].map(m => m[1]);
}
/** I comandi registrati da un'area. */
function registrati(area) {
  const src = fs.readFileSync(`${EXT}/esterni/comandi/${area}.js`, 'utf8');
  return [...src.matchAll(/comandi\['([a-z_0-9]+)'\]/g)].map(m => m[1]);
}
function areeEsistenti() {
  const d = `${EXT}/esterni/comandi`;
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')) : [];
}

console.log('\n=== IL REGISTRO DEI COMANDI ===');

sezione('Il registro funziona');
{
  // Si carica in un finto service worker: non c'è chrome, e non serve.
  const g = {};
  const src = fs.readFileSync(`${EXT}/esterni/registro.js`, 'utf8');
  new Function('globalThis', 'console', src)(g, { error() {}, log() {} });
  const R = g.Registro;

  ok('si registra un comando', R.comando('prova', async () => ({ ok: true }), 'test') === true);
  ok('e si ritrova', R.ha('prova') === true);
  ok('uno che non c e non c e', R.ha('inventato') === false);

  // La protezione che conta: due implementazioni dello stesso nome sono il
  // difetto del ponte fantasma in un'altra stanza.
  ok('registrarlo due volte e RIFIUTATO', R.comando('prova', async () => ({}), 'altro') === false);
  ok('e il doppione viene segnalato', R.elenco().doppioni.length === 1);
  ok('col nome di chi ci ha provato', R.elenco().doppioni[0].secondo === 'altro');

  ok('un comando senza funzione viene rifiutato', R.comando('vuoto', null, 'test') === false);
}

sezione('Nessun comando si e perso nel trasloco');
{
  const aree = areeEsistenti();
  ok('c e almeno un area', aree.length > 0, aree.join(', '));

  const daAree = aree.flatMap(registrati);
  const nelVecchio = nelloSwitch();

  // I 18 comandi di messaggistica: erano nel switch, ora sono nell'area.
  const MESSAGGISTICA = [  // ora divisi fra whatsapp.js e linkedin.js
    'whatsapp_sessione', 'whatsapp_elenco_chat', 'whatsapp_non_letti',
    'whatsapp_conversazione', 'whatsapp_scrivi', 'whatsapp_diagnosi',
    'whatsapp_leggi_conversazione', 'whatsapp_rispondi',
    'linkedin_profilo', 'linkedin_cerca', 'linkedin_posta', 'linkedin_conversazione',
    'linkedin_scrivi', 'linkedin_diagnosi', 'linkedin_elenco_chat',
    'linkedin_leggi_conversazione', 'linkedin_rispondi', 'linkedin_collegati',
  ];
  const persi = MESSAGGISTICA.filter(n => !daAree.includes(n));
  ok(`tutti i ${MESSAGGISTICA.length} comandi di messaggistica sono nelle aree`,
     persi.length === 0, 'persi: ' + persi.join(', '));

  const doppi = MESSAGGISTICA.filter(n => nelVecchio.includes(n));
  ok('e nessuno e rimasto anche nel vecchio switch', doppi.length === 0,
     'in due posti: ' + doppi.join(', '));
}

sezione('Il centralinista chiede al registro per primo');
{
  ok('executeCommand interroga il registro', /Registro\.ha\(command\)/.test(bg));
  ok('e prima del vecchio switch',
     bg.indexOf('Registro.ha(command)') < bg.indexOf('switch (command)'));
  ok('col motivo scritto', /vince quella caricata\s*\n?\s*\/\/ per ultima/.test(bg));
}

sezione('Le aree sono caricate, e nell ordine giusto');
{
  const ponte = fs.readFileSync(`${EXT}/esterni/ponte.js`, 'utf8');
  ok('il registro viene caricato', /importScripts\('esterni\/registro\.js'\)/.test(ponte));
  ok('le aree si caricano tutte', /for \(const area of \[/.test(ponte));
  for (const a of areeEsistenti()) {
    ok(`l area ${a} e nell elenco`, new RegExp(`'${a}'`).test(ponte));
  }
  // L'ordine non è un dettaglio: le aree usano Pagine, Mappa e Ritmo. Se si
  // caricassero prima, `globalThis.Pagine` sarebbe undefined al primo uso.
  ok('il registro prima delle aree',
     ponte.indexOf('esterni/registro.js') < ponte.indexOf('esterni/comandi/'));
  for (const dip of ['ritmo.js', 'mappa.js', 'pagine.js']) {
    ok(`${dip} prima delle aree`,
       ponte.indexOf(`esterni/${dip}`) < ponte.indexOf('esterni/comandi/'));
  }
}

sezione('Nessun file di comandi e troppo grosso');
{
  // Il primo taglio aveva portato background.js da 4.730 a 1.256 righe, ma
  // messaggistica.js ne aveva prese 1.318: il problema si era spostato, non
  // risolto. Luca l'ha fatto notare, e aveva ragione — un file di 1.300 righe
  // non e' meglio di uno di 4.000 se dentro ci sono due cose diverse.
  //
  // Il numero non e' il criterio: il criterio e' quante ragioni ha un file per
  // cambiare. Ma sopra una certa soglia le ragioni sono sempre piu' di una, e
  // questa soglia e' una rete, non una regola di stile.
  const LIMITE = 900;
  const grossi = areeEsistenti()
    .map(a => ({ a, righe: fs.readFileSync(`${EXT}/esterni/comandi/${a}.js`, 'utf8').split('\n').length }))
    .filter(x => x.righe > LIMITE);
  ok(`nessuna area supera le ${LIMITE} righe`, grossi.length === 0,
     grossi.map(g => `${g.a}: ${g.righe}`).join(', '));

  for (const a of areeEsistenti()) {
    const righe = fs.readFileSync(`${EXT}/esterni/comandi/${a}.js`, 'utf8').split('\n').length;
    console.log(`     ${String(righe).padStart(5)} righe  ${a}`);
  }
}

sezione('Nessun comando in due posti, e nessuno perso');
{
  // Il conto: novantanove comandi c'erano prima del trasloco dell'8 agosto,
  // novantanove dovevano esserci dopo. Un comando perso resterebbe verde in
  // tutti gli altri test — nessuno esegue il service worker — e si
  // scoprirebbe al primo uso.
  //
  // Questo numero si alza SOLO quando si aggiunge un comando davvero nuovo, e
  // va scritto qui insieme al perche'. Se sale senza che nessuno l'abbia
  // deciso, e' un comando comparso per sbaglio.
  //
  //   99 → 100  il 9 agosto: stato_permessi, che chiede a Chrome com'e' messo
  //             con posizione, notifiche, microfono e telecamera. Serviva
  //             perche' i permessi ora si decidono a livello di browser e
  //             l'unico modo onesto di sapere se ha funzionato e' chiederlo.
  const PRIMA = 100;
  const daAree = areeEsistenti().flatMap(registrati);
  const nelVecchio = nelloSwitch();
  ok(`i comandi sono ancora ${PRIMA}`, daAree.length + nelVecchio.length === PRIMA,
     `${daAree.length} nelle aree + ${nelVecchio.length} nel switch = ${daAree.length + nelVecchio.length}`);

  const doppi = daAree.filter(n => nelVecchio.includes(n));
  ok('nessuno sta in due posti', doppi.length === 0, doppi.join(', '));

  const visti = new Set(); const dueVolte = [];
  for (const n of daAree) { if (visti.has(n)) dueVolte.push(n); visti.add(n); }
  ok('e nessuno e registrato due volte fra le aree', dueVolte.length === 0, dueVolte.join(', '));

  // I tre rimasti usano `break` invece di `return`, oppure non compilano da
  // soli: restano nel switch finche' non vengono riscritti. Dirlo e' meglio
  // che spostarli male.
  ok('quelli rimasti sono i tre noti',
     nelVecchio.every(n => ['wait_for', 'verify_action', 'retry'].includes(n)),
     'rimasti: ' + nelVecchio.join(', '));
}

sezione('background.js e diventato un centralinista');
{
  const righe = bg.split('\n').length;
  // Era 4.730 righe. Il numero non e' un vezzo: in un file di quelle
  // dimensioni non vedi cosa c'e' gia', ed e' cosi' che nasce un comando
  // duplicato.
  ok('da 4.730 righe a meno di 1.500', righe < 1500, `${righe} righe`);
  const nelloSw = nelloSwitch().length;
  ok('e nel switch ne restano tre', nelloSw === 3, `${nelloSw} rimasti`);
  console.log(`     (${righe} righe, ${nelloSw} comandi ancora nel switch)`);
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  IL REGISTRO: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
