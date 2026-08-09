// ══════════════════════════════════════════════
// WhatsApp Extension v5.10 — Tab Manager Module
// AUTOMATION WINDOW ISOLATION (no focus stealing)
// ══════════════════════════════════════════════

var TabManager = globalThis.TabManager || (function () {
  // ── Two-lane queue: session (lightweight) vs action (heavy) ──
  let _sessionQueue = Promise.resolve();
  let _actionQueue = Promise.resolve();

  // ── Automation window/tab ownership (persisted in chrome.storage.session) ──
  let _automationWindowId = null;
  let _ownedWaTabIds = new Set();
  let _creatingWaTabPromise = null;
  // 5.10.18 — Worker tab persistente (alias di getOrCreateWaTab) con
  // tracciamento dell'id corrente e flag ready, per UI/ping.
  let _workerTabId = null;
  let _workerReady = false;

  function enqueueSession(fn) {
    _sessionQueue = _sessionQueue.then(fn).catch(function (e) {
      console.error("[WA TabMgr] Session queue error:", e);
    });
  }

  function enqueueAction(fn) {
    _actionQueue = _actionQueue.then(fn).catch(function (e) {
      console.error("[WA TabMgr] Action queue error:", e);
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // ── Persistence helpers (service worker may restart) ──
  async function loadOwnership() {
    try {
      const data = await chrome.storage.session.get(["wa_automation_window", "wa_owned_tabs"]);
      if (data.wa_automation_window) _automationWindowId = data.wa_automation_window;
      if (Array.isArray(data.wa_owned_tabs)) _ownedWaTabIds = new Set(data.wa_owned_tabs);
    } catch (e) { /* session storage may be unavailable */ }
  }

  async function saveOwnership() {
    try {
      await chrome.storage.session.set({
        wa_automation_window: _automationWindowId,
        wa_owned_tabs: Array.from(_ownedWaTabIds),
      });
    } catch (e) { /* ignore */ }
  }

  function markOwned(tabId) {
    _ownedWaTabIds.add(tabId);
    saveOwnership();
  }

  function isOwned(tabId) {
    return _ownedWaTabIds.has(tabId);
  }

  function getWorkerInfo() {
    return { id: _workerTabId, ready: _workerReady };
  }

  function invalidateWorker(closedTabId) {
    if (closedTabId === undefined || closedTabId === _workerTabId) {
      _workerTabId = null;
      _workerReady = false;
    }
  }

  // ── Legacy automation window shim ──
  // Disabled: creating a minimized automation window caused repeated hidden
  // Chrome windows when multiple WA actions started while the MV3 worker was
  // cold/restarted. We now reuse an existing WhatsApp tab or create one single
  // inactive tab in the current browser window.
  async function getOrCreateAutomationWindow() {
    await loadOwnership();
    _automationWindowId = null;
    await saveOwnership();
    return null;
  }

  // ── Safe tab operations with retry ──
  async function safeCreateTab(url, active) {
    for (let i = 0; i < 3; i++) {
      try {
        const tab = await chrome.tabs.create({ url: url, active: !!active });
        markOwned(tab.id);
        return tab;
      } catch (e) {
        if (i < 2) await sleep(500 * (i + 1));
        else {
          const tab = await chrome.tabs.create({ url: url, active: false });
          markOwned(tab.id);
          return tab;
        }
      }
    }
  }

  async function safeRemoveTab(tabId) {
    try {
      await chrome.tabs.remove(tabId);
      _ownedWaTabIds.delete(tabId);
      saveOwnership();
    } catch (err) { console.debug("[WA Tab]", err?.message); }
  }

  async function waitForLoad(tabId, timeoutMs) {
    const start = Date.now();
    const limit = timeoutMs || 30000;
    while (Date.now() - start < limit) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") return true;
      } catch (err) { console.debug("[WA Tab]", err?.message); return false; }
      await sleep(500);
    }
    return false;
  }

  // ── REUSE LOGIC: only OWNED tabs are eligible (never user tabs) ──
  async function getBestExistingWaTab() {
    await loadOwnership();
    try {
      // Step 1: look ONLY among owned tabs
      const owned = Array.from(_ownedWaTabIds);
      for (const tid of owned) {
        try {
          const t = await chrome.tabs.get(tid);
          if (t && t.url && /web\.whatsapp\.com/i.test(t.url)) return t;
        } catch (e) {
          // Tab no longer exists — clean up
          _ownedWaTabIds.delete(tid);
        }
      }
      saveOwnership();
      // Step 2: reuse any user-opened web.whatsapp.com tab if available.
      // Creating a fresh tab in the automation window forces a new login (QR),
      // which breaks sends when the user is already authenticated elsewhere.
      try {
        const userTabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
        if (userTabs && userTabs[0]) {
          markOwned(userTabs[0].id);
          return userTabs[0];
        }
      } catch (e) { /* ignore */ }
      return null;
    } catch (err) { console.debug("[WA Tab]", err?.message); return null; }
  }

  async function getLastFocusedActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (err) { console.debug("[WA Tab]", err?.message); return null; }
  }

  // ── Move tab into the automation window if it isn't already there ──
  async function ensureTabInAutomationWindow(tabId) {
    markOwned(tabId);
    return true;
  }

  // ── OPTIMUS V2.1 (FOCUS-SAFE): activateAndStabilize ──
  // CONTRACT: NEVER call chrome.tabs.update({active:true}) on a tab that lives
  // in a window the user is currently working in.
  //
  // Strategy:
  //   1. Ensure the tab is in our automation window (move it if not).
  //   2. Activate it ONLY inside the automation window.
  //   3. The automation window stays minimized/unfocused — Cockpit untouched.
  //   4. No restore() is needed because we never touched the user's window.
  async function activateAndStabilize(tabId, maxWaitMs) {
    // Move tab to automation window (silent — no focus change)
    await ensureTabInAutomationWindow(tabId);

    // Activate ONLY within the automation window. If the move failed and the
    // tab is still in a user window, we MUST NOT activate it. Probe DOM as-is.
    let activatedInAutomation = false;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === _automationWindowId) {
        await chrome.tabs.update(tabId, { active: true });
        activatedInAutomation = true;
      } else {
        console.warn("[WA TabMgr] Tab " + tabId + " not in automation window — skipping activate to preserve user focus");
      }
    } catch (err) { console.debug("[WA Tab] V2.1 activate:", err?.message); }

    // Wait for DOM stable (works even without activation thanks to MV3 scripting)
    const startTime = Date.now();
    const maxWait = maxWaitMs || 3000;
    let stable = false;
    while (Date.now() - startTime < maxWait) {
      try {
        const check = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function () {
            return {
              ready: document.readyState === "complete",
              hasContent: !!(
                document.querySelector('[role="row"]') ||
                document.querySelector('#pane-side') ||
                document.querySelector('[role="grid"]')
              ),
              loading: !!(
                document.querySelector('[data-testid="startup"]') ||
                document.querySelector('.landing-window')
              ),
            };
          },
        });
        const r = check && check[0] && check[0].result;
        // We do NOT require visibilityState=visible anymore — minimized
        // automation window will report "hidden", but DOM is rendered.
        if (r && r.ready && r.hasContent && !r.loading) { stable = true; break; }
      } catch (err) { console.debug("[WA Tab] V2.1 probe:", err?.message); }
      await sleep(300);
    }
    if (stable) await sleep(500);

    return {
      stable: stable,
      previousTabId: null, // never changed user's window
      activatedInAutomation: activatedInAutomation,
      restore: async function () {
        // No-op: we never stole focus
        return;
      },
    };
  }

  // ── DEPRECATED shim — now delegates to focus-safe activateAndStabilize ──
  // Kept for backward-compat with verifySession and legacy paths.
  async function ensureTabVisibleAndWait(tabId, postActivateMs) {
    const res = await activateAndStabilize(tabId, Math.max(postActivateMs || 600, 1500));
    return !!res.stable || !!res.activatedInAutomation;
  }

  // ── DEPRECATED shim ──
  async function withTemporarilyVisibleTab(tabId, fn) {
    await ensureTabVisibleAndWait(tabId, 600);
    return await fn();
  }

  // ── Get or create WA tab (always in automation window) ──
  async function getOrCreateWaTab() {
    try {
      const existing = await getBestExistingWaTab();
      if (existing) {
        if (existing.status !== "complete") await waitForLoad(existing.id, 15000);
        await ensureTabInAutomationWindow(existing.id);
        _workerTabId = existing.id;
        _workerReady = true;
        return { tab: existing, reused: true };
      }
    } catch (err) { console.debug("[WA Tab]", err?.message); }

    if (!_creatingWaTabPromise) {
      _creatingWaTabPromise = (async function () {
        const tab = await safeCreateTab(Config.WA_BASE, false);
        const loaded = await waitForLoad(tab.id, 30000);
        if (!loaded) throw new Error("WhatsApp Web non caricato");
        await sleep(4000);
        _workerTabId = tab.id;
        _workerReady = true;
        return { tab: tab, reused: false };
      })().finally(function () { _creatingWaTabPromise = null; });
    }
    return await _creatingWaTabPromise;
  }

  // 5.10.18 — Alias semantico per la nomenclatura "worker tab" condivisa con LI.
  async function ensureWorkerTab() {
    return await getOrCreateWaTab();
  }

  // ── Bridge injection ──
  async function injectBridgeIntoFrame(tabId, frameId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId, frameIds: [frameId] },
        files: ["content.js"],
      });
      return true;
    } catch (err) { console.debug("[WA Tab]", err?.message); return false; }
  }

  async function injectBridgeIntoTab(tabId) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
      if (!frames || !frames.length) return false;
      let injected = false;
      for (let i = 0; i < frames.length; i++) {
        if (!Config.isAppUrl(frames[i].url)) continue;
        const ok = await injectBridgeIntoFrame(tabId, frames[i].frameId);
        injected = ok || injected;
      }
      return injected;
    } catch (err) { console.debug("[WA Tab]", err?.message); return false; }
  }

  async function syncBridgeAcrossOpenTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      for (let i = 0; i < tabs.length; i++) {
        if (typeof tabs[i].id !== "number") continue;
        await injectBridgeIntoTab(tabs[i].id);
      }
    } catch (err) { console.debug("[WA Tab]", err?.message); }
  }

  // Initialize ownership cache from session storage
  loadOwnership();

  return {
    sleep: sleep,
    enqueueSession: enqueueSession,
    enqueueAction: enqueueAction,
    safeCreateTab: safeCreateTab,
    safeRemoveTab: safeRemoveTab,
    waitForLoad: waitForLoad,
    getBestExistingWaTab: getBestExistingWaTab,
    getOrCreateWaTab: getOrCreateWaTab,
    ensureWorkerTab: ensureWorkerTab,
    getWorkerInfo: getWorkerInfo,
    invalidateWorker: invalidateWorker,
    getOrCreateAutomationWindow: getOrCreateAutomationWindow,
    ensureTabInAutomationWindow: ensureTabInAutomationWindow,
    isOwned: isOwned,
    activateAndStabilize: activateAndStabilize,
    ensureTabVisibleAndWait: ensureTabVisibleAndWait,
    withTemporarilyVisibleTab: withTemporarilyVisibleTab,
    injectBridgeIntoTab: injectBridgeIntoTab,
    syncBridgeAcrossOpenTabs: syncBridgeAcrossOpenTabs,
  };
})();
globalThis.TabManager = TabManager;
