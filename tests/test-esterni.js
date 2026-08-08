// tests/test-esterni.js — Le due estensioni del Navigator dentro COBRA.
//
// COSA PUÒ ESSERE PROVATO QUI, E COSA NO
//
// NON si può provare che i selettori di WhatsApp funzionino: per quello serve
// WhatsApp Web aperto davvero. Fingere una risposta e chiamarla verifica è
// esattamente il modo di dire "fatto" senza avere niente in mano.
//
// Si può provare invece la cosa che ho introdotto io, ed è l'unica che ho
// scritto: il caricatore. Le due estensioni chiamano i loro moduli con gli
// stessi nomi, vivono nello stesso service worker, e se si sovrascrivono
// LinkedIn si ritrova il Config di WhatsApp — un guasto che in produzione si
// manifesterebbe come "i selettori non funzionano più", mandando a cercare nel
// posto sbagliato per ore.
//
// Quindi qui si caricano i FILE VERI, quelli copiati, dentro un finto service
// worker, e si guarda se restano separati.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  ✓ ${nome}`); }
  else { fail++; console.log(`  ✗ ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}

const EST = path.join(__dirname, '..', 'cobra-extension', 'esterni');

// ── 1. La copia è davvero una copia ──
//
// Se qualcuno "sistemasse" un selettore qui dentro, perderemmo il pezzo di
// valore: quei file valgono perché sono stati corretti sul campo, non a mente.
console.log('\n── 1. I file copiati sono identici a quelli del Navigator ──');
{
  const originali = '/tmp/nav/wca-network-navigator-main/public';
  const coppie = [['wa', 'whatsapp-extension'], ['li', 'linkedin-extension']];
  // ── Le differenze volute ──
  //
  // Questo controllo serve a provare che il codice del Navigator e' stato
  // copiato davvero e non riscritto a memoria. Ma dove il loro codice ha un
  // difetto vero, si corregge: restare identici a un bug non e' fedelta', e'
  // pigrizia. Ogni divergenza sta scritta qui col motivo, cosi' resta una
  // scelta dichiarata e non una copia venuta male.
  const DIVERGENZE = {
    'wa/actions.js':
      'Il 7 agosto a Jose e\' arrivato "test cobratest cobratest cobra": tre '
      + 'tentativi accodati nella stessa casella. Loro svuotano con un '
      + 'execCommand("delete") dentro un try/catch muto — su Lexical a volte non '
      + 'fa niente — e poi considerano riuscito se il testo COMPARE nella '
      + 'casella invece di ESSERE la casella. Con un residuo dentro, il primo '
      + 'controllo e\' gia\' vero e si manda il residuo piu\' il nuovo. Noi '
      + 'svuotiamo verificando, e se resta qualcosa non scriviamo.',
  };

  let confrontati = 0, diversi = [];
  for (const [nostro, loro] of coppie) {
    const dir = path.join(EST, nostro);
    if (!fs.existsSync(path.join(originali, loro))) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
      const a = path.join(dir, f), b = path.join(originali, loro, f);
      if (!fs.existsSync(b)) continue;
      confrontati++;
      if (fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) diversi.push(`${nostro}/${f}`);
    }
  }
  if (confrontati === 0) {
    console.log('  · originali non estratti in /tmp: confronto saltato');
  } else {
    const attese = diversi.filter(d => DIVERGENZE[d]);
    const inattese = diversi.filter(d => !DIVERGENZE[d]);
    ok(`${confrontati} file identici all'originale (${attese.length} divergenze dichiarate)`,
      inattese.length === 0, 'diversi senza motivo scritto: ' + inattese.join(', '));
    for (const d of attese) console.log(`    · ${d} — diverso apposta: ${DIVERGENZE[d].slice(0, 90)}…`);

    // E il verso opposto: una divergenza dichiarata che non c'e' piu' significa
    // che la correzione e' stata persa in un aggiornamento.
    for (const d of Object.keys(DIVERGENZE)) {
      ok(`la correzione in ${d} c'e' ancora`, diversi.includes(d),
        'il file e\' tornato identico all\'originale: la correzione e\' andata persa');
    }
  }
}

