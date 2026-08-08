// tests/test-strumenti-raggiungibili.js — Uno strumento che il modello non vede
// non esiste.
//
// PERCHÉ QUESTO FILE
//
// Il 7 agosto ho aggiunto `whatsapp_scrivi` e ho sbagliato tre volte di fila,
// sempre nello stesso modo — dimenticando un anello della catena:
//
//   1. l'ho scritto, ma senza SCHEMA → il modello non sapeva che esistesse
//   2. gli ho dato lo schema, ma senza RISCHIO → nasceva "destructive" e
//      veniva bloccato prima di partire
//   3. gli ho dato il rischio, ma non l'ho messo in nessun AMBITO → il filtro
//      degli ambiti non lo consegnava mai, e COBRA rispondeva a Luca
//      "non posso mandare messaggi WhatsApp" con lo strumento a due centimetri
//
// Ogni volta il codice era giusto e il pezzo mancante era altrove. Ogni volta
// il sintomo era lo stesso: silenzio. Nessun errore, nessun avviso — solo una
// capacità che non c'era.
//
// Perché tre volte e non una: perché ogni anello vive in un file diverso, e
// nessuno dei tre sa degli altri. Un controllo che li guarda insieme è l'unica
// cosa che poteva accorgersene, e non c'era.
//
// Adesso c'è.

const { COBRA_TOOLS } = require('../modules/tools/schemas');
const handlers = require('../modules/tools/handlers');
const { TOOL_RISK_TAXONOMY } = require('../modules/risk/taxonomy');
const { TOOL_SCOPES } = require('../modules/supermario');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  ✓ ${nome}`); }
  else { fail++; console.log(`  ✗ ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}

const schemi = COBRA_TOOLS.map(t => t.function.name);
const conHandler = Object.keys(handlers).filter(n => typeof handlers[n] === 'function');

// Gli strumenti raggiungibili da almeno un ambito (escluso 'full', che li dà
// tutti e quindi non prova niente).
const raggiungibili = new Set();
for (const [nome, elenco] of Object.entries(TOOL_SCOPES || {})) {
  if (nome === 'full' || !Array.isArray(elenco)) continue;
  elenco.forEach(t => raggiungibili.add(t));
}

console.log('\n── La catena completa: handler → schema → rischio → ambito ──');

// ── 1. Ogni handler ha uno schema ──
{
  const senza = conHandler.filter(n => !schemi.includes(n));
  // Alcuni sono alias interni voluti, non strumenti che il modello chiama.
  // Alcuni sono alias interni voluti, non strumenti che il modello chiama.
  //
  // whatsapp_send e linkedin_send_message sono stati tolti dagli SCHEMI il
  // 9 agosto: erano la seconda strada senza regole, quella da cui il 7 agosto
  // sono usciti sette messaggi fuori conteggio. L'handler resta (risponde
  // "strada dismessa" a chi lo chiamasse dall'interno) ma il modello non lo
  // vede piu': un nome in meno e' meglio di un nome piu' chiaro.
  const ammessi = ['web_search', 'execute_js', 'read_inbox', 'send_whatsapp', 'send_linkedin',
                   'whatsapp_send', 'linkedin_send_message'];
  const veri = senza.filter(n => !ammessi.includes(n));
  ok(`tutti i ${conHandler.length} handler hanno uno schema`, veri.length === 0,
    'senza schema: ' + veri.join(', '));
}

// ── 2. Ogni schema ha un handler ──
//
// Il verso opposto è più grave: il modello chiama uno strumento che non
// esiste, e si becca un errore in faccia a metà lavoro.
{
  const senza = schemi.filter(n => !conHandler.includes(n));
  ok(`tutti i ${schemi.length} schemi hanno un handler`, senza.length === 0,
    'senza handler: ' + senza.join(', '));
}

// ── 3. Ogni schema ha un rischio dichiarato ──
//
// Non dichiararlo non è neutro: chi non è in tabella nasce "destructive" e
// viene bloccato. È come è morto `scrivi_raccolta` per quattro giri.
{
  const senza = schemi.filter(n => !TOOL_RISK_TAXONOMY || !TOOL_RISK_TAXONOMY[n]);
  ok('tutti gli schemi hanno un rischio in tabella', senza.length === 0,
    'senza rischio (nascerebbero destructive e verrebbero bloccati): ' + senza.join(', '));
}

