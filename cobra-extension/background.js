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


// ── Cosa so fare, dichiarato al server ──
//
// Il server ha SEMPRE letto `msg.capabilities` all'aggancio, l'ha conservato in
// _bridgeCapabilities, l'ha esposto su /api/bridge-status e l'ha mandato alla
// webapp. Ed e' sempre stato vuoto, perche' nessuno lo riempiva: il campo
// esisteva da una parte sola.
//
// Costa questa funzione, e in cambio il server puo' accorgersi da solo che il
// service worker in esecuzione non ha caricato un file. E' il caso di
// guarda_pagina il 9 agosto: il file c'era sul disco, i sorgenti erano giusti,
// e nessuna lettura del codice poteva saperlo — solo chiedere a chi gira.
function _cosaSoFare() {
  const nomi = new Set();
  try { for (const n of (globalThis.Registro?.elenco()?.nomi || [])) nomi.add(n); } catch (_) { /* registro non caricato */ }
  // I superstiti dello switch, che nel registro non ci sono.
  for (const n of ['wait_for', 'verify_action', 'retry']) nomi.add(n);
  return [...nomi].sort();
}

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
      ws.send(JSON.stringify({ type: 'bridge_connect', token: _bridgeToken, userAgent: navigator.userAgent, version: VERSION, capabilities: _cosaSoFare() }));
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
            ws.send(JSON.stringify({ type: 'bridge_connect', token: _bridgeToken, userAgent: navigator.userAgent, version: VERSION, capabilities: _cosaSoFare() }));
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
    // ── Prima si chiede al registro ──
    //
    // I comandi stanno migrando da questo `switch` — che era di 3.804 righe —
    // ai file di esterni/comandi/. Chi e' gia' migrato risponde da li'.
    //
    // Il registro rifiuta di accettare due volte lo stesso nome, quindi un
    // comando non puo' esistere in tutti e due i posti senza che qualcuno se
    // ne accorga: e' la protezione contro il difetto che ha generato questo
    // lavoro — due implementazioni della stessa cosa, e vince quella caricata
    // per ultima.
    if (globalThis.Registro && globalThis.Registro.ha(command)) {
      return await globalThis.Registro.esegui(command, args);
    }

    switch (command) {

      // ════════════════════════════════════════
      // 1. NAVIGAZIONE
      // ════════════════════════════════════════






      // ════════════════════════════════════════
      // 2. SCREENSHOT
      // ════════════════════════════════════════


      // ════════════════════════════════════════
      // 3. CLICK — realistico con sequenza eventi completa
      // ════════════════════════════════════════





































      // ════════════════════════════════════════
      // 4. HOVER
      // ════════════════════════════════════════


      // ════════════════════════════════════════
      // 5. DRAG & DROP
      // ════════════════════════════════════════


      // ════════════════════════════════════════
      // 6. SCROLL — progressivo, per elemento, per coordinate
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 7. TASTIERA COMPLETA
      // ════════════════════════════════════════







      // ════════════════════════════════════════
      // 8. FORM — compilazione avanzata
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 9. DATEPICKER / DROPDOWN COMPLESSI
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 10. FILE UPLOAD
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 11. DOWNLOAD
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 12. CLIPBOARD
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 13. MULTI-TAB & POPUP
      // ════════════════════════════════════════





      // ════════════════════════════════════════
      // 14. IFRAME + SHADOW DOM (Modulo 2)
      // ════════════════════════════════════════







      // ════════════════════════════════════════
      // 15. DIALOG — alert, confirm, prompt, beforeunload
      // ════════════════════════════════════════


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




      // ════════════════════════════════════════
      // 17. PAGE UNDERSTANDING (Modulo 2)
      // ════════════════════════════════════════











      // ════════════════════════════════════════
      // 18. HUMAN TAKEOVER (Modulo 4)
      // ════════════════════════════════════════




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


      // ════════════════════════════════════════
      // 20b. OVERLAY / SPLASH / INTERSTITIAL DISMISS
      // ════════════════════════════════════════


      // ════════════════════════════════════════
      // 21. AUDIT LOG
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 22. SESSION / STORAGE
      // ════════════════════════════════════════



      // ════════════════════════════════════════
      // 23. TABELLE / GRIGLIE
      // ════════════════════════════════════════


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
