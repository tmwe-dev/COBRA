/**
 * COBRA Bridge v2.0 — Browser Action Engine
 * ═══════════════════════════════════════════
 * Automazione browser completa a livello umano.
 *
 * MODULI:
 *   1. Browser Action Engine — click, type, key, scroll, drag, mouse, upload, download, clipboard, tabs
 *   2. Page Understanding  — DOM, Shadow DOM, iframe, forms, links, buttons, screenshot, selectors robusti
 *   3. Smart Wait Engine   — DOM ready, element visible/hidden, URL change, SPA content, network idle, download
 *   4. Human Takeover      — CAPTCHA/OTP/2FA detection, pause+notify, resume
 *   5. Audit & Recovery    — action log, screenshot, error recovery, retry, result verification
 *
 * Protocollo: WebSocket ↔ server COBRA
 *   server → { type:'bridge_command', id, command, args }
 *   ext    → { type:'bridge_result', id, result }
 */

// 127.0.0.1 e NON localhost: il server ascolta solo su IPv4, mentre su macOS
// "localhost" risolve prima in ::1 (IPv6). Verificato: http://::1:3000 non
// risponde. Chi passa da "localhost" dipende dal ripiego su IPv4 del browser,
// e quando quel ripiego tarda Chrome scrive un errore rosso sulla riga della
// WebSocket. Con l'indirizzo esplicito non c'e' ambiguita' da risolvere.
const COBRA_WS_URL = 'ws://127.0.0.1:3000';
const COBRA_API_URL = 'http://127.0.0.1:3000';
const VERSION = chrome.runtime.getManifest().version;
let ws = null;
let connected = false;
let _bridgeToken = null; // Auth token fetched from server

// P1-5: helper per richiedere permission opzionali prima dell'uso
async function ensurePermission(perm) {
  const has = await chrome.permissions.contains({ permissions: [perm] });
  if (has) return true;
  return chrome.permissions.request({ permissions: [perm] });
}
let _authRetryCount = 0; // Track auth retry attempts to prevent infinite loop

// ── Work Tab: tab separato per navigazione, MAI il tab di COBRA ──
let _workTabId = null;   // ID del tab di lavoro (booking.com, google, ecc.)
let _cobraTabId = null;  // ID del tab dove gira l'interfaccia COBRA (localhost:3000)


// Il tab di COBRA va riconosciuto sia che l'interfaccia sia aperta su
// localhost sia su 127.0.0.1: sono lo stesso posto, e scambiarlo per un tab
// di lavoro significa navigarci sopra e cancellare la chat sotto gli occhi.
function eIlTabDiCobra(url) {
  if (!url) return false;
  return url.includes('localhost:3000') || url.includes('127.0.0.1:3000');
}

// ── Action Log (Modulo 5) ──
const actionLog = [];
function logAction(command, args, result, durationMs) {
  const entry = { ts: Date.now(), command, args, ok: result?.ok, durationMs };
  if (!result?.ok) entry.error = result?.error;
  actionLog.push(entry);
  if (actionLog.length > 200) actionLog.shift();
}

// ══════════════════════════════════════════
//  WebSocket
// ══════════════════════════════════════════
async function fetchBridgeToken() {
  try {
    const resp = await fetch(`${COBRA_API_URL}/api/bridge-token`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    _bridgeToken = data.token;
    console.log('[COBRA Bridge] Auth token acquired');
    return true;
  } catch (e) {
    console.warn('[COBRA Bridge] Token fetch failed:', e.message);
    return false;
  }
}

let _tentativiConnessione = 0;

// Il server c'e'? Una domanda a cui si puo' rispondere PRIMA di aprire la
// WebSocket. Senza questo controllo un server spento produce un errore rosso
// non catturabile sulla riga "new WebSocket", che poi copre gli errori veri.
async function serverVivo() {
  try {
    const r = await fetch(`${COBRA_API_URL}/api/status`, { cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

function riprova() {
  _tentativiConnessione++;
  // Si riprova sempre, ma senza martellare: da 2s fino a 30s.
  const attesa = Math.min(2000 * _tentativiConnessione, 30000);
  setTimeout(connect, attesa);
}

async function connect() {
  if (ws && ws.readyState <= 1) return;
  if (!(await serverVivo())) {
    if (_tentativiConnessione === 0 || _tentativiConnessione % 10 === 0) {
      console.log(`[COBRA Bridge] Il server non risponde su ${COBRA_API_URL} — riprovo. Non è un errore dell'estensione: è COBRA spento o in riavvio.`);
    }
    updateBadge('OFF', '#ef4444');
    riprova();
    return;
  }
  try {
    ws = new WebSocket(COBRA_WS_URL);
    ws.onopen = async () => {
      connected = true;
      _tentativiConnessione = 0;
      console.log('[COBRA Bridge] Connesso a ' + COBRA_WS_URL);
      // Fetch auth token with retry
      for (let attempt = 0; attempt < 3 && !_bridgeToken; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500 * attempt));
        await fetchBridgeToken();
      }
      if (!_bridgeToken) {
        console.error('[COBRA Bridge] Cannot acquire auth token after 3 attempts');
        updateBadge('ERR', '#ef4444');
        return;
      }
      ws.send(JSON.stringify({ type: 'bridge_connect', token: _bridgeToken, userAgent: navigator.userAgent, version: VERSION }));
      // Badge e counter reset avvengono su bridge_auth_ok dal server
      // Registra il tab COBRA (localhost:3000) per non sovrascriverlo mai
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        for (const t of tabs) {
          if (eIlTabDiCobra(t.url)) {
            _cobraTabId = t.id;
            console.log('[COBRA Bridge] COBRA tab registered:', t.id);
            break;
          }
        }
      } catch {}
    };
    ws.onmessage = async (event) => {
      let msgId = null;
      try {
        const msg = JSON.parse(event.data);
        // Handle auth failure — retry with fresh token
        if (msg.type === 'bridge_auth_ok') {
          _authRetryCount = 0;
          console.log('[COBRA Bridge] Auth confirmed by server');
          updateBadge('ON', '#22c55e');
          return;
        }
        if (msg.type === 'bridge_auth_failed') {
          _authRetryCount = (_authRetryCount || 0) + 1;
          if (_authRetryCount > 3) {
            console.error('[COBRA Bridge] Auth failed 3+ times — stopping retry. Reload extension or restart server.');
            updateBadge('ERR', '#ef4444');
            return;
          }
          console.warn(`[COBRA Bridge] Auth rejected (attempt ${_authRetryCount}/3), refreshing token...`);
          _bridgeToken = null;
          updateBadge('AUTH', '#f59e0b');
          await new Promise(r => setTimeout(r, 1000 * _authRetryCount)); // backoff
          await fetchBridgeToken();
          if (_bridgeToken && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'bridge_connect', token: _bridgeToken, userAgent: navigator.userAgent, version: VERSION }));
          }
          return;
        }
        if (msg.type === 'bridge_command') {
          msgId = msg.id;
          const t0 = performance.now();
          const result = await executeCommand(msg.command, msg.args || {});
          const dur = Math.round(performance.now() - t0);
          logAction(msg.command, msg.args, result, dur);
          ws.send(JSON.stringify({ type: 'bridge_result', id: msg.id, result }));
        }
      } catch (e) {
        console.error('[COBRA Bridge] Error:', e);
        // CRITICAL: always send result back to server, even on error
        if (msgId && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'bridge_result', id: msgId, result: { ok: false, error: e.message || 'Extension error' } }));
        }
      }
    };
    ws.onclose = () => { connected = false; updateBadge('OFF', '#ef4444'); riprova(); };
    // Un errore di rete qui NON e' un guasto dell'estensione: e' il server
    // spento o in riavvio. Si chiude e si riprova, senza allarmare.
    ws.onerror = () => { try { ws.close(); } catch (_) { /* gia' chiusa */ } };
  } catch (e) {
    console.log('[COBRA Bridge] Connessione non riuscita: ' + (e && e.message) + ' — riprovo');
    riprova();
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ══════════════════════════════════════════
//  Helpers base
// ══════════════════════════════════════════
async function getActiveTab() {
  // Anche qui si legge l'identificativo persistito: dopo un risveglio del
  // service worker la variabile in memoria è vuota, ma la scheda esiste ancora.
  const salvato = await recuperaWorkTab();
  if (salvato) {
    try {
      const tab = await chrome.tabs.get(salvato);
      if (tab) { _workTabId = salvato; return tab; }
    } catch {
      // Scheda chiusa: si dimentica
      _workTabId = null;
    }
  }
  // Fallback: tab attivo, ma MAI il tab di COBRA
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  // Se il tab attivo è COBRA, non usarlo per navigazione
  if (eIlTabDiCobra(tab.url)) {
    _cobraTabId = tab.id;
  }
  return tab;
}

// Ottieni o crea un work tab separato da COBRA
// L'identificativo della scheda di lavoro va conservato fuori dalle variabili
// del service worker: Chrome lo sospende dopo pochi secondi di inattività e al
// risveglio le variabili sono azzerate. Senza persistenza COBRA dimenticava la
// propria scheda e ne apriva una nuova ad ogni risveglio.
async function ricordaWorkTab(tabId) {
  _workTabId = tabId;
  try { await chrome.storage.session.set({ cobraWorkTabId: tabId }); }
  catch { try { await chrome.storage.local.set({ cobraWorkTabId: tabId }); } catch { /* senza persistenza si degrada */ } }
}

async function recuperaWorkTab() {
  if (_workTabId) return _workTabId;
  try {
    const s = await chrome.storage.session.get('cobraWorkTabId');
    if (s?.cobraWorkTabId) return s.cobraWorkTabId;
  } catch { /* storage.session non disponibile */ }
  try {
    const l = await chrome.storage.local.get('cobraWorkTabId');
    if (l?.cobraWorkTabId) return l.cobraWorkTabId;
  } catch { /* nessuna persistenza */ }
  return null;
}

async function getWorkTab() {
  // Individua la scheda di COBRA, che non va mai usata come scheda di lavoro
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (eIlTabDiCobra(t.url)) { _cobraTabId = t.id; break; }
    }
  } catch { /* impossibile elencare le schede */ }

  // 1. La scheda già in uso, anche dopo un risveglio del service worker
  const salvato = await recuperaWorkTab();
  if (salvato && salvato !== _cobraTabId) {
    try {
      const tab = await chrome.tabs.get(salvato);
      if (tab) { _workTabId = salvato; return tab; }
    } catch { _workTabId = null; }
  }

  // 2. Una scheda vuota già aperta, invece di crearne un'altra
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (t.id === _cobraTabId) continue;
      if (t.url === 'about:blank' || t.url === 'chrome://newtab/') {
        await ricordaWorkTab(t.id);
        console.log('[COBRA Bridge] Riuso scheda vuota:', t.id);
        return t;
      }
    }
  } catch { /* impossibile elencare le schede */ }

  // 3. Si crea una finestra dedicata, in secondo piano.
  //    Serve una finestra propria: per fotografare una pagina Chrome richiede
  //    che sia la scheda attiva della sua finestra. Da sola in una finestra
  //    separata lo è sempre, senza mai interferire con quella dell'utente.
  try {
    const win = await chrome.windows.create({
      url: 'about:blank', focused: false, type: 'normal', width: 1280, height: 900,
    });
    const tab = win.tabs && win.tabs[0];
    if (tab) {
      await ricordaWorkTab(tab.id);
      console.log('[COBRA Bridge] Creata finestra di lavoro dedicata:', tab.id);
      return tab;
    }
  } catch (e) {
    console.log('[COBRA Bridge] Finestra dedicata non creata:', e.message);
  }

  // 4. Se la finestra non si può creare, si ripiega su una scheda normale
  const newTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await ricordaWorkTab(newTab.id);
  console.log('[COBRA Bridge] Creata scheda di lavoro:', newTab.id);
  return newTab;
}

function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeout);
  });
}

// Chrome serializza la funzione e la esegue nel contesto della pagina: le
// variabili del service worker (RESOLVE_CODE, MOUSE_CODE) NON sopravvivono
// all'iniezione. Molti comandi le usano, quindi vanno ricreate nello scope
// della pagina prima di invocare la funzione.
function eseguiNellaPagina(sorgente, resolveCode, mouseCode, argomenti) {
  globalThis.RESOLVE_CODE = resolveCode;
  globalThis.MOUSE_CODE = mouseCode;
  const fn = (0, eval)('(' + sorgente + ')');
  return fn(...argomenti);
}

/**
 * Cattura la pagina tramite il protocollo di ispezione di Chrome.
 * A differenza della cattura diretta funziona anche quando la finestra non è
 * visibile, perché chiede al motore di disegnare la pagina invece di leggere
 * quello che c'è sullo schermo.
 */
// Nessuna delle chiamate di cattura promette di rispondere. chrome.debugger.attach
// resta appeso a tempo indeterminato se la scheda ha già un debugger collegato o
// se l'utente ha aperto gli strumenti di sviluppo; captureVisibleTab fa lo stesso
// su una finestra che Chrome ha smesso di disegnare. Senza un tetto, il gestore
// non risponde mai e il server aspetta invano: nel monitor non compare nulla e
// non si capisce perché. Un limite di tempo trasforma un blocco muto in un
// errore leggibile.
function conLimite(promessa, ms, cosa) {
  return Promise.race([
    promessa,
    new Promise((_, rifiuta) => setTimeout(() => rifiuta(new Error(`${cosa} non ha risposto entro ${ms}ms`)), ms)),
  ]);
}

// L'altezza massima di una cattura intera. Una pagina di 40.000 pixel
// produrrebbe un'immagine che nessuno guarda e che intasa il ponte: dopo
// 6.000 si taglia, dicendolo.
const ALTEZZA_MASSIMA_CATTURA = 6000;