// ── 4. Ogni strumento è raggiungibile da almeno un ambito ──
//
// È l'anello che mi è sfuggito con whatsapp_scrivi. Uno strumento fuori da
// tutti gli ambiti è codice che nessuno chiamerà mai.
{
  // ── I tool tolti apposta ──
  //
  // C'erano DUE strade per mandare un messaggio: whatsapp_scrivi, con le
  // regole e la verifica di chi sia il destinatario, e whatsapp_send, senza
  // niente. Il 7 agosto sono usciti sette messaggi, tutti e sette dalla
  // seconda: il registro degli invii era vuoto e i limiti non avevano contato
  // nulla — non perche' fossero rotti, ma perche' nessuno ci era passato.
  //
  // Una protezione che si puo' aggirare senza saperlo non e' una protezione.
  // Questi restano nel codice per i flussi interni e per l'ambito 'full', ma
  // fuori da 'communicate' non ci arriva piu' nessuno.
  // ── I gemelli che perdono il confronto ──
  //
  // Non si elencano a mano: il motivo lo dichiara GEMELLI in supermario.js, e
  // quello e' anche il posto che li toglie. Ricopiarli qui sarebbe una seconda
  // fonte della stessa regola — la malattia dell'8 agosto in un file di prove.
  const { GEMELLI } = require('../modules/supermario');
  const GEMELLI_PERDENTI = {};
  for (const [lavoro, g] of Object.entries(GEMELLI)) {
    for (const t of g.perdono) {
      GEMELLI_PERDENTI[t] = `per "${lavoro}" vince ${g.vince}: ${g.perche}`;
    }
  }

  const TOLTI_APPOSTA = {
    ...GEMELLI_PERDENTI,
    whatsapp_send: 'sostituito da whatsapp_scrivi: quello ha regole e verifica del destinatario',
    linkedin_send_message: 'sostituito da linkedin_scrivi',
    open_whatsapp: 'apriva solo la pagina, non scrive',
    open_linkedin: 'apriva solo la pagina, non scrive',
    prepare_whatsapp_message: 'la bozza non serve piu\': whatsapp_scrivi mostra e chiede',
    prepare_linkedin_message: 'come sopra',
  };

  const orfani = schemi.filter(n => !raggiungibili.has(n));
  const inattesi = orfani.filter(n => !TOLTI_APPOSTA[n]);
  ok(`i ${schemi.length} strumenti sono raggiungibili, tranne ${Object.keys(TOLTI_APPOSTA).length} tolti apposta`,
    inattesi.length === 0, 'irraggiungibili senza motivo scritto: ' + inattesi.join(', '));

  // Il verso opposto: se una di queste porte si riapre, i sette messaggi
  // fuori conteggio possono succedere di nuovo.
  for (const [t, perche] of Object.entries(TOLTI_APPOSTA)) {
    ok(`${t} resta fuori dagli ambiti — ${perche.slice(0, 46)}…`, !raggiungibili.has(t));
  }
}

// ── 5. I nomi negli ambiti esistono davvero ──
//
// Il verso opposto: un nome scritto male in TOOL_SCOPES non dà nessun errore,
// semplicemente non consegna niente.
{
  const inventati = [...raggiungibili].filter(n => !schemi.includes(n) && !conHandler.includes(n));
  ok('nessun ambito nomina strumenti inesistenti', inventati.length === 0,
    'nomi che non corrispondono a niente: ' + inventati.join(', '));
}

// ── 6. Gli strumenti che scrivono a una persona sono in "communicate" ──
//
// Questo è specifico e apposta: è il caso che ha fatto rispondere a COBRA
// "non posso mandare messaggi WhatsApp".
{
  for (const t of ['whatsapp_scrivi', 'linkedin_scrivi', 'conto_invii']) {
    ok(`${t} è raggiungibile`, raggiungibili.has(t));
  }
  ok('e stanno nell\'ambito "communicate"',
    ['whatsapp_scrivi', 'linkedin_scrivi'].every(t => (TOOL_SCOPES.communicate || []).includes(t)));
}

