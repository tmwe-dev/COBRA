// esterni/ponte.js — Far convivere due estensioni dentro una sola.
//
// DA DOVE VIENE QUESTA ROBA
//
// I file in esterni/wa/ e esterni/li/ sono COPIE IDENTICHE, byte per byte,
// delle estensioni che girano già nel Navigator:
//
//   esterni/wa/  ← public/whatsapp-extension/  (WCA WhatsApp Bridge 5.10.19)
//   esterni/li/  ← public/linkedin-extension/  (LinkedIn Cookie Sync 3.9.59)
//
// Non sono state riscritte e non vanno riscritte. Dentro c'è una cosa che non
// si ottiene ragionando: sapere quali selettori reggono davvero su WhatsApp Web
// e su LinkedIn. È conoscenza pagata con mesi di rotture — un selettore
// indovinato a tavolino vale zero su applicazioni che cambiano il DOM ogni due
// settimane.
//
// IL PROBLEMA DA RISOLVERE
//
// Le due estensioni chiamano i loro moduli con gli stessi nomi: tutte e due
// hanno un `Config`, un `TabManager`, un `Actions`. Scritte per vivere in due
// service worker separati, la collisione non esisteva. Qui vivono nello stesso,
// e importScripts condivide un solo spazio globale: la seconda che si carica
// troverebbe `globalThis.Config` già occupato e si terrebbe quello dell'altra.
//
// LA SOLUZIONE, E PERCHÉ QUESTA
//
// Si potevano rinominare i moduli file per file. Sarebbero state migliaia di
// righe toccate su codice che funziona — e la prossima volta che il Navigator
// aggiorna la sua estensione, il travaso andrebbe rifatto a mano.
//
// Invece: si caricano a gruppi, e dopo ogni gruppo si mette da parte quello che
// ha definito e si liberano i nomi. I file restano intatti, aggiornarli è
// ricopiarli.
//
// Ogni chiamata rimette in piedi i globali del suo gruppo. Siccome i moduli si
// cercano fra loro per nome globale al momento della chiamata (non del
// caricamento), due comandi che si intrecciassero si ruberebbero i moduli a
// vicenda: per questo passano tutti da una coda, uno alla volta.

// I nomi che i moduli copiati assegnano a globalThis. NON e' una lista di
// comodo: e' l'elenco esatto, e va tenuto esatto.
//
// L'ho gia' sbagliato due volte, e il modo in cui si e' manifestato merita di
// restare scritto. Avevo scritto "AiLearn" invece di "AILearn", e avevo
// dimenticato "Optimus" del tutto. Un nome che manca qui non da' nessun errore:
// semplicemente non viene liberato fra un gruppo e l'altro, quindi LinkedIn si
// ritrova l'Optimus di WhatsApp e lavora con quello. Cioe' esattamente il
// guasto che questo file esiste per impedire, in silenzio.
//
// Per questo tests/test-esterni.js ricava l'elenco leggendo i file e lo
// confronta con questo: un nome dimenticato deve rompere un test, non la
// produzione.
const _NOMI_CONDIVISI = [
  'Config', 'TabManager', 'Actions', 'AiBridge', 'Optimus', 'OptimusClient',
  'Discovery', 'AiExtract',                  // solo WhatsApp
  'AXTree', 'AILearn', 'Auth', 'HybridOps',  // solo LinkedIn
];

const _gruppi = {};

function _raccogli() {
  const preso = {};
  for (const n of _NOMI_CONDIVISI) {
    if (globalThis[n]) preso[n] = globalThis[n];
  }
  return preso;
}

function _liberaINomi() {
  // Non si può fare delete su una `var` globale, ma la si può svuotare: basta
  // a far scattare il `globalThis.X || (function(){...})()` del gruppo dopo.
  for (const n of _NOMI_CONDIVISI) {
    try { globalThis[n] = undefined; } catch (_) { /* non scrivibile: pazienza */ }
  }
}

let _caricato = false;
let _perche = null;   // perche' non si e' caricato: senza, si indovina

function caricaEsterni() {
  if (_caricato) return true;
  try {
    importScripts(
      'esterni/wa/config.js',
      'esterni/wa/tab-manager.js',
      'esterni/wa/discovery.js',
      'esterni/wa/ai-bridge.js',
      'esterni/wa/ai-extract.js',
      'esterni/wa/optimus-client.js',
      'esterni/wa/actions.js',
    );
    _gruppi.wa = _raccogli();
    _liberaINomi();

    importScripts(
      'esterni/li/config.js',
      'esterni/li/tab-manager.js',
      'esterni/li/ax-tree.js',
      'esterni/li/ai-bridge.js',
      'esterni/li/ai-learn.js',
      'esterni/li/auth.js',
      'esterni/li/hybrid-ops.js',
      'esterni/li/optimus-client.js',
      'esterni/li/actions.js',
    );
    _gruppi.li = _raccogli();
    _liberaINomi();

    _caricato = true;
    console.log('[COBRA] Moduli esterni pronti — WhatsApp:',
      Object.keys(_gruppi.wa).length, 'moduli, LinkedIn:', Object.keys(_gruppi.li).length);
    return true;
  } catch (e) {
    _perche = e.message;
    console.error('[COBRA] I moduli esterni non si caricano:', e.message);
    return false;
  }
}

