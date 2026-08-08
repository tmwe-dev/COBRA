// tests/test-accessi.js — Gli accessi ai sistemi chiusi.
//
// COSA SI STA VERIFICANDO, E PERCHÉ PROPRIO QUESTO
//
// Qui dentro passano le password vere di Luca: DHL, UPS, TNT, FedEx, LinkedIn,
// le banche dati aziendali. Una funzione che "sembra funzionare" non basta —
// serve la prova che la password NON esca da dove deve stare.
//
// I quattro modi in cui una password scappa, e il test che li chiude:
//
//   1. finisce in chiaro su disco        → si legge il file e si cerca la stringa
//   2. finisce nel prompt del modello    → si guardano gli argomenti dello strumento
//   3. finisce nel log                   → si intercetta ctx.log e si cerca la stringa
//   4. finisce sul sito sbagliato        → si chiede la credenziale di un altro dominio
//
// Il quarto è il più insidioso: è quello che una pagina scritta apposta
// proverebbe a ottenere. La difesa è che la ricerca avviene per dominio, quindi
// non esiste proprio la strada.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Credenziali, dominioDi } = require('../modules/security/credenziali');
const { accedi, siti_con_accesso } = require('../modules/tools/handlers/accesso');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  ✓ ${nome}`); }
  else { fail++; console.log(`  ✗ ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}

const CHIAVE = 'chiave-di-prova-abbastanza-lunga-2026';
const SEGRETO = 'P4ssw0rd-Assolutamente-Unica-9x7';

function cartellaPulita() { return fs.mkdtempSync(path.join(os.tmpdir(), 'accessi-')); }

// ── 1. Il dominio, ridotto alla forma con cui si confronta ──
console.log('\n── 1. Riconoscere il dominio ──');
ok('https://www.ups.com/lasso/login → ups.com', dominioDi('https://www.ups.com/lasso/login') === 'ups.com');
ok('mydhl.express.dhl resta intero', dominioDi('https://mydhl.express.dhl/it/it/auth/login.html') === 'mydhl.express.dhl');
ok('senza schema funziona lo stesso', dominioDi('linkedin.com/login') === 'linkedin.com');
ok('il www si toglie sempre', dominioDi('WWW.FedEx.COM') === 'fedex.com');
ok('vuoto resta vuoto', dominioDi('') === '');

// ── 2. Salvare e ritrovare ──
console.log('\n── 2. Salvare e ritrovare ──');
{
  const d = cartellaPulita();
  const A = new Credenziali(d, CHIAVE);

  ok('senza utente non si salva', A.aggiungi({ url: 'ups.com', password: 'x' }).ok === false);
  ok('senza password non si salva', A.aggiungi({ url: 'ups.com', utente: 'x' }).ok === false);
  ok('indirizzo vuoto rifiutato', A.aggiungi({ url: '', utente: 'a', password: 'b' }).ok === false);

  const r = A.aggiungi({ url: 'https://www.ups.com/lasso/login?loc=it_IT', utente: 'tmwe@tmwe.it', password: SEGRETO, note: 'fatture' });
  ok('si salva', r.ok && r.dominio === 'ups.com');

  const c = A.per('https://www.ups.com/billing/dettaglio');
  ok('si ritrova da un altro percorso dello stesso sito', c && c.utente === 'tmwe@tmwe.it');
  ok('la password torna giusta a chi ha diritto di averla', c && c.password === SEGRETO);

  ok('un sottodominio eredita', new Credenziali(d, CHIAVE).per('https://fatture.ups.com/x') !== null);
  ok('conosce() dice sì senza tirare fuori niente', A.conosce('ups.com') === true);
  ok('conosce() dice no per gli altri', A.conosce('sito-mai-visto.it') === false);

  // Riscrivere lo stesso accesso non crea un doppione
  A.aggiungi({ url: 'ups.com', utente: 'tmwe@tmwe.it', password: 'nuova-password-123' });
  ok('salvare due volte lo stesso utente non fa doppioni', A.elenco().filter(v => v.dominio === 'ups.com').length === 1);
  ok('la password nuova sostituisce la vecchia', A.per('ups.com').password === 'nuova-password-123');

  // Due utenti sullo stesso sito convivono
  A.aggiungi({ url: 'ups.com', utente: 'secondo@tmwe.it', password: 'altra' });
  ok('due utenti sullo stesso sito convivono', A.elenco().filter(v => v.dominio === 'ups.com').length === 2);

  ok('togliere funziona', A.togli('ups.com').tolte === 2);
  ok('dopo aver tolto non si trova più', A.per('ups.com') === null);
}