// ══════════════════════════════════════════
//  IL CURSORE DI COBRA
// ══════════════════════════════════════════
//
// Luca, 6 agosto 2026: "non si vede il mouse di cobra muoversi e fare gli
// aggiornamenti. deve esserci un mouse visibile che mostra il movimento
// durante la navigazione".
//
// Aveva ragione e il motivo è più che estetico: senza cursore, guardando
// l'anteprima non si distingue una pagina su cui COBRA sta lavorando da una
// pagina ferma, e non si capisce MAI su cosa abbia cliccato. Quando poi il
// click va sul bottone sbagliato — è successo col banner dei cookie — non
// c'è modo di accorgersene se non dal risultato finale.
//
// Il cursore è un elemento disegnato dentro la pagina, quindi entra nella
// fotografia: quello che vedi nell'anteprima è dove COBRA ha davvero messo
// le mani. Si muove con una transizione, così il movimento si vede anche
// fra due scatti; e quando clicca lascia un cerchio che si allarga.
//
// Vive in un contenitore isolato (shadow DOM) per non ereditare il CSS del
// sito, e non intercetta i click (pointer-events: none): è un disegno, non
// un ostacolo.
function disegnaCursore(x, y, azione) {
  const ID = '__cobra_cursore__';
  let ospite = document.getElementById(ID);
  if (!ospite) {
    ospite = document.createElement('div');
    ospite.id = ID;
    ospite.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    (document.body || document.documentElement).appendChild(ospite);
    const radice = ospite.attachShadow({ mode: 'open' });
    radice.innerHTML = `
      <style>
        .punta { position:fixed; width:26px; height:26px; margin:-3px 0 0 -3px;
                 transition: left .45s cubic-bezier(.22,.61,.36,1), top .45s cubic-bezier(.22,.61,.36,1);
                 pointer-events:none; will-change:left,top; }
        .punta svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.5)); }
        .etichetta { position:fixed; transform:translate(20px,18px); background:#7c3aed; color:#fff;
                     font:600 11px/1.5 -apple-system,system-ui,sans-serif; padding:2px 8px;
                     border-radius:10px; white-space:nowrap; pointer-events:none;
                     transition: left .45s cubic-bezier(.22,.61,.36,1), top .45s cubic-bezier(.22,.61,.36,1); }
        .onda { position:fixed; width:14px; height:14px; margin:-7px 0 0 -7px; border-radius:50%;
                border:2px solid #7c3aed; pointer-events:none; animation: cresci .6s ease-out forwards; }
        @keyframes cresci { from { transform:scale(.3); opacity:1 } to { transform:scale(3.4); opacity:0 } }
      </style>
      <div class="punta" id="p">
        <svg viewBox="0 0 24 24" width="26" height="26">
          <path d="M5 2 L5 20 L10 15.5 L13 22 L16 20.5 L13 14.5 L19.5 14 Z"
                fill="#7c3aed" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="etichetta" id="e"></div>`;
    ospite._radice = radice;
  }
  // Si usa il riferimento tenuto da parte, non la proprietà shadowRoot: è lo
  // stesso oggetto, ma non dipende da come il contenitore è stato aperto.
  const radice = ospite._radice || ospite.shadowRoot;
  if (!radice) return { ok: false };
  const punta = radice.getElementById('p');
  const etichetta = radice.getElementById('e');
  punta.style.left = x + 'px';
  punta.style.top = y + 'px';
  etichetta.style.left = x + 'px';
  etichetta.style.top = y + 'px';
  etichetta.textContent = azione || '';
  etichetta.style.display = azione ? 'block' : 'none';

  if (azione === 'clic') {
    const onda = document.createElement('div');
    onda.className = 'onda';
    onda.style.left = x + 'px';
    onda.style.top = y + 'px';
    radice.appendChild(onda);
    setTimeout(() => { try { onda.remove(); } catch (_) { /* già andata */ } }, 700);
  }
  return { ok: true, x, y };
}

// Porta il cursore sopra un elemento e lascia il tempo di vederlo arrivare.
// L'attesa non è un vezzo: senza, la fotografia successiva coglie il cursore
// ancora al punto di partenza e il movimento non si vede.
async function muoviCursoreSu(tabId, selettore, azione) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sel, disegna, atto) => {
        const trova = (s) => {
          try { return document.querySelector(s); } catch (_) { /* selettore non valido */ }
          return null;
        };
        const el = trova(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        // eslint-disable-next-line no-new-func
        return new Function('return ' + disegna)()(r.left + r.width / 2, r.top + r.height / 2, atto);
      },
      args: [String(selettore || ''), disegnaCursore.toString(), azione || ''],
    });
    await new Promise(r => setTimeout(r, 500));   // il tempo della transizione
  } catch (_) { /* il cursore è un di più: non deve mai fermare il lavoro */ }
}

async function catturaConIspettore(tabId, qualita = 70, intera = true) {
  const bersaglio = { tabId };
  let collegato = false;
  try {
    await conLimite(chrome.debugger.attach(bersaglio, '1.3'), 3000, 'collegamento ispettore');
    collegato = true;

    // ── La pagina intera, non solo la piega ──
    //
    // Con captureBeyondViewport:false si fotografava soltanto la parte
    // visibile: nel monitor la pagina finiva a metà e sotto restava il nero.
    // Chiedendo le misure del documento e passandole come ritaglio, il motore
    // disegna anche quello che sta sotto il bordo dello schermo — è la stessa
    // cosa che fa Chrome con "cattura schermata a pagina intera".
    let ritaglio = null;
    if (intera) {
      try {
        const misure = await conLimite(
          chrome.debugger.sendCommand(bersaglio, 'Page.getLayoutMetrics', {}), 3000, 'misure pagina');
        const c = misure?.cssContentSize || misure?.contentSize;
        if (c && c.width > 0 && c.height > 0) {
          ritaglio = {
            x: 0, y: 0,
            width: Math.min(c.width, 2000),
            height: Math.min(c.height, ALTEZZA_MASSIMA_CATTURA),
            scale: 1,
          };
        }
      } catch { /* senza misure si ripiega sulla piega, meglio che niente */ }
    }

    const risposta = await conLimite(
      chrome.debugger.sendCommand(bersaglio, 'Page.captureScreenshot', {
        format: 'jpeg', quality: qualita,
        captureBeyondViewport: !!ritaglio,
        ...(ritaglio ? { clip: ritaglio } : {}),
      }), 9000, 'cattura ispettore');
    return risposta?.data || null;
  } finally {
    if (collegato) { try { await chrome.debugger.detach(bersaglio); } catch { /* già staccato */ } }
  }
}

// Il ponte serve SOLO alle funzioni che usano gli helper: ricostruirle richiede
// eval, che molti siti (Google compreso) vietano tramite CSP. Le funzioni che
// non ne hanno bisogno — fra cui tutte le letture di contenuto — vengono
// iniettate direttamente, senza eval, e funzionano ovunque.
function parametriIniezione(func, args) {
  const sorgente = func.toString();
  const usaHelper = sorgente.includes('RESOLVE_CODE') || sorgente.includes('MOUSE_CODE');
  return usaHelper
    ? { func: eseguiNellaPagina, args: [sorgente, RESOLVE_CODE, MOUSE_CODE, args] }
    : { func, args };
}

async function run(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    ...parametriIniezione(func, args),
    world: 'MAIN',
  });
  return results[0]?.result ?? { ok: false, error: 'No result' };
}

async function runIsolated(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    ...parametriIniezione(func, args),
  });
  return results[0]?.result ?? { ok: false, error: 'No result' };
}

async function runInFrame(tabId, frameId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    ...parametriIniezione(func, args),
    world: 'MAIN',
  });
  return results[0]?.result ?? { ok: false, error: 'No result' };
}

// Broadcast event to server for monitor
function notify(eventType, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'bridge_event', event: eventType, ...data }));
}

// ══════════════════════════════════════════
//  SELETTORE ROBUSTO (Modulo 2)
//  Supporta: CSS, XPath, text:, aria:, placeholder:, role:, coord:x,y
// ══════════════════════════════════════════
function resolveElementCode() {
  return `
    const cssEsc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s) => s.replace(/([^\\w-])/g, '\\\\$1');
    function resolveElement(sel) {
      if (!sel) return document.activeElement || document.body;
      // CSS selector (con escape per ID con caratteri speciali)
      if (!sel.includes(':') || sel.startsWith('#') || sel.startsWith('.') || sel.startsWith('[')) {
        try { const el = document.querySelector(sel); if (el) return el; } catch {}
        // Retry con escape se il selettore ha # e fallisce
        if (sel.startsWith('#')) {
          try { const el = document.getElementById(sel.slice(1)); if (el) return el; } catch {}
        }
      }
      const [prefix, ...rest] = sel.split(':');
      const val = rest.join(':').trim();
      switch (prefix) {
        case 'text': {
          const lower = val.toLowerCase();
          for (const el of document.querySelectorAll('a, button, input[type="submit"], [role="button"], label, span, div, li, td, th, h1, h2, h3, h4, p')) {
            if ((el.textContent || '').trim().toLowerCase().includes(lower) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) return el;
          }
          // Shadow DOM search
          const found = searchShadowDOM(document, lower);
          if (found) return found;
          return null;
        }
        case 'aria': {
          // Match fuzzy case-insensitive su aria-label, placeholder, title
          const ariaLower = val.toLowerCase().trim();
          // 1. Exact match
          const exact = document.querySelector('[aria-label="' + val + '"]');
          if (exact) { const _r = exact.getBoundingClientRect(); if (_r.width >= 2 && _r.height >= 2) return exact; }
          // La visibilità si misura dallo spazio occupato, non da offsetParent:
          // quello è nullo per TUTTI gli elementi position:fixed, e usarlo come
          // prova di invisibilità rendeva invisibili a COBRA le intestazioni
          // fisse, i modali, i pulsanti flottanti e i banner dei cookie — cioè
          // buona parte di quello che su un sito moderno si deve cliccare.
          // 2. Fuzzy: cerca su tutti gli elementi interattivi + custom components
          const candidates = document.querySelectorAll('input, textarea, button, select, [role="combobox"], [role="textbox"], [role="button"], [role="listbox"], [role="searchbox"], [contenteditable="true"], [aria-label], [placeholder], [title]');
          for (const el of candidates) {
            { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            const ph = (el.getAttribute('placeholder') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            if (label.includes(ariaLower) || ph.includes(ariaLower) || title.includes(ariaLower)) return el;
          }
          // 3. Cerca per aria-labelledby (risolvi l'id referenziato)
          for (const el of document.querySelectorAll('[aria-labelledby]')) {
            const refId = el.getAttribute('aria-labelledby');
            const refEl = document.getElementById(refId);
            if (refEl && (refEl.textContent || '').toLowerCase().includes(ariaLower)) return el;
          }
          return null;
        }
        case 'placeholder': {
          return document.querySelector('[placeholder="' + val + '"]') || document.querySelector('[placeholder*="' + val + '"]');
        }
        case 'role': {
          const lower = val.toLowerCase();
          for (const el of document.querySelectorAll('[role="' + lower + '"]')) {
            if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) return el;
          }
          return null;
        }
        case 'xpath': {
          const result = document.evaluate(val, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return result.singleNodeValue;
        }
        case 'coord': {
          const [x, y] = val.split(',').map(Number);
          return document.elementFromPoint(x, y);
        }
        case 'near': {
          // near:label text — trova campo vicino a una label
          const lower = val.toLowerCase();
          for (const lbl of document.querySelectorAll('label')) {
            if (lbl.textContent.trim().toLowerCase().includes(lower)) {
              if (lbl.htmlFor) { const el = document.getElementById(lbl.htmlFor); if (el) return el; }
              const input = lbl.querySelector('input, select, textarea');
              if (input) return input;
              const next = lbl.nextElementSibling;
              if (next && (next.matches('input, select, textarea'))) return next;
            }
          }
          return null;
        }
        default: {
          // Prova come CSS
          try { return document.querySelector(sel); } catch { return null; }
        }
      }
    }

    function searchShadowDOM(root, textLower) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        if (node.shadowRoot) {
          // Cerca dentro Shadow DOM
          for (const el of node.shadowRoot.querySelectorAll('*')) {
            if ((el.textContent || '').trim().toLowerCase().includes(textLower) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) return el;
          }
          const deep = searchShadowDOM(node.shadowRoot, textLower);
          if (deep) return deep;
        }
      }
      return null;
    }

    function queryShadow(root, selector) {
      // Cerca selector anche dentro Shadow DOM
      let found = root.querySelector(selector);
      if (found) return found;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        if (node.shadowRoot) {
          found = node.shadowRoot.querySelector(selector);
          if (found) return found;
          found = queryShadow(node.shadowRoot, selector);
          if (found) return found;
        }
      }
      return null;
    }

    function queryShadowAll(root, selector) {
      const results = [...root.querySelectorAll(selector)];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        if (node.shadowRoot) {
          results.push(...node.shadowRoot.querySelectorAll(selector));
          results.push(...queryShadowAll(node.shadowRoot, selector));
        }
      }
      return results;
    }
  `;
}