// ── Adesso, non alla prima chiamata ──
//
// In MV3 importScripts si puo' usare SOLO mentre il service worker viene
// valutato la prima volta. Chiamarlo dopo — alla prima richiesta, che sarebbe
// stato piu' pulito — lo fa fallire con "not allowed", e il guasto arriva
// mascherato da "moduli non disponibili" quando il vero motivo e' il momento
// in cui si e' chiesto, non i file.
//
// Questo file viene importato in cima a background.js, quindi qui siamo dentro
// la valutazione iniziale: e' l'unico istante in cui e' concesso.
caricaEsterni();

// ── Svegliare le schede addormentate ──
//
// Chrome scarica dalla memoria le schede che non guardi da un po'. La scheda
// resta nell'elenco, con il suo indirizzo giusto e lo stato "unloaded", ma
// dentro non c'e' nessun documento.
//
// I moduli del Navigator scelgono la scheda per indirizzo e non guardano lo
// stato: pescano quella scaricata e chiedono di leggerla. Chrome risponde
//
//     "Cannot access contents of the page. Extension manifest must request
//      permission to access the respective host."
//
// che e' un messaggio pessimo, perche' parla di permessi mentre il permesso
// c'e': manca la pagina. Il 7 agosto ci ho perso mezz'ora a controllare
// manifest e impostazioni di Chrome, e la prova che il permesso fosse a posto
// e' arrivata solo leggendo la SECONDA scheda WhatsApp, quella viva.
//
// Non serve toccare i loro file: basta che, prima di chiamarli, non esistano
// piu' schede addormentate del sito che gli interessa.
const _DOMINI = { wa: /web\.whatsapp\.com/i, li: /linkedin\.com/i };

async function svegliaSchede(gruppo) {
  const dominio = _DOMINI[gruppo];
  if (!dominio) return;
  let schede;
  try { schede = await chrome.tabs.query({}); } catch (_) { return; }

  const dormienti = schede.filter(t => dominio.test(t.url || '') && t.status === 'unloaded');
  if (!dormienti.length) return;

  console.log(`[COBRA] Sveglio ${dormienti.length} scheda/e addormentate di ${gruppo}`);
  await Promise.all(dormienti.map(t => new Promise((fine) => {
    // reload() su una scheda scaricata la fa ricaricare davvero.
    try { chrome.tabs.reload(t.id); } catch (_) { return fine(); }
    const scaduta = setTimeout(() => { chrome.tabs.onUpdated.removeListener(guarda); fine(); }, 12000);
    function guarda(id, info) {
      if (id === t.id && info.status === 'complete') {
        clearTimeout(scaduta);
        chrome.tabs.onUpdated.removeListener(guarda);
        fine();
      }
    }
    chrome.tabs.onUpdated.addListener(guarda);
  })));

  // Le applicazioni disegnate in JavaScript non sono pronte quando la scheda
  // dice "complete": il documento c'e', il contenuto no.
  await new Promise(r => setTimeout(r, 2000));
}

// ── Il ritmo umano ──
//
// Caricato qui e non altrove perche' vale per OGNI comando dei due gruppi:
// mettere il controllo nel singolo comando significa dimenticarselo al
// prossimo che si aggiunge.
try { importScripts('esterni/ritmo.js'); }
catch (e) { console.error('[COBRA] ritmo.js non caricato:', e.message); }

// I selettori: dove sono le cose nella pagina, con i candidati di riserva e
// la diagnosi che dice quando l'interfaccia e' cambiata.
try { importScripts('esterni/selettori.js'); }
catch (e) { console.error('[COBRA] selettori.js non caricato:', e.message); }

// La mappa: impara dove sono le cose la prima volta, poi le ricorda. Quando
// una pagina cambia, il primo uso dopo il cambio riscopre e aggiorna.
try { importScripts('esterni/mappa.js'); }
catch (e) { console.error('[COBRA] mappa.js non caricato:', e.message); }

// Portarsi sulla pagina giusta: una sola funzione, per tutti i comandi.
// Lo sguardo: guardare la pagina e poterne nominare i pezzi. Va caricato dopo
// mappa e pagine perche' e' l'ultimo anello — ma non dipende da loro: se uno
// dei due manca, guardare funziona lo stesso.
// Il registro dei comandi, e chi ci si registra. Vanno caricati PRIMA di
// tutto il resto: background.js chiede al registro appena arriva un comando,
// e un registro vuoto significherebbe cadere nel vecchio switch senza motivo.
// I permessi del browser: PRIMA di tutto il resto, perche' una bolla di
// Chrome ferma la pagina e nessun comando piu' avanti la puo' togliere.
try { importScripts('esterni/permessi.js'); }
catch (e) { console.error('[COBRA] permessi.js non caricato:', e.message); }

