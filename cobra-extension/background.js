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

// I moduli presi dalle estensioni gia' funzionanti del Navigator.
// Vedi esterni/ponte.js per il perche' del caricatore.
try { importScripts('esterni/ponte.js'); }
catch (e) { console.error('[COBRA] ponte.js non caricato:', e.message); }

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
        const finestra = misure?.cssVisualViewport || misure?.visualViewport;

        // ── Si chiede la pagina intera SOLO se c'è davvero qualcosa sotto ──
        //
        // Regressione vista a schermo il 6 agosto su Google Voli: la stessa
        // schermata ripetuta tre volte una sotto l'altra, come una carta da
        // parati. Succede perché chiedendo un ritaglio più alto della pagina
        // vera, il motore riempie lo spazio che avanza ridisegnando quello che
        // ha — e viene fuori una piastrellatura che sembra un guasto grave.
        //
        // Su una pagina che sta tutta in una schermata — e Google Voli è una
        // di quelle — non c'è niente da andare a prendere sotto: si fotografa
        // la finestra e basta.
        const altezzaFinestra = finestra?.clientHeight || finestra?.height || 0;
        const valeLaPena = c && altezzaFinestra > 0 && c.height > altezzaFinestra * 1.05;

        if (c && c.width > 0 && c.height > 0 && valeLaPena) {
          ritaglio = {
            x: 0, y: 0,
            width: Math.min(c.width, 2000),
            // Mai oltre l'altezza vera del documento: è il ritaglio troppo
            // alto a produrre la ripetizione.
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


// ── Svegliare una scheda che Chrome ha messo a dormire ──
//
// Chrome scarica dalla memoria le schede che non guardi da un po'. Restano
// nell'elenco, con il loro titolo e il loro url, ma dentro non c'e' piu'
// niente. Chiedere di eseguire uno script li' dentro produce:
//
//   "Cannot access contents of the page. Extension manifest must request
//    permission to access the respective host."
//
// che sembra un problema di permessi e non lo e' — infatti gli stessi
// permessi bastavano un minuto prima. Il 7 agosto ci ho perso un giro su
// WhatsApp e oggi un altro su LinkedIn, perche' l'avevo gestito nel comando
// dell'elenco e non in quello della lettura.
//
// Si ricarica e si aspetta. Una volta sola: se dopo il ricaricamento non
// risponde ancora, il problema e' un altro e va detto com'e'.
async function svegliaScheda(scheda) {
  if (!scheda) return null;
  try {
    const t = await chrome.tabs.get(scheda.id);
    if (t.status !== 'unloaded' && !t.discarded) return t;
    await chrome.tabs.reload(t.id);
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 700));
      const d = await chrome.tabs.get(t.id);
      if (d.status === 'complete') {
        // Il contenuto compare dopo il caricamento: leggere subito
        // significa leggere il guscio.
        await new Promise(r => setTimeout(r, 2500));
        return d;
      }
    }
    return await chrome.tabs.get(t.id);
  } catch (e) { return scheda; }
}