// ══════════════════════════════════════════
//  MOUSE REALISTICO (Modulo 1)
//  Genera sequenza completa di eventi: pointermove, mousemove, pointerdown, mousedown, pointerup, mouseup, click
// ══════════════════════════════════════════
function realisticMouseCode() {
  return `
    function simulateMouseEvent(el, type, opts = {}) {
      const rect = el.getBoundingClientRect();
      const x = opts.clientX ?? (rect.left + rect.width / 2);
      const y = opts.clientY ?? (rect.top + rect.height / 2);
      const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y,
        screenX: x + window.screenX, screenY: y + window.screenY, button: opts.button ?? 0, buttons: opts.buttons ?? 1,
        ctrlKey: opts.ctrlKey || false, shiftKey: opts.shiftKey || false, altKey: opts.altKey || false, metaKey: opts.metaKey || false };
      if (type.startsWith('pointer')) {
        el.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse' }));
      } else {
        el.dispatchEvent(new MouseEvent(type, base));
      }
    }

    function realisticClick(el, opts = {}) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const o = { ...opts, clientX: cx, clientY: cy };
      simulateMouseEvent(el, 'pointerover', o);
      simulateMouseEvent(el, 'mouseover', o);
      simulateMouseEvent(el, 'pointerenter', o);
      simulateMouseEvent(el, 'mouseenter', o);
      simulateMouseEvent(el, 'pointermove', o);
      simulateMouseEvent(el, 'mousemove', o);
      simulateMouseEvent(el, 'pointerdown', o);
      simulateMouseEvent(el, 'mousedown', o);
      el.focus && el.focus();
      simulateMouseEvent(el, 'pointerup', o);
      simulateMouseEvent(el, 'mouseup', o);
      simulateMouseEvent(el, 'click', o);
    }

    function realisticDblClick(el) {
      realisticClick(el);
      realisticClick(el);
      const rect = el.getBoundingClientRect();
      simulateMouseEvent(el, 'dblclick', { clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 });
    }

    function realisticRightClick(el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const rect = el.getBoundingClientRect();
      const o = { clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, button: 2, buttons: 2 };
      simulateMouseEvent(el, 'pointerdown', o);
      simulateMouseEvent(el, 'mousedown', o);
      simulateMouseEvent(el, 'pointerup', o);
      simulateMouseEvent(el, 'mouseup', o);
      simulateMouseEvent(el, 'contextmenu', o);
    }

    function simulateHover(el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const rect = el.getBoundingClientRect();
      const o = { clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 };
      simulateMouseEvent(el, 'pointerover', o);
      simulateMouseEvent(el, 'mouseover', o);
      simulateMouseEvent(el, 'pointerenter', o);
      simulateMouseEvent(el, 'mouseenter', o);
      simulateMouseEvent(el, 'pointermove', o);
      simulateMouseEvent(el, 'mousemove', o);
    }

    function simulateDrag(fromEl, toEl) {
      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();
      const startX = fromRect.left + fromRect.width/2, startY = fromRect.top + fromRect.height/2;
      const endX = toRect.left + toRect.width/2, endY = toRect.top + toRect.height/2;

      // DragEvent sequence
      fromEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, clientX: startX, clientY: startY }));
      toEl.dispatchEvent(new DragEvent('dragenter', { bubbles: true, clientX: endX, clientY: endY }));
      toEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, clientX: endX, clientY: endY }));
      toEl.dispatchEvent(new DragEvent('drop', { bubbles: true, clientX: endX, clientY: endY }));
      fromEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: endX, clientY: endY }));
    }
  `;
}