// ── 3. Le quattro fughe ──
console.log('\n── 3. Le quattro strade da cui una password potrebbe scappare ──');
{
  const d = cartellaPulita();
  const A = new Credenziali(d, CHIAVE);
  A.aggiungi({ url: 'https://mydhl.express.dhl/it/it/auth/login.html', utente: 'tmwe', password: SEGRETO, note: 'fatture' });

  // FUGA 1 — il disco
  const suDisco = fs.readFileSync(path.join(d, 'accessi.enc.json'), 'utf8');
  ok('sul disco non c\'è la password in chiaro', !suDisco.includes(SEGRETO));
  ok('sul disco c\'è invece roba cifrata', /"iv"/.test(suDisco) && /"tag"/.test(suDisco));

  const modo = fs.statSync(path.join(d, 'accessi.enc.json')).mode & 0o777;
  ok('il file è leggibile solo dal proprietario (0600)', modo === 0o600, 'modo=' + modo.toString(8));

  // FUGA 2 — l'elenco che si mostra e si manda al pannello
  const elenco = JSON.stringify(A.elenco());
  ok('l\'elenco non contiene la password', !elenco.includes(SEGRETO));
  ok('l\'elenco non contiene nemmeno il pacchetto cifrato', !elenco.includes('"segreto"'));
  ok('l\'elenco contiene quello che serve vedere', /mydhl/.test(elenco) && /fatture/.test(elenco));

  // FUGA 3 — la chiave sbagliata non apre niente
  ok('chi copia il file senza la chiave non legge niente',
    new Credenziali(d, 'una-chiave-completamente-diversa-xyz').per('mydhl.express.dhl') === null);
  ok('senza chiave nel .env l\'archivio non è attivo', new Credenziali(d, null).attiva === false);
  ok('una chiave troppo corta viene rifiutata', new Credenziali(d, 'corta').attiva === false);

  // FUGA 4 — il dominio sbagliato
  ok('la password di DHL non si ottiene chiedendo un altro sito', A.per('https://sito-ostile.it/pagina') === null);
  ok('e nemmeno con un dominio che finisce simile', A.per('https://finto-mydhl.express.dhl.malevolo.it') === null);
}