// ── 1bis. L'elenco dei nomi e' completo? ──
//
// Il caricatore libera i nomi elencati in _NOMI_CONDIVISI. Uno che manca non
// produce nessun errore: resta assegnato, e il gruppo dopo eredita il modulo
// del gruppo prima. Nessuno se ne accorge finche' non si comporta male.
//
// Quindi l'elenco NON si controlla a occhio: si ricava dai file.
console.log('\n── 1bis. Nessun nome dimenticato nel caricatore ──');
{
  const definiti = new Set();
  for (const g of ['wa', 'li']) {
    const dir = path.join(EST, g);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
      const testo = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of testo.matchAll(/^globalThis\.(\w+)\s*=/gm)) definiti.add(m[1]);
    }
  }
  const ponte = fs.readFileSync(path.join(EST, 'ponte.js'), 'utf8');
  const inLista = new Set(
    [...(ponte.match(/const _NOMI_CONDIVISI = \[[\s\S]*?\];/) || [''])[0]
      .matchAll(/'(\w+)'/g)].map(m => m[1]));

  const mancanti = [...definiti].filter(n => !inLista.has(n));
  const diPiu = [...inLista].filter(n => !definiti.has(n));

  ok(`tutti i ${definiti.size} moduli dei file sono nell'elenco del caricatore`,
    mancanti.length === 0, 'dimenticati: ' + mancanti.join(', '));
  ok('e nell\'elenco non c\'e nessun nome inventato',
    diPiu.length === 0, 'inesistenti: ' + diPiu.join(', '));
}