// ══════════════════════════════════════════
//  COMMAND EXECUTOR
// ══════════════════════════════════════════
async function executeCommand(command, args) {
  try {
    switch (command) {

      // ════════════════════════════════════════
      // 1. NAVIGAZIONE
      // ════════════════════════════════════════

      case 'navigate': {
        // MAI navigare sul tab di COBRA — usa un work tab separato
        const tab = await getWorkTab();

        // Se il work tab è nella stessa finestra di COBRA, spostalo in una finestra separata
        if (_cobraTabId) {
          try {
            const cobraTab = await chrome.tabs.get(_cobraTabId);
            if (cobraTab && tab.windowId === cobraTab.windowId) {
              const currentWindow = await chrome.windows.get(cobraTab.windowId);
              const screenW = currentWindow.width || 1440;
              const screenH = currentWindow.height || 900;
              const popW = Math.round(screenW * 0.55);
              const popH = Math.round(screenH * 0.90);
              const popX = Math.round(screenW * 0.42);
              const popY = 30;
              await chrome.windows.create({
                tabId: tab.id,
                type: 'normal',
                width: popW,
                height: popH,
                left: popX,
                top: popY,
                focused: true
              });
              try { await chrome.tabs.setZoom(tab.id, 0.80); } catch {}
            }
          } catch (e) {
            log('[Navigate] Popup window: ' + e.message);
          }
        }

        // La scheda resta in secondo piano: l'utente segue tutto dal monitor di
        // COBRA e non si vede rubare il fuoco ad ogni pagina aperta.
        await chrome.tabs.update(tab.id, { url: args.url, active: false });
        await ricordaWorkTab(tab.id);
        await waitForTabLoad(tab.id);

        // Auto-dismiss browser permission prompts (geolocation, notifications, etc.)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              // Override Permission API to auto-deny
              if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition = (s, e) => { if (e) e({ code: 1, message: 'COBRA: auto-denied' }); };
                navigator.geolocation.watchPosition = (s, e) => { if (e) e({ code: 1, message: 'COBRA: auto-denied' }); return 0; };
              }
              if (window.Notification && Notification.permission !== 'granted') {
                window.Notification.requestPermission = () => Promise.resolve('denied');
              }
              // Dismiss visible permission/consent dialogs in DOM
              const dismissTexts = ['non consentire', 'deny', 'block', 'rifiuta', 'no thanks', 'no grazie', 'dismiss', 'chiudi', 'non ora', 'not now', 'maybe later'];
              document.querySelectorAll('button, a[role="button"], [class*="dismiss"], [class*="deny"], [class*="close"]').forEach(el => {
                const txt = (el.textContent || '').trim().toLowerCase();
                if (txt.length < 40 && dismissTexts.some(d => txt.includes(d))) {
                  try { el.click(); } catch {}
                }
              });
            }
          });
        } catch (e) { log('[Navigate] Permission dismiss: ' + e.message); }

        return { ok: true, url: args.url, tabId: tab.id };
      }

      case 'go_back': {
        const tab = await getWorkTab();
        await chrome.tabs.goBack(tab.id);
        await waitForTabLoad(tab.id);
        return { ok: true };
      }

      case 'go_forward': {
        const tab = await getWorkTab();
        await chrome.tabs.goForward(tab.id);
        await waitForTabLoad(tab.id);
        return { ok: true };
      }

      case 'reload': {
        const tab = await getWorkTab();
        await chrome.tabs.reload(tab.id);
        await waitForTabLoad(tab.id);
        return { ok: true };
      }

      case 'get_url': {
        const tab = await getWorkTab();
        return { ok: true, url: tab.url, title: tab.title };
      }

      // ════════════════════════════════════════
      // 2. SCREENSHOT
      // ════════════════════════════════════════

      case 'screenshot': {
        // Chrome fotografa solo la scheda ATTIVA di una finestra. La scheda di
        // lavoro sta in una finestra propria, quindi renderla attiva lì non
        // disturba l'utente: la sua finestra non viene mai toccata.
        let windowId = null;
        const idScheda = await recuperaWorkTab();
        if (idScheda) {
          try {
            const wTab = await chrome.tabs.get(idScheda);
            windowId = wTab.windowId;
            if (!wTab.active) await chrome.tabs.update(idScheda, { active: true });
            // La finestra non va mai portata in primo piano: ruberebbe il fuoco
            await new Promise(r => setTimeout(r, 200));
          } catch { windowId = null; }
        }
        // Prima via: cattura diretta. Veloce, ma Chrome smette di disegnare le
        // finestre completamente coperte e restituisce "image readback failed".
        const motivi = [];
        // ── Prima l'ispettore, perché è l'unico che vede la pagina INTERA ──
        //
        // Prima veniva provata per prima la cattura diretta, più veloce. Ma
        // quella fotografa solo ciò che sta a schermo: nel monitor la pagina
        // finiva a metà e sotto restava il nero, e nessuna delle due vie
        // avrebbe mai mostrato il resto. Meglio qualche decimo di secondo in
        // più e vedere il documento per intero.
        if (idScheda && chrome.debugger) {
          try {
            const immagine = await catturaConIspettore(idScheda, args.quality || 70, true);
            if (immagine) return { ok: true, screenshot: immagine, via: 'ispettore (pagina intera)' };
            motivi.push('ispettore: nessuna immagine restituita');
          } catch (e) {
            motivi.push(`ispettore: ${e.message}`);
          }
        } else {
          motivi.push(chrome.debugger ? 'scheda di lavoro non trovata' : 'ispettore non disponibile');
        }

        // Ripiego: la cattura diretta. Vede solo la piega, ma una mezza
        // immagine è meglio di nessuna immagine.
        try {
          const dataUrl = await conLimite(
            chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: args.quality || 70 }),
            4000, 'cattura diretta');
          if (dataUrl) return { ok: true, screenshot: dataUrl.split(',')[1], via: 'cattura diretta (solo la parte visibile)' };
          motivi.push('cattura diretta: nessuna immagine restituita');
        } catch (e) {
          motivi.push(`cattura diretta: ${e.message}`);
          console.log('[COBRA Bridge] Cattura diretta non riuscita:', e.message);
        }
        // Si risponde SEMPRE, anche per dire di non essere riusciti: un errore
        // esplicito si legge nel registro, un'attesa infinita no.
        return { ok: false, error: `Nessuna immagine catturata — ${motivi.join(' | ')}` };
      }

      // ════════════════════════════════════════
      // 3. CLICK — realistico con sequenza eventi completa
      // ════════════════════════════════════════

      // Il cursore su richiesta: serve al server per mostrare dove sta
      // guardando anche quando non clicca niente — una lettura, un'attesa,
      // uno scorrimento. Senza, l'anteprima di una pagina su cui si sta
      // lavorando è identica a quella di una pagina ferma.
      case 'mostra_cursore': {
        const tab = await getWorkTab();
        if (args.selettore) {
          await muoviCursoreSu(tab.id, args.selettore, args.azione || '');
          return { ok: true, dove: args.selettore };
        }
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: (disegna, x, y, atto) => {
            // eslint-disable-next-line no-new-func
            return new Function('return ' + disegna)()(x, y, atto);
          },
          args: [disegnaCursore.toString(), Number(args.x) || 40, Number(args.y) || 40, args.azione || ''],
        });
        await new Promise(r => setTimeout(r, 450));
        return { ok: true, x: args.x, y: args.y };
      }

      case 'click': {
        const tab = await getWorkTab();
        // Il cursore arriva prima del click: così nella fotografia si vede
        // DOVE COBRA ha messo le mani, non solo cosa è successo dopo.
        await muoviCursoreSu(tab.id, args.selector, 'clic');
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Element not found: ' + sel };
          realisticClick(el);
          // CRITICAL: el.click() nativo come fallback — genera evento trusted che bypassa isTrusted check (Google, etc.)
          try { if (typeof el.click === 'function') el.click(); } catch {}
          return { ok: true, clicked: el.tagName + (el.textContent?.trim().substring(0, 40) || '') };
        }, [args.selector]);
      }

      case 'double_click': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          realisticDblClick(el);
          return { ok: true };
        }, [args.selector]);
      }

      case 'right_click': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          realisticRightClick(el);
          return { ok: true };
        }, [args.selector]);
      }

      case 'click_coord': {
        const tab = await getWorkTab();
        return await run(tab.id, (x, y) => {
          eval(MOUSE_CODE);
          const el = document.elementFromPoint(x, y);
          if (!el) return { ok: false, error: `Nothing at ${x},${y}` };
          realisticClick(el);
          try { if (typeof el.click === 'function') el.click(); } catch {}
          return { ok: true, element: el.tagName, text: el.textContent?.trim().substring(0, 40) };
        }, [args.x, args.y]);
      }

      // ════════════════════════════════════════
      // 4. HOVER
      // ════════════════════════════════════════

      case 'hover': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          simulateHover(el);
          return { ok: true };
        }, [args.selector]);
      }

      // ════════════════════════════════════════
      // 5. DRAG & DROP
      // ════════════════════════════════════════

      case 'drag_drop': {
        const tab = await getWorkTab();
        return await run(tab.id, (fromSel, toSel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const from = resolveElement(fromSel);
          const to = resolveElement(toSel);
          if (!from) return { ok: false, error: 'From not found' };
          if (!to) return { ok: false, error: 'To not found' };
          simulateDrag(from, to);
          return { ok: true };
        }, [args.from, args.to]);
      }

      // ════════════════════════════════════════
      // 6. SCROLL — progressivo, per elemento, per coordinate
      // ════════════════════════════════════════

      case 'scroll': {
        const tab = await getWorkTab();
        return await run(tab.id, (dir, amount, sel, smooth) => {
          eval(RESOLVE_CODE);
          const target = sel ? resolveElement(sel) : window;
          const behavior = smooth ? 'smooth' : 'auto';
          const px = amount || 500;
          const opts = dir === 'up' ? { top: -px, behavior } :
                       dir === 'down' ? { top: px, behavior } :
                       dir === 'left' ? { left: -px, behavior } :
                       { left: px, behavior };
          if (target === window) window.scrollBy(opts);
          else target.scrollBy(opts);
          return { ok: true, scrolled: dir, amount: px };
        }, [args.direction || 'down', args.amount || 500, args.selector || null, args.smooth !== false]);
      }

      case 'scroll_to_element': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { ok: true };
        }, [args.selector]);
      }

      // ════════════════════════════════════════
      // 7. TASTIERA COMPLETA
      // ════════════════════════════════════════

      // Type istantaneo (setValue + react events)
      case 'type': {
        try {
          const t = await getWorkTab();
          await muoviCursoreSu(t.id, args.selector, 'scrivo');
        } catch (_) { /* il cursore non deve mai bloccare la scrittura */ }
        const tab = await getWorkTab();
        return await run(tab.id, (text, sel, clear) => {
          eval(RESOLVE_CODE);
          const el = sel ? resolveElement(sel) : (document.activeElement || document.body);
          if (!el) return { ok: false, error: 'No element' };
          el.focus();
          // Supporto contenteditable
          if (el.isContentEditable || el.contentEditable === 'true') {
            if (clear) el.innerHTML = '';
            // Usa execCommand per compatibilità con rich editors (Gmail, Notion, etc.)
            document.execCommand('insertText', false, text);
            return { ok: true, method: 'contenteditable' };
          }
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (clear) { if (nativeSetter) nativeSetter.call(el, ''); else el.value = ''; }
          if (nativeSetter) nativeSetter.call(el, (clear ? '' : el.value) + text);
          else el.value = (clear ? '' : el.value) + text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, method: 'value' };
        }, [args.text, args.selector || null, args.clear === true]);
      }

      // Type realistico char-by-char con delay gaussiano
      // Fix: doppia strategia — eventi sintetici + value setter nativo per siti con isTrusted check
      case 'type_human': {
        const tab = await getWorkTab();
        return await run(tab.id, async (text, sel, avgDelay, clear) => {
          eval(RESOLVE_CODE);
          const el = sel ? resolveElement(sel) : (document.activeElement || document.body);
          if (!el) return { ok: false, error: 'No element' };
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.focus();
          el.dispatchEvent(new Event('focus', { bubbles: true }));

          const isContentEditable = el.isContentEditable || el.contentEditable === 'true';
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

          if (!isContentEditable) {
            if (clear) { if (setter) setter.call(el, ''); else el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
          } else if (clear) {
            el.innerHTML = '';
          }

          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const u1 = Math.random(), u2 = Math.random();
            const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const delay = Math.max(20, Math.round(avgDelay + gauss * (avgDelay / 3)));
            await new Promise(r => setTimeout(r, delay));

            el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: ch.length === 1 ? 'Key' + ch.toUpperCase() : ch, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));

            if (isContentEditable) {
              document.execCommand('insertText', false, ch);
            } else {
              // Strategia doppia: setter nativo (React/Angular) + value diretto (vanilla)
              if (setter) setter.call(el, el.value + ch);
              else el.value += ch;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));

          // Verifica: se il valore non è cambiato (isTrusted rejection), forza con setter completo
          if (!isContentEditable && el.value !== text && !el.value.endsWith(text)) {
            if (setter) setter.call(el, clear ? text : (el.value || '') + text);
            else el.value = clear ? text : (el.value || '') + text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, typed: text.length, method: 'forced_setter' };
          }
          return { ok: true, typed: text.length, method: isContentEditable ? 'contenteditable_human' : 'human' };
        }, [args.text, args.selector || null, args.delay || 80, args.clear === true]);
      }

      // Singolo tasto (Enter, Tab, Escape, Backspace, frecce, F1-F12)
      case 'press_key': {
        const tab = await getWorkTab();
        return await run(tab.id, (key, repeat) => {
          const keyMap = {
            enter:'Enter', tab:'Tab', escape:'Escape', esc:'Escape', backspace:'Backspace',
            delete:'Delete', space:' ', arrowup:'ArrowUp', arrowdown:'ArrowDown',
            arrowleft:'ArrowLeft', arrowright:'ArrowRight', home:'Home', end:'End',
            pageup:'PageUp', pagedown:'PageDown',
            f1:'F1', f2:'F2', f3:'F3', f4:'F4', f5:'F5', f6:'F6', f7:'F7', f8:'F8', f9:'F9', f10:'F10', f11:'F11', f12:'F12'
          };
          const mapped = keyMap[key.toLowerCase()] || key;
          const target = document.activeElement || document.body;
          for (let i = 0; i < (repeat || 1); i++) {
            const prevented = !target.dispatchEvent(new KeyboardEvent('keydown', { key: mapped, code: mapped, bubbles: true, cancelable: true }));
            if (!prevented && mapped === 'Tab') {
              // Simula cambio focus
              const focusable = [...document.querySelectorAll('input, select, textarea, button, a[href], [tabindex]')]
                .filter(e => ((e.getBoundingClientRect().width || 0) >= 2 && (e.getBoundingClientRect().height || 0) >= 2) && !e.disabled);
              const idx = focusable.indexOf(target);
              if (idx >= 0 && idx < focusable.length - 1) focusable[idx + 1].focus();
            }
            target.dispatchEvent(new KeyboardEvent('keyup', { key: mapped, code: mapped, bubbles: true }));
          }
          return { ok: true, key: mapped, repeat: repeat || 1 };
        }, [args.key, args.repeat || 1]);
      }

      // Combo tastiera (Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z, Shift+Enter, etc.)
      case 'key_combo': {
        const tab = await getWorkTab();
        return await run(tab.id, (combo) => {
          const parts = combo.toLowerCase().split('+').map(s => s.trim());
          const mod = {
            ctrl: parts.includes('ctrl') || parts.includes('control'),
            shift: parts.includes('shift'),
            alt: parts.includes('alt') || parts.includes('option'),
            meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('command'),
          };
          const keyPart = parts.filter(p => !['ctrl','control','shift','alt','option','meta','cmd','command'].includes(p))[0] || '';
          const keyMap = { enter:'Enter', tab:'Tab', escape:'Escape', backspace:'Backspace', delete:'Delete', space:' ', arrowup:'ArrowUp', arrowdown:'ArrowDown', arrowleft:'ArrowLeft', arrowright:'ArrowRight' };
          const key = keyMap[keyPart] || keyPart;
          const target = document.activeElement || document.body;

          target.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), bubbles: true, cancelable: true,
            ctrlKey: mod.ctrl, shiftKey: mod.shift, altKey: mod.alt, metaKey: mod.meta }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key, code: 'Key' + key.toUpperCase(), bubbles: true,
            ctrlKey: mod.ctrl, shiftKey: mod.shift, altKey: mod.alt, metaKey: mod.meta }));

          // Azioni native per combo comuni
          if ((mod.ctrl || mod.meta) && key === 'a') {
            if (target.select) target.select();
            else document.execCommand('selectAll');
            return { ok: true, action: 'select_all' };
          }
          if ((mod.ctrl || mod.meta) && key === 'c') { document.execCommand('copy'); return { ok: true, action: 'copy' }; }
          if ((mod.ctrl || mod.meta) && key === 'v') { document.execCommand('paste'); return { ok: true, action: 'paste' }; }
          if ((mod.ctrl || mod.meta) && key === 'x') { document.execCommand('cut'); return { ok: true, action: 'cut' }; }
          if ((mod.ctrl || mod.meta) && key === 'z') { document.execCommand('undo'); return { ok: true, action: 'undo' }; }
          if ((mod.ctrl || mod.meta) && mod.shift && key === 'z') { document.execCommand('redo'); return { ok: true, action: 'redo' }; }
          return { ok: true, combo };
        }, [args.combo]);
      }

      // Selezione testo
      case 'select_text': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel, start, end) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          if (el.setSelectionRange) {
            el.focus();
            el.setSelectionRange(start || 0, end || el.value.length);
            return { ok: true, selected: el.value.substring(start || 0, end || el.value.length) };
          }
          // Per contenteditable o testo generico
          const range = document.createRange();
          const textNode = el.firstChild;
          if (textNode) {
            range.setStart(textNode, start || 0);
            range.setEnd(textNode, end || textNode.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return { ok: true, selected: selection.toString() };
          }
          return { ok: false, error: 'No text content' };
        }, [args.selector, args.start, args.end]);
      }

      // Focus management
      case 'focus': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          el.focus();
          el.dispatchEvent(new Event('focus', { bubbles: true }));
          return { ok: true, element: el.tagName };
        }, [args.selector]);
      }

      // ════════════════════════════════════════
      // 8. FORM — compilazione avanzata
      // ════════════════════════════════════════

      case 'fill_form': {
        const tab = await getWorkTab();
        const fields = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields;
        // Fill sequenziale con supporto componenti custom (combobox, popup, ecc.)
        const results = [];
        for (const [sel, value] of Object.entries(fields)) {
          try {
            const fieldResult = await run(tab.id, (sel, value) => {
              eval(RESOLVE_CODE);
              eval(MOUSE_CODE);

              function nativeSet(target, val) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                  || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (setter) setter.call(target, val);
                else target.value = val;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
              }

              const el = resolveElement(sel);
              if (!el) return { selector: sel, ok: false, error: 'Not found' };
              el.scrollIntoView({ block: 'center', behavior: 'smooth' });

              // Determina se è un campo standard o un componente custom
              const tag = el.tagName?.toLowerCase();
              const role = (el.getAttribute('role') || '').toLowerCase();
              const isStandardInput = (tag === 'input' || tag === 'textarea') && !role;
              const isSelect = tag === 'select';
              const isCheckbox = el.type === 'checkbox' || el.type === 'radio';
              const isDate = el.type === 'date' || el.type === 'datetime-local' || el.type === 'time';
              const isEditable = el.isContentEditable || el.contentEditable === 'true';
              const isCustom = role === 'combobox' || role === 'textbox' || role === 'searchbox' || role === 'listbox' || (!isStandardInput && !isSelect && !isCheckbox && !isDate && !isEditable);

              realisticClick(el);

              if (isSelect) {
                let found = false;
                for (const opt of el.options) {
                  if (opt.value === value || opt.textContent.trim() === value) {
                    opt.selected = true; found = true; break;
                  }
                }
                if (!found) return { selector: sel, ok: false, error: 'Option not found: ' + value };
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { selector: sel, ok: true, value, method: 'select' };
              }
              if (isCheckbox) {
                if (String(value) === 'true' && !el.checked) el.click();
                if (String(value) === 'false' && el.checked) el.click();
                return { selector: sel, ok: true, value, method: 'checkbox' };
              }
              if (isDate) {
                nativeSet(el, value);
                return { selector: sel, ok: true, value, method: 'date' };
              }
              if (isEditable) {
                el.innerHTML = '';
                document.execCommand('insertText', false, value);
                return { selector: sel, ok: true, value, method: 'contenteditable' };
              }
              if (isStandardInput) {
                nativeSet(el, value);
                return { selector: sel, ok: true, value, method: 'native' };
              }
              // CUSTOM COMPONENT: click ha già aperto il popup — marca per fase 2
              return { selector: sel, ok: false, custom: true, method: 'needs_active_input' };
            }, [sel, value]);

            // Fase 2: componente custom — aspetta popup, cerca input attivo, scrivi lì
            if (fieldResult && fieldResult.custom) {
              await new Promise(r => setTimeout(r, 500)); // aspetta popup/dropdown
              const phase2 = await run(tab.id, (value) => {
                function nativeSet(target, val) {
                  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                    || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                  if (setter) setter.call(target, val);
                  else target.value = val;
                  target.dispatchEvent(new Event('input', { bubbles: true }));
                  target.dispatchEvent(new Event('change', { bubbles: true }));
                }
                // Strategia 1: activeElement è un input/textarea
                const active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
                  nativeSet(active, value);
                  return { ok: true, method: 'active_element', tag: active.tagName };
                }
                // Strategia 2: contentEditable attivo
                if (active && (active.isContentEditable || active.contentEditable === 'true')) {
                  active.innerHTML = '';
                  document.execCommand('insertText', false, value);
                  return { ok: true, method: 'active_contenteditable' };
                }
                // Strategia 3: trova ultimo input visibile apparso (popup/dialog)
                const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]'))
                  .filter(n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; });
                if (inputs.length > 0) {
                  const target = inputs[inputs.length - 1]; // ultimo apparso
                  target.focus();
                  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                    nativeSet(target, value);
                  } else {
                    target.innerHTML = '';
                    document.execCommand('insertText', false, value);
                  }
                  return { ok: true, method: 'last_visible_input', tag: target.tagName };
                }
                return { ok: false, error: 'No active/visible input after click' };
              }, [value]);
              results.push({ selector: sel, ...phase2, value });
            } else {
              results.push(fieldResult);
            }
          } catch (e) {
            results.push({ selector: sel, ok: false, error: e.message });
          }
        }
        return { ok: results.every(r => r.ok), results };
      }

      // Submit form
      case 'submit_form': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const form = sel ? resolveElement(sel) : document.querySelector('form');
          if (!form) return { ok: false, error: 'No form found' };
          // Cerca submit button
          const submit = form.querySelector('button[type="submit"], input[type="submit"]');
          if (submit) { submit.click(); return { ok: true, method: 'button_click' }; }
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.submit();
          return { ok: true, method: 'form_submit' };
        }, [args.selector || null]);
      }

      // ════════════════════════════════════════
      // 9. DATEPICKER / DROPDOWN COMPLESSI
      // ════════════════════════════════════════

      case 'set_datepicker': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel, value) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };

          // Strategy 1: input[type=date] nativo
          if (el.type === 'date' || el.type === 'datetime-local') {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, method: 'native_date' };
          }

          // Strategy 2: React/MUI datepicker — click + type
          realisticClick(el);
          el.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return { ok: true, method: 'type_date' };
        }, [args.selector, args.value]);
      }

      case 'select_dropdown': {
        const tab = await getWorkTab();
        return await run(tab.id, async (sel, value, searchable) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };

          // Native select
          if (el.tagName === 'SELECT') {
            for (const opt of el.options) {
              if (opt.value === value || opt.textContent.trim().toLowerCase().includes(value.toLowerCase())) {
                opt.selected = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, method: 'native_select', selected: opt.textContent.trim() };
              }
            }
            return { ok: false, error: 'Option not found' };
          }

          // Custom dropdown (React Select, MUI, etc.): click to open
          realisticClick(el);
          await new Promise(r => setTimeout(r, 300));

          // Se searchable, digita il valore
          if (searchable) {
            const input = el.querySelector('input') || document.activeElement;
            if (input && (input.tagName === 'INPUT' || input.isContentEditable)) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (setter) setter.call(input, value);
              else input.value = value;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
            }
          }

          // Cerca opzione visibile con testo corrispondente
          const lower = value.toLowerCase();
          const options = document.querySelectorAll('[role="option"], [role="listbox"] > *, .option, li[data-value], .select-option, [class*="option"]');
          for (const opt of options) {
            if (opt.textContent.trim().toLowerCase().includes(lower) && ((opt.getBoundingClientRect().width || 0) >= 2 && (opt.getBoundingClientRect().height || 0) >= 2)) {
              realisticClick(opt);
              return { ok: true, method: 'custom_dropdown', selected: opt.textContent.trim() };
            }
          }
          return { ok: false, error: 'Option not found in dropdown: ' + value };
        }, [args.selector, args.value, args.searchable || false]);
      }

      // ════════════════════════════════════════
      // 10. FILE UPLOAD
      // ════════════════════════════════════════

      case 'file_upload': {
        const tab = await getWorkTab();
        // Per input[type=file] serve un approccio speciale
        // Il file deve essere passato come base64 o URL dal server
        return await runIsolated(tab.id, (sel, fileName, fileType, fileDataB64) => {
          const el = sel ? document.querySelector(sel) : document.querySelector('input[type="file"]');
          if (!el) return { ok: false, error: 'No file input found' };

          // Converti base64 in File
          const byteStr = atob(fileDataB64);
          const bytes = new Uint8Array(byteStr.length);
          for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
          const file = new File([bytes], fileName, { type: fileType || 'application/octet-stream' });

          const dt = new DataTransfer();
          dt.items.add(file);
          el.files = dt.files;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true, fileName, size: file.size };
        }, [args.selector || null, args.fileName || 'file.pdf', args.fileType || 'application/pdf', args.fileData || '']);
      }

      // Drag & drop file upload
      case 'file_drop': {
        const tab = await getWorkTab();
        return await runIsolated(tab.id, (sel, fileName, fileType, fileDataB64) => {
          const el = sel ? document.querySelector(sel) : document.querySelector('[class*="drop"], [class*="upload"], [data-testid*="drop"]');
          if (!el) return { ok: false, error: 'No drop zone found' };

          const byteStr = atob(fileDataB64);
          const bytes = new Uint8Array(byteStr.length);
          for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
          const file = new File([bytes], fileName, { type: fileType || 'application/octet-stream' });

          const dt = new DataTransfer();
          dt.items.add(file);
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

          el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
          el.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
          el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
          return { ok: true, fileName, size: file.size, method: 'drag_drop' };
        }, [args.selector || null, args.fileName || 'file.pdf', args.fileType || 'application/pdf', args.fileData || '']);
      }

      // ════════════════════════════════════════
      // 11. DOWNLOAD
      // ════════════════════════════════════════

      case 'download_file': {
        if (!await ensurePermission('downloads')) return { ok: false, error: 'Downloads permission denied by user' };
        const downloadId = await chrome.downloads.download({ url: args.url, filename: args.filename || undefined });
        return { ok: true, downloadId };
      }

      case 'download_status': {
        if (!await ensurePermission('downloads')) return { ok: false, error: 'Downloads permission denied by user' };
        const [item] = await chrome.downloads.search({ id: args.downloadId });
        if (!item) return { ok: false, error: 'Download not found' };
        return { ok: true, state: item.state, filename: item.filename, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes };
      }

      // ════════════════════════════════════════
      // 12. CLIPBOARD
      // ════════════════════════════════════════

      case 'clipboard_read': {
        const tab = await getWorkTab();
        return await run(tab.id, async () => {
          try {
            const text = await navigator.clipboard.readText();
            return { ok: true, text };
          } catch (e) {
            return { ok: false, error: 'Clipboard read failed: ' + e.message };
          }
        });
      }

      case 'clipboard_write': {
        const tab = await getWorkTab();
        return await run(tab.id, async (text) => {
          try {
            await navigator.clipboard.writeText(text);
            return { ok: true };
          } catch (e) {
            // Fallback: textarea + execCommand
            const t = document.createElement('textarea');
            t.value = text;
            document.body.appendChild(t);
            t.select();
            document.execCommand('copy');
            t.remove();
            return { ok: true, method: 'fallback' };
          }
        }, [args.text]);
      }

      // ════════════════════════════════════════
      // 13. MULTI-TAB & POPUP
      // ════════════════════════════════════════

      case 'open_tab': {
        const tab = await chrome.tabs.create({ url: args.url || 'about:blank', active: args.active !== false });
        if (args.url && args.url !== 'about:blank') await waitForTabLoad(tab.id);
        return { ok: true, tabId: tab.id, url: tab.url };
      }

      case 'switch_tab': {
        if (args.tabId) {
          await chrome.tabs.update(args.tabId, { active: true });
          return { ok: true, tabId: args.tabId };
        }
        if (args.index !== undefined) {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const target = tabs[args.index];
          if (!target) return { ok: false, error: `Tab index ${args.index} not found` };
          await chrome.tabs.update(target.id, { active: true });
          return { ok: true, tabId: target.id };
        }
        if (args.urlContains) {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const target = tabs.find(t => t.url.includes(args.urlContains));
          if (!target) return { ok: false, error: `No tab with URL containing "${args.urlContains}"` };
          await chrome.tabs.update(target.id, { active: true });
          return { ok: true, tabId: target.id, url: target.url };
        }
        return { ok: false, error: 'Specify tabId, index, or urlContains' };
      }

      case 'close_tab': {
        const tabId = args.tabId || (await getWorkTab()).id;
        await chrome.tabs.remove(tabId);
        return { ok: true, closed: tabId };
      }

      case 'list_tabs': {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        return { ok: true, tabs: tabs.map((t, i) => ({ index: i, id: t.id, url: t.url, title: t.title, active: t.active })) };
      }

      // ════════════════════════════════════════
      // 14. IFRAME + SHADOW DOM (Modulo 2)
      // ════════════════════════════════════════

      case 'iframe_list': {
        const tab = await getWorkTab();
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        return { ok: true, frames: frames.map(f => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId })) };
      }

      case 'iframe_execute': {
        const tab = await getWorkTab();
        let frameId = args.frameId;
        if (frameId === undefined && args.urlPattern) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          const match = frames.find(f => f.url.includes(args.urlPattern));
          if (!match) return { ok: false, error: `No iframe matching "${args.urlPattern}"` };
          frameId = match.frameId;
        }
        if (frameId === undefined) return { ok: false, error: 'Specify frameId or urlPattern' };
        return await runInFrame(tab.id, frameId, (code) => {
          try { return { ok: true, result: eval(code) }; } catch (e) { return { ok: false, error: e.message }; }
        }, [args.code]);
      }

      case 'iframe_click': {
        const tab = await getWorkTab();
        let frameId = args.frameId;
        if (frameId === undefined && args.urlPattern) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          const match = frames.find(f => f.url.includes(args.urlPattern));
          if (!match) return { ok: false, error: 'Frame not found' };
          frameId = match.frameId;
        }
        return await runInFrame(tab.id, frameId, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Element not found in iframe' };
          realisticClick(el);
          return { ok: true, clicked: el.textContent?.trim().substring(0, 40) };
        }, [args.selector]);
      }

      case 'iframe_type': {
        const tab = await getWorkTab();
        let frameId = args.frameId;
        if (frameId === undefined && args.urlPattern) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          const match = frames.find(f => f.url.includes(args.urlPattern));
          if (!match) return { ok: false, error: 'Frame not found' };
          frameId = match.frameId;
        }
        return await runInFrame(tab.id, frameId, (sel, text) => {
          const el = sel ? document.querySelector(sel) : document.activeElement;
          if (!el) return { ok: false, error: 'Not found' };
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }, [args.selector, args.text]);
      }

      // Shadow DOM query
      case 'shadow_query': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const els = queryShadowAll(document, sel);
          return { ok: true, count: els.length, elements: els.slice(0, 20).map(el => ({
            tag: el.tagName.toLowerCase(), text: el.textContent?.trim().substring(0, 60),
            id: el.id || '', className: el.className || '',
            visible: ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) })) };
        }, [args.selector]);
      }

      case 'shadow_click': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = queryShadow(document, sel);
          if (!el) return { ok: false, error: 'Not found in Shadow DOM' };
          realisticClick(el);
          return { ok: true };
        }, [args.selector]);
      }

      // ════════════════════════════════════════
      // 15. DIALOG — alert, confirm, prompt, beforeunload
      // ════════════════════════════════════════

      case 'handle_dialog': {
        const tab = await getWorkTab();
        return await run(tab.id, (action, promptText, duration) => {
          const origAlert = window.alert;
          const origConfirm = window.confirm;
          const origPrompt = window.prompt;
          let captured = null;

          window.alert = (msg) => { captured = { type: 'alert', message: msg }; };
          window.confirm = (msg) => { captured = { type: 'confirm', message: msg }; return action === 'accept'; };
          window.prompt = (msg, def) => { captured = { type: 'prompt', message: msg }; return action === 'accept' ? (promptText || def || '') : null; };

          // beforeunload handler
          const unloadHandler = (e) => { if (action === 'accept') { e.preventDefault(); delete e.returnValue; } };
          window.addEventListener('beforeunload', unloadHandler);

          setTimeout(() => {
            window.alert = origAlert;
            window.confirm = origConfirm;
            window.prompt = origPrompt;
            window.removeEventListener('beforeunload', unloadHandler);
          }, duration || 10000);

          return { ok: true, action, duration: duration || 10000, interceptors: ['alert', 'confirm', 'prompt', 'beforeunload'] };
        }, [args.action || 'accept', args.promptText || '', args.duration || 10000]);
      }

      // ════════════════════════════════════════
      // 16. SMART WAIT (Modulo 3)
      // ════════════════════════════════════════

      case 'wait_for': {
        const tab = await getWorkTab();
        const timeout = args.timeout || 10000;
        return await run(tab.id, async (sel, timeout, condition) => {
          eval(RESOLVE_CODE);
          const start = Date.now();
          while (Date.now() - start < timeout) {
            switch (condition) {
              case 'hidden': {
                const el = resolveElement(sel);
                if (!el) return { ok: true, waited: Date.now() - start, state: 'hidden' };
                { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) return { ok: true, waited: Date.now() - start, state: 'hidden' }; }
                break;
              }
              case 'text': {
                const el = resolveElement(sel);
                if (el && el.textContent.trim().length > 0) return { ok: true, waited: Date.now() - start, text: el.textContent.trim().substring(0, 100) };
                break;
              }
              case 'text_contains': {
                const el = resolveElement(sel);
                if (el && el.textContent.toLowerCase().includes((condition === 'text_contains' ? sel : '').toLowerCase())) {
                  return { ok: true, waited: Date.now() - start };
                }
                break;
              }
              case 'clickable': {
                const el = resolveElement(sel);
                if (el && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) && !el.disabled) return { ok: true, waited: Date.now() - start };
                break;
              }
              default: {
                // visible
                const el = resolveElement(sel);
                if (el && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) return { ok: true, waited: Date.now() - start, state: 'visible' };
              }
            }
            await new Promise(r => setTimeout(r, 200));
          }
          return { ok: false, error: 'Timeout', waited: timeout };
        }, [args.selector, timeout, args.condition || 'visible']);
      }

      // Attendi cambio URL
      case 'wait_url_change': {
        const tab = await getWorkTab();
        const startUrl = tab.url;
        const timeout = args.timeout || 15000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          await new Promise(r => setTimeout(r, 300));
          const current = await getWorkTab();
          if (current.url !== startUrl) return { ok: true, oldUrl: startUrl, newUrl: current.url, waited: Date.now() - start };
        }
        return { ok: false, error: 'URL did not change', waited: timeout };
      }

      // Attendi network idle (nessuna richiesta per N ms)
      case 'wait_network_idle': {
        const tab = await getWorkTab();
        return await run(tab.id, async (idleMs, timeout) => {
          const start = Date.now();
          let lastActivity = Date.now();
          const origFetch = window.fetch;
          const origXHR = XMLHttpRequest.prototype.open;

          window.fetch = function(...a) { lastActivity = Date.now(); return origFetch.apply(this, a); };
          XMLHttpRequest.prototype.open = function(...a) { lastActivity = Date.now(); return origXHR.apply(this, a); };

          while (Date.now() - start < timeout) {
            if (Date.now() - lastActivity >= idleMs) {
              window.fetch = origFetch;
              XMLHttpRequest.prototype.open = origXHR;
              return { ok: true, waited: Date.now() - start };
            }
            await new Promise(r => setTimeout(r, 100));
          }
          window.fetch = origFetch;
          XMLHttpRequest.prototype.open = origXHR;
          return { ok: false, error: 'Network not idle', waited: timeout };
        }, [args.idleMs || 1000, args.timeout || 15000]);
      }

      // Attendi download completato
      case 'wait_download': {
        const timeout = args.timeout || 30000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const [item] = await chrome.downloads.search({ id: args.downloadId });
          if (item && item.state === 'complete') return { ok: true, filename: item.filename, size: item.totalBytes };
          if (item && item.state === 'interrupted') return { ok: false, error: 'Download failed', reason: item.error };
          await new Promise(r => setTimeout(r, 500));
        }
        return { ok: false, error: 'Download timeout' };
      }

      // ════════════════════════════════════════
      // 17. PAGE UNDERSTANDING (Modulo 2)
      // ════════════════════════════════════════

      // ════════════════════════════════════════
      // STATO DELLA PAGINA — si chiede, non si indovina
      // ════════════════════════════════════════
      //
      // Contare i secondi e' indovinare. Una pagina sa dire da sola se ha
      // finito di caricare, se sta ancora scaricando dati, e se c'e' qualcosa
      // che copre il contenuto. Questi sono fatti, non stime.
      //
      // Un ostacolo si riconosce da COSA FA, non da come si chiama: un
      // elemento che sta davanti a tutto, copre mezzo schermo e blocca lo
      // scorrimento e' un ostacolo, che sia un banner cookie, una newsletter,
      // un invito a scaricare l'app o un avviso di eta'.
      case 'stato_pagina': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
          const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
          const areaSchermo = Math.max(vw * vh, 1);

          // Un ostacolo e' qualcosa che sta sopra e copre. Si guarda la
          // posizione, non il nome della classe.
          const ostacoli = [];
          const visti = new Set();
          for (const el of document.querySelectorAll('div,section,aside,dialog,iframe')) {
            if (visti.has(el)) continue;
            let st;
            try { st = getComputedStyle(el); } catch (_) { continue; }
            const fisso = st.position === 'fixed' || st.position === 'sticky';
            const modale = el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG';
            if (!fisso && !modale) continue;
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') < 0.05) continue;
            const r = el.getBoundingClientRect();
            const copertura = (r.width * r.height) / areaSchermo;
            if (copertura < 0.12) continue;                 // troppo piccolo per bloccare
            if (r.bottom < 0 || r.top > vh) continue;       // fuori schermo
            const z = parseInt(st.zIndex, 10) || 0;
            // Le barre di navigazione sono fisse ma non bloccano: si distingue
            // per la copertura e per la presenza di pulsanti di chiusura.
            const testo = (el.innerText || '').trim().substring(0, 200);
            ostacoli.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || '', classe: String(el.className || '').substring(0, 60),
              copertura: Math.round(copertura * 100), z,
              modale, testo,
            });
            visti.add(el);
          }

          // Lo scorrimento bloccato e' il segno piu' affidabile di un modale
          const corpo = getComputedStyle(document.body);
          const scorrimentoBloccato = corpo.overflow === 'hidden' || corpo.position === 'fixed'
            || getComputedStyle(document.documentElement).overflow === 'hidden';

          const testo = (document.body.innerText || '').trim();
          return {
            ok: true,
            pronta: document.readyState === 'complete',
            statoDocumento: document.readyState,
            caratteri: testo.length,
            // La pagina dichiara lei stessa di stare lavorando
            dichiaraAttesa: /caricamento|sto cercando|loading|searching|please wait|ricerca in corso|attendere/i.test(testo.substring(0, 3000)),
            ostacoli,
            scorrimentoBloccato,
            bloccata: ostacoli.length > 0 || scorrimentoBloccato,
            titolo: document.title,
          };
        });
      }

      // Toglie di mezzo cio' che copre il contenuto. Prima si prova a chiudere
      // come farebbe una persona (pulsante, Esc); se resiste, si rimuove
      // l'elemento e si ridà lo scorrimento. Un banner che non si lascia
      // chiudere non deve poter impedire di leggere.
      case 'sblocca_pagina': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
          const azioni = [];

          const chiusuraTesti = ['accetta','accept','ok','ho capito','got it','continua','continue',
            'chiudi','close','no grazie','no thanks','dismiss','x','consenti','allow','agree','accetto',
            'acconsento','prosegui','va bene','capito','accetta tutti','accept all','accetta tutto'];

          // Una cosa è visibile se occupa spazio e non è nascosta.
          //
          // Prima si usava "offsetParent === null" per dire "invisibile". Ma
          // un elemento con position:fixed ha SEMPRE offsetParent nullo — è
          // così che funziona il posizionamento fisso — e i banner dei cookie
          // sono fissi per definizione. Quel controllo saltava esattamente i
          // pulsanti che bisognava premere: su tmwe.it il banner è rimasto lì
          // dopo tre tentativi, e nel registro si leggeva tre volte "tolgo di
          // mezzo quello che copre la pagina" mentre non veniva tolto niente.
          const siVede = (el) => {
            try {
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) return false;
              const st = getComputedStyle(el);
              return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
            } catch (_) { return false; }
          };

          // 1. Come farebbe una persona: cercare il pulsante di chiusura
          const candidati = [...document.querySelectorAll(
            'button,[role="button"],a[role="button"],input[type="button"],input[type="submit"],[aria-label],[class*="close"],[id*="close"],[class*="accept" i],[id*="accept" i]')];
          for (const el of candidati) {
            try {
              if (!siVede(el)) continue;
              const et = ((el.innerText || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
              if (!et || et.length > 40) continue;
              if (chiusuraTesti.some(t => et === t || et.includes(t))) { el.click(); azioni.push('cliccato:' + et.substring(0, 20)); break; }
            } catch (_) { /* elemento sparito */ }
          }

          // 1b. Gli stessi pulsanti dentro i riquadri di consenso annidati.
          // Molti servizi (OneTrust, Cookiebot, Iubenda) mettono il banner in
          // un iframe: se è dello stesso sito si può entrare, altrimenti no.
          for (const fr of document.querySelectorAll('iframe')) {
            let doc = null;
            try { doc = fr.contentDocument; } catch (_) { continue; }   // altro dominio: non si entra
            if (!doc) continue;
            try {
              for (const el of doc.querySelectorAll('button,[role="button"],a')) {
                const et = (el.innerText || '').trim().toLowerCase();
                if (!et || et.length > 40) continue;
                if (chiusuraTesti.some(t => et === t || et.includes(t))) {
                  el.click(); azioni.push('cliccato nel riquadro:' + et.substring(0, 20)); break;
                }
              }
            } catch (_) { /* riquadro non leggibile */ }
          }

          // 2. Esc: molti modali lo ascoltano
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            azioni.push('esc');
          } catch (_) { /* niente */ }

          // 3. Se qualcosa copre ancora, si toglie
          for (const el of document.querySelectorAll('div,section,aside,dialog,iframe')) {
            let st; try { st = getComputedStyle(el); } catch (_) { continue; }
            if (st.position !== 'fixed' && st.position !== 'sticky' && el.tagName !== 'DIALOG') continue;
            if (st.display === 'none' || st.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            const copertura = (r.width * r.height) / (vw * vh);

            // Un banner d'angolo non copre un quarto dello schermo: quello di
            // tmwe.it sta in basso a destra e ne copre circa un decimo. Se però
            // si chiama "cookie", "consent" o "privacy", quello che è si è
            // dichiarato da solo, e basta molto meno spazio per toglierlo.
            const nome = ((el.id || '') + ' ' + (el.className || '')).toString().toLowerCase();
            const siDichiara = /cookie|consent|gdpr|privacy|onetrust|cookiebot|iubenda|didomi|quantcast/.test(nome);
            const soglia = siDichiara ? 0.02 : 0.25;
            if (copertura < soglia) continue;
            try { el.remove(); azioni.push('rimosso:' + (el.id || el.tagName.toLowerCase())); } catch (_) { /* gia' via */ }
          }

          // 4. Ridare lo scorrimento, che i modali spengono
          try {
            document.body.style.overflow = 'auto';
            document.body.style.position = 'static';
            document.documentElement.style.overflow = 'auto';
            azioni.push('scorrimento ripristinato');
          } catch (_) { /* niente */ }

          return { ok: true, azioni, caratteri: (document.body.innerText || '').length };
        });
      }

      case 'get_page_content': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          // ── HTML → Markdown pulito (stile FireScrape) ──
          const NOISE_SELS = ['nav','header','footer','[role="navigation"]','[role="banner"]','[role="contentinfo"]','.nav','.navbar','.header','.footer','.sidebar','.menu','.breadcrumb','.pagination','.ad','.ads','[class*="ad-"]','[id*="ad-"]','.cookie','[class*="cookie"]','.popup','.modal','.overlay','.social-share','[class*="social"]','.comments','#comments','script','style','noscript','iframe','svg','[aria-hidden="true"]','form:not([role="search"])'];
          const MAIN_SELS = ['main','article','[role="main"]','#content','#main-content','.main-content','.post-content','.article-content','.entry-content','.page-content','.content'];

          function getMain() {
            for (const s of MAIN_SELS) { const el = document.querySelector(s); if (el && el.textContent.trim().length > 200) return el.cloneNode(true); }
            return document.body.cloneNode(true);
          }
          function removeNoise(root) {
            for (const s of NOISE_SELS) { root.querySelectorAll(s).forEach(el => el.remove()); }
            root.querySelectorAll('[style]').forEach(el => { const st = el.style; if (st.display==='none'||st.visibility==='hidden'||st.opacity==='0') el.remove(); });
            return root;
          }
          function nodeToMd(node, depth) {
            if (depth > 40) return node.textContent || '';
            if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
            if (node.nodeType !== 1) return '';
            const tag = node.tagName.toLowerCase();
            const inner = () => [...node.childNodes].map(c => nodeToMd(c, depth+1)).join('');
            switch(tag) {
              case 'h1': return '\n\n# '+inner().trim()+'\n\n';
              case 'h2': return '\n\n## '+inner().trim()+'\n\n';
              case 'h3': return '\n\n### '+inner().trim()+'\n\n';
              case 'h4': return '\n\n#### '+inner().trim()+'\n\n';
              case 'p': return '\n\n'+inner().trim()+'\n\n';
              case 'br': return '\n';
              case 'hr': return '\n\n---\n\n';
              case 'blockquote': return '\n\n> '+inner().trim().replace(/\n/g,'\n> ')+'\n\n';
              case 'ul': case 'ol': {
                const items = [];let i=1;
                for (const li of node.children) { if (li.tagName?.toLowerCase()==='li') { items.push((tag==='ol'?i+'. ':'- ')+nodeToMd(li,depth+1).trim()); i++; } }
                return '\n\n'+items.join('\n')+'\n\n';
              }
              case 'li': return inner().trim();
              case 'strong': case 'b': { const t=inner().trim(); return t?'**'+t+'**':''; }
              case 'em': case 'i': { const t=inner().trim(); return t?'*'+t+'*':''; }
              case 'code': return '`'+inner().trim()+'`';
              case 'pre': { const code=node.querySelector('code'); return '\n\n```\n'+(code||node).textContent.trim()+'\n```\n\n'; }
              case 'a': { const href=node.getAttribute('href'); const t=inner().trim(); if(!t)return ''; if(!href||href==='#')return t; try{return '['+t+']('+new URL(href,location.href).href+')';}catch{return t;} }
              case 'img': { const src=node.getAttribute('src'); const alt=node.getAttribute('alt')||'img'; if(!src)return ''; try{return '!['+alt+']('+new URL(src,location.href).href+')';}catch{return '';} }
              case 'table': {
                const rows=[];node.querySelectorAll('tr').forEach(tr=>{const cells=[];tr.querySelectorAll('th,td').forEach(c=>cells.push(nodeToMd(c,depth+1).trim().replace(/\|/g,'\\|')));rows.push(cells);});
                if(!rows.length)return '';const cols=Math.max(...rows.map(r=>r.length));
                const norm=r=>{while(r.length<cols)r.push('');return r;};
                return '\n\n| '+norm(rows[0]).join(' | ')+' |\n| '+Array(cols).fill('---').join(' | ')+' |\n'+rows.slice(1).map(r=>'| '+norm(r).join(' | ')+' |').join('\n')+'\n\n';
              }
              default: return inner();
            }
          }
          const root = removeNoise(getMain());
          const md = nodeToMd(root, 0).replace(/\n{3,}/g,'\n\n').trim();
          const meta = { title: document.title, url: location.href, description: document.querySelector('meta[name="description"]')?.content||'', lang: document.documentElement.lang||'' };
          const output = '# '+meta.title+'\n> '+meta.url+'\n\n---\n\n'+md;
          return { ok: true, title: meta.title, url: meta.url, markdown: output.substring(0, 20000), text: root.innerText.substring(0, 8000), stats: { chars: output.length, words: output.split(/\s+/).length } };
        });
      }

      case 'get_forms': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          eval(RESOLVE_CODE);
          const forms = [];
          // Anche form dentro Shadow DOM
          const allForms = queryShadowAll(document, 'form');
          for (const form of allForms) {
            const fields = [];
            for (const el of form.querySelectorAll('input, select, textarea')) {
              fields.push({
                tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
                id: el.id || '', placeholder: el.placeholder || '', value: el.value || '',
                label: el.labels?.[0]?.textContent?.trim() || '',
                required: el.required,
                selector: el.id ? '#' + el.id : el.name ? '[name="' + el.name + '"]' : null
              });
            }
            forms.push({ action: form.action, method: form.method, id: form.id || '', fields });
          }
          return { ok: true, forms };
        });
      }

      case 'get_links': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const links = [];
          for (const a of document.querySelectorAll('a[href]')) {
            { const _r = a.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            links.push({ text: a.textContent.trim().substring(0, 80), href: a.href, target: a.target || '' });
          }
          return { ok: true, links: links.slice(0, 100) };
        });
      }

      case 'get_buttons': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const buttons = [];
          for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn, a[class*="button"]')) {
            { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            buttons.push({
              text: el.textContent.trim().substring(0, 60), type: el.type || '', disabled: el.disabled || false,
              selector: el.id ? '#' + el.id : 'text:' + el.textContent.trim().substring(0, 30)
            });
          }
          return { ok: true, buttons: buttons.slice(0, 50) };
        });
      }

      case 'get_interactive': {
        const tab = await getWorkTab();
        // Attendi che la pagina sia caricata (evita query su pagine in loading)
        try {
          const tabInfo = await chrome.tabs.get(tab.id);
          if (tabInfo.status !== 'complete') {
            await waitForTabLoad(tab.id, 10000);
            await new Promise(r => setTimeout(r, 500)); // extra settle time per SPA/Google
          }
        } catch {}
        // Pre-dismiss any blocking overlays/popups before scanning
        try {
          await run(tab.id, () => {
            const dismissTexts = ['non consentire','deny','block','rifiuta','no thanks','dismiss','chiudi','non ora','close','accetta','accept','ok','got it','ho capito','consenti','allow'];
            document.querySelectorAll('[class*="modal"] button, [class*="dialog"] button, [class*="overlay"] button, [class*="popup"] button, [class*="consent"] button, [class*="cookie"] button, [class*="banner"] button').forEach(el => {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length < 40 && dismissTexts.some(d => txt.includes(d))) { try { el.click(); } catch {} }
            });
          });
        } catch {}
        return await run(tab.id, () => {
          // CSS.escape fallback
          const cssEsc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s) => s.replace(/([^\w-])/g, '\\$1');
          function buildSelector(el) {
            if (el.id) return '#' + cssEsc(el.id);
            if (el.name) return el.tagName.toLowerCase() + '[name="' + cssEsc(el.name) + '"]';
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) return 'aria:' + ariaLabel;
            const placeholder = el.placeholder;
            if (placeholder) return 'placeholder:' + placeholder;
            const text = el.textContent?.trim();
            if (text && text.length <= 30 && text.length > 0) return 'text:' + text.substring(0, 30);
            // Fallback: nth-child
            const parent = el.parentElement;
            if (parent) {
              const idx = [...parent.children].indexOf(el) + 1;
              return el.tagName.toLowerCase() + ':nth-child(' + idx + ')';
            }
            return el.tagName.toLowerCase();
          }
          const items = [];
          const giaVisti = new Set();
          for (const el of document.querySelectorAll('input, select, textarea, button, [role="button"], a[href], [contenteditable="true"]')) {
            { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            giaVisti.add(el);
            items.push({
              tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
              text: el.textContent?.trim().substring(0, 50) || '', placeholder: el.placeholder || '',
              ariaLabel: el.getAttribute('aria-label') || '', role: el.getAttribute('role') || '',
              href: el.href || '', value: el.value?.substring(0, 30) || '',
              disabled: el.disabled || false,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              selector: buildSelector(el)
            });
          }
          // ── Seconda passata: i cliccabili che non sono link né pulsanti ──
          //
          // Sull'ERP TMWE la prima passata trovava DUE elementi su una pagina
          // piena di comandi, e la risposta era "non ci sono pulsanti visibili":
          // vera alla lettera e inservibile. Quel gestionale — come molti
          // applicativi aziendali di vecchia data — è fatto di <div onclick>,
          // <td> e immagini: cento comandi reali, zero <a> e zero <button>.
          //
          // Si raccoglie quindi anche ciò che è cliccabile di fatto. Per non
          // riempire l'elenco di rumore sui siti moderni, dove il puntatore a
          // mano è ovunque, si tiene solo l'elemento più interno di ogni gruppo
          // e solo se porta un'etichetta breve e leggibile.
          const cliccabili = [];
          for (const el of document.querySelectorAll('div,td,span,li,img,nobr,label')) {
            if (giaVisti.has(el)) continue;
            { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            const rect = el.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) continue;

            const haGestore = !!(el.onclick || el.getAttribute('onclick'));
            let aMano = false;
            try { aMano = getComputedStyle(el).cursor === 'pointer'; } catch (_) { /* elemento sparito */ }
            if (!haGestore && !aMano) continue;

            // Se contiene un altro candidato, il comando vero è quello dentro
            if (el.querySelector('[onclick],input,button,a[href],select')) continue;

            const testo = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            const etichetta = testo || el.getAttribute('title') || el.getAttribute('alt') || '';
            if (!etichetta || etichetta.length > 40) continue;

            cliccabili.push({
              tag: el.tagName.toLowerCase(), type: '', name: '', id: el.id || '',
              text: etichetta.substring(0, 50), placeholder: '',
              ariaLabel: el.getAttribute('title') || el.getAttribute('alt') || '',
              // Il server lo tratta come un pulsante: per chi lo deve usare è
              // esattamente quello, indipendentemente dal tag scelto nel 2009.
              role: 'button', cliccabileDiFatto: true,
              href: '', value: '', disabled: false,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              selector: buildSelector(el)
            });
            if (cliccabili.length >= 80) break;
          }

          return { ok: true, url: location.href, title: document.title,
                   elements: items.concat(cliccabili).slice(0, 160),
                   standard: items.length, cliccabiliDiFatto: cliccabili.length };
        }).catch(async (err) => {
          // Retry dopo breve pausa (pagina potrebbe non essere ancora pronta)
          await new Promise(r => setTimeout(r, 1500));
          try {
            return await run(tab.id, () => {
              const items = [];
              for (const el of document.querySelectorAll('input, select, textarea, button, [role="button"], a[href]')) {
                { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                items.push({
                  tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
                  text: el.textContent?.trim().substring(0, 50) || '', placeholder: el.placeholder || '',
                  ariaLabel: el.getAttribute('aria-label') || '', role: el.getAttribute('role') || '',
                  selector: el.id ? '#' + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : el.tagName.toLowerCase())
                });
              }
              return { ok: true, url: location.href, title: document.title, elements: items.slice(0, 80), retried: true };
            });
          } catch (e2) {
            return { ok: false, error: 'get_interactive failed: ' + (err.message || '') + ' / retry: ' + (e2.message || '') };
          }
        });
      }

      // ════════════════════════════════════════
      // 17b. PAGE SNAPSHOT — mappa strutturata per AI decision
      // ════════════════════════════════════════
      case 'get_page_snapshot': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const cssEsc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s) => s.replace(/([^\w-])/g, '\\$1');
          function buildSel(el) {
            if (el.id) return '#' + cssEsc(el.id);
            if (el.name) return el.tagName.toLowerCase() + '[name="' + cssEsc(el.name) + '"]';
            const aria = el.getAttribute('aria-label');
            if (aria) return 'aria:' + aria;
            if (el.placeholder) return 'placeholder:' + el.placeholder;
            if (el.className && typeof el.className === 'string') {
              const cls = el.className.trim().split(/\s+/).slice(0, 2).map(c => cssEsc(c)).join('.');
              if (cls) return el.tagName.toLowerCase() + '.' + cls;
            }
            const text = (el.textContent || '').trim();
            if (text.length > 0 && text.length <= 30) return 'text:' + text;
            return el.tagName.toLowerCase();
          }
          return {
            ok: true, url: location.href, title: document.title,
            buttons: [...document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn, a[class*="button"]')]
              .filter(el => ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)).slice(0, 25)
              .map(el => ({ text: el.textContent?.trim().slice(0, 50), selector: buildSel(el), disabled: el.disabled || false })),
            inputs: [...document.querySelectorAll('input, textarea, select')]
              .filter(el => ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)).slice(0, 25)
              .map(el => ({ type: el.type || el.tagName.toLowerCase(), name: el.name, placeholder: el.placeholder, value: el.value?.slice(0, 30), label: el.labels?.[0]?.textContent?.trim()?.slice(0,40) || '', selector: buildSel(el), required: el.required || false })),
            links: [...document.querySelectorAll('a[href]')]
              .filter(el => ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)).slice(0, 30)
              .map(el => ({ text: el.textContent?.trim().slice(0, 50), href: el.href, selector: buildSel(el) })),
            headings: [...document.querySelectorAll('h1, h2, h3')].slice(0, 15)
              .map(el => ({ level: el.tagName, text: el.textContent?.trim().slice(0, 80) })),
            mainText: (document.querySelector('main, article, [role="main"]') || document.body)
              .textContent?.trim().slice(0, 2000),
          };
        });
      }

      case 'highlight': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          el.style.outline = '3px solid #a78bfa';
          el.style.outlineOffset = '2px';
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 3000);
          return { ok: true };
        }, [args.selector]);
      }

      case 'execute_js': {
        const tab = await getWorkTab();
        return await run(tab.id, (code) => {
          try { return { ok: true, result: eval(code) }; } catch (e) { return { ok: false, error: e.message }; }
        }, [args.code]);
      }

      // ════════════════════════════════════════
      // 18. HUMAN TAKEOVER (Modulo 4)
      // ════════════════════════════════════════

      case 'detect_block': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const blocks = [];
          const body = document.body.innerText.toLowerCase();

          // CAPTCHA
          if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey], .cf-challenge'))
            blocks.push('captcha');
          if (body.includes('captcha') || body.includes('verify you are human') || body.includes('conferma di essere umano'))
            blocks.push('captcha_text');

          // 2FA / OTP
          if (document.querySelector('input[name*="otp"], input[name*="2fa"], input[autocomplete="one-time-code"], input[name*="totp"]'))
            blocks.push('2fa');
          if (body.includes('two-factor') || body.includes('verifica in due passaggi') || body.includes('codice di verifica') || body.includes('authentication code'))
            blocks.push('2fa_text');

          // Login
          if (document.querySelector('input[type="password"]') && document.querySelector('form'))
            blocks.push('login_form');

          // Permission dialogs
          if (body.includes('allow notifications') || body.includes('consenti notifiche') || body.includes('enable location'))
            blocks.push('permission_request');

          // Blocked / rate limited
          if (body.includes('access denied') || body.includes('403') || body.includes('rate limit') || body.includes('too many requests'))
            blocks.push('access_denied');

          return { ok: true, blocked: blocks.length > 0, blocks };
        });
      }

      case 'request_human': {
        // Notifica l'utente che serve intervento manuale
        notify('human_takeover', { reason: args.reason || 'Intervento manuale richiesto', type: args.type || 'generic' });
        // Anche notifica Chrome nativa
        chrome.notifications.create('cobra-takeover', {
          type: 'basic', iconUrl: 'icons/cobra-128.png',
          title: 'COBRA — Intervento richiesto',
          message: args.reason || 'Serve il tuo intervento nel browser.'
        });
        return { ok: true, notified: true, reason: args.reason };
      }

      case 'resume_after_human': {
        const tab = await getWorkTab();
        const url = tab.url;
        return { ok: true, url, title: tab.title, note: 'Agent resumed' };
      }

      // ════════════════════════════════════════
      // 19. VERIFICA RISULTATO (Modulo 5)
      // ════════════════════════════════════════

      case 'verify_action': {
        const tab = await getWorkTab();
        return await run(tab.id, (checks) => {
          const results = [];
          for (const check of checks) {
            switch (check.type) {
              case 'url_contains': {
                results.push({ check: check.type, expected: check.value, actual: location.href,
                  passed: location.href.includes(check.value) });
                break;
              }
              case 'element_exists': {
                const el = document.querySelector(check.selector);
                results.push({ check: check.type, selector: check.selector, passed: !!el });
                break;
              }
              case 'element_text': {
                const el = document.querySelector(check.selector);
                const text = el?.textContent?.trim() || '';
                results.push({ check: check.type, selector: check.selector, expected: check.value,
                  actual: text.substring(0, 100), passed: text.toLowerCase().includes(check.value.toLowerCase()) });
                break;
              }
              case 'element_visible': {
                const el = document.querySelector(check.selector);
                results.push({ check: check.type, selector: check.selector, passed: !!(el && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) });
                break;
              }
              case 'no_error': {
                const errors = [];
                for (const el of document.querySelectorAll('.error, .alert-danger, [class*="error"], [role="alert"]')) {
                  if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) && el.textContent.trim()) errors.push(el.textContent.trim().substring(0, 80));
                }
                results.push({ check: check.type, passed: errors.length === 0, errors });
                break;
              }
              case 'toast': {
                const toasts = [];
                for (const el of document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="snackbar"], [role="status"]')) {
                  if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) toasts.push(el.textContent.trim().substring(0, 80));
                }
                results.push({ check: check.type, found: toasts, passed: toasts.length > 0 });
                break;
              }
              default:
                results.push({ check: check.type, passed: false, error: 'Unknown check type' });
            }
          }
          const allPassed = results.every(r => r.passed);
          return { ok: true, allPassed, results };
        }, [typeof args.checks === 'string' ? JSON.parse(args.checks) : args.checks]);
      }

      // ════════════════════════════════════════
      // 20. COOKIE / CONSENT DISMISS
      // ════════════════════════════════════════

      case 'dismiss_cookies': {
        const tab = await getWorkTab();
        // Strategy A: main frame search (includes shadow DOM traversal)
        const mainResult = await run(tab.id, () => {
          // Deep querySelectorAll — traverses shadow DOM roots
          function deepQueryAll(root, selector) {
            const results = [...root.querySelectorAll(selector)];
            // Search inside shadow roots
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) {
                results.push(...deepQueryAll(el.shadowRoot, selector));
              }
            }
            return results;
          }

          const rejectTexts = ['rifiuta tutto','rifiuta tutti','rifiuta','reject all','reject','deny all','deny',
            'decline','solo necessari','strictly necessary only','nur notwendige','tout refuser','solo cookies tecnici',
            'ablehnen','rechazar todo'];
          const acceptTexts = ['accetta tutto','accetta tutti','accetta e continua','accetta','accept all','accept and continue','accept','agree',
            'allow all','allow','consent','got it','ok','ho capito','continua','alle akzeptieren','tout accepter',
            'aceptar todo','einverstanden'];
          const manageTexts = ['gestisci','gestisci cookie','gestisci preferenze','manage','manage cookies','manage preferences',
            'cookie settings','personalizza','customize','impostazioni cookie'];
          const SELS = 'button, a[role="button"], [role="button"], a.btn, span[role="button"], div[role="button"], a[class*="cookie"], a[class*="consent"], [class*="cookie"] button, [class*="consent"] button, [id*="cookie"] button';

          function findAndClick(texts) {
            for (const el of deepQueryAll(document, SELS)) {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length > 80 || txt.length === 0) continue;
              try {
                if (texts.some(t => txt.includes(t)) && (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none')) {
                  el.click(); return txt;
                }
              } catch { /* shadow DOM element without getComputedStyle */ }
            }
            return null;
          }

          // Si ACCETTA e si va avanti, per scelta dichiarata dell'utente.
          //
          // Prima si tentava il rifiuto per primo. Su molti siti il rifiuto
          // non esiste come pulsante diretto: sta dentro "Preferenze", e il
          // banner restava aperto a coprire la pagina. Su emirates.com il
          // risultato era una pagina da 8.578 caratteri letta come vuota.
          // Un banner che resta aperto non protegge nessuno: impedisce solo
          // di leggere.
          const acceptSels = ['#onetrust-accept-btn-handler', '.cmp-accept-all', 'button.fc-cta-consent',
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '[data-testid="cookie-accept"]',
            '#didomi-notice-agree-button', '.iubenda-cs-accept-btn',
            // Aggiunti dopo averli incontrati sul campo
            '#onetrust-accept-btn-handler', '#accept-recommended-btn-handler',
            '.ot-pc-refuse-all-handler ~ button', '#truste-consent-button',
            '.qc-cmp2-summary-buttons button[mode="primary"]', '#usercentrics-root',
            'button[data-cky-tag="accept-button"]', '.cc-allow', '.cookie-accept-all',
            '#cookie-accept', '#acceptCookies', '.js-accept-cookies'];
          for (const sel of acceptSels) {
            for (const el of deepQueryAll(document, sel)) {
              try { if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none') { el.click(); return { ok: true, action: 'accepted_sel', button: sel }; } } catch {}
            }
          }
          let clicked = findAndClick(acceptTexts);
          if (clicked) return { ok: true, action: 'accepted', button: clicked };
          // Se non c'e' nulla da accettare, si prova comunque a chiudere:
          // meglio un rifiuto che un banner che copre la pagina.
          clicked = findAndClick(rejectTexts);
          if (clicked) return { ok: true, action: 'rejected', button: clicked };
          const rejectSels = ['#onetrust-reject-all-handler', '.cmp-reject-all', 'button.fc-cta-do-not-consent',
            '[data-testid="cookie-reject"]', '.cookie-reject', '#CybotCookiebotDialogBodyButtonDecline',
            '#didomi-notice-disagree-button', '.iubenda-cs-reject-btn'];
          for (const sel of rejectSels) {
            for (const el of deepQueryAll(document, sel)) {
              try { if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none') { el.click(); return { ok: true, action: 'rejected_sel', button: sel }; } } catch {}
            }
          }
          // Ultima risorsa: aprire "Preferenze" e accettare da dentro
          // 4. Manage button (two-step: click manage, then accept inside panel)
          clicked = findAndClick(manageTexts);
          if (clicked) return { ok: true, action: 'manage_clicked', button: clicked, needsSecondStep: true };

          return { ok: true, action: 'no_banner' };
        });

        // If manage was clicked, wait and then accept inside the opened panel
        if (mainResult?.needsSecondStep) {
          await new Promise(r => setTimeout(r, 1000));
          const secondResult = await run(tab.id, () => {
            const acceptTexts = ['accetta tutto','accetta tutti','accetta','accept all','accept','conferma','confirm',
              'salva e accetta','save and accept','accetta e chiudi','accept and close','salva','save',
              'consenti tutto','allow all','accetta selezionati','accept selected'];
            for (const el of document.querySelectorAll('button, a[role="button"], [role="button"], span[role="button"], div[role="button"]')) {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length > 80 || txt.length === 0) continue;
              if (acceptTexts.some(t => txt.includes(t)) && (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) || getComputedStyle(el).display !== 'none')) {
                el.click(); return { ok: true, action: 'accepted_after_manage', button: txt };
              }
            }
            return { ok: true, action: 'manage_opened_no_accept' };
          });
          return secondResult;
        }

        // If no_banner in main frame, check inside iframes (CMP often in iframe)
        if (mainResult?.action === 'no_banner') {
          try {
            const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
            const cmpFrames = frames.filter(f => f.frameId !== 0 && f.url && !f.url.startsWith('about:') &&
              (f.url.includes('consent') || f.url.includes('cookie') || f.url.includes('privacy') ||
               f.url.includes('onetrust') || f.url.includes('didomi') || f.url.includes('iubenda') ||
               f.url.includes('cookiebot') || f.url.includes('quantcast') || f.url.includes('consentmanager')));
            for (const frame of cmpFrames) {
              const frameResult = await runInFrame(tab.id, frame.frameId, () => {
                const rejectTexts = ['rifiuta tutto','rifiuta tutti','rifiuta','reject all','reject','deny all','deny','decline'];
                const acceptTexts = ['accetta tutto','accetta tutti','accetta','accept all','accept','agree','allow all','allow','consent','ok','continua'];
                for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                  const txt = (el.textContent || '').trim().toLowerCase();
                  if (txt.length > 80 || txt.length === 0) continue;
                  if (rejectTexts.some(t => txt.includes(t)) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                    el.click(); return { ok: true, action: 'rejected_iframe', button: txt };
                  }
                }
                for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                  const txt = (el.textContent || '').trim().toLowerCase();
                  if (txt.length > 80 || txt.length === 0) continue;
                  if (acceptTexts.some(t => txt.includes(t)) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                    el.click(); return { ok: true, action: 'accepted_iframe', button: txt };
                  }
                }
                return null;
              });
              if (frameResult && frameResult.ok) return frameResult;
            }
          } catch (e) { /* iframe access failed, return no_banner */ }
        }

        return mainResult;
      }

      // ════════════════════════════════════════
      // 20b. OVERLAY / SPLASH / INTERSTITIAL DISMISS
      // ════════════════════════════════════════

      case 'dismiss_overlay': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          // Deep querySelectorAll — traverses shadow DOM roots
          function deepQueryAll(root, selector) {
            const results = [...root.querySelectorAll(selector)];
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
            }
            return results;
          }

          // Detect fullscreen/near-fullscreen overlays covering the page
          // Common patterns: video splash, welcome screens, age gates, newsletter popups
          const closeTexts = ['chiudi','close','skip','salta','x','✕','✖','×','continua','continue',
            'vai al sito','go to site','enter','entra','esplora','explore','scopri','discover',
            'prosegui','proceed','inizia','start','accedi al sito','enter site','skip intro',
            'skip video','chiudi video','close video'];
          const closeSels = [
            // Generic close/dismiss buttons on overlays
            '[class*="overlay"] [class*="close"]', '[class*="overlay"] [class*="skip"]',
            '[class*="modal"] [class*="close"]', '[class*="modal"] button',
            '[class*="splash"] [class*="close"]', '[class*="splash"] [class*="skip"]',
            '[class*="interstitial"] [class*="close"]', '[class*="intro"] [class*="close"]',
            '[class*="welcome"] [class*="close"]', '[class*="hero"] [class*="close"]',
            '[class*="fullscreen"] [class*="close"]', '[class*="video"] [class*="close"]',
            '[class*="popup"] [class*="close"]', '[class*="lightbox"] [class*="close"]',
            '.close-button', '.btn-close', '[aria-label="Close"]', '[aria-label="Chiudi"]',
            '[data-dismiss="modal"]', '.modal-close', '.overlay-close',
            // Age gates
            '[class*="age"] button', '[class*="gate"] button',
          ];

          // Strategy 1: check if there's a large overlay element covering the viewport (deep: shadow DOM)
          const overlayEls = deepQueryAll(document, '[class*="overlay"], [class*="modal"], [class*="splash"], [class*="interstitial"], [class*="lightbox"], [class*="popup"], [class*="fullscreen-video"], [class*="hero-video"], [class*="welcome"]');
          let foundOverlay = false;
          for (const ov of overlayEls) {
            const style = getComputedStyle(ov);
            const rect = ov.getBoundingClientRect();
            // Is it covering most of the viewport?
            if (rect.width > window.innerWidth * 0.7 && rect.height > window.innerHeight * 0.5 &&
                style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.1 &&
                (style.position === 'fixed' || style.position === 'absolute' || parseInt(style.zIndex) > 10)) {
              foundOverlay = true;
              // Look for close/skip button inside this overlay
              for (const btn of ov.querySelectorAll('button, a, [role="button"], span, div[class*="close"], svg')) {
                const txt = (btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
                if (txt.length > 60) continue;
                if (closeTexts.some(t => txt === t || txt.includes(t)) ||
                    btn.classList.toString().toLowerCase().match(/close|skip|dismiss|chiudi/) ||
                    (btn.tagName === 'SVG' && btn.closest('[class*="close"]'))) {
                  btn.click();
                  return { ok: true, action: 'overlay_closed', button: txt || btn.className, overlay: ov.className };
                }
              }
              // No labeled close button — try clicking the overlay background itself (some dismiss on bg click)
              // But only if it has a click handler or pointer cursor
              if (style.cursor === 'pointer') {
                ov.click();
                return { ok: true, action: 'overlay_bg_clicked', overlay: ov.className };
              }
            }
          }

          // Strategy 2: look for close buttons matching known selectors (deep)
          for (const sel of closeSels) {
            try {
              for (const el of deepQueryAll(document, sel)) {
                if (((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    el.click();
                    return { ok: true, action: 'overlay_closed_sel', button: sel };
                  }
                }
              }
            } catch {}
          }

          // Strategy 3: text-based search on visible buttons (deep)
          for (const el of deepQueryAll(document, 'button, a[role="button"], [role="button"], a.btn')) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (txt.length > 40 || txt.length === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const elZ = parseInt(getComputedStyle(el).zIndex) || 0;
            const parentZ = parseInt(getComputedStyle(el.parentElement).zIndex) || 0;
            // Only click if element is in a high z-index layer (overlay)
            if ((elZ > 100 || parentZ > 100) && closeTexts.some(t => txt.includes(t))) {
              el.click();
              return { ok: true, action: 'overlay_closed_text', button: txt };
            }
          }

          // Strategy 4: detect "empty" page with just a video — page has very little readable text
          const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
          if (bodyText.length < 100) {
            // Almost empty page — likely a video splash. Look for ANY close/skip button (deep)
            for (const el of deepQueryAll(document, 'button, a, [role="button"]')) {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length > 40 || txt.length === 0) continue;
              if (closeTexts.some(t => txt.includes(t)) && ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)) {
                el.click();
                return { ok: true, action: 'empty_page_close', button: txt };
              }
            }
          }

          return { ok: true, action: foundOverlay ? 'overlay_no_close_found' : 'no_overlay' };
        });
      }

      // ════════════════════════════════════════
      // 21. AUDIT LOG
      // ════════════════════════════════════════

      case 'get_action_log': {
        return { ok: true, log: actionLog.slice(-(args.limit || 50)) };
      }

      case 'clear_action_log': {
        actionLog.length = 0;
        return { ok: true };
      }

      // ════════════════════════════════════════
      // 22. SESSION / STORAGE
      // ════════════════════════════════════════

      case 'get_cookies': {
        const cookies = await chrome.cookies.getAll({ url: args.url });
        return { ok: true, cookies: cookies.map(c => ({ name: c.name, value: c.value.substring(0, 50), domain: c.domain, httpOnly: c.httpOnly })) };
      }

      case 'get_storage': {
        const tab = await getWorkTab();
        return await run(tab.id, (type) => {
          const storage = type === 'session' ? sessionStorage : localStorage;
          const items = {};
          for (let i = 0; i < storage.length && i < 50; i++) {
            const key = storage.key(i);
            items[key] = storage.getItem(key)?.substring(0, 200);
          }
          return { ok: true, type, count: storage.length, items };
        }, [args.type || 'local']);
      }

      // ════════════════════════════════════════
      // 23. TABELLE / GRIGLIE
      // ════════════════════════════════════════

      case 'read_table': {
        const tab = await getWorkTab();
        return await run(tab.id, (sel, maxRows) => {
          eval(RESOLVE_CODE);
          const table = sel ? resolveElement(sel) : document.querySelector('table');
          if (!table) return { ok: false, error: 'No table found' };

          const headers = [];
          const rows = [];
          const headerEls = table.querySelectorAll('thead th, thead td, tr:first-child th');
          for (const th of headerEls) headers.push(th.textContent.trim());

          const bodyRows = table.querySelectorAll('tbody tr, tr');
          for (let i = 0; i < Math.min(bodyRows.length, maxRows || 50); i++) {
            const cells = [];
            for (const td of bodyRows[i].querySelectorAll('td, th')) {
              cells.push(td.textContent.trim().substring(0, 200));
            }
            if (cells.length > 0) rows.push(cells);
          }
          return { ok: true, headers, rows, totalRows: bodyRows.length };
        }, [args.selector || null, args.maxRows || 50]);
      }

      // ════════════════════════════════════════
      // 24. RETRY + ERROR RECOVERY (Modulo 5)
      // ════════════════════════════════════════

      case 'retry': {
        // Meta-comando: esegue un sotto-comando con retry
        const maxRetries = args.retries || 3;
        const delayMs = args.delay || 1000;
        let lastResult;
        for (let i = 0; i <= maxRetries; i++) {
          lastResult = await executeCommand(args.command, args.commandArgs || {});
          if (lastResult.ok) return { ...lastResult, retries: i };
          if (i < maxRetries) await new Promise(r => setTimeout(r, delayMs));
        }
        return { ...lastResult, retriesFailed: maxRetries };
      }

      default:
        return { ok: false, error: `Unknown command: ${command}` };
    }
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack?.substring(0, 200) };
  }
}