// ── 7. E l'incarico sa chiedere quell'ambito ──
//
// Anche con tutto a posto, se `ordineDiLavoro` non chiede mai "communicate"
// il filtro non consegna comunque niente. Era l'altra metà dello stesso guasto.
{
  const { ordineDiLavoro } = require('../modules/collega/comando');
  const chiede = (obiettivo) => ordineDiLavoro({ obiettivo, criteri: [] }).ambiti;

  ok('"manda un messaggio a Jose" chiede communicate',
    chiede('manda un messaggio WhatsApp a Jose: test cobra').includes('communicate'));
  ok('"rispondi a Brandon" chiede communicate',
    chiede('rispondi a Brandon su WhatsApp').includes('communicate'));
  ok('"scrivi su LinkedIn a Samuel" chiede communicate',
    chiede('scrivi su LinkedIn a Samuel Chen').includes('communicate'));

  // E NON deve chiederlo per un lavoro che non c'entra: un ambito in più
  // significa strumenti in più nel prompt, e strumenti in più significano
  // scelte sbagliate in più.
  ok('"confronta i prezzi dei fornitori" NON chiede communicate',
    !chiede('confronta i prezzi dei fornitori di trasporto').includes('communicate'));
  ok('"scrivi un report sui costi" NON chiede communicate',
    !chiede('scrivi un report sui costi del trimestre').includes('communicate'));
}

// ── 8. E le mani possono toccare quei siti ──
//
// Il quinto anello, quello che mi è costato più giri di tutti gli altri messi
// insieme. Lo strumento arrivava, il rischio era giusto, l'ambito c'era, il
// permesso pure — e COBRA continuava a dire "non posso inviare messaggi
// WhatsApp". Diceva la verità: il prompt gli ripete due volte "interazione DOM
// SOLO su domini whitelistati, gli altri SOLO lettura", e web.whatsapp.com non
// era nella lista. Aveva le mani legate su quel dominio, e lo sapeva.
//
// Uno strumento che può girare su un sito che non può toccare non serve a
// niente. Da qui in poi le due cose si controllano insieme.
{
  const { isDomainWhitelisted } = require('../modules/config/whitelist');
  ok('web.whatsapp.com è interagibile', isDomainWhitelisted('https://web.whatsapp.com/'));
  ok('linkedin.com è interagibile', isDomainWhitelisted('https://www.linkedin.com/messaging/'));
  // E il verso opposto: la lista deve restare una lista, non un "tutti".
  ok('un dominio qualsiasi resta in sola lettura',
    !isDomainWhitelisted('https://sito-a-caso.example.com/'));
}

// ── 9. Nessuno strumento deve chiedere un dato che la pagina non ha ──
//
// Il 7 agosto, a "apri la conversazione con Samuel Chen", COBRA ha risposto
// "non posso accedere ai messaggi di LinkedIn" senza nemmeno provare. Lo
// strumento c'era ed era raggiungibile: il suo SCHEMA pretendeva threadUrl,
// obbligatorio. Ma la messaggistica di LinkedIn non espone nessun indirizzo —
// verificato sulla pagina, zero link. Il modello leggeva "obbligatorio", non
// ce l'aveva, e concludeva giustamente di non potere.
//
// Uno strumento che chiede un dato inesistente e' peggio di uno strumento che
// manca: sembra esserci.
{
  const perNome = Object.fromEntries(COBRA_TOOLS.map(t => [t.function.name, t.function.parameters || {}]));
  const VIETATI = {
    linkedin_read_thread: ['threadUrl', 'url', 'profileUrl'],
    linkedin_scrivi: ['profileUrl'],
    whatsapp_read_thread: ['phone', 'numero'],
  };
  for (const [strumento, campi] of Object.entries(VIETATI)) {
    const req = (perNome[strumento] || {}).required || [];
    const brutti = req.filter(r => campi.includes(r));
    ok(`${strumento} non pretende dati che la pagina non espone`, brutti.length === 0,
      'obbligatori ma inesistenti: ' + brutti.join(', '));
  }
  ok('linkedin_read_thread chiede il nome', ((perNome.linkedin_read_thread || {}).required || []).includes('nome'));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  STRUMENTI RAGGIUNGIBILI: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
