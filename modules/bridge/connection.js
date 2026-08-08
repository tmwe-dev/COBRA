// Bridge - WebSocket Connection Management
let _bridgeSocket = null;
let _bridgeReady = false;
let _pendingBridgeRequests = new Map();
let _bridgeRequestId = 0;

function isBridgeReady() {
  return _bridgeReady && _bridgeSocket && _bridgeSocket.readyState === 1; // WebSocket.OPEN
}

// ── Quanto si aspetta, e perche' non e' uguale per tutti ──
//
// Quindici secondi bastano per leggere una pagina o cliccare un bottone. NON
// bastano per i comandi presi dalle estensioni del Navigator: `verifySession`
// di WhatsApp apre la scheda, la interroga tre volte a distanza crescente, e se
// e' in secondo piano la rende visibile un istante e ricomincia da capo. Sono
// venti secondi buoni quando va bene.
//
// Il 7 agosto e' successo esattamente questo: il comando era partito e stava
// lavorando, ma il ponte si e' arreso a 15,1 secondi. L'errore diceva "timeout",
// che suona come "non risponde" — mentre stava rispondendo, solo con calma.
//
// Un timeout unico va sempre male in un verso: o taglia i comandi lenti, o
// lascia appesi per un minuto quelli che sono morti davvero.
const _ATTESE = {
  whatsapp_sessione: 90000,
  whatsapp_non_letti: 120000,
  whatsapp_conversazione: 120000,
  whatsapp_scrivi: 120000,
  whatsapp_diagnosi: 90000,
  linkedin_profilo: 120000,
  linkedin_cerca: 120000,
  linkedin_posta: 120000,
  linkedin_conversazione: 120000,
  linkedin_scrivi: 120000,
  linkedin_diagnosi: 90000,
  compila_accesso: 60000,     // navigare + compilare + verificare l'esito

  // ── I comandi che si muovono come una persona ──
  //
  // Questi passano da Ritmo.comeUnaPersona: aspettano il proprio turno in
  // coda, fanno una pausa gaussiana, muovono il mouse su una traiettoria
  // curva e ogni tanto scorrono. E' esattamente quello che Luca ha chiesto —
  // "mai in serie, mai sovrapposte, simula il mouse" — e costa secondi.
  //
  // Con l'attesa normale di 15 secondi andavano regolarmente in timeout, e
  // l'errore diceva "non risponde" mentre stavano lavorando piano apposta.
  // Un limite che punisce il comportamento che si e' chiesto di avere e' un
  // limite scritto male.
  //
  // Il caso peggiore: coda + pausa (fino a ~10s con la coda della gaussiana)
  // + mouse (~1s) + scorrimento (~1,5s) + apertura conversazione (2,5s) +
  // digitazione a pezzi di un messaggio lungo (fino a ~40s). Novanta secondi
  // lasciano margine senza lasciare appeso per sempre un comando morto.
  linkedin_elenco_chat: 90000,
  linkedin_leggi_conversazione: 120000,
  linkedin_rispondi: 180000,        // qui dentro c'e' anche la scrittura lenta
  whatsapp_elenco_chat: 60000,
  whatsapp_leggi_conversazione: 120000,
  whatsapp_rispondi: 180000,        // apre la chat e scrive lentamente
  diagnosi_selettori: 60000,   // gira su due siti e campiona il DOM
  mappa_pagine: 20000,
  mappa_dimentica: 20000,
};
const _ATTESA_NORMALE = 15000;

function attesaPer(command) {
  return _ATTESE[command] || _ATTESA_NORMALE;
}

async function bridgeCommand(command, args = {}) {
  if (!isBridgeReady()) {
    throw new Error('Bridge not ready');
  }
  return new Promise((resolve, reject) => {
    const id = ++_bridgeRequestId;
    const quanto = attesaPer(command);
    const timeout = setTimeout(() => {
      _pendingBridgeRequests.delete(id);
      reject(new Error(`Bridge command timeout: ${command} (dopo ${quanto / 1000}s)`));
    }, quanto);

    _pendingBridgeRequests.set(id, { resolve, reject, timeout });
    // Protocollo atteso dall'estensione (cobra-extension/background.js): bridge_command
    _bridgeSocket.send(JSON.stringify({ type: 'bridge_command', id, command, args }));
  });
}

function setBridgeSocket(socket) {
  _bridgeSocket = socket;
  _bridgeReady = true;
}

function setBridgeReady(ready) {
  _bridgeReady = ready;
}

function getPendingBridgeRequests() {
  return _pendingBridgeRequests;
}

// ── Bridge Navigation (merged from navigate.js) ──
async function bridgeNavigate(url, wsBroadcast, log) {
  const navResult = await bridgeCommand('navigate', { url });
  if (!navResult.ok) return navResult;

  await new Promise(r => setTimeout(r, 2000));

  // Auto-dismiss cookie con retry
  let cookieResult = await bridgeCommand('dismiss_cookies');
  if (cookieResult?.action === 'no_banner') {
    await new Promise(r => setTimeout(r, 2000));
    cookieResult = await bridgeCommand('dismiss_cookies');
  }
  if (cookieResult?.action && cookieResult.action !== 'no_banner') {
    if (log) log(`[Cookie] Bridge dismiss: ${cookieResult.action} "${cookieResult.button || ''}"`);
    await new Promise(r => setTimeout(r, 500));
  }

  // Auto-dismiss overlay/splash
  const overlayResult = await bridgeCommand('dismiss_overlay');
  if (overlayResult?.action && overlayResult.action !== 'no_overlay') {
    if (log) log(`[Overlay] Bridge dismiss: ${overlayResult.action} "${overlayResult.button || ''}"`);
    await new Promise(r => setTimeout(r, 1000));
    const overlay2 = await bridgeCommand('dismiss_overlay');
    if (overlay2?.action && overlay2.action !== 'no_overlay') {
      if (log) log(`[Overlay] Bridge dismiss (2nd): ${overlay2.action} "${overlay2.button || ''}"`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Screenshot
  const ssResult = await bridgeCommand('screenshot', { quality: 70 });
  if (ssResult.ok && ssResult.screenshot && wsBroadcast) {
    wsBroadcast({ type: 'screenshot', data: ssResult.screenshot, url, title: '' });
  }

  const contentResult = await bridgeCommand('get_page_content');
  return { ok: true, url, screenshot: ssResult?.screenshot, content: contentResult };
}

module.exports = {
  isBridgeReady,
  bridgeCommand,
  attesaPer,
  bridgeNavigate,
  setBridgeSocket,
  setBridgeReady,
  getPendingBridgeRequests,
};