try { importScripts('esterni/registro.js'); }
catch (e) { console.error('[COBRA] registro.js non caricato:', e.message); }

try { importScripts('esterni/sguardo.js'); }
catch (e) { console.error('[COBRA] sguardo.js non caricato:', e.message); }

try { importScripts('esterni/pagine.js'); }
catch (e) { console.error('[COBRA] pagine.js non caricato:', e.message); }

// ── Le aree dei comandi ──
//
// Vanno per ultime: usano Pagine, Mappa e Ritmo, che devono esserci gia'.
for (const area of ['pagina', 'moduli', 'schede', 'ostacoli', 'foto',
                    'whatsapp', 'linkedin', 'diagnosi']) {
  try { importScripts(`esterni/comandi/${area}.js`); }
  catch (e) { console.error(`[COBRA] comandi/${area}.js non caricato:`, e.message); }
}

// ── La coda ──
//
// Un comando alla volta. Non è pigrizia: mentre un comando di WhatsApp aspetta
// una risposta dalla pagina, i globali sono i suoi. Se nel frattempo partisse
// un comando di LinkedIn, glieli cambierebbe sotto.
let _coda = Promise.resolve();

function conModuliDi(gruppo, lavoro, modo = 'automatico') {
  const risultato = _coda.then(async () => {
    if (!caricaEsterni()) {
      throw new Error('moduli esterni non disponibili' + (_perche ? ': ' + _perche : ''));
    }
    const mod = _gruppi[gruppo];
    if (!mod) throw new Error(`gruppo "${gruppo}" sconosciuto`);

    // Prima di consegnare il lavoro ai moduli: niente schede addormentate.
    await svegliaSchede(gruppo);

    // E prima di toccare la pagina: si va al ritmo di una persona.
    //
    // Su LinkedIn questo e' il pezzo che conta piu' dei limiti di invio. Il
    // Navigator lo scrive nel suo stesso codice — "detection anti-bot piu'
    // aggressiva di WhatsApp" — e poi non lo applica da nessuna parte:
    // l'estensione che usano non ha un solo controllo di ritmo.
    if (globalThis.Ritmo) {
      const passo = await globalThis.Ritmo.chiedi(gruppo, gruppo === 'li' ? 'leggere' : 'veloce', modo);
      if (!passo.si) {
        const e = new Error(passo.motivo);
        e.ritmo = { motivo: passo.motivo, cosaFare: passo.cosaFare };
        throw e;
      }
      if (passo.aspetta > 0) {
        console.log(`[COBRA] Ritmo ${gruppo}: aspetto ${Math.round(passo.aspetta / 1000)}s`);
        await new Promise(r => setTimeout(r, passo.aspetta));
      }
    }

    for (const [n, v] of Object.entries(mod)) globalThis[n] = v;
    try {
      const esito = await lavoro(mod);
      // ── La traccia per il badge ──
      //
      // Ogni lavoro vero lascia detto com'e' andata. Cosi' il badge in alto
      // non deve andare a guardare: ricorda. E' la differenza fra una spia
      // che costa zero e una che ogni venti secondi va a bussare a una porta
      // per chiedere se c'e' qualcuno.
      await _ricorda(gruppo, esito);
      return esito;
    } finally {
      _liberaINomi();
    }
  });
  // La coda prosegue anche se questo comando è fallito.
  _coda = risultato.catch(() => {});
  return risultato;
}

/**
 * Si segna com'è andata l'ultima operazione vera su questo canale.
 *
 * Non è un log: è la memoria da cui il badge legge. Un badge che si fida di
 * quello che è successo davvero è più onesto di uno che va a controllare in
 * continuazione — e non lascia tracce su WhatsApp o LinkedIn.
 */
async function _ricorda(gruppo, esito) {
  try {
    const tutto = (await chrome.storage.local.get(['cobra_canali'])).cobra_canali || {};
    const e = esito || {};
    // Il segno che si era dentro: la funzione ha risposto qualcosa di sensato.
    const dentro = e.authenticated === true
      || e.ok === true
      || e.success === true
      || (Array.isArray(e.chat) && e.chat.length > 0);
    tutto[gruppo] = {
      quando: Date.now(),
      dentro: !!dentro,
      perche: dentro ? null : (e.reason === 'qr_required' ? 'chiede il QR'
        : e.motivo || e.error || 'l\'ultima operazione non è riuscita'),
    };
    await chrome.storage.local.set({ cobra_canali: tutto });
  } catch (_) { /* la memoria è un di più, non deve far fallire il lavoro */ }
}

/** Quali moduli sono in piedi — serve a dire la verità, non a indovinarla. */
function statoEsterni() {
  return {
    caricato: _caricato,
    perche: _perche,                  // il motivo vero, se non e' andata
    wa: Object.keys(_gruppi.wa || {}),
    li: Object.keys(_gruppi.li || {}),
  };
}

globalThis.Esterni = { carica: caricaEsterni, con: conModuliDi, stato: statoEsterni };
