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

const COBRA_WS_URL = 'ws://localhost:3000';
const COBRA_API_URL = 'http://localhost:3000';
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

function connect() {
  if (ws && ws.readyState <= 1) return;
  try {
    ws = new WebSocket(COBRA_WS_URL);
    ws.onopen = async () => {
      connected = true;
      console.log('[COBRA Bridge v2.1] Connected');
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
          if (t.url && t.url.includes('localhost:3000')) {
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
    ws.onclose = () => { connected = false; updateBadge('OFF', '#ef4444'); setTimeout(connect, 5000); };
    ws.onerror = () => { ws.close(); };
  } catch { setTimeout(connect, 5000); }
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
  if (tab.url && tab.url.includes('localhost:3000')) {
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
      if (t.url?.includes('localhost:3000')) { _cobraTabId = t.id; break; }
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

  // 3. Solo come ultima risorsa se ne crea una, in secondo piano
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

async function run(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'MAIN' });
  return results[0]?.result ?? { ok: false, error: 'No result' };
}

async function runIsolated(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results[0]?.result ?? { ok: false, error: 'No result' };
}

async function runInFrame(tabId, frameId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args, world: 'MAIN' });
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
            if ((el.textContent || '').trim().toLowerCase().includes(lower) && el.offsetParent !== null) return el;
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
          if (exact && exact.offsetParent !== null) return exact;
          // 2. Fuzzy: cerca su tutti gli elementi interattivi + custom components
          const candidates = document.querySelectorAll('input, textarea, button, select, [role="combobox"], [role="textbox"], [role="button"], [role="listbox"], [role="searchbox"], [contenteditable="true"], [aria-label], [placeholder], [title]');
          for (const el of candidates) {
            if (el.offsetParent === null) continue;
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
            if (el.offsetParent !== null) return el;
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
            if ((el.textContent || '').trim().toLowerCase().includes(textLower) && el.offsetParent !== null) return el;
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
        // Cattura dalla finestra del work tab SENZA rubare focus all'utente
        let windowId = null;
        if (_workTabId) {
          try {
            const wTab = await chrome.tabs.get(_workTabId);
            windowId = wTab.windowId;
            // Assicura che il work tab sia attivo nella SUA finestra
            // ma NON portare la finestra in primo piano (no focused: true)
            await chrome.tabs.update(_workTabId, { active: true });
            // NON fare chrome.windows.update(focused: true) — ruba focus utente
          } catch {}
          await new Promise(r => setTimeout(r, 200));
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: args.quality || 70 });
        return { ok: true, screenshot: dataUrl.split(',')[1] };
      }

      // ════════════════════════════════════════
      // 3. CLICK — realistico con sequenza eventi completa
      // ════════════════════════════════════════

      case 'click': {
        const tab = await getWorkTab();
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
                .filter(e => e.offsetParent !== null && !e.disabled);
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
            if (opt.textContent.trim().toLowerCase().includes(lower) && opt.offsetParent !== null) {
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
            visible: el.offsetParent !== null })) };
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
                if (!el || el.offsetParent === null) return { ok: true, waited: Date.now() - start, state: 'hidden' };
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
                if (el && el.offsetParent !== null && !el.disabled) return { ok: true, waited: Date.now() - start };
                break;
              }
              default: {
                // visible
                const el = resolveElement(sel);
                if (el && el.offsetParent !== null) return { ok: true, waited: Date.now() - start, state: 'visible' };
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
            if (a.offsetParent === null) continue;
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
            if (el.offsetParent === null) continue;
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
          for (const el of document.querySelectorAll('input, select, textarea, button, [role="button"], a[href], [contenteditable="true"]')) {
            if (el.offsetParent === null) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
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
          return { ok: true, url: location.href, title: document.title, elements: items.slice(0, 120) };
        }).catch(async (err) => {
          // Retry dopo breve pausa (pagina potrebbe non essere ancora pronta)
          await new Promise(r => setTimeout(r, 1500));
          try {
            return await run(tab.id, () => {
              const items = [];
              for (const el of document.querySelectorAll('input, select, textarea, button, [role="button"], a[href]')) {
                if (el.offsetParent === null) continue;
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
              .filter(el => el.offsetParent !== null).slice(0, 25)
              .map(el => ({ text: el.textContent?.trim().slice(0, 50), selector: buildSel(el), disabled: el.disabled || false })),
            inputs: [...document.querySelectorAll('input, textarea, select')]
              .filter(el => el.offsetParent !== null).slice(0, 25)
              .map(el => ({ type: el.type || el.tagName.toLowerCase(), name: el.name, placeholder: el.placeholder, value: el.value?.slice(0, 30), label: el.labels?.[0]?.textContent?.trim()?.slice(0,40) || '', selector: buildSel(el), required: el.required || false })),
            links: [...document.querySelectorAll('a[href]')]
              .filter(el => el.offsetParent !== null).slice(0, 30)
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
                results.push({ check: check.type, selector: check.selector, passed: !!(el && el.offsetParent !== null) });
                break;
              }
              case 'no_error': {
                const errors = [];
                for (const el of document.querySelectorAll('.error, .alert-danger, [class*="error"], [role="alert"]')) {
                  if (el.offsetParent !== null && el.textContent.trim()) errors.push(el.textContent.trim().substring(0, 80));
                }
                results.push({ check: check.type, passed: errors.length === 0, errors });
                break;
              }
              case 'toast': {
                const toasts = [];
                for (const el of document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="snackbar"], [role="status"]')) {
                  if (el.offsetParent !== null) toasts.push(el.textContent.trim().substring(0, 80));
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
                if (texts.some(t => txt.includes(t)) && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) {
                  el.click(); return txt;
                }
              } catch { /* shadow DOM element without getComputedStyle */ }
            }
            return null;
          }

          // 1. Reject (privacy-first)
          let clicked = findAndClick(rejectTexts);
          if (clicked) return { ok: true, action: 'rejected', button: clicked };
          // 2. Known reject selectors (also deep)
          const rejectSels = ['#onetrust-reject-all-handler', '.cmp-reject-all', 'button.fc-cta-do-not-consent',
            '[data-testid="cookie-reject"]', '.cookie-reject', '#CybotCookiebotDialogBodyButtonDecline',
            '#didomi-notice-disagree-button', '.iubenda-cs-reject-btn'];
          for (const sel of rejectSels) {
            for (const el of deepQueryAll(document, sel)) {
              try { if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') { el.click(); return { ok: true, action: 'rejected_sel', button: sel }; } } catch {}
            }
          }
          // 3. Accept
          clicked = findAndClick(acceptTexts);
          if (clicked) return { ok: true, action: 'accepted', button: clicked };
          const acceptSels = ['#onetrust-accept-btn-handler', '.cmp-accept-all', 'button.fc-cta-consent',
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '[data-testid="cookie-accept"]',
            '#didomi-notice-agree-button', '.iubenda-cs-accept-btn'];
          for (const sel of acceptSels) {
            for (const el of deepQueryAll(document, sel)) {
              try { if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') { el.click(); return { ok: true, action: 'accepted_sel', button: sel }; } } catch {}
            }
          }
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
              if (acceptTexts.some(t => txt.includes(t)) && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) {
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
                  if (rejectTexts.some(t => txt.includes(t)) && el.offsetParent !== null) {
                    el.click(); return { ok: true, action: 'rejected_iframe', button: txt };
                  }
                }
                for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                  const txt = (el.textContent || '').trim().toLowerCase();
                  if (txt.length > 80 || txt.length === 0) continue;
                  if (acceptTexts.some(t => txt.includes(t)) && el.offsetParent !== null) {
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
                if (el.offsetParent !== null) {
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
              if (closeTexts.some(t => txt.includes(t)) && el.offsetParent !== null) {
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
  if (changeInfo.url && changeInfo.url.includes('localhost:3000')) {
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

// ── Boot ──
connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