// ── Fotografare LA scheda giusta, o nessuna ──
//
// Il 7 agosto il pannello di COBRA ha mostrato la pagina "Cervello AI" di
// Funnemail mentre l'etichetta sotto diceva "LinkedIn — Samuel Chen, 14
// messaggi". Non era un errore di etichetta: captureVisibleTab fotografa la
// scheda in PRIMO PIANO della finestra, e LinkedIn stava dietro. Usciva
// l'immagine di una pagina che non c'entrava niente.
//
// Una foto sbagliata e' peggio di nessuna foto: chi guarda crede di vedere la
// prova di quello che e' stato letto, e sta vedendo altro. Quindi si fotografa
// solo se quella scheda e' davvero quella in primo piano; altrimenti si dice
// perche' non c'e' l'immagine.
async function fotoDi(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t.active) {
      return { url: t.url, perche: 'la pagina e\' in una scheda in secondo piano: '
        + 'Chrome fotografa solo quella in primo piano, e una foto di un\'altra '
        + 'pagina sarebbe peggio di nessuna foto.' };
    }
    const img = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 60 });
    return img ? { screenshot: img.split(',')[1], url: t.url } : { url: t.url };
  } catch (e) {
    return { perche: 'non sono riuscito a fotografare la pagina: ' + e.message };
  }
}
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

      // ── Compilare un campo: prima si guarda, poi si scrive, poi si verifica ──
      //
      // Il metodo precedente faceva una cosa sola: prendeva il selettore e
      // assegnava el.value, assumendo sempre un <input> o una <textarea>.
      // Su un modulo vero questo produce tre guasti silenziosi:
      //
      //   <select>   — assegnare .value con un testo che non è uno dei valori
      //                delle opzioni non fa niente. Nessun errore, campo vuoto.
      //   checkbox   — la spunta sta in .checked, non in .value. Scrivere
      //                "true" in .value lascia la casella com'era.
      //   React/Vue  — molti moduli riscrivono il campo dopo l'evento, e senza
      //                rileggere si dichiarava riuscito un campo tornato vuoto.
      //
      // Qui il campo viene prima ispezionato, poi trattato secondo quello che
      // è, e infine RILETTO: si riferisce quello che c'è davvero nel campo,
      // non quello che si è provato a metterci.
      // ── WhatsApp e LinkedIn, con il codice che gia' funziona ──
      //
      // Qui non c'e' nessun selettore scritto da noi: si chiamano le funzioni
      // delle estensioni del Navigator, che quei selettori li hanno gia'
      // sbagliati e corretti abbastanza volte da sapere quali reggono.
      case 'whatsapp_sessione':
        return await Esterni.con('wa', (m) => m.Actions.verifySession(), args.modo || 'automatico');

      // ── L'elenco delle conversazioni, letto dove sta davvero ──
      //
      // PERCHE' NON USO IL LORO readUnreadMessages
      //
      // Il 7 agosto l'ho provato sul WhatsApp vero di Luca. Ha restituito 150
      // righe in cui i messaggi erano finiti al posto dei contatti:
      //
      //     contact: "We will do tomorrow"       <- e' un messaggio
      //     lastMessage: "wds-ic-read"           <- e' il nome dell'icona
      //     avgBadge: 0, confidence: 15
      //
      // Il motivo: la loro strategia "role-row" prende ogni elemento con
      // role="row" di TUTTA la pagina, e le bolle della conversazione aperta
      // hanno lo stesso ruolo delle righe dell'elenco. Con una chat aperta,
      // legge quella e la scambia per la rubrica.
      //
      // I SELETTORI QUI SOTTO NON SONO INDOVINATI
      //
      // Vengono dal LORO Discovery, che sulla stessa pagina e nello stesso
      // momento ha misurato: sidebarSelector "pane-side", chatItems 68,
      // chatItemsMethod "cell-frame". Sono fatti rilevati dal vivo, non
      // ipotesi mie: mi limito a leggere dentro il contenitore che loro hanno
      // gia' identificato, invece che in tutta la pagina.
      case 'whatsapp_elenco_chat': {
        const _pwe = await globalThis.Pagine.preparaPagina('whatsapp_chat');
        if (!_pwe.ok) return _pwe;
        const viva = _pwe.scheda;

        // Anche leggere e' un gesto che si vede. Su LinkedIn il ritmo c'era e
        // qui no: sessantaquattro righe lette in un millisecondo, ogni volta
        // allo stesso modo, sono una firma quanto un invio raffica.
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'veloce', async () => {});

        // Il selettore lo chiede alla mappa: la prima volta lo impara guardando,
        // le volte dopo lo riusa, e se il DOM cambia lo ritrova da solo.
        let selRighe = null, comeLoSoWa = 'scritto a mano';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'elenco_conversazioni');
          if (m.ok) { selRighe = m.selettore; comeLoSoWa = m.dallaMemoria ? 'gia\' noto dalla mappa' : m.come; }
        }

        const r = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          args: [Number(args.quante) || 40, selRighe],
          func: (quante, selRighe) => {
            const elenco = document.querySelector('#pane-side');
            if (!elenco) return { ok: false, motivo: 'non trovo l\'elenco chat (#pane-side)' };

            // ── Quale selettore, lo dice la pagina ──
            //
            // Al primo tentativo avevo scelto [role="listitem"] e ho trovato
            // zero righe: WhatsApp non lo usa piu'. Indovinare un secondo
            // selettore sarebbe stato lo stesso errore due volte.
            //
            // Il selettore imparato dalla mappa ha la precedenza: se regge, si
            // usa quello e non si prova nient'altro.
            //
            // Quindi si provano i candidati e vince quello che trova piu'
            // righe. Nota che "role=row" qui e' innocuo, mentre e' proprio
            // quello che rovinava la lettura dei moduli del Navigator: la
            // differenza non e' il selettore, e' che qui si cerca DENTRO
            // #pane-side, dove le bolle della conversazione non arrivano.
            // Il selettore imparato dalla mappa va provato per primo: se regge,
            // gli altri non si guardano nemmeno. Se non regge, si ricade sui
            // candidati e la mappa imparera' quello nuovo al giro dopo.
            const candidati = [
              ...(selRighe ? [selRighe] : []),
              '[data-testid="cell-frame-container"]',
              '[role="listitem"]',
              '[role="row"]',
              '[role="gridcell"]',
              'div[data-id]',
            ];
            let scelto = null, righe = [];
            for (const sel of candidati) {
              let trovate = [...elenco.querySelectorAll(sel)];

              // ── Solo le righe piu' esterne ──
              //
              // WhatsApp annida: una riga della lista ne contiene un'altra con
              // lo stesso ruolo. Prendendole tutte, ogni conversazione viene
              // contata due volte — il 7 agosto la prova dal vivo ha restituito
              // 198 righe per 68 conversazioni, con ogni nome ripetuto.
              //
              // Contare di piu' non e' contare meglio. Si tengono solo gli
              // elementi che non stanno dentro un altro elemento gia' preso.
              trovate = trovate.filter(el => !trovate.some(altro => altro !== el && altro.contains(el)));

              if (trovate.length > righe.length) { righe = trovate; scelto = sel; }
            }

            // Nessun candidato: si riporta com'e' fatto il contenitore, cosi'
            // la prossima mossa parte da un fatto invece che da un'ipotesi.
            if (!righe.length) {
              const campione = [...elenco.querySelectorAll('*')].slice(0, 400);
              const conteggio = {};
              for (const el of campione) {
                const chiave = el.getAttribute('role') ? 'role=' + el.getAttribute('role')
                  : el.getAttribute('data-testid') ? 'data-testid=' + el.getAttribute('data-testid')
                  : null;
                if (chiave) conteggio[chiave] = (conteggio[chiave] || 0) + 1;
              }
              return {
                ok: false,
                motivo: 'dentro #pane-side non riconosco le righe',
                figli: elenco.children.length,
                elementi: campione.length,
                cosaCeDentro: Object.entries(conteggio).sort((a, b) => b[1] - a[1]).slice(0, 12),
              };
            }

            // ── Nome, anteprima e ora: da dove si prendono davvero ──
            //
            // La prima versione leggeva riga.innerText e ne ricavava tutto.
            // Provata sulle chat vere di Luca il 7 agosto: nomi giusti, ma
            // anteprima e ora VUOTE per tutte e 64 le conversazioni. WhatsApp
            // mette quei testi in nodi che innerText non restituisce.
            //
            // Verificato sulla pagina: ogni riga ha due span[title] — il primo
            // e' il contatto, il secondo l'ultimo messaggio. L'ora sta in un
            // nodo a parte e si riconosce dalla forma.
            const chat = righe.map((riga) => {
              const titoli = [...riga.querySelectorAll('span[title], [title]')]
                .map(e => (e.getAttribute('title') || '').trim());
              const nome = titoli[0] || '';
              // Il carattere invisibile che WhatsApp mette attorno all'anteprima
              // (U+202A/U+202C, direzione del testo) va tolto o si porta dietro
              // caratteri che non si vedono ma sporcano i confronti.
              const anteprima = (titoli[1] || '').replace(/[‪-‮⁦-⁩]/g, '').slice(0, 160);

              let ora = '';
              for (const n of riga.querySelectorAll('div, span')) {
                const s = (n.textContent || '').trim();
                if (s.length < 12 && /^(\d{1,2}[:.]\d{2}|ieri|oggi|yesterday|today|\d{1,2}\/\d{1,2}\/\d{2,4}|luned|marted|mercoled|gioved|venerd|sabato|domenica)/i.test(s)) {
                  ora = s; break;
                }
              }

              let nonLetti = 0;
              for (const e of riga.querySelectorAll('[aria-label]')) {
                const m = (e.getAttribute('aria-label') || '').match(/(\d+)\s*(messagg|non lett|unread)/i);
                if (m) { nonLetti = parseInt(m[1], 10); break; }
              }

              return { nome, anteprima, ora, nonLetti };
            }).filter(c => c.nome);

            // Cintura e bretelle: se due righe diverse portano lo stesso nome,
            // per Luca sono la stessa conversazione. La struttura puo' cambiare
            // ancora; il fatto che un contatto sia uno solo, no.
            const visti = new Set();
            const unici = chat.filter(c => {
              if (visti.has(c.nome)) return false;
              visti.add(c.nome);
              return true;
            });

            return {
              ok: true,
              selettore: scelto,
              righeGuardate: righe.length,
              conNome: chat.length,
              conversazioni: unici.length,
              conNonLetti: unici.filter(c => c.nonLetti > 0).length,
              chat: unici.slice(0, quante),
            };
          },
        });
        return r[0].result;
      }

      case 'whatsapp_non_letti':
        // ── I non letti sono una VISTA dell'elenco, non un'altra lettura ──
        //
        // Qui c'era Actions.readUnreadMessages(), il lettore del Navigator.
        // Misurato sul WhatsApp vero: circa 150 righe sbagliate, perche'
        // cercava role="row" su TUTTA la pagina e prendeva insieme le righe
        // della barra laterale e le bolle della conversazione aperta. Usciva
        // roba come contact:"We will do tomorrow" (un messaggio scambiato per
        // un contatto) e lastMessage:"wds-ic-read" (un'icona scambiata per un
        // messaggio).
        //
        // whatsapp_elenco_chat quel problema non ce l'ha: cerca DENTRO
        // #pane-side, dove le bolle non arrivano, e conta gia' i non letti riga
        // per riga. Il difetto non era il selettore, era il perimetro.
        //
        // Quindi non si scrive un secondo lettore: si filtra il primo. Una
        // implementazione sola, due viste — che e' anche il modo di non
        // ritrovarsi fra un mese con due letture che divergono.
        {
          const tutte = await executeCommand('whatsapp_elenco_chat',
            { quante: Number(args.quante) || 60 });
          if (!tutte || !tutte.ok) return tutte;
          const conNonLetti = (tutte.chat || []).filter(c => Number(c.nonLetti) > 0);
          return {
            ...tutte,
            chat: conNonLetti,
            conversazioni: conNonLetti.length,
            messaggiNonLetti: conNonLetti.reduce((n, c) => n + Number(c.nonLetti || 0), 0),
            suQuante: (tutte.chat || []).length,
          };
        }

      // Duplicato di whatsapp_leggi_conversazione, che passa da Pagine e Mappa.
      case 'whatsapp_conversazione':
        return await executeCommand('whatsapp_leggi_conversazione',
          { nome: args.contatto || args.nome, quanti: args.quanti || 30 });

      // ── whatsapp_scrivi: rimosso, si passa da whatsapp_rispondi ──
      //
      // Delegava a sendWhatsAppMessage, che sceglie la scheda con
      // existingTabs[0]: la PRIMA scheda WhatsApp trovata. Luca ne tiene due
      // aperte. Quella prima scheda puo' essere il codice QR, una scheda
      // sospesa, o una chat diversa da quella giusta — e il messaggio parte
      // lo stesso. Non verifica chi c'e' dall'altra parte, non ha ritmo.
      //
      // whatsapp_rispondi apre la conversazione per nome, LEGGE il nome in
      // cima e se non riesce a leggerlo NON scrive. E' la stessa regola per
      // cui esiste questo progetto: meglio non mandare che mandare a uno
      // sconosciuto.
      case 'whatsapp_scrivi':
        return { ok: false, motivo: 'strada dismessa: usa whatsapp_rispondi (verifica il destinatario)' };

      case 'whatsapp_diagnosi':
        return await Esterni.con('wa', (m) => m.Actions.diagnostic(), args.modo || 'automatico');

      case 'linkedin_profilo':
        return await Esterni.con('li', (m) => m.Actions.extractProfileByUrl(args.url), args.modo || 'automatico');

      case 'linkedin_cerca':
        return await Esterni.con('li', (m) => m.Actions.searchProfile(args.chi), args.modo || 'automatico');

      // Duplicato di linkedin_elenco_chat. Il lettore vecchio, misurato sulla
      // messaggistica vera il 7 agosto: 26 righe per 12 conversazioni (ogni
      // persona due volte, la seconda vuota) in 28 secondi. Il nuovo: 10
      // conversazioni pulite in 0,1 secondi.
      case 'linkedin_posta':
        return await executeCommand('linkedin_elenco_chat',
          { quante: args.quante || 50 });

      // Duplicato di linkedin_leggi_conversazione.
      case 'linkedin_conversazione':
        return await executeCommand('linkedin_leggi_conversazione',
          { nome: args.contatto || args.nome, quanti: args.quanti || 30 });

      // ── linkedin_scrivi: converge su linkedin_rispondi ──
      //
      // Delegava a sendLinkedInMessage, che pretende un indirizzo di profilo.
      // Il codice ha cose buone — controlla lo slug, si rifiuta se la scheda
      // e' su un'altra conversazione — ma non ha il ritmo umano, non passa
      // dalla mappa dei selettori, e cerca i pulsanti con offsetParent, che
      // sui riquadri `position: fixed` li scarta come invisibili.
      //
      // Soprattutto: era la porta da cui si usciva dal percorso controllato
      // semplicemente passando un indirizzo invece di un nome. Adesso
      // linkedin_rispondi accetta anche `url` e fa lo stesso lavoro con le
      // verifiche al posto giusto.
      case 'linkedin_scrivi':
        return await executeCommand('linkedin_rispondi',
          { url: args.url, nome: args.nome, testo: args.testo });

      case 'linkedin_diagnosi':
        return await Esterni.con('li', (m) => m.Actions.diagnostic(), args.modo || 'automatico');

      // Quali schede ci sono, e su quali si puo' davvero guardare.
      //
      // Serve a rispondere a una domanda precisa senza indovinare: quando un
      // modulo dice "non riesco ad accedere alla pagina", su QUALE pagina non
      // riesce? Le pagine chrome:// e il Web Store sono vietate a ogni
      // estensione, e se la scheda scelta e' una di quelle l'errore parla di
      // permessi ma il problema e' la scelta.
      case 'elenco_schede': {
        const schede = await chrome.tabs.query({});
        const vietata = (u) => /^(chrome|edge|about|devtools|view-source):/i.test(u || '')
          || /chrome\.google\.com\/webstore|chromewebstore\.google\.com/i.test(u || '');
        return {
          quante: schede.length,
          whatsapp: schede.filter(t => /web\.whatsapp\.com/i.test(t.url || ''))
            .map(t => ({ id: t.id, url: t.url, attiva: t.active, stato: t.status, finestra: t.windowId })),
          linkedin: schede.filter(t => /linkedin\.com/i.test(t.url || ''))
            .map(t => ({ id: t.id, url: (t.url || '').slice(0, 70), attiva: t.active })),
          // Se COBRA riesce a leggere QUESTA, il permesso c'e'.
          provaLettura: await (async () => {
            const wa = schede.find(t => /web\.whatsapp\.com/i.test(t.url || ''));
            if (!wa) return 'nessuna scheda WhatsApp aperta';
            try {
              const r = await chrome.scripting.executeScript({
                target: { tabId: wa.id },
                func: () => ({ titolo: document.title, caratteri: (document.body?.innerText || '').length }),
              });
              return { riuscita: true, ...r[0].result };
            } catch (e) { return { riuscita: false, errore: e.message }; }
          })(),
          attiva: (schede.find(t => t.active) || {}).url,
          vietate: schede.filter(t => vietata(t.url)).map(t => (t.url || '').slice(0, 50)),
        };
      }

      // ── Come stanno WhatsApp e LinkedIn, per il badge in alto ──
      //
      // COMPLETAMENTE PASSIVO. Questo comando non tocca le pagine, non inietta
      // niente, non manda una sola richiesta di rete. Se WhatsApp e LinkedIn
      // fossero due persone che ci guardano, da qui non vedrebbero nulla.
      //
      // Il primo tentativo non era cosi': leggevo il DOM ogni venti secondi.
      // Nessuna richiesta di rete, d'accordo, ma comunque uno script iniettato
      // in continuazione in una pagina che non me lo aveva chiesto — per
      // accendere una spia. Luca ha avuto ragione a fermarmi: "meno grave"
      // non e' "zero", e su una spia decorativa il costo giusto e' zero.
      //
      // Da dove viene l'informazione, adesso:
      //
      //   1. chrome.tabs.query — dice se la scheda esiste e se e' caricata.
      //      E' l'elenco che Chrome tiene per conto suo: leggerlo non tocca
      //      nessun sito.
      //
      //   2. chrome.cookies — per LinkedIn c'e' il cookie `li_at`, che esiste
      //      solo se la sessione e' aperta. Chrome ce l'ha gia' sul disco:
      //      leggerlo e' come guardare in tasca, non come bussare alla porta.
      //
      //   3. La MEMORIA dell'ultima operazione vera. Quando COBRA fa davvero
      //      qualcosa — legge le chat, verifica la sessione — l'esito resta
      //      registrato. Il badge mostra quello, e dice quanto e' vecchio.
      //
      // WhatsApp non ha un cookie che dica "sei dentro" (la sessione vive in
      // IndexedDB, che senza toccare la pagina non si legge). Quindi per
      // WhatsApp il badge si fida della memoria, e se e' vecchia lo dichiara
      // invece di fingere di sapere. Dire "verificato venti minuti fa" e'
      // piu' onesto che dire "collegato" senza aver guardato.
      case 'stato_canali': {
        const schede = await chrome.tabs.query({});
        const ricordo = (await chrome.storage.local.get(['cobra_canali'])).cobra_canali || {};

        const cerca = (regex) => {
          const t = schede.filter(x => regex.test(x.url || ''));
          if (!t.length) return { scheda: false, caricata: false };
          const viva = t.find(x => x.status === 'complete');
          return { scheda: true, caricata: !!viva, quante: t.length,
            titolo: (viva || t[0]).title || '' };
        };

        const eta = (quando) => {
          if (!quando) return null;
          const m = Math.round((Date.now() - quando) / 60000);
          if (m < 1) return 'adesso';
          if (m < 60) return `${m} minuti fa`;
          const o = Math.round(m / 60);
          return o < 24 ? `${o} ore fa` : `${Math.round(o / 24)} giorni fa`;
        };

        // ── LinkedIn: il cookie dice la verita' senza chiedere niente ──
        const li = cerca(/linkedin\.com/i);
        let liDentro = null;
        try {
          const c = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
          liDentro = !!(c && c.value);
        } catch (_) { liDentro = null; }

        const linkedin = {
          scheda: li.scheda,
          connesso: liDentro === true,
          perche: liDentro === true ? null
            : liDentro === false ? 'sessione non attiva: devi entrare tu'
            : li.scheda ? 'non riesco a leggere lo stato della sessione'
            : 'nessuna scheda aperta',
          come: 'cookie di sessione — nessun contatto con LinkedIn',
          ultimoLavoro: eta(ricordo.li?.quando),
        };

        // ── WhatsApp: memoria, piu' quello che dice la scheda ──
        //
        // Il titolo della scheda e' l'unica cosa che WhatsApp scrive fuori
        // dalla pagina: diventa "(3) WhatsApp" quando ci sono non letti. Non
        // dice se sei dentro, ma dice che l'applicazione sta girando.
        const wa = cerca(/web\.whatsapp\.com/i);
        const nonLetti = (wa.titolo.match(/^\((\d+)\)/) || [])[1];
        const memoriaWa = ricordo.wa || {};
        const recente = memoriaWa.quando && (Date.now() - memoriaWa.quando) < 30 * 60000;

        const whatsapp = {
          scheda: wa.scheda,
          connesso: !!(wa.caricata && (recente ? memoriaWa.dentro : nonLetti !== undefined)),
          perche: !wa.scheda ? 'nessuna scheda aperta'
            : !wa.caricata ? 'scheda scaricata da Chrome'
            : recente ? (memoriaWa.dentro ? null : (memoriaWa.perche || 'non risultavi dentro'))
            : nonLetti !== undefined ? null
            : 'non verifico da un po\': lo sapro\' al prossimo lavoro',
          nonLetti: nonLetti ? Number(nonLetti) : null,
          come: recente ? 'ultimo lavoro vero' : 'titolo della scheda — nessun contatto con WhatsApp',
          ultimoLavoro: eta(memoriaWa.quando),
        };

        return { whatsapp, linkedin, passivo: true };
      }

      // ── L'elenco delle conversazioni LinkedIn ──
      //
      // Scritto guardando la pagina vera il 7 agosto, non a memoria. Il
      // lettore del Navigator (readLinkedInInbox, metodo "legacy-structural")
      // su quella stessa pagina restituiva 26 righe per 12 conversazioni:
      // ogni contatto compariva due volte, la seconda vuota. E' lo stesso
      // difetto che aveva su WhatsApp — prende elementi annidati e li conta
      // tutti — e per giunta ci arriva solo dopo che il metodo principale
      // scade (optimus_inbox_timeout_12000ms), quindi 28 secondi per un dato
      // sbagliato.
      //
      // Qui si legge una volta sola, dal contenitore giusto.
      //
      // COSA NON C'E', e va detto: nella messaggistica LinkedIn non esiste
      // nessun link al profilo delle persone — verificato, zero <a href="/in/">
      // in tutta la pagina. Il numero della conversazione sta solo
      // nell'indirizzo, e compare dopo averla aperta. Per questo qui si torna
      // il NOME: e' l'unica chiave che la pagina offre davvero.
      case 'linkedin_elenco_chat': {
        // Regola di Luca: mai in serie, mai sovrapposte, mai meccaniche.
        // Ritmo.comeUnaPersona mette in coda (una operazione per volta),
        // aspetta una pausa gaussiana, muove il mouse su una traiettoria
        // curva e ogni tanto scorre. Se il modulo non e' caricato si procede
        // lo stesso: meglio senza ritmo che fermi.
        // Una funzione sola porta sulla pagina giusta: la cerca, la sveglia,
        // o la apre in secondo piano. Prima questo blocco era lungo trenta
        // righe ed era diverso in ognuno dei cinque comandi.
        const _pe = await globalThis.Pagine.preparaPagina('linkedin_messaggi');
        if (!_pe.ok) return _pe;
        const viva = _pe.scheda;
        const apertaDaMe = !!_pe.apertaDaMe;

        // ── Il selettore lo chiede alla mappa, non lo sa a memoria ──
        //
        // La prima volta guarda la pagina e impara; le volte dopo usa quello
        // che sa, e ci mette un millisecondo. Se il DOM e' cambiato, il
        // selettore imparato non regge piu' e la mappa ne trova un altro da
        // sola: il lavoro prosegue, e la riscoperta viene detta invece di
        // essere nascosta.
        let selRighe = 'li.msg-conversation-listitem';
        let comeLoSo = 'scritto a mano (mappa non disponibile)';
        let riscoperto = false;
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'elenco_conversazioni');
          if (m.ok) {
            selRighe = m.selettore;
            comeLoSo = m.dallaMemoria ? 'gia\' noto dalla mappa' : m.come;
            riscoperto = !!m.riscoperto;
          }
        }

        const r = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          args: [Number(args.quante) || 50, selRighe],
          func: (quante, selRighe) => {
            const righe = document.querySelectorAll(selRighe);
            if (!righe.length) {
              return {
                ok: false,
                motivo: 'non trovo le conversazioni',
                cosaFare: 'Apri https://www.linkedin.com/messaging/ e riprova.',
                cosaCeDentro: document.title.slice(0, 80),
              };
            }

            // Righe che non sono persone: la barra di stato in fondo, e le
            // InMail pubblicitarie che mettono l'etichetta al posto del nome.
            const NON_PERSONE = /^(stato:|messaggio inmail$|sponsorizzat)/i;

            const chat = [];
            const visti = new Set();
            for (const el of righe) {
              const n = el.querySelector('.msg-conversation-listitem__participant-names, h3');
              const nome = n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
              if (!nome || NON_PERSONE.test(nome)) continue;
              if (visti.has(nome)) continue;      // niente doppioni
              visti.add(nome);

              const p = el.querySelector('.msg-conversation-card__message-snippet, .msg-conversation-card__message-snippet-body');
              const t = el.querySelector('time, .msg-conversation-listitem__time-stamp');
              chat.push({
                nome,
                anteprima: p ? p.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
                quando: t ? t.innerText.trim() : '',
                nonLetto: !!el.querySelector('.msg-conversation-card__unread-count, [class*="unread"]'),
              });
              if (chat.length >= quante) break;
            }

            return {
              ok: true,
              righeGuardate: righe.length,
              conversazioni: chat.length,
              conNonLetti: chat.filter(c => c.nonLetto).length,
              // Detto apertamente, perche' chi legge questa risposta deve
              // sapere cosa NON puo' fare con essa.
              nota: 'La messaggistica LinkedIn non espone il profilo di nessuno: '
                + 'per rispondere si usa il nome, non un indirizzo.',
              chat,
            };
          },
        });
        if (r?.[0]?.result) {
          r[0].result.selettore = selRighe;
          r[0].result.comeLoSo = comeLoSo;
          if (riscoperto) {
            r[0].result.paginaCambiata = 'Il selettore che conoscevo non funzionava piu\': '
              + 'ho riguardato la pagina e ne ho imparato uno nuovo (' + selRighe + ').';
          }
        }
        const esito = r?.[0]?.result || { ok: false, motivo: 'la pagina non ha risposto' };

        // ── La foto della pagina che ho letto davvero ──
        //
        // Il pannello di COBRA restava nero durante le letture. Il comando
        // 'screenshot' fotografa la scheda ATTIVA, che quasi sempre e' COBRA
        // stesso o un'altra cosa: la messaggistica sta in un'altra scheda, a
        // volte perfino in secondo piano.
        //
        // Quindi la foto si scatta qui, dove si sa quale scheda e'. Cosi' Luca
        // vede la pagina da cui sono usciti quei nomi, e puo' controllarla a
        // occhio in un secondo invece di fidarsi.
        if (esito.ok) {
          const foto = await fotoDi(viva.id);
          if (foto.screenshot) esito.screenshot = foto.screenshot;
          esito.url = foto.url;
          if (foto.perche) esito.notaFoto = foto.perche;
        }
        // Se la scheda l'ho aperta io e non e' servita a niente, la chiudo:
        // lasciarne in giro una a ogni tentativo fallito e' come Luca si e'
        // ritrovato con centocinquanta copie dell'estensione.
        if (apertaDaMe && !esito.ok) { try { await chrome.tabs.remove(viva.id); } catch (_) {} }
        else if (apertaDaMe) esito.nota2 = 'Ho aperto io la scheda della messaggistica: era su un\'altra pagina.';
        return esito;
      }

      // ── Aprire una conversazione e leggerla per intero ──
      //
      // Domanda di Luca, 7 agosto: "se legge la pagina e non entra nel
      // messaggio di ognuno, come riporta i risultati?". Non li riportava: la
      // lista da' solo l'anteprima, centocinquanta caratteri tagliati a meta'.
      // Un riepilogo costruito su quelle e' un riepilogo di titoli, non di
      // messaggi — e infatti diceva cose come "ha inviato un allegato".
      //
      // Qui la conversazione si apre davvero e si leggono i messaggi uno per
      // uno, con chi ha scritto e quando.
      //
      // UN EFFETTO DA SAPERE: aprire una conversazione la segna come letta su
      // LinkedIn. Non e' evitabile — succede anche a una persona che clicca —
      // ma va detto, perche' e' un cambiamento sull'account di Luca fatto per
      // leggere, non per scrivere.
      case 'linkedin_leggi_conversazione': {
        // Regola di Luca: mai in serie, mai sovrapposte, mai meccaniche.
        // Ritmo.comeUnaPersona mette in coda (una operazione per volta),
        // aspetta una pausa gaussiana, muove il mouse su una traiettoria
        // curva e ogni tanto scorre. Se il modulo non e' caricato si procede
        // lo stesso: meglio senza ritmo che fermi.
        const chi = String(args.nome || args.contact || '').trim();
        if (!chi) return { ok: false, motivo: 'non mi hai detto quale conversazione' };

        const _pl = await globalThis.Pagine.preparaPagina('linkedin_messaggi');
        if (!_pl.ok) return _pl;
        const viva = _pl.scheda;

        // 1. Trovare la riga e aprirla — dopo aver aspettato il proprio turno,
        //    con la pausa e il movimento del mouse di una persona.
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const righe = [...document.querySelectorAll('li.msg-conversation-listitem')];
            const nomeDi = (el) => {
              const n = el.querySelector('.msg-conversation-listitem__participant-names, h3');
              return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
            };
            let trovate = righe.filter(el => piatto(nomeDi(el)) === cerca);
            if (!trovate.length) trovate = righe.filter(el => piatto(nomeDi(el)).includes(cerca));

            if (!trovate.length) {
              return { ok: false, motivo: `non trovo nessuna conversazione con "${chi}"`,
                disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 12) };
            }
            // Piu' di una: NON si sceglie. Aprire la conversazione sbagliata
            // significa segnarla come letta e riferire le parole di un altro.
            if (trovate.length > 1) {
              return { ok: false, ambiguo: true,
                motivo: `"${chi}" corrisponde a ${trovate.length} conversazioni`,
                candidati: trovate.map(nomeDi) };
            }
            const el = trovate[0];
            const cliccabile = el.querySelector('.msg-conversation-listitem__link, a, [role="link"]') || el;
            cliccabile.click();
            return { ok: true, aperta: nomeDi(el) };
          },
        });
        const esitoApri = apri?.[0]?.result;
        if (!esitoApri || !esitoApri.ok) return esitoApri || { ok: false, motivo: 'la pagina non ha risposto' };

        // 2. Aspettare che i messaggi compaiano. Leggere subito significa
        //    leggere la conversazione precedente, ancora sullo schermo.
        await new Promise(r => setTimeout(r, 2500));

        let selMsg = '.msg-s-event-listitem';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'messaggi');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selMsg = m.selettore;
        }

        const leggi = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [Number(args.quanti) || 30, esitoApri.aperta, selMsg],
          func: (quanti, aperta, selMsg) => {
            const nodi = [...document.querySelectorAll(selMsg)];
            if (!nodi.length) return { ok: false, motivo: 'la conversazione si e\' aperta ma non vedo messaggi' };

            const messaggi = [];
            let ultimoAutore = '';
            for (const n of nodi.slice(-quanti)) {
              const a = n.querySelector('.msg-s-message-group__name');
              // LinkedIn scrive il nome solo sul primo messaggio di un gruppo:
              // i successivi dello stesso autore non lo ripetono.
              if (a && a.innerText.trim()) ultimoAutore = a.innerText.replace(/\s+/g, ' ').trim();
              const t = n.querySelector('.msg-s-event-listitem__body');
              const q = n.querySelector('time, .msg-s-message-group__timestamp');
              const testo = t ? t.innerText.replace(/\n{3,}/g, '\n\n').trim() : '';
              if (!testo) continue;
              messaggi.push({ da: ultimoAutore || '(sconosciuto)', quando: q ? q.innerText.trim() : '', testo });
            }
            return { ok: true, conversazione: aperta, quanti: messaggi.length, messaggi,
              nota: 'Aprire la conversazione l\'ha segnata come letta su LinkedIn.' };
          },
        });

        const esito = leggi?.[0]?.result || { ok: false, motivo: 'non riesco a leggere i messaggi' };
        if (esito.ok) {
          const foto = await fotoDi(viva.id);
          if (foto.screenshot) esito.screenshot = foto.screenshot;
          esito.url = foto.url;
          if (foto.perche) esito.notaFoto = foto.perche;
        }
        return esito;
      }

      // ── Rispondere dentro la conversazione ──
      //
      // Il pezzo che chiudeva il cerchio: leggere serve a poco se poi non si
      // puo' rispondere. Prima l'unica strada era linkedin_send_message, che
      // vuole l'indirizzo di un profilo — un dato che la messaggistica non
      // espone. Quindi si poteva leggere Samuel Chen e non rispondergli mai.
      //
      // Qui si apre la conversazione per nome (stesso codice della lettura,
      // stesse garanzie: se il nome corrisponde a due persone ci si ferma) e
      // si scrive nella casella che e' gia' li'.
      //
      // La casella si svuota e si VERIFICA che si sia svuotata, come su
      // WhatsApp: e' il difetto che ha fatto arrivare a Jose "test cobratest
      // cobratest cobra". Qui non e' ancora successo, e non deve.
      // ── Chiedere il collegamento a qualcuno ──
      //
      // Questo comando non c'era, e il buco e' costato l'8 agosto intero.
      // `linkedin_connect` passava da `extRelay` — cioe' da un'ALTRA
      // estensione LinkedIn, quella con `direction: from-webapp-li`, che sul
      // computer di Luca non risponde. Nessuno raccoglieva il comando: nessuna
      // pagina si apriva, nessun errore, solo un'attesa fino al timeout.
      // Quattro tentativi, quattro "Extension timeout", e Luca che diceva la
      // cosa giusta: "io non vedo cercare su linkedin la pagina corretta".
      //
      // Il ponte di COBRA aveva gia' nove comandi LinkedIn funzionanti e non
      // questo. Adesso e' qui, con lo stesso metodo degli altri: la pagina se
      // la prepara Pagine, il ritmo lo mette Ritmo, e il pulsante si cerca per
      // SIGNIFICATO — ruolo piu' nome accessibile — non per classe CSS.
      case 'linkedin_collegati': {
        const url = String(args.url || args.profilo || '').trim();
        const nota = String(args.nota || args.note || args.testo || '');
        if (!/linkedin\.com\/(in|pub)\//i.test(url)) {
          return { ok: false, motivo: 'serve l\'indirizzo di un profilo LinkedIn' };
        }

        const _pc = await globalThis.Pagine.preparaPagina('linkedin_profilo', { vai: url });
        if (!_pc.ok) return _pc;
        const viva = _pc.scheda;

        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});
        await new Promise(r => setTimeout(r, 2000));

        // 1. Chi e' aperto davvero? Come per i messaggi: se non si legge il
        //    nome non si va avanti. Un invito alla persona sbagliata non si
        //    richiama piu' di un messaggio.
        const chiCe = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [url],
          func: (atteso) => {
            const h1 = document.querySelector('h1');
            const slug = (location.pathname.match(/\/in\/([^/]+)/) || [])[1] || '';
            const attesoSlug = (String(atteso).match(/\/in\/([^/?#]+)/) || [])[1] || '';
            const piatto = (x) => String(x || '').replace(/[-_]/g, ' ')
              .replace(/\s+\S*\d\S*$/, '').toLowerCase().trim();
            return {
              nome: h1 ? h1.innerText.trim() : '',
              stessaPagina: piatto(slug) === piatto(attesoSlug),
              url: location.href,
            };
          },
        });
        const q = chiCe?.[0]?.result;
        if (!q || !q.nome) return { ok: false, motivo: 'non riesco a leggere di chi e\' il profilo: non procedo' };
        if (!q.stessaPagina) return { ok: false, motivo: `sono finito su un altro profilo (${q.url}): non procedo` };

        // 2. Il pulsante "Collegati". A volte e' in vista, a volte sta dentro
        //    il menu "Altro": si guarda prima fuori, poi dentro.
        if (globalThis.Ritmo) await globalThis.Ritmo.primaDiScrivere();
        const premi = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          func: async () => {
            const attendi = (ms) => new Promise(r => setTimeout(r, ms));
            const nomeDi = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
            // Un elemento in `position: fixed` ha SEMPRE offsetParent nullo:
            // e' cosi' che funziona il posizionamento fisso. Il riquadro
            // "Aggiungi una nota" di LinkedIn e' esattamente questo, quindi
            // filtrare su offsetParent lo avrebbe scartato come invisibile.
            // Stesso difetto che teneva a schermo i banner dei cookie.
            const siVede = (el) => {
              try {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const st = getComputedStyle(el);
                return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
              } catch (_) { return false; }
            };
            const bottoni = () => [...document.querySelectorAll('button, a[role="button"]')].filter(siVede);
            const cerca = (re) => bottoni().find(b => re.test(nomeDi(b)));

            const collega = /^(collegati|connect)\b/i;
            const gia = /(in attesa|pending|messaggio|message)$/i;

            let b = cerca(collega);
            if (!b) {
              // Dietro "Altro": si apre e si riguarda.
              const altro = cerca(/^(altro|more)\b/i);
              if (altro) { altro.click(); await attendi(1200); b = cerca(collega); }
            }
            if (!b) {
              const inAttesa = bottoni().find(x => /^(in attesa|pending)\b/i.test(nomeDi(x)));
              if (inAttesa) return { ok: false, gia: true, motivo: 'la richiesta era gia\' in attesa' };
              return { ok: false, motivo: 'non trovo il pulsante Collegati',
                visti: bottoni().map(nomeDi).filter(Boolean).slice(0, 15) };
            }
            b.click();
            await attendi(2000);
            return { ok: true, premuto: nomeDi(b) };
          },
        });
        const pr = premi?.[0]?.result;
        if (!pr || !pr.ok) return pr || { ok: false, motivo: 'la pagina non ha risposto' };

        // 3. La nota, se c'e'. "Aggiungi una nota" → si scrive → "Invia".
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'pensare', async () => {});
        const invia = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [nota],
          func: async (nota) => {
            const attendi = (ms) => new Promise(r => setTimeout(r, ms));
            const nomeDi = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
            // Un elemento in `position: fixed` ha SEMPRE offsetParent nullo:
            // e' cosi' che funziona il posizionamento fisso. Il riquadro
            // "Aggiungi una nota" di LinkedIn e' esattamente questo, quindi
            // filtrare su offsetParent lo avrebbe scartato come invisibile.
            // Stesso difetto che teneva a schermo i banner dei cookie.
            const siVede = (el) => {
              try {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const st = getComputedStyle(el);
                return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
              } catch (_) { return false; }
            };
            const visibili = () => [...document.querySelectorAll('button')].filter(siVede);
            const cerca = (re) => visibili().find(b => re.test(nomeDi(b)));

            if (nota && nota.trim()) {
              const aggiungi = cerca(/^(aggiungi una nota|add a note)\b/i);
              if (aggiungi) {
                aggiungi.click();
                await attendi(1200);
                const campo = document.querySelector('textarea[name="message"], textarea#custom-message, textarea');
                if (!campo) return { ok: false, motivo: 'non trovo il campo della nota' };
                campo.focus();
                // A pezzetti, non tutto insieme: come scrive una persona.
                campo.value = '';
                for (const pezzo of String(nota).match(/.{1,4}/g) || []) {
                  campo.value += pezzo;
                  campo.dispatchEvent(new Event('input', { bubbles: true }));
                  await attendi(40 + Math.random() * 90);
                }
                await attendi(600);
              }
            }

            const spedisci = cerca(/^(invia(\s+ora)?|send(\s+now)?|invia senza nota|send without a note)\b/i);
            if (!spedisci) return { ok: false, motivo: 'non trovo il pulsante Invia',
              visti: visibili().map(nomeDi).filter(Boolean).slice(0, 15) };
            spedisci.click();
            await attendi(2000);
            return { ok: true, premuto: nomeDi(spedisci) };
          },
        });
        const iv = invia?.[0]?.result;
        if (!iv || !iv.ok) return iv || { ok: false, motivo: 'la pagina non ha risposto' };

        // 4. La prova: il pulsante deve essere diventato "In attesa".
        await new Promise(r => setTimeout(r, 2500));
        const prova = await chrome.scripting.executeScript({
          target: { tabId: viva.id },
          func: () => {
            const testo = document.body.innerText;
            return { inAttesa: /\b(in attesa|pending)\b/i.test(testo),
              collegatiAncoraLi: /\b(collegati|connect)\b/i.test(testo) };
          },
        });
        const pv = prova?.[0]?.result || {};
        return { ok: true, a: q.nome, url: q.url, conNota: !!(nota && nota.trim()),
          confermato: !!pv.inAttesa,
          nota: pv.inAttesa ? 'il profilo dice "In attesa": la richiesta e\' partita'
            : 'non vedo "In attesa" sul profilo: verifica a mano' };
      }

      case 'linkedin_rispondi': {
        // Regola di Luca: mai in serie, mai sovrapposte, mai meccaniche.
        // Ritmo.comeUnaPersona mette in coda (una operazione per volta),
        // aspetta una pausa gaussiana, muove il mouse su una traiettoria
        // curva e ogni tanto scorre. Se il modulo non e' caricato si procede
        // lo stesso: meglio senza ritmo che fermi.
        const chi = String(args.nome || args.a || '').trim();
        const profilo = String(args.url || args.profilo || '').trim();
        const testo = String(args.testo || '');
        if (!testo) return { ok: false, motivo: 'serve il testo' };
        if (!chi && !profilo) return { ok: false, motivo: 'serve il nome o l\'indirizzo del profilo' };

        // ── Con un indirizzo si parte dal profilo, non dall'elenco chat ──
        //
        // Prima questa strada non c'era e il server mandava gli indirizzi al
        // comando vendorizzato, fuori da ogni verifica. Qui invece si apre il
        // profilo, si controlla che lo slug sia proprio quello chiesto, si
        // legge il nome, e da li' si apre la finestra di scrittura: dopodiche'
        // il testo passa dallo stesso identico percorso del caso "per nome".
        if (profilo && !chi) {
          const _pp = await globalThis.Pagine.preparaPagina('linkedin_profilo', { vai: profilo });
          if (!_pp.ok) return _pp;
          const t = _pp.scheda;
          if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(t.id, 'leggere', async () => {});
          await new Promise(r => setTimeout(r, 1800));

          const ap = await chrome.scripting.executeScript({
            target: { tabId: t.id }, args: [profilo],
            func: async (atteso) => {
              const attendi = (ms) => new Promise(r => setTimeout(r, ms));
              const siVede = (el) => {
                try {
                  const r = el.getBoundingClientRect();
                  if (r.width < 2 || r.height < 2) return false;
                  const st = getComputedStyle(el);
                  return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
                } catch (_) { return false; }
              };
              const piatto = (x) => String(x || '').replace(/[-_]/g, ' ')
                .replace(/\s+\S*\d\S*$/, '').toLowerCase().trim();
              const mio = (location.pathname.match(/\/in\/([^/]+)/) || [])[1] || '';
              const suo = (String(atteso).match(/\/in\/([^/?#]+)/) || [])[1] || '';
              if (piatto(mio) !== piatto(suo)) {
                return { ok: false, motivo: `sono su un altro profilo (${location.href}): non scrivo` };
              }
              const h1 = document.querySelector('h1');
              const nome = h1 ? h1.innerText.trim() : '';
              if (!nome) return { ok: false, motivo: 'non riesco a leggere di chi e\' il profilo: non scrivo' };

              const nomeDi = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
              const b = [...document.querySelectorAll('button, a[role="button"]')]
                .filter(siVede).find(x => /^(invia messaggio|message|messaggio)\b/i.test(nomeDi(x)));
              if (!b) return { ok: false, motivo: `non trovo il pulsante per scrivere a ${nome}` };
              b.click();
              await attendi(2500);
              return { ok: true, nome };
            },
          });
          const a0 = ap?.[0]?.result;
          if (!a0 || !a0.ok) return a0 || { ok: false, motivo: 'la pagina non ha risposto' };
          // Da qui in poi la finestra di scrittura e' aperta sul profilo
          // giusto: si prosegue come per una conversazione aperta.
          args = { ...args, nome: a0.nome };
          return await executeCommand('linkedin_rispondi', { nome: a0.nome, testo });
        }

        const _pr = await globalThis.Pagine.preparaPagina('linkedin_messaggi');
        if (!_pr.ok) return _pr;
        const viva = _pr.scheda;

        // 1. Aprire la conversazione giusta (o fermarsi).
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const righe = [...document.querySelectorAll('li.msg-conversation-listitem')];
            const nomeDi = (el) => {
              const n = el.querySelector('.msg-conversation-listitem__participant-names, h3');
              return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
            };
            let t = righe.filter(el => piatto(nomeDi(el)) === cerca);
            if (!t.length) t = righe.filter(el => piatto(nomeDi(el)).includes(cerca));
            if (!t.length) return { ok: false, motivo: `non trovo "${chi}" fra le conversazioni`,
              disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 12) };
            if (t.length > 1) return { ok: false, ambiguo: true,
              motivo: `"${chi}" corrisponde a ${t.length} conversazioni`, candidati: t.map(nomeDi) };
            (t[0].querySelector('.msg-conversation-listitem__link, a, [role="link"]') || t[0]).click();
            return { ok: true, aperta: nomeDi(t[0]) };
          },
        });
        const a = apri?.[0]?.result;
        if (!a || !a.ok) return a || { ok: false, motivo: 'la pagina non ha risposto' };

        await new Promise(r => setTimeout(r, 2500));

        // Prima di scrivere una persona legge quello che le hanno mandato e ci
        // pensa su. Scrivere nell'istante in cui la conversazione si apre e'
        // il gesto meno umano di tutti.
        if (globalThis.Ritmo) { await globalThis.Ritmo.primaDiScrivere(); await globalThis.Ritmo.comeUnaPersona(viva.id, 'pensare', async () => {}); }

        // ── Verificare CHI c'e' aperto, come su WhatsApp ──
        //
        // Qui non c'era per niente: si apriva la conversazione e si scriveva.
        // Su WhatsApp il controllo c'era (rotto, ma c'era); qui mancava del
        // tutto. E' l'ennesima asimmetria fra le due strade, e sta sul percorso
        // dove un errore manda un messaggio a uno sconosciuto.
        //
        // Il titolo su LinkedIn e' in chiaro, verificato sulla pagina:
        // .msg-entity-lockup__entity-title dice "Samuel Chen".
        //
        // Se non si riesce a leggerlo NON si scrive: nel dubbio si perde un
        // invio, non si sbaglia persona.
        const conferma = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [a.aperta],
          func: (atteso) => {
            const e = document.querySelector('.msg-entity-lockup__entity-title, .msg-title-bar h2, [class*="entity-title"]');
            const chi = e ? (e.innerText || '').split('\n')[0].trim() : '';
            if (!chi) return { chi: null, perche: 'non riesco a leggere il nome in cima alla conversazione' };
            const piatto = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            return { chi, combacia: piatto(chi) === piatto(atteso) };
          },
        });
        const c = conferma?.[0]?.result;
        if (!c || !c.chi) {
          return { ok: false,
            motivo: c?.perche || 'non riesco a verificare quale conversazione e\' aperta',
            cosaFare: 'Non scrivo senza sapere a chi. Riprova, o aprila tu e dimmelo.' };
        }
        if (!c.combacia) {
          return { ok: false,
            motivo: `ho chiesto "${a.aperta}" ma in cima vedo "${c.chi}": non scrivo`,
            cosaFare: 'La conversazione aperta non e\' quella giusta. Riferiscilo a Luca.' };
        }

        // 2. Scrivere e mandare.
        // La casella dalla mappa: se il DOM cambia, la ritrova da sola —
        // anche per significato, cioe' "la casella dove si scrive un messaggio".
        let selCasellaLi = '.msg-form__contenteditable';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'casella_scrittura');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selCasellaLi = m.selettore;
        }

        const inviato = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [testo, a.aperta, selCasellaLi],
          func: async (testo, aperta, selCasella) => {
            const box = document.querySelector(selCasella)
              || document.querySelector('.msg-form__contenteditable, div[contenteditable="true"][role="textbox"]');
            if (!box) return { ok: false, motivo: 'non trovo la casella di scrittura' };
            box.focus();

            const svuota = () => {
              try {
                const r = document.createRange(); r.selectNodeContents(box);
                const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                document.execCommand('delete', false);
              } catch (e) { /* si riprova */ }
            };
            let residuo = '';
            for (let i = 0; i < 3; i++) {
              svuota();
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
              try {
                box.innerHTML = '';
                box.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
              } catch (e) { /* ignore */ }
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
            }
            if (residuo) {
              return { ok: false, motivo: 'casella_non_vuota', residuo: residuo.slice(0, 120),
                perche: 'Nella casella e\' rimasto del testo: se scrivessi adesso partirebbe attaccato al mio.' };
            }

            // ── Si scrive a pezzi, non di colpo ──
            //
            // Regola di Luca: niente modifiche troppo rapide. Un messaggio di
            // duecento caratteri che compare tutto insieme in un millisecondo
            // non e' scritto da nessuno: e' incollato da un programma. Qui il
            // testo entra a gruppi di poche lettere, con pause diverse ogni
            // volta e qualche sosta piu' lunga dopo la punteggiatura, come chi
            // rilegge la frase prima di continuare.
            //
            // Resta l'incollata come riserva: se il modo lento non attecchisce
            // (Lexical a volte ignora insertText), meglio un messaggio inviato
            // in fretta che un messaggio non inviato.
            const uguale = () => (box.innerText || '').trim() === testo.trim();
            const attesa = (ms) => new Promise(r => setTimeout(r, ms));

            let scritto = '';
            for (let i = 0; i < testo.length && !uguale();) {
              const pezzo = 2 + Math.floor(Math.random() * 4);   // 2-5 caratteri
              const parte = testo.slice(i, i + pezzo);
              try { document.execCommand('insertText', false, parte); }
              catch (e) { break; }
              scritto += parte;
              i += pezzo;
              // Il ritmo di chi scrive non e' costante.
              let pausa = 45 + Math.random() * 110;
              if (/[.,;:!?]\s*$/.test(parte)) pausa += 200 + Math.random() * 400;
              if (Math.random() < 0.07) pausa += 500 + Math.random() * 900;  // si ferma a pensare
              await attesa(pausa);
            }

            if (!uguale()) {
              try {
                const dt = new DataTransfer(); dt.setData('text/plain', testo);
                box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
              } catch (e) { /* ignore */ }
            }
            if (!uguale()) { try { document.execCommand('insertText', false, testo); } catch (e) { /* ignore */ } }
            if (!uguale()) {
              try {
                box.textContent = testo;
                box.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: testo, bubbles: true, composed: true }));
              } catch (e) { /* ignore */ }
            }
            if (!uguale()) return { ok: false, motivo: 'non riesco a scrivere nella casella',
              dentro: (box.innerText || '').slice(0, 80) };

            // Una persona rilegge prima di premere Invia.
            await attesa(700 + Math.random() * 1600);
            const bottone = [...document.querySelectorAll('button')]
              .find(b => /invia|send/i.test(b.innerText || b.getAttribute('aria-label') || '') && !b.disabled);
            if (!bottone) return { ok: false, motivo: 'il pulsante Invia e\' disattivato: il testo non e\' stato accettato' };
            bottone.click();
            await new Promise(r => setTimeout(r, 1200));

            // La prova che e' partito: la casella si e' svuotata da sola.
            const partito = !(box.innerText || '').trim();
            return partito
              ? { ok: true, a: aperta, testo }
              : { ok: false, motivo: 'ho premuto Invia ma il testo e\' ancora nella casella' };
          },
        });
        return inviato?.[0]?.result || { ok: false, motivo: 'la pagina non ha risposto' };
      }

      // ── Aprire una chat WhatsApp e leggerla ──
      //
      // Scritta da zero il 7 agosto. Quella del Navigator — readThread in
      // wa/actions.js — non ha mai potuto funzionare: chiama
      // _pageOpenAndReadThread e _pageDomReadMessages, e nessuna delle due
      // esiste in nessun file. Ogni chiamata finiva nel catch e tornava
      // { success: false }. Nessuno se n'era accorto perche' il fallimento
      // sembrava un problema di sessione.
      //
      // DUE COSE IMPARATE GUARDANDO LA PAGINA, non a memoria:
      //
      //   1. Un .click() sulla riga NON apre la chat. WhatsApp ascolta la
      //      sequenza vera del puntatore: pointerdown, mousedown, pointerup,
      //      mouseup, click. Con il solo click la pagina non si muove, e si
      //      finisce a leggere la conversazione precedente.
      //
      //   2. Autore e orario non stanno nel testo: stanno nell'attributo
      //      data-pre-plain-text, nella forma "[04:57, 07/08/2026] Luca: ".
      //      E' l'unico punto dove WhatsApp li mette insieme.
      //
      // EFFETTO DA SAPERE: aprire una chat la segna come letta. Vale anche
      // per una persona che clicca, ma qui e' un programma a farlo su
      // richiesta, e va detto.
      // ── Scrivere in una chat WhatsApp aperta per nome ──
      //
      // Gemello di linkedin_rispondi, e nasce da un'asimmetria trovata
      // rileggendo il codice a fine giornata.
      //
      // whatsapp_scrivi passava da sendWhatsAppMessage del Navigator, che
      // prende `existingTabs[0]`: la PRIMA scheda WhatsApp che trova. Luca ne
      // ha due aperte. Se la prima e' quella ferma sul QR o svuotata da Chrome,
      // l'invio fallisce — o peggio, scrive nella conversazione sbagliata.
      //
      // E' lo stesso difetto che ho corretto oggi in cinque punti diversi. Su
      // una lettura costa un errore; su un invio costa un messaggio mandato
      // alla persona sbagliata, e quello non si richiama.
      //
      // Con un NUMERO la strada del Navigator resta giusta: /send?phone= apre
      // la chat esatta senza ambiguita'. Con un NOME si passa di qui.
      case 'whatsapp_rispondi': {
        const chi = String(args.nome || args.a || '').trim();
        const testo = String(args.testo || '');
        if (!chi || !testo) return { ok: false, motivo: 'servono il nome e il testo' };

        const _pw = await globalThis.Pagine.preparaPagina('whatsapp_chat');
        if (!_pw.ok) return _pw;
        const viva = _pw.scheda;

        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        // 1. Aprire la chat giusta, o fermarsi.
        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const pane = document.querySelector('#pane-side');
            if (!pane) return { ok: false, motivo: 'non trovo l\'elenco chat' };
            const righe = [...pane.querySelectorAll('[role="row"]')];
            const nomeDi = (r) => { const t = r.querySelector('span[title]'); return t ? (t.getAttribute('title') || '').trim() : ''; };
            let t = righe.filter(r => piatto(nomeDi(r)) === cerca);
            if (!t.length) t = righe.filter(r => piatto(nomeDi(r)).includes(cerca));
            if (!t.length) return { ok: false, motivo: `non trovo nessuna chat con "${chi}"`,
              disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 15) };
            if (t.length > 1) return { ok: false, ambiguo: true,
              motivo: `"${chi}" corrisponde a ${t.length} chat`, candidati: t.map(nomeDi) };

            const riga = t[0];
            const bersaglio = riga.querySelector('[data-testid="cell-frame-container"]')
              || riga.querySelector('[role="gridcell"]') || riga;
            const b = bersaglio.getBoundingClientRect();
            const x = b.left + b.width / 2, y = b.top + b.height / 2;
            // La sequenza intera: col solo click la chat non si apre.
            for (const tipo of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                                'pointerup', 'mouseup', 'click']) {
              const C = tipo.startsWith('pointer') ? PointerEvent : MouseEvent;
              bersaglio.dispatchEvent(new C(tipo, { bubbles: true, cancelable: true,
                composed: true, clientX: x, clientY: y, button: 0 }));
            }
            return { ok: true, aperta: nomeDi(riga) };
          },
        });
        const a = apri?.[0]?.result;
        if (!a || !a.ok) return a || { ok: false, motivo: 'la pagina non ha risposto' };

        await new Promise(r => setTimeout(r, 2500));
        if (globalThis.Ritmo) await globalThis.Ritmo.primaDiScrivere();

        // ── 2. Verificare CHI c'e' aperto, e fermarsi se non si riesce ──
        //
        // La prima versione cercava `#main header span[title]` e trovava
        // "Dettagli profilo" — l'etichetta del bottone che apre la scheda del
        // contatto. Il nome della persona nell'header di WhatsApp NON sta in un
        // attributo: sta nel testo.
        //
        // Il difetto era doppio, e il secondo peggiore del primo: trovando una
        // stringa qualsiasi il controllo la confrontava, non combaciava mai
        // davvero, ma la condizione `!chi` lo faceva passare lo stesso. Una rete
        // di sicurezza che restituisce sempre "vai" non e' una rete: e' una
        // decorazione. E sta sul percorso peggiore, quello dove un errore manda
        // un messaggio a uno sconosciuto.
        //
        // Adesso: si legge il nome dal testo, e se non si riesce a leggerlo NON
        // si scrive. Nel dubbio si perde un invio, non si sbaglia persona.
        const conferma = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [a.aperta],
          func: (atteso) => {
            const h = document.querySelector('#main header');
            if (!h) return { chi: null, perche: 'nessuna conversazione aperta' };

            // Il nome e' il primo testo utile: si scartano le etichette dei
            // bottoni e le righe di stato ("online", "sta scrivendo...").
            const scarta = /^(online|digitando|sta scrivendo|typing|click|clicca|dettagli|profil|ultimo accesso|last seen|tocca qui)/i;
            let chi = null;
            for (const n of h.querySelectorAll('span, div, h1, h2')) {
              if (n.querySelector('span, div, h1, h2')) continue;   // solo le foglie
              const t = (n.textContent || '').trim();
              if (!t || t.length > 80 || scarta.test(t)) continue;
              chi = t; break;
            }
            if (!chi) return { chi: null, perche: 'non riesco a leggere il nome in cima alla chat' };

            const piatto = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            return { chi, combacia: piatto(chi) === piatto(atteso) };
          },
        });
        const c = conferma?.[0]?.result;
        if (!c || !c.chi) {
          return { ok: false,
            motivo: c?.perche || 'non riesco a verificare quale chat e\' aperta',
            cosaFare: 'Non scrivo senza sapere a chi: nel dubbio si perde un invio, '
              + 'non si sbaglia persona. Riprova, o aprila tu e dimmelo.' };
        }
        if (!c.combacia) {
          return { ok: false,
            motivo: `ho chiesto "${a.aperta}" ma in cima alla chat vedo "${c.chi}": non scrivo`,
            cosaFare: 'La conversazione aperta non e\' quella giusta. Riferiscilo a Luca.' };
        }

        // 3. Scrivere e mandare.
        let selCasellaWa = 'footer [contenteditable="true"][data-tab]';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'casella_scrittura');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selCasellaWa = m.selettore;
        }

        const inviato = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [testo, a.aperta, selCasellaWa],
          func: async (testo, aperta, selCasella) => {
            const attesa = (ms) => new Promise(r => setTimeout(r, ms));
            const box = document.querySelector(selCasella)
              || document.querySelector('footer [contenteditable="true"][data-tab], footer [contenteditable="true"]');
            if (!box) return { ok: false, motivo: 'non trovo la casella di scrittura' };
            box.focus();

            // Svuotare e VERIFICARE: e' il difetto che ha fatto arrivare a Jose
            // "test cobratest cobratest cobra".
            let residuo = '';
            for (let i = 0; i < 3; i++) {
              try {
                const r = document.createRange(); r.selectNodeContents(box);
                const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
                document.execCommand('delete', false);
              } catch (e) { /* si riprova */ }
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
              try {
                box.textContent = '';
                box.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
              } catch (e) { /* ignore */ }
              residuo = (box.innerText || '').trim();
              if (!residuo) break;
            }
            if (residuo) return { ok: false, motivo: 'casella_non_vuota', residuo: residuo.slice(0, 120) };

            // Uguale, non "contiene": la differenza che produceva i doppioni.
            const uguale = () => (box.innerText || '').trim() === testo.trim();
            for (let i = 0; i < testo.length && !uguale();) {
              const pezzo = 2 + Math.floor(Math.random() * 4);
              const parte = testo.slice(i, i + pezzo);
              try { document.execCommand('insertText', false, parte); } catch (e) { break; }
              i += pezzo;
              let pausa = 45 + Math.random() * 110;
              if (/[.,;:!?]\s*$/.test(parte)) pausa += 200 + Math.random() * 400;
              if (Math.random() < 0.07) pausa += 500 + Math.random() * 900;
              await attesa(pausa);
            }
            if (!uguale()) {
              try {
                const dt = new DataTransfer(); dt.setData('text/plain', testo);
                box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
              } catch (e) { /* ignore */ }
            }
            if (!uguale()) return { ok: false, motivo: 'non riesco a scrivere nella casella',
              dentro: (box.innerText || '').slice(0, 80) };

            await attesa(700 + Math.random() * 1600);
            const bottone = document.querySelector('[data-testid="send"], [aria-label*="Invia" i], [aria-label*="Send" i]');
            if (bottone) bottone.click();
            else {
              box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            }
            await attesa(1200);

            // La prova che e' partito: la casella si e' svuotata da sola.
            return (box.innerText || '').trim()
              ? { ok: false, motivo: 'ho premuto invio ma il testo e\' ancora nella casella' }
              : { ok: true, a: aperta, testo };
          },
        });
        return inviato?.[0]?.result || { ok: false, motivo: 'la pagina non ha risposto' };
      }

      case 'whatsapp_leggi_conversazione': {
        const chi = String(args.nome || args.contact || '').trim();
        if (!chi) return { ok: false, motivo: 'non mi hai detto quale chat' };

        const _pw = await globalThis.Pagine.preparaPagina('whatsapp_chat');
        if (!_pw.ok) return _pw;
        const viva = _pw.scheda;

        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(viva.id, 'leggere', async () => {});

        const apri = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [chi],
          func: (chi) => {
            const piatto = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const cerca = piatto(chi);
            const pane = document.querySelector('#pane-side');
            if (!pane) return { ok: false, motivo: 'non trovo l\'elenco chat' };

            const righe = [...pane.querySelectorAll('[role="row"]')];
            const nomeDi = (r) => {
              const t = r.querySelector('span[title]');
              return t ? (t.getAttribute('title') || '').trim() : '';
            };
            let t = righe.filter(r => piatto(nomeDi(r)) === cerca);
            if (!t.length) t = righe.filter(r => piatto(nomeDi(r)).includes(cerca));

            if (!t.length) {
              return { ok: false, motivo: `non trovo nessuna chat con "${chi}"`,
                disponibili: righe.map(nomeDi).filter(Boolean).slice(0, 15) };
            }
            // Due omonimi: non si sceglie. Aprire la chat sbagliata la segna
            // come letta e fa riferire le parole di un altro.
            if (t.length > 1) {
              return { ok: false, ambiguo: true,
                motivo: `"${chi}" corrisponde a ${t.length} chat`,
                candidati: t.map(nomeDi) };
            }

            const riga = t[0];
            const bersaglio = riga.querySelector('[data-testid="cell-frame-container"]')
              || riga.querySelector('[role="gridcell"]') || riga;
            const b = bersaglio.getBoundingClientRect();
            const x = b.left + b.width / 2, y = b.top + b.height / 2;
            // La sequenza intera: col solo click la chat non si apre.
            for (const tipo of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                                'pointerup', 'mouseup', 'click']) {
              const C = tipo.startsWith('pointer') ? PointerEvent : MouseEvent;
              bersaglio.dispatchEvent(new C(tipo, {
                bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0,
              }));
            }
            return { ok: true, aperta: nomeDi(riga) };
          },
        });
        const a = apri?.[0]?.result;
        if (!a || !a.ok) return a || { ok: false, motivo: 'la pagina non ha risposto' };

        await new Promise(r => setTimeout(r, 2500));

        let selMsgWa = '[data-pre-plain-text]';
        if (globalThis.Mappa) {
          const m = await globalThis.Mappa.selettorePer(viva.id, viva.url, 'messaggi');
          if (m.ok && m.selettore !== '__TESTO_INTESTAZIONE__') selMsgWa = m.selettore;
        }

        const leggi = await chrome.scripting.executeScript({
          target: { tabId: viva.id }, args: [Number(args.quanti) || 40, a.aperta, selMsgWa],
          func: (quanti, aperta, selMsgWa) => {
            const main = document.querySelector('#main');
            if (!main) return { ok: false, motivo: 'la chat non si e\' aperta' };

            const nodi = [...main.querySelectorAll(selMsgWa)];
            if (!nodi.length) {
              return { ok: true, conversazione: aperta, quanti: 0, messaggi: [],
                nota: 'La chat e\' aperta ma non contiene messaggi di testo: '
                  + 'puo\' essere fatta solo di immagini, audio o allegati.' };
            }

            const messaggi = [];
            for (const n of nodi.slice(-quanti)) {
              const pre = n.getAttribute('data-pre-plain-text') || '';
              const m = pre.match(/^\[([^,\]]+),\s*([^\]]+)\]\s*(.*?):\s*$/);
              const t = n.querySelector('span.selectable-text, span[dir]') || n;
              const testo = (t.innerText || '').replace(/\s+/g, ' ').trim();
              if (!testo) continue;
              messaggi.push({
                da: m ? m[3] : '(sconosciuto)',
                quando: m ? `${m[1]} ${m[2]}` : '',
                testo,
              });
            }
            return { ok: true, conversazione: aperta, quanti: messaggi.length, messaggi,
              nota: 'Aprire la chat l\'ha segnata come letta su WhatsApp.' };
          },
        });

        const esito = leggi?.[0]?.result || { ok: false, motivo: 'non riesco a leggere i messaggi' };
        if (esito.ok) {
          const foto = await fotoDi(viva.id);
          if (foto.screenshot) esito.screenshot = foto.screenshot;
          esito.url = foto.url;
          if (foto.perche) esito.notaFoto = foto.perche;
        }
        return esito;
      }

      // ── "La pagina e' cambiata?" ──
      //
      // Domanda di Luca, 7 agosto: se il DOM cambia, COBRA se ne deve
      // accorgere. Giusto, e prima non se ne accorgeva: un selettore che non
      // trova niente restituisce una lista vuota, e "lista vuota" diventava
      // "non hai messaggi" — detto serenamente a chi ne aveva otto.
      //
      // Questo comando prova tutti i selettori su entrambi i siti e dice
      // quali reggono, quali stanno andando di riserva e quali sono morti.
      // Legge soltanto: non apre, non clicca, non manda niente.
      // ── Cosa ha imparato la mappa ──
      case 'mappa_pagine':
        if (!globalThis.Mappa) return { ok: false, motivo: 'mappa.js non caricato' };
        return await globalThis.Mappa.quelloCheSo();

      // Dimentica quello che sa: il prossimo uso riparte guardando la pagina.
      // Serve quando si vuole forzare una riscoperta senza aspettare un guasto.
      case 'mappa_dimentica':
        if (!globalThis.Mappa) return { ok: false, motivo: 'mappa.js non caricato' };
        return await globalThis.Mappa.dimentica(args.pagina || null);

      case 'diagnosi_selettori':
        if (!globalThis.Selettori) return { ok: false, motivo: 'selettori.js non caricato' };
        return await globalThis.Selettori.diagnosi();

      // Sblocca la coda del ritmo. Serve se un'operazione e' rimasta appesa
      // (tipico: la pagina ricaricata mentre COBRA la stava leggendo).
      case 'sblocca_coda':
        return globalThis.Ritmo ? globalThis.Ritmo.sbloccaCoda()
                                : { ok: false, motivo: 'ritmo non caricato' };

      case 'stato_ritmo':
        return globalThis.Ritmo ? await globalThis.Ritmo.stato() : { errore: 'ritmo non caricato' };

      case 'stato_moduli_esterni':
        return Esterni.stato();

      // ── Entrare in un sito chiuso ──
      //
      // La password arriva qui dal server e finisce nel campo. Non viene
      // registrata, non torna nella risposta, non passa dal modello.
      //
      // Prima si guarda se si e' GIA' dentro: la sessione condivisa del
      // profilo di Luca spesso e' ancora valida, e in quel caso rifare
      // l'accesso e' solo un rischio in piu'.
      case 'compila_accesso': {
        const tab = await getWorkTab();
        if (args.url) {
          await chrome.tabs.update(tab.id, { url: args.url });
          await waitForTabLoad(tab.id, 15000);
          await new Promise(r => setTimeout(r, 1200));
        }

        const trovaCampi = () => {
          const vedi = (el) => {
            const r = el.getBoundingClientRect();
            return r.width >= 2 && r.height >= 2;
          };
          const tutti = [...document.querySelectorAll('input')].filter(vedi);
          const pwd = tutti.find(i => (i.type || '').toLowerCase() === 'password');
          const utente = tutti.find(i => {
            const t = (i.type || '').toLowerCase();
            const n = ((i.name || '') + ' ' + (i.id || '') + ' ' + (i.autocomplete || '')
              + ' ' + (i.placeholder || '')).toLowerCase();
            return (t === 'email' || t === 'text' || t === 'tel')
              && /user|email|mail|login|account|utente|username|userid/.test(n);
          }) || tutti.find(i => ['email', 'text'].includes((i.type || '').toLowerCase()));
          return { utente, pwd };
        };

        // Si e' gia' dentro? Se non c'e' un campo password, quasi certamente si'.
        const stato = await run(tab.id, () => {
          const pwd = [...document.querySelectorAll('input')].find(i => {
            const r = i.getBoundingClientRect();
            return (i.type || '').toLowerCase() === 'password' && r.width >= 2 && r.height >= 2;
          });
          const testo = (document.body.innerText || '').toLowerCase();
          return {
            campoPassword: !!pwd,
            sembraDentro: !pwd && /esci|logout|il mio account|my account|dashboard|benvenut/.test(testo),
          };
        });
        if (stato && !stato.campoPassword) {
          return { ok: true, gia: true, motivo: 'la sessione era ancora valida: non ho rifatto l\'accesso' };
        }

        // Si compila. Il setter nativo serve ai moduli fatti in React, che
        // altrimenti riscrivono il campo appena si gira lo sguardo.
        const esito = await run(tab.id, (u, p, sorgenteTrova) => {
          // eslint-disable-next-line no-new-func
          const trova = new Function('return ' + sorgenteTrova)();
          const { utente, pwd } = trova();
          if (!pwd) return { ok: false, motivo: 'non trovo il campo della password' };

          const scrivi = (el, valore) => {
            el.focus();
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
            if (setter && setter.set) setter.set.call(el, valore); else el.value = valore;
            for (const e of ['input', 'change', 'blur']) el.dispatchEvent(new Event(e, { bubbles: true }));
            return el.value === valore;
          };

          const okU = utente ? scrivi(utente, u) : true;
          const okP = scrivi(pwd, p);
          if (!okP) return { ok: false, motivo: 'la pagina ha rifiutato il valore nel campo password' };

          // Il pulsante di invio: quello del modulo, o il primo che lo dice.
          const modulo = pwd.form;
          let invio = modulo && modulo.querySelector('button[type="submit"], input[type="submit"]');
          if (!invio) {
            invio = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
              .find(b => {
                const r = b.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const t = ((b.innerText || b.value || '') + '').trim().toLowerCase();
                return /^(accedi|entra|login|log in|sign in|continua|invia|submit)$/.test(t);
              });
          }
          if (invio) { invio.click(); return { ok: true, compilati: { utente: okU, password: true }, inviato: true }; }
          if (modulo) { try { modulo.submit(); return { ok: true, inviato: true, via: 'modulo' }; } catch (_) { /* niente */ } }
          return { ok: false, motivo: 'campi compilati ma non trovo il pulsante per entrare' };
        }, [String(args.utente || ''), String(args.password || ''), trovaCampi.toString()]);

        if (!esito || !esito.ok) return esito || { ok: false, motivo: 'accesso non riuscito' };

        await waitForTabLoad(tab.id, 15000);
        await new Promise(r => setTimeout(r, 1500));

        // Ha funzionato davvero? Se c'e' ancora un campo password, no. E se
        // chiede un codice, serve una persona: non e' un fallimento nostro.
        const dopo = await run(tab.id, () => {
          const t = (document.body.innerText || '').toLowerCase();
          const pwd = [...document.querySelectorAll('input')].some(i => {
            const r = i.getBoundingClientRect();
            return (i.type || '').toLowerCase() === 'password' && r.width >= 2 && r.height >= 2;
          });
          return {
            ancoraFuori: pwd,
            chiedeCodice: /codice di verifica|verification code|autenticazione a due|two.?factor|otp|sms/.test(t),
            erroreCredenziali: /credenziali non valide|password errata|incorrect password|invalid (username|password|credentials)/.test(t),
          };
        });

        if (dopo && dopo.chiedeCodice) {
          return { ok: false, serveUmano: true, motivo: 'il sito chiede un codice di verifica' };
        }
        if (dopo && dopo.erroreCredenziali) {
          return { ok: false, motivo: 'il sito dice che le credenziali non sono valide' };
        }
        if (dopo && dopo.ancoraFuori) {
          return { ok: false, motivo: 'dopo l\'invio c\'e\' ancora il modulo di accesso' };
        }
        return { ok: true, entrato: true };
      }

      case 'compila_campo': {
        const tab = await getWorkTab();
        await muoviCursoreSu(tab.id, args.selettore, 'scrivo');
        return await run(tab.id, (sel, valore) => {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, motivo: 'campo non trovato', selettore: sel };

          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return { ok: false, motivo: 'campo presente ma non visibile', selettore: sel };
          if (el.disabled) return { ok: false, motivo: 'campo disabilitato: la pagina non permette di compilarlo', selettore: sel };
          if (el.readOnly) return { ok: false, motivo: 'campo di sola lettura', selettore: sel };

          const tag = el.tagName.toLowerCase();
          const tipo = (el.type || '').toLowerCase();
          const testo = String(valore);
          const avvisa = () => {
            for (const e of ['input', 'change', 'blur']) el.dispatchEvent(new Event(e, { bubbles: true }));
          };

          try { el.focus(); } catch (_) { /* alcuni campi non prendono il fuoco */ }

          // ── Elenco a tendina ──
          if (tag === 'select') {
            const opzioni = [...el.options];
            const norm = (x) => String(x || '').trim().toLowerCase();
            let scelta = opzioni.find(o => norm(o.value) === norm(testo))
              || opzioni.find(o => norm(o.text) === norm(testo))
              || opzioni.find(o => norm(o.text).includes(norm(testo)));
            if (!scelta) {
              return { ok: false, motivo: 'nessuna opzione corrisponde', selettore: sel,
                opzioniDisponibili: opzioni.slice(0, 25).map(o => o.text.trim()).filter(Boolean) };
            }
            el.value = scelta.value;
            avvisa();
            return { ok: el.value === scelta.value, tipo: 'elenco', scritto: scelta.text.trim(), rilettoDalCampo: el.value };
          }

          // ── Casella e scelta singola: la spunta non è un testo ──
          if (tipo === 'checkbox' || tipo === 'radio') {
            const vuole = !(testo === 'false' || testo === '0' || testo === '' || testo === 'no');
            if (el.checked !== vuole) { try { el.click(); } catch (_) { el.checked = vuole; avvisa(); } }
            return { ok: el.checked === vuole, tipo: tipo === 'radio' ? 'scelta' : 'casella', rilettoDalCampo: el.checked };
          }

          // ── Testo modificabile (editor ricchi) ──
          if (el.isContentEditable) {
            el.textContent = testo;
            avvisa();
            return { ok: (el.textContent || '').includes(testo), tipo: 'testo libero', rilettoDalCampo: (el.textContent || '').slice(0, 80) };
          }

          // ── Campo di testo: si passa dal setter nativo, altrimenti React
          //    non si accorge del cambiamento e al primo ridisegno lo cancella.
          const proto = tag === 'textarea' ? HTMLTextAreaElement : HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
          if (setter && setter.set) setter.set.call(el, testo); else el.value = testo;
          avvisa();

          // La rilettura è il punto: un modulo che rifiuta il valore lo si
          // scopre adesso, non quando l'utente guarda il modulo mezzo vuoto.
          const dopo = el.value;
          if (dopo === testo) return { ok: true, tipo: tipo || 'testo', rilettoDalCampo: dopo };
          return { ok: false, tipo: tipo || 'testo', selettore: sel,
            motivo: dopo === '' ? 'la pagina ha svuotato il campo subito dopo'
              : 'la pagina ha cambiato il valore scritto',
            volevo: testo, rilettoDalCampo: dopo };
        }, [args.selettore, args.valore]);
      }

      // Cosa c'è davvero in un modulo, prima di provare a compilarlo.
      case 'leggi_modulo': {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const campi = [];
          for (const el of document.querySelectorAll('input, select, textarea, [contenteditable="true"]')) {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const tipo = (el.type || '').toLowerCase();
            if (tipo === 'hidden') continue;

            // L'etichetta come la vede una persona: quella collegata, quella
            // che lo contiene, il segnaposto, o il testo di aiuto.
            let etichetta = '';
            try {
              if (el.id) {
                const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (l) etichetta = l.innerText.trim();
              }
              if (!etichetta) {
                const dentro = el.closest('label');
                if (dentro) etichetta = dentro.innerText.trim();
              }
              if (!etichetta) etichetta = el.getAttribute('aria-label') || el.placeholder || '';
            } catch (_) { /* etichetta non trovata */ }

            const voce = {
              selettore: el.id ? '#' + CSS.escape(el.id)
                : el.name ? `[name="${el.name}"]`
                : el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` : null,
              etichetta: etichetta.slice(0, 80),
              tag: el.tagName.toLowerCase(),
              tipo,
              obbligatorio: !!(el.required || el.getAttribute('aria-required') === 'true'),
              disabilitato: !!el.disabled,
              solaLettura: !!el.readOnly,
              valoreAttuale: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : String(el.value || '').slice(0, 60),
            };
            if (el.tagName === 'SELECT') {
              voce.opzioni = [...el.options].slice(0, 30).map(o => o.text.trim()).filter(Boolean);
            }
            if (voce.selettore) campi.push(voce);
          }
          const invii = [...document.querySelectorAll('button[type="submit"],input[type="submit"],button')]
            .filter(b => { const r = b.getBoundingClientRect(); return r.width > 2 && r.height > 2; })
            .map(b => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 8);
          return { ok: true, campi, quanti: campi.length, pulsanti: invii };
        });
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

          // Un selettore rifiutato non deve portarsi via tutto il resto.
          //
          // querySelectorAll con una lista separata da virgole è tutto-o-niente:
          // se UNA sola parte non è valida per il motore, la chiamata solleva
          // un'eccezione e non torna NIENTE — nemmeno i pulsanti che sarebbero
          // stati trovati dalle parti valide.
          //
          // Qui dentro c'è [class*="accept" i], che usa il modificatore di
          // maiuscole/minuscole negli attributi: Chrome, Firefox e Safari lo
          // accettano da anni, ma è la parte più giovane della lista, ed è
          // stata aggiunta oggi. Se un domani un motore la rifiuta, senza
          // questa rete salterebbe l'intera rimozione degli ostacoli — e il
          // sintomo sarebbe "i banner non si tolgono più", che manda a cercare
          // dalla parte sbagliata.
          const cerca = (sel) => {
            try { return [...document.querySelectorAll(sel)]; }
            catch (_) { return []; }
          };

          // 1. Come farebbe una persona: cercare il pulsante di chiusura
          const candidati = [
            ...cerca('button,[role="button"],a[role="button"],input[type="button"],input[type="submit"],[aria-label],[class*="close"],[id*="close"]'),
            ...cerca('[class*="accept" i],[id*="accept" i]'),
          ];
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

          // 1c. I muri di accesso: si chiudono, non si attraversano.
          //
          // Google, LinkedIn, Pinterest e molti altri aprono un riquadro
          // "Accedi con Google" sopra il contenuto. Quel riquadro va tolto di
          // mezzo per continuare a leggere — quasi sempre la pagina sotto è
          // consultabile lo stesso.
          //
          // Ma NON si preme "Continua con Google". Quel gesto concede a un
          // sito l'accesso all'account di Luca: nome, indirizzo, a volte molto
          // di più, e su alcuni siti resta valido finché non lo si revoca a
          // mano. È una decisione sua, non una scorciatoia da automatizzare.
          // Se la pagina è leggibile solo dopo l'accesso, si chiede a lui.
          const testiAccesso = ['continua con google','continue with google','accedi con google',
            'sign in with google','continua con facebook','accedi con facebook','sign in with apple',
            'continua con apple','accedi con linkedin','sign in with linkedin'];
          let muroDiAccesso = null;
          for (const el of document.querySelectorAll('div,section,dialog,form,[role="dialog"]')) {
            let st; try { st = getComputedStyle(el); } catch (_) { continue; }
            if (st.position !== 'fixed' && el.tagName !== 'DIALOG') continue;
            const t = (el.innerText || '').toLowerCase();
            if (t.length > 600) continue;
            if (testiAccesso.some(x => t.includes(x))) { muroDiAccesso = el; break; }
          }
          if (muroDiAccesso) {
            // Prima si cerca la sua X, che è il modo pulito di dire "no grazie"
            let chiuso = false;
            for (const b of muroDiAccesso.querySelectorAll('button,[role="button"],[aria-label]')) {
              const et = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().toLowerCase();
              if (/^(x|✕|×|chiudi|close|dismiss|not now|non ora|salta|skip|annulla|cancel)$/.test(et)
                  || /chiudi|close|dismiss/.test(b.getAttribute('aria-label') || '')) {
                try { b.click(); chiuso = true; azioni.push('chiuso il riquadro di accesso'); break; } catch (_) { /* sparito */ }
              }
            }
            if (!chiuso) {
              try { muroDiAccesso.remove(); azioni.push('tolto il riquadro di accesso'); } catch (_) { /* gia via */ }
            }
            azioni.push('NB: non ho fatto l\'accesso, ho solo tolto il riquadro');
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