// ── 4. Lo strumento: cosa vede il modello ──
//
// È il punto della difesa. Il modello chiama accedi("dhl") e riceve indietro
// "fatto" o "non fatto". La password passa dal codice al ponte e basta.
console.log('\n── 4. Quello che il modello vede, e quello che non vede ──');
(async () => {
  const d = cartellaPulita();
  process.env.COBRA_CREDENZIALI_CHIAVE = CHIAVE;

  const registro = [];
  const versoEstensione = [];
  const ctx = {
    dataDir: d,
    log: (m) => registro.push(String(m)),
    emitReasoning: (m) => registro.push(String(m)),
    isBridgeReady: () => true,
    bridgeCommand: async (cmd, args) => { versoEstensione.push({ cmd, args }); return { ok: true, entrato: true }; },
  };

  const A = new Credenziali(d, CHIAVE);
  A.aggiungi({ url: 'https://mydhl.express.dhl/it/it/auth/login.html', utente: 'tmwe', password: SEGRETO });
  ctx._credenziali = A;

  const risposta = await accedi({ sito: 'mydhl.express.dhl' }, ctx);
  const r = JSON.parse(risposta);
  ok('l\'accesso riesce', r.ok === true);
  ok('LA RISPOSTA AL MODELLO NON CONTIENE LA PASSWORD', !risposta.includes(SEGRETO));
  ok('la risposta dice dove è entrato', r.dominio === 'mydhl.express.dhl');

  ok('NEL LOG NON C\'È LA PASSWORD', !registro.join('\n').includes(SEGRETO));
  ok('nel log c\'è dominio e utente, che servono', registro.join('\n').includes('mydhl.express.dhl'));

  ok('la password va SOLO all\'estensione', versoEstensione.length === 1 && versoEstensione[0].args.password === SEGRETO);
  ok('e il comando è quello giusto', versoEstensione[0].cmd === 'compila_accesso');

  // Un sito senza accesso salvato: si spiega, non si inventa
  const senza = JSON.parse(await accedi({ sito: 'sito-mai-configurato.it' }, ctx));
  ok('per un sito sconosciuto dice che non ce l\'ha', /non ho un accesso/.test(senza.error || ''));
  ok('e suggerisce cosa fare', !!senza.cosaFare);
  ok('e dice su quali siti invece può entrare', Array.isArray(senza.sitiChePosso));
  ok('l\'elenco dei siti non contiene password', !JSON.stringify(senza).includes(SEGRETO));

  // Senza browser collegato non si prova nemmeno
  const senzaPonte = JSON.parse(await accedi({ sito: 'mydhl.express.dhl' },
    { ...ctx, isBridgeReady: () => false }));
  ok('senza browser collegato non ci prova', /browser collegato/.test(senzaPonte.error || ''));

  // Il sito chiede un codice: non è un fallimento nostro, serve una persona
  const conCodice = JSON.parse(await accedi({ sito: 'mydhl.express.dhl' }, {
    ...ctx, bridgeCommand: async () => ({ ok: false, serveUmano: true, motivo: 'il sito chiede un codice di verifica' }),
  }));
  ok('se serve un codice, lo dice e chiama Luca', conCodice.ok === false && /Luca/.test(conCodice.cosaFare));

  // L'elenco per il modello
  const siti = JSON.parse(await siti_con_accesso({}, ctx));
  ok('il modello può sapere dove ha le chiavi', siti.siti.some(x => x.dominio === 'mydhl.express.dhl'));
  ok('ma non le chiavi', !JSON.stringify(siti).includes(SEGRETO));

  // ── 4bis. WhatsApp: nessuna password, solo la sessione ──
  //
  // Chiedere utente e password per WhatsApp Web e' una domanda senza risposta.
  // Qui si verifica che COBRA lo sappia, invece di provarci e fallire.
  console.log('\n── 4bis. WhatsApp: si entra col telefono, non con la password ──');

  const conStato = (stato) => ({ ...ctx, bridgeCommand: async (cmd, a) => {
    ultimoComando = { cmd, a }; return stato;
  } });
  let ultimoComando = null;

  const aperto = JSON.parse(await accedi({ sito: 'web.whatsapp.com' }, conStato({ success: true, authenticated: true, method: 'sidebar' })));
  ok('se la sessione e viva dice che si puo lavorare', aperto.ok === true && aperto.sessione === true);
  ok('non ha cercato nessuna password', ultimoComando.cmd === 'whatsapp_sessione');
  ok('chiede al modulo del Navigator, non a selettori nostri', ultimoComando.cmd === 'whatsapp_sessione');

  const colQr = JSON.parse(await accedi({ sito: 'https://web.whatsapp.com/' }, conStato({ success: true, authenticated: false, reason: 'qr_required' })));
  ok('se c\'e il QR non ci prova nemmeno', colQr.ok === false && colQr.serveUmano === true);
  ok('e spiega che nessuna password esiste', /nessuna password/.test(colQr.cosaFare));
  ok('e dice a Luca dove trovare "Collega un dispositivo"', /Dispositivi collegati/.test(colQr.cosaFare));

  const boh = JSON.parse(await accedi({ sito: 'web.whatsapp.com' }, conStato({ success: true, authenticated: false, reason: 'confirm_popup', message: 'non stabilizzato' })));
  ok('se non e aperto lo dice, invece di dare per buono', boh.ok === false && /non risulta aperto/.test(boh.motivo));
  ok('e riporta il motivo tecnico che arriva dal modulo', /confirm_popup/.test(boh.motivo));

  // ── 5. Il comando dentro l'estensione ──
  console.log('\n── 5. Il pezzo dentro l\'estensione ──');
  const est = fs.readFileSync(path.join(__dirname, '..', 'cobra-extension', 'background.js'), 'utf8');
  ok('il comando compila_accesso esiste', est.includes("case 'compila_accesso'"));
  ok('prima guarda se la sessione è ancora valida', /sembraDentro|campoPassword/.test(est));
  ok('usa il setter nativo, per i moduli fatti in React', /getOwnPropertyDescriptor[\s\S]{0,400}compila_accesso|compila_accesso[\s\S]{0,4000}getOwnPropertyDescriptor/.test(est));
  ok('riconosce la richiesta di un codice di verifica', /chiedeCodice/.test(est));
  ok('riconosce le credenziali rifiutate', /erroreCredenziali/.test(est));
  ok('verifica DOPO l\'invio di essere entrato davvero', /ancoraFuori/.test(est));
  ok('la password non viene stampata nella console dell\'estensione',
    !/console\.log\([^)]*password/i.test(est));

  // ── 6. Il pannello ──
  console.log('\n── 6. Il pannello dove Luca li inserisce ──');
  const pag = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok('c\'è la sezione degli accessi', pag.includes('Accessi ai sistemi chiusi'));
  ok('WhatsApp NON chiede utente e password nel pannello', !pag.includes("nome: 'WhatsApp'"));
  ok('e il pannello spiega perche', pag.includes('WhatsApp non sta qui'));
  ok('lo stato della sessione si chiede al modulo del Navigator', est.includes("case 'whatsapp_sessione'"));
  ok('NON ci sono piu selettori WhatsApp indovinati da noi', !/canvasGrande|parlaDiQr/.test(est));
  for (const nome of ['DHL', 'UPS', 'TNT', 'FedEx', 'LinkedIn', 'Report aziende', 'WCA']) {
    ok(`${nome} è tra i pronti`, pag.includes(`'${nome}'`) || pag.includes(`nome: '${nome}'`));
  }
  ok('il campo password è di tipo password', /id="accPassword"[^>]*type="password"|type="password"[^>]*id="accPassword"/.test(pag));
  ok('dopo il salvataggio il campo si svuota', /accPassword'\)\.value = ''/.test(pag));
  ok('l\'elenco si carica solo aprendo il pannello', /classList\.contains\('open'\)[\s\S]{0,120}caricaAccessi/.test(pag));

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  ACCESSI: ${pass} PASS, ${fail} FAIL`);
  console.log(`╚══════════════════════════════════════════╝`);
  process.exit(fail ? 1 : 0);
})();