// ── 1ter. Indipendenti dal Navigator ──
//
// Luca ha chiesto una garanzia, non una rassicurazione: il codice e' nostro e
// gira in casa nostra, senza parlare con l'infrastruttura del Navigator.
//
// Il rischio e' concreto. Dentro i file copiati ci sono due `fetch` verso le
// edge function Supabase del Navigator (wa/ai-extract.js:80 e
// li/ai-learn.js:180): servono a far rileggere il DOM da un modello quando i
// selettori non funzionano. Non partono perche' sono protette da
// `if (url && key)`, e url e chiave arrivano da chrome.storage popolato dal
// comando `setConfig` — che mandava il content.js del Navigator dalla webapp
// lovable. Quel file l'abbiamo cancellato, e la nostra estensione ha un ID
// Chrome diverso, quindi uno storage diverso e vuoto.
//
// E' una catena di quattro anelli. Basta che qualcuno rimetta content.js
// "perche' serviva" e i dati di Luca ricominciano a uscire. Questi controlli
// tengono la catena.
console.log('\n── 1ter. Nessun filo che torna al Navigator ──');
{
  const estDir = path.join(EST, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(estDir, 'manifest.json'), 'utf8'));
  const testoManifest = JSON.stringify(manifest);

  ok('il manifest non nomina lovable', !/lovable/i.test(testoManifest));
  ok('il manifest non nomina supabase', !/supabase/i.test(testoManifest));

  // I due file che facevano da ponte con la webapp del Navigator
  for (const g of ['wa', 'li']) {
    ok(`esterni/${g}/content.js non esiste (era il ponte con la loro webapp)`,
      !fs.existsSync(path.join(EST, g, 'content.js')));
    ok(`esterni/${g}/background.js non esiste (era il loro router di messaggi)`,
      !fs.existsSync(path.join(EST, g, 'background.js')));
  }

  // Nessun content script che ascolti la webapp del Navigator
  const suLovable = (manifest.content_scripts || [])
    .flatMap(c => c.matches || [])
    .filter(m => /lovable|supabase/i.test(m));
  ok('nessun content script punta alla loro webapp', suLovable.length === 0, suLovable.join(', '));

  // Il comando setConfig — l'unica porta da cui entrerebbero url e chiave —
  // non e' raggiungibile: il nostro background.js non lo gestisce.
  const bg = fs.readFileSync(path.join(estDir, 'background.js'), 'utf8');
  ok('il nostro background.js non gestisce setConfig', !/case\s*['\"]setConfig['\"]/.test(bg));

  // Ogni fetch nei file copiati deve essere protetta da un controllo
  // sull'indirizzo: una senza guardia partirebbe davvero.
  let fetchTotali = 0, fetchProtette = 0;
  for (const g of ['wa', 'li']) {
    for (const f of fs.readdirSync(path.join(EST, g)).filter(x => x.endsWith('.js'))) {
      const testo = fs.readFileSync(path.join(EST, g, f), 'utf8');
      const righe = testo.split('\n');
      righe.forEach((riga, i) => {
        if (!/\bfetch\s*\(/.test(riga)) return;
        fetchTotali++;
        // Si guarda nelle dieci righe sopra: c'e' un if che pretende url e chiave?
        const prima = righe.slice(Math.max(0, i - 10), i).join('\n');
        if (/if\s*\(\s*\w*[Uu]rl\s*&&\s*\w*[Kk]ey|if\s*\(\s*url\s*&&\s*key/.test(prima)) fetchProtette++;
      });
    }
  }
  ok(`tutte le ${fetchTotali} fetch sono protette da "se ho indirizzo e chiave"`,
    fetchTotali > 0 && fetchProtette === fetchTotali, `protette ${fetchProtette}/${fetchTotali}`);

  // E comunque l'indirizzo verrebbe da chrome.storage, che nella nostra
  // estensione nessuno riempie.
  const cfg = fs.readFileSync(path.join(EST, 'wa', 'config.js'), 'utf8');
  ok('l\'indirizzo Supabase puo\' arrivare solo da chrome.storage, mai dal codice',
    /chrome\.storage\.local\.get/.test(cfg) && !/https:\/\/\w+\.supabase\.co/.test(cfg));
}

// ── 1quater. Il ritmo umano, e perche' LinkedIn ha numeri suoi ──
//
// Il Navigator scrive, nel suo stesso codice: "LinkedIn ha detection anti-bot
// piu' aggressiva di WhatsApp" (src/hooks/useLinkedInAutoSync.ts, riga 4). Poi
// pero' quel ritmo non lo applica: l'estensione che usano non ha un solo
// controllo, e il modulo che ce l'aveva e' finito in archive/.
//
// Qui i numeri tornano in servizio, e questi controlli servono a impedire che
// qualcuno li allenti "per fare prima" senza accorgersi di cosa sta togliendo.
console.log('\n── 1quater. Il ritmo: LinkedIn piu severo di WhatsApp ──');
{
  const ritmo = fs.readFileSync(path.join(EST, 'ritmo.js'), 'utf8');
  const num = (chiave, gruppo) => {
    const blocco = (ritmo.match(new RegExp(gruppo + ':\\s*\\{[\\s\\S]*?\\}', 'm')) || [''])[0];
    const m = blocco.match(new RegExp(chiave + ':\\s*([0-9*\\s]+)'));
    return m ? Function('return ' + m[1])() : null;
  };

  ok('LinkedIn: 20 operazioni all\'ora (da rate-limiter.js del Navigator)', num('allOra', 'li') === 20);
  ok('LinkedIn: 80 al giorno (idem)', num('alGiorno', 'li') === 80);
  ok('LinkedIn: almeno 8 secondi fra due gesti (idem)', num('intervalloMinimo', 'li') === 8000);
  ok('LinkedIn: 15 gesti e poi una pausa (da stealth.js)', num('gestiPerSessione', 'li') === 15);
  ok('LinkedIn: 5 minuti di pausa fra le sessioni', num('pausaFraSessioni', 'li') === 5 * 60000);
  ok('LinkedIn: non piu\' di 3 sessioni all\'ora', num('sessioniAllOra', 'li') === 3);

  // Il confronto e' il punto: se un giorno qualcuno pareggia i due canali,
  // questi controlli lo fanno vedere subito.
  ok('LinkedIn e\' PIU\' severo di WhatsApp sull\'ora', num('allOra', 'li') < num('allOra', 'wa'));
  ok('LinkedIn e\' PIU\' severo sul giorno', num('alGiorno', 'li') < num('alGiorno', 'wa'));
  ok('LinkedIn aspetta di piu\' fra un gesto e l\'altro', num('intervalloMinimo', 'li') > num('intervalloMinimo', 'wa'));
  ok('LinkedIn fa sessioni piu\' corte', num('gestiPerSessione', 'li') < num('gestiPerSessione', 'wa'));

  ok('le pause sono gaussiane, non fisse', /Box-Muller|_gaussiana/.test(ritmo));
  ok('e ogni tanto ce n\'e\' una piu\' lunga senza motivo', /Math\.random\(\) < 0\.10/.test(ritmo));
  ok('il conto sta in chrome.storage, non in memoria', /chrome\.storage\.local\.set/.test(ritmo));

  // E soprattutto: il ritmo deve valere per OGNI comando, non per quelli che
  // qualcuno si ricorda di proteggere.
  const ponte = fs.readFileSync(path.join(EST, 'ponte.js'), 'utf8');
  ok('il ritmo si applica nel punto in cui passano TUTTI i comandi',
    /Ritmo\.chiedi\(gruppo/.test(ponte));
  ok('e se il ritmo dice no, il comando non parte', /throw e;/.test(ponte));
}

// ── 2. Un finto service worker ──
//
// I moduli si aspettano importScripts e le API di Chrome. Non serve che
// funzionino: serve che si CARICHINO, perché è al caricamento che si
// sovrascriverebbero.
console.log('\n── 2. I due gruppi si caricano senza mangiarsi a vicenda ──');

function fintoChrome() {
  const nulla = () => Promise.resolve();
  return {
    runtime: { id: 'prova', getURL: (p) => 'chrome-extension://prova/' + p, onMessage: { addListener: nulla }, lastError: null },
    tabs: { query: async () => [], create: async () => ({ id: 1 }), update: nulla, remove: nulla, onRemoved: { addListener: nulla }, onUpdated: { addListener: nulla }, sendMessage: nulla },
    windows: { create: async () => ({ id: 1 }), update: nulla, getCurrent: async () => ({ id: 1 }) },
    scripting: { executeScript: async () => [{ result: null }] },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    cookies: { get: async () => null, getAll: async () => [] },
    alarms: { create: nulla, onAlarm: { addListener: nulla } },
    webNavigation: { onCompleted: { addListener: nulla }, onHistoryStateUpdated: { addListener: nulla } },
    notifications: { create: nulla },
    debugger: { attach: nulla, detach: nulla, sendCommand: nulla, onEvent: { addListener: nulla } },
  };
}

const scatola = { console: { log() {}, warn() {}, error() {} }, chrome: fintoChrome(), fetch: async () => ({ ok: false, json: async () => ({}) }), setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder, crypto: require('crypto').webcrypto };
scatola.globalThis = scatola;
scatola.self = scatola;
scatola.importScripts = function (...files) {
  for (const f of files) {
    const p = path.join(EST, '..', f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  }
};
const ctx = vm.createContext(scatola);

let caricato = true;
try {
  vm.runInContext(fs.readFileSync(path.join(EST, 'ponte.js'), 'utf8'), ctx, { filename: 'esterni/ponte.js' });
  caricato = scatola.Esterni.carica();
} catch (e) {
  caricato = false;
  console.log('  errore al caricamento:', e.message);
}
ok('il caricatore porta su entrambi i gruppi', caricato === true);

const stato = scatola.Esterni.stato();
ok('WhatsApp ha i suoi moduli', stato.wa.length >= 6, 'trovati: ' + stato.wa.join(', '));
ok('LinkedIn ha i suoi moduli', stato.li.length >= 8, 'trovati: ' + stato.li.join(', '));
ok('WhatsApp ha Discovery, che è solo suo', stato.wa.includes('Discovery'));
ok('LinkedIn ha HybridOps e AXTree, che sono solo suoi', stato.li.includes('HybridOps') && stato.li.includes('AXTree'));
ok('LinkedIn NON si è preso il Discovery di WhatsApp', !stato.li.includes('Discovery'));
ok('WhatsApp NON si è preso HybridOps', !stato.wa.includes('HybridOps'));

// ── 3. Il punto della collisione ──
//
// Tutti e due definiscono Config, TabManager, Actions. Se il caricatore non
// funzionasse, sarebbero LO STESSO OGGETTO — e nessuno se ne accorgerebbe
// finché LinkedIn non smettesse di trovare i suoi elementi.
console.log('\n── 3. I nomi in comune puntano a cose diverse ──');
(async () => {
  const wa = await scatola.Esterni.con('wa', (m) => m);
  const li = await scatola.Esterni.con('li', (m) => m);

  for (const nome of ['Config', 'TabManager', 'Actions', 'OptimusClient']) {
    ok(`${nome}: WhatsApp e LinkedIn ne hanno uno ciascuno`, wa[nome] && li[nome] && wa[nome] !== li[nome]);
  }

  // La prova che sono proprio quelli giusti, non due copie a caso
  ok('Actions di WhatsApp sa mandare messaggi WhatsApp', typeof wa.Actions.sendWhatsAppMessage === 'function');
  ok('Actions di WhatsApp sa verificare la sessione', typeof wa.Actions.verifySession === 'function');
  ok('Actions di WhatsApp NON ha funzioni di LinkedIn', typeof wa.Actions.sendLinkedInMessage === 'undefined');
  ok('Actions di LinkedIn sa estrarre un profilo', typeof li.Actions.extractProfileByUrl === 'function');
  ok('Actions di LinkedIn sa cercare', typeof li.Actions.searchProfile === 'function');
  ok('Actions di LinkedIn NON ha funzioni di WhatsApp', typeof li.Actions.sendWhatsAppMessage === 'undefined');

  // ── 4. Dopo la chiamata i nomi tornano liberi ──
  ok('finita la chiamata i globali sono puliti', scatola.Config === undefined && scatola.Actions === undefined);

  // ── 5. Due comandi intrecciati non si rubano i moduli ──
  //
  // È lo scenario che rompe tutto in silenzio: parte una lettura WhatsApp,
  // mentre aspetta parte una ricerca LinkedIn, e la prima si ritrova i moduli
  // dell'altra a metà lavoro. La coda esiste per questo.
  console.log('\n── 4. Due comandi lanciati insieme restano ognuno coi suoi ──');
  const visto = [];
  const lento = scatola.Esterni.con('wa', async (m) => {
    await new Promise(r => setTimeout(r, 30));
    visto.push(['wa', m.Actions === wa.Actions, scatola.Actions === wa.Actions]);
    return 'wa';
  });
  const veloce = scatola.Esterni.con('li', async (m) => {
    visto.push(['li', m.Actions === li.Actions, scatola.Actions === li.Actions]);
    return 'li';
  });
  await Promise.all([lento, veloce]);

  ok('sono partiti tutti e due', visto.length === 2);
  ok('WhatsApp ha lavorato coi moduli di WhatsApp', visto.find(v => v[0] === 'wa')?.[1] === true);
  ok('LinkedIn ha lavorato coi moduli di LinkedIn', visto.find(v => v[0] === 'li')?.[1] === true);
  ok('e i globali erano quelli giusti anche a metà lavoro',
    visto.every(v => v[2] === true), JSON.stringify(visto));
  ok('la coda li ha messi in fila, non in parallelo', visto[0][0] === 'wa' && visto[1][0] === 'li');

  // ── 6. I comandi esistono dentro COBRA ──
  console.log('\n── 5. I comandi sono agganciati a COBRA ──');
  const bg = fs.readFileSync(path.join(EST, '..', 'background.js'), 'utf8');
  for (const c of ['whatsapp_sessione', 'whatsapp_non_letti', 'whatsapp_conversazione', 'whatsapp_scrivi',
    'linkedin_profilo', 'linkedin_cerca', 'linkedin_posta', 'linkedin_scrivi', 'stato_moduli_esterni']) {
    ok(`comando ${c}`, bg.includes(`case '${c}'`));
  }
  ok('il ponte viene caricato all\'avvio', /importScripts\('esterni\/ponte\.js'\)/.test(bg));

  // ── 7. Il guasto noto, dichiarato ──
  //
  // BUG PRE-ESISTENTE nell'estensione del Navigator, non introdotto qui:
  // readThread di WhatsApp chiama due funzioni che non esistono in nessun file.
  console.log('\n── 6. Il guasto ereditato, messo nero su bianco ──');
  const waAct = fs.readFileSync(path.join(EST, 'wa', 'actions.js'), 'utf8');
  const chiamate = (waAct.match(/_pageOpenAndReadThread|_pageDomReadMessages/g) || []).length;
  const definite = (waAct.match(/function\s+(_pageOpenAndReadThread|_pageDomReadMessages)/g) || []).length;
  ok('readThread di WhatsApp chiama due funzioni mai definite (bug del Navigator, non nostro)',
    chiamate > 0 && definite === 0, `chiamate ${chiamate}, definite ${definite}`);

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  ESTERNI: ${pass} PASS, ${fail} FAIL`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log('\nNON verificato qui: che i selettori funzionino su WhatsApp Web');
  console.log('e LinkedIn veri. Serve una prova dal vivo, col browser aperto.');
  process.exit(fail ? 1 : 0);
})();
