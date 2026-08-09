// ══════════════════════════════════════════════════
// LinkedIn Extension v3.9 — Tab Manager Module
// AUTOMATION WINDOW ISOLATION (no focus stealing)
// ══════════════════════════════════════════════════

var TabManager = globalThis.TabManager || (function () {
  let _liTabId = null;
  let _automationWindowId = null;
  let _ownedTabIds = new Set();
  // 3.9.57 — Persistent Worker Tab parcheggiata su /messaging/.
  // Tutte le operazioni read/send messaging usano questa tab di servizio.
  // Non viene MAI attivata, non ruba il focus, vive in background.
  const WORKER_HOME_URL = "https://www.linkedin.com/messaging/";
  let _workerTabId = null;
  let _workerReady = false;
  let _ensureWorkerPromise = null;

  // ── Persistence (service worker may restart) ──
  async function loadOwnership() {
    try {
      const data = await chrome.storage.session.get([
        "li_automation_window", "li_owned_tabs", "li_main_tab", "li_worker_tab",
      ]);
      if (data.li_automation_window) _automationWindowId = data.li_automation_window;
      if (Array.isArray(data.li_owned_tabs)) _ownedTabIds = new Set(data.li_owned_tabs);
      if (data.li_main_tab) _liTabId = data.li_main_tab;
      if (data.li_worker_tab) _workerTabId = data.li_worker_tab;
      // Defensive cleanup: drop owned tabs that aren't LinkedIn anymore
      try {
        const ids = Array.from(_ownedTabIds);
        for (const tid of ids) {
          try {
            const t = await chrome.tabs.get(tid);
            const u = t && (t.pendingUrl || t.url) || "";
            if (!/linkedin\.com/i.test(u)) _ownedTabIds.delete(tid);
          } catch { _ownedTabIds.delete(tid); }
        }
        if (_liTabId !== null) {
          try {
            const t = await chrome.tabs.get(_liTabId);
            const u = t && (t.pendingUrl || t.url) || "";
            if (!/linkedin\.com/i.test(u)) _liTabId = null;
          } catch { _liTabId = null; }
        }
        if (_workerTabId !== null) {
          try {
            const t = await chrome.tabs.get(_workerTabId);
            const u = t && (t.pendingUrl || t.url) || "";
            if (!/linkedin\.com/i.test(u)) { _workerTabId = null; _workerReady = false; }
          } catch { _workerTabId = null; _workerReady = false; }
        }
      } catch { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  async function saveOwnership() {
    try {
      await chrome.storage.session.set({
        li_automation_window: _automationWindowId,
        li_owned_tabs: Array.from(_ownedTabIds),
        li_main_tab: _liTabId,
        li_worker_tab: _workerTabId,
      });
    } catch (e) { /* ignore */ }
  }

  function markOwned(tabId) {
    _ownedTabIds.add(tabId);
    saveOwnership();
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // ── Legacy automation window API ──
  // Disabled: creating a separate window can spawn a blank placeholder tab and
  // closes the extension popup. New tabs are now created as inactive tabs in
  // the current browser window, after reusing any existing LinkedIn tab.
  async function getOrCreateAutomationWindow(initialUrl) {
    await loadOwnership();
    try {
      _automationWindowId = null;
      await chrome.storage.session.remove(["li_automation_window"]);
      await saveOwnership();
    } catch (e) {
      _automationWindowId = null;
    }
    return null;
  }

  // ── Move tab into automation window (silent, no focus change) ──
  async function ensureTabInAutomationWindow(tabId) {
    try {
      const winId = await getOrCreateAutomationWindow();
      if (winId === null) return false;
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === winId) return true;
      await chrome.tabs.move(tabId, { windowId: winId, index: -1 });
      return true;
    } catch (e) {
      console.debug("[LI TabMgr] ensureTabInAutomationWindow:", e?.message);
      return false;
    }
  }

  // ── Retry-safe tab creation IN AUTOMATION WINDOW ──
  async function safeCreate(options, maxRetries) {
    maxRetries = maxRetries || 3;
    await loadOwnership();
    _automationWindowId = null;
    const opts = Object.assign({ active: false }, options || {});
    delete opts.windowId;
    // Reuse any existing LinkedIn tab before opening a new inactive tab.
    try {
      if (opts.url) {
        const existing = await chrome.tabs.query({ url: "*://*.linkedin.com/*" });
        if (existing && existing[0]) {
          markOwned(existing[0].id);
          return existing[0];
        }
      }
    } catch (e) { /* ignore */ }
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const tab = await chrome.tabs.create(opts);
        markOwned(tab.id);
        return tab;
      } catch (err) {
        if (attempt < maxRetries - 1 && /cannot be edited/i.test(err.message)) {
          await sleep(500 * (attempt + 1));
        } else {
          const tab = await chrome.tabs.create({ url: opts.url, active: false });
          markOwned(tab.id);
          return tab;
        }
      }
    }
  }

  function safeRemove(tabId) {
    if (tabId === _liTabId) return Promise.resolve();
    _ownedTabIds.delete(tabId);
    saveOwnership();
    return chrome.tabs.remove(tabId).catch(function () {});
  }

  function waitForLoad(tabId, ms) {
    ms = ms || 20000;
    return new Promise(function (resolve) {
      const timeout = setTimeout(function () {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, ms);

      function listener(id, info) {
        if (id === tabId && info.status === "complete") {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 2000);
        }
      }

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  function urlMatchesTarget(tabUrl, targetUrl) {
    if (!tabUrl || !targetUrl) return false;
    try {
      const current = new URL(tabUrl);
      const target = new URL(targetUrl);
      const currentPath = current.pathname.replace(/\/$/, "");
      const targetPath = target.pathname.replace(/\/$/, "");
      return current.hostname === target.hostname && currentPath === targetPath;
    } catch (err) { console.debug("[LI Tab]", err?.message); return false; }
  }

  // ── 3.9.57 — ensureWorkerTab ──
  // Idempotente. Garantisce che esista una tab di servizio in background
  // parcheggiata su /messaging/. Mai attivata. Mai rubata all'utente: se
  // l'utente ha aperto LinkedIn lui stesso e non c'è ancora una worker tab,
  // adottiamo solo se la sua tab è già su /messaging/.
  async function ensureWorkerTab(targetUrl) {
    if (_ensureWorkerPromise) return _ensureWorkerPromise;
    _ensureWorkerPromise = (async function () {
      await loadOwnership();
      const wantUrl = targetUrl || WORKER_HOME_URL;

      // 1) Worker già nota e viva?
      if (_workerTabId !== null) {
        try {
          const t = await chrome.tabs.get(_workerTabId);
          if (t && /linkedin\.com/i.test(t.url || t.pendingUrl || "")) {
            // Se serve un URL specifico e la worker è altrove, riportala lì.
            if (targetUrl && !urlMatchesTarget(t.url || "", wantUrl)) {
              try { await chrome.tabs.update(_workerTabId, { url: wantUrl }); } catch (e) { /* ignore */ }
              await waitForLoad(_workerTabId, 20000);
            } else if (t.status !== "complete") {
              await waitForLoad(_workerTabId, 15000);
            }
            _workerReady = true;
            saveOwnership();
            return { id: _workerTabId, ready: true, reused: true };
          }
        } catch (e) {
          _workerTabId = null;
          _workerReady = false;
        }
      }

      // 2) Adozione conservativa: se l'utente ha già una tab su /messaging/*,
      //    la usiamo come worker (no navigation away → zero rischio focus steal).
      try {
        const existing = await chrome.tabs.query({ url: "*://*.linkedin.com/messaging/*" });
        if (existing && existing[0]) {
          _workerTabId = existing[0].id;
          markOwned(_workerTabId);
          if (targetUrl && !urlMatchesTarget(existing[0].url || "", wantUrl)) {
            try { await chrome.tabs.update(_workerTabId, { url: wantUrl }); } catch (e) { /* ignore */ }
            await waitForLoad(_workerTabId, 20000);
          } else if (existing[0].status !== "complete") {
            await waitForLoad(_workerTabId, 15000);
          }
          _workerReady = true;
          saveOwnership();
          return { id: _workerTabId, ready: true, reused: true, adopted: true };
        }
      } catch (e) { /* ignore */ }

      // 3) Crea una tab di servizio inactive su /messaging/.
      try {
        const tab = await chrome.tabs.create({ url: wantUrl, active: false });
        _workerTabId = tab.id;
        markOwned(_workerTabId);
        await waitForLoad(_workerTabId, 25000);
        _workerReady = true;
        saveOwnership();
        console.log("[LI Tab][WORKER] Created persistent worker tab #" + _workerTabId);
        return { id: _workerTabId, ready: true, reused: false, created: true };
      } catch (e) {
        console.warn("[LI Tab][WORKER] create failed:", e?.message);
        _workerReady = false;
        return { id: null, ready: false, error: e?.message || String(e) };
      }
    })().finally(function () { _ensureWorkerPromise = null; });
    return _ensureWorkerPromise;
  }

  function getWorkerInfo() {
    return { id: _workerTabId, ready: _workerReady };
  }

  // Invalidazione esterna (chiamata dal background quando la tab viene chiusa)
  function invalidateWorker(closedTabId) {
    if (closedTabId === undefined || closedTabId === _workerTabId) {
      _workerTabId = null;
      _workerReady = false;
      saveOwnership();
    }
  }

  // ── getLinkedInTab: only reuses OWNED tabs, never user tabs ──
  async function getLinkedInTab(url, skipNavigateIfSameDomain, allowCreate) {
    await loadOwnership();
    const canCreate = allowCreate !== false;

    // 3.9.57 — Per le operazioni di messaging usiamo la worker tab persistente.
    // Nessuna adozione della tab utente (che potrebbe essere su un profilo
    // qualsiasi). La worker viene navigata al target richiesto.
    if (url && /linkedin\.com\/(messaging|in\/|pub\/)/i.test(url)) {
      try {
        const w = await ensureWorkerTab(url);
        if (w && w.id) {
          if (skipNavigateIfSameDomain) {
            return { id: w.id, reused: true, worker: true };
          }
          // ensureWorkerTab ha già garantito la navigazione al target.
          return { id: w.id, reused: !!w.reused, worker: true };
        }
      } catch (e) { console.warn("[LI Tab] worker resolver failed:", e?.message); }
    }

    // 3.9.54 — Preferenza esatta: se url target valorizzato, cerchiamo
    // PRIMA una tab LinkedIn con path identico, prima di adottare una
    // tab generica. Evita di dirottare l'utente su un profilo diverso.
    if (url) {
      try {
        const allLi = await chrome.tabs.query({ url: "*://*.linkedin.com/*" });
        const exact = (allLi || []).find(function (t) {
          return t.windowId !== _automationWindowId && urlMatchesTarget(t.url, url);
        });
        if (exact) {
          _liTabId = exact.id;
          markOwned(_liTabId);
          console.log("[LI Tab] Reusing exact-match LinkedIn tab #" + _liTabId);
          if (exact.status !== "complete") await waitForLoad(_liTabId, 15000);
          return { id: _liTabId, reused: true, exactMatch: true };
        }
      } catch (e) { /* ignore */ }
    }

    // Always prefer a LinkedIn tab already open outside the automation window.
    // P14: if the caller says same-domain reuse is allowed, keep the user on
    // the current LinkedIn page instead of navigating away.
    try {
      const userTabs = await chrome.tabs.query({ url: "*://*.linkedin.com/*" });
      const userTab = userTabs && userTabs.find(function (t) { return t.windowId !== _automationWindowId; });
      if (userTab) {
        _liTabId = userTab.id;
        markOwned(_liTabId);
        console.log("[LI Tab] Reusing existing user LinkedIn tab #" + _liTabId);
        if (skipNavigateIfSameDomain && userTab.url && /linkedin\.com/i.test(userTab.url)) {
          if (userTab.status !== "complete") await waitForLoad(_liTabId, 15000);
          return { id: _liTabId, reused: true };
        }
        await chrome.tabs.update(_liTabId, { url: url });
        await waitForLoad(_liTabId, 20000);
        return { id: _liTabId, reused: false };
      }
    } catch (e) { /* ignore */ }

    // Try cached owned main tab
    if (_liTabId !== null) {
      try {
        const existing = await chrome.tabs.get(_liTabId);
        if (existing) {
          // NB: do NOT force-move the tab to the automation window.
          // If the user has LinkedIn open in their own window we want to reuse
          // it in place — moving it creates the perception of a "new tab"
          // appearing somewhere else and steals the user's tab.
          if (skipNavigateIfSameDomain && existing.url && /linkedin\.com/i.test(existing.url)) {
            if (existing.status !== "complete") await waitForLoad(_liTabId, 15000);
            return { id: _liTabId, reused: true };
          }
          await chrome.tabs.update(_liTabId, { url: url });
          await waitForLoad(_liTabId, 20000);
          return { id: _liTabId, reused: false };
        }
      } catch (err) {
        _liTabId = null;
      }
    }

    // Prefer reusing a LinkedIn tab the user already has open — this avoids
    // spawning a new automation window when one is not needed and matches
    // the user expectation ("usa la pagina che è già aperta").
    try {
      const userTabs = await chrome.tabs.query({ url: "*://*.linkedin.com/*" });
      if (userTabs && userTabs[0]) {
        _liTabId = userTabs[0].id;
        markOwned(_liTabId);
        console.log("[LI Tab] Adopted existing LinkedIn tab #" + _liTabId);
        if (skipNavigateIfSameDomain && userTabs[0].url && /linkedin\.com/i.test(userTabs[0].url)) {
          if (userTabs[0].status !== "complete") await waitForLoad(_liTabId, 15000);
          return { id: _liTabId, reused: true };
        }
        await chrome.tabs.update(_liTabId, { url: url });
        await waitForLoad(_liTabId, 20000);
        return { id: _liTabId, reused: false };
      }
    } catch (e) { /* ignore */ }

    // Service worker may have restarted: also check an already-known
    // automation window, but DO NOT create one just to query it.
    try {
      if (_automationWindowId !== null) {
        const win = await chrome.windows.get(_automationWindowId).catch(function () { return null; });
        if (win) {
        const tabsInWin = await chrome.tabs.query({
          windowId: _automationWindowId,
          url: "*://*.linkedin.com/*",
        });
        if (tabsInWin && tabsInWin[0]) {
          _liTabId = tabsInWin[0].id;
          markOwned(_liTabId);
          console.log("[LI Tab] Reused owned tab #" + _liTabId);
          if (skipNavigateIfSameDomain && tabsInWin[0].url && /linkedin\.com/i.test(tabsInWin[0].url)) {
            if (tabsInWin[0].status !== "complete") await waitForLoad(_liTabId, 15000);
            return { id: _liTabId, reused: true };
          }
          await chrome.tabs.update(_liTabId, { url: url });
          await waitForLoad(_liTabId, 20000);
          return { id: _liTabId, reused: false };
        }
        }
      }
    } catch (queryErr) {
      console.debug("[LI Tab] query owned tabs failed:", queryErr?.message);
    }

    if (!canCreate) {
      console.warn("[LI Tab] No existing LinkedIn tab and creation disabled for this action");
      return null;
    }

    // Create new inactive tab only for explicit non-send actions
    const tab = await safeCreate({ url: url, active: false });
    _liTabId = tab.id;
    saveOwnership();
    await waitForLoad(tab.id, 20000);
    return tab;
  }

  function getTabId() {
    return _liTabId;
  }

  // ── 3.9.55 — Separate read-only tab resolver ──
  // Used by readInbox / peek flows. NEVER navigates the user's currently
  // open LinkedIn tab to a different page (which would "kick them out" of
  // a profile they're viewing). Behavior:
  //   1. If a LinkedIn tab whose URL exactly matches `url` exists, reuse it.
  //   2. Otherwise open a NEW inactive background tab on `url`.
  // This keeps the send-message tab acquisition logic and the inbox-read
  // logic on independent code paths so a fix to one cannot break the other.
  async function getLinkedInTabForRead(url) {
    await loadOwnership();
    // 3.9.57 — Worker tab first per messaging. Se url è null o /messaging/*,
    // usiamo direttamente la worker tab pre-warmed.
    const isMessaging = !url || /linkedin\.com\/messaging\//i.test(url);
    if (isMessaging) {
      try {
        const w = await ensureWorkerTab(url || WORKER_HOME_URL);
        if (w && w.id) {
          console.log("[LI Tab][READ][WORKER] Using worker tab #" + w.id + (w.created ? " (cold)" : " (hot)"));
          return { id: w.id, reused: true, worker: true };
        }
      } catch (e) { console.warn("[LI Tab][READ] worker failed:", e?.message); }
    }

    if (url) {
      try {
        const allLi = await chrome.tabs.query({ url: "*://*.linkedin.com/*" });
        const exact = (allLi || []).find(function (t) {
          return t.windowId !== _automationWindowId && urlMatchesTarget(t.url, url);
        });
        if (exact) {
          markOwned(exact.id);
          console.log("[LI Tab][READ] Reusing exact-match tab #" + exact.id);
          if (exact.status !== "complete") await waitForLoad(exact.id, 15000);
          return { id: exact.id, reused: true, exactMatch: true };
        }
      } catch (e) { /* ignore */ }
    }
    // No exact match → open a new inactive background tab.
    // Do NOT adopt and re-navigate the user's existing LinkedIn tab.
    const tab = await chrome.tabs.create({ url: url, active: false });
    markOwned(tab.id);
    console.log("[LI Tab][READ] Opened new background tab #" + tab.id + " for " + url);
    await waitForLoad(tab.id, 20000);
    return { id: tab.id, reused: false };
  }

  // ── OPTIMUS V2.1 (FOCUS-SAFE): activateAndStabilize ──
  // Same contract as WA: NEVER activate a tab in the user's window.
  async function activateAndStabilize(tabId, maxWaitMs) {
    // Do NOT create/move tabs just to stabilize. If the user already has
    // LinkedIn open, keep that tab exactly where it is and probe DOM as-is.
    await loadOwnership();

    let activatedInAutomation = false;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === _automationWindowId) activatedInAutomation = false;
      console.warn("[LI TabMgr] Focus-safe mode — never activating LinkedIn tab during automation");
    } catch (err) { console.debug("[LI Tab] V2.1 activate:", err?.message); }

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
                document.querySelector('[class*="msg-conversations"]') ||
                document.querySelector('[class*="msg-overlay"]') ||
                document.querySelector('main') ||
                document.querySelector('[role="main"]')
              ),
              loading: !!document.querySelector('[class*="loading"]'),
            };
          },
        });
        const r = check && check[0] && check[0].result;
        // visibilityState NOT required (minimized automation window)
        if (r && r.ready && r.hasContent) { stable = true; break; }
      } catch (err) { console.debug("[LI Tab] V2.1 probe:", err?.message); }
      await sleep(300);
    }
    if (stable) await sleep(500);

    return {
      stable: stable,
      previousTabId: null,
      activatedInAutomation: activatedInAutomation,
      restore: async function () { return; },
    };
  }

  // ── DEPRECATED shim — now focus-safe ──
  async function ensureTabVisibleAndWait(tabId, postActivateMs) {
    const res = await activateAndStabilize(tabId, Math.max(postActivateMs || 600, 1500));
    return !!res.stable || !!res.activatedInAutomation;
  }

  // ── Operation Queue with dual lanes ──
  let _sessionQueue = Promise.resolve();
  let _actionQueue = Promise.resolve();

  function enqueueSession(fn) {
    _sessionQueue = _sessionQueue.then(fn, fn);
    return _sessionQueue;
  }

  function enqueueAction(fn) {
    _actionQueue = _actionQueue.then(fn, fn);
    return _actionQueue;
  }

  function enqueue(fn) {
    return enqueueAction(fn);
  }

  loadOwnership();

  return {
    safeCreate: safeCreate,
    safeRemove: safeRemove,
    waitForLoad: waitForLoad,
    getLinkedInTab: getLinkedInTab,
    getLinkedInTabForRead: getLinkedInTabForRead,
    ensureWorkerTab: ensureWorkerTab,
    getWorkerInfo: getWorkerInfo,
    invalidateWorker: invalidateWorker,
    getTabId: getTabId,
    getOrCreateAutomationWindow: getOrCreateAutomationWindow,
    ensureTabInAutomationWindow: ensureTabInAutomationWindow,
    activateAndStabilize: activateAndStabilize,
    ensureTabVisibleAndWait: ensureTabVisibleAndWait,
    enqueueSession: enqueueSession,
    enqueueAction: enqueueAction,
    enqueue: enqueue,
    sleep: sleep,
  };
})();
globalThis.TabManager = TabManager;