// ── Inject helper code as strings for eval in page context ──
// Questi vengono passati come variabili globali fittizziere nel contesto della pagina
const RESOLVE_CODE = resolveElementCode();
const MOUSE_CODE = realisticMouseCode();

// ── Tab lifecycle: pulisci work tab se chiuso ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === _workTabId) {
    console.log('[COBRA Bridge] Scheda di lavoro chiusa');
    _workTabId = null;
    // Va cancellato anche il valore persistito, altrimenti al prossimo
    // risveglio si cercherebbe una scheda che non esiste più
    try { chrome.storage.session.remove('cobraWorkTabId'); } catch { /* non disponibile */ }
    try { chrome.storage.local.remove('cobraWorkTabId'); } catch { /* non disponibile */ }
  }
  if (tabId === _cobraTabId) {
    console.log('[COBRA Bridge] COBRA tab closed');
    _cobraTabId = null;
  }
});

// Rileva quando un tab naviga a localhost:3000 (registralo come COBRA tab)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (eIlTabDiCobra(changeInfo.url)) {
    _cobraTabId = tabId;
  }
});

// ── Mantenimento della connessione ──
// In Manifest V3 il service worker viene sospeso dopo circa 30 secondi di
// inattività, e con esso cade il bridge. Due contromisure:
//   1) un allarme periodico che risveglia il worker e ricollega se serve;
//   2) un messaggio applicativo verso il server, che tiene vivo lo scambio.
const KEEPALIVE_ALARM = 'cobra-keepalive';

function ensureConnection() {
  try {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connect();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'keepalive', ts: Date.now() }));
    }
  } catch {
    try { connect(); } catch { /* si riprova al prossimo allarme */ }
  }
}

if (chrome.alarms) {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === KEEPALIVE_ALARM) ensureConnection();
  });
}
// Secondo livello: finché il worker è sveglio, controlla più spesso
setInterval(ensureConnection, 20000);

// ── Avvio ──
// La connessione non parte durante la registrazione del service worker: se il
// server COBRA non è ancora attivo, un errore in quel momento verrebbe mostrato
// da Chrome come errore dell'estensione. Rimandandola di un istante, la
// registrazione si conclude sempre e il collegamento si stabilisce quando può.
setTimeout(() => { try { connect(); } catch (e) { console.log('[COBRA Bridge] avvio rimandato:', e.message); } }, 100);
chrome.runtime.onStartup.addListener(() => { try { connect(); } catch { /* si riprova col timer */ } });
chrome.runtime.onInstalled.addListener(() => { try { connect(); } catch { /* si riprova col timer */ } });
