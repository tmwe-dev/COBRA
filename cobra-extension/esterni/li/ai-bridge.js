// ══════════════════════════════════════════════
// LinkedIn Extension — AI Bridge Client
// Permette al background di richiedere chiamate
// edge-function alla webapp via content script,
// evitando il blocco CORS chrome-extension://.
// ══════════════════════════════════════════════

var AiBridge = globalThis.AiBridge || (function () {
  const REQUEST_TIMEOUT_MS = 15000;
  let _seq = 0;
  const _pending = new Map(); // requestId → { resolve, timer }

  function nextId() {
    _seq = (_seq + 1) >>> 0;
    return "li-bridge-" + Date.now().toString(36) + "-" + _seq.toString(36);
  }

  async function findWebappTab() {
    try {
      const tabs = await chrome.tabs.query({});
      // Search across ALL frames in each tab — the webapp may live in an iframe
      // (e.g. id-preview--*.lovable.app embedded inside lovable.dev editor).
      const matchUrl = (u) => !!u && (
        /https:\/\/[^/]+\.lovable\.app\//i.test(u) ||
        /https:\/\/[^/]+\.lovableproject\.com\//i.test(u) ||
        /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(u)
      );
      const candidates = [];
      for (const t of tabs) {
        if (!t || typeof t.id !== "number") continue;
        // Quick path: top-level URL matches
        if (matchUrl(t.url)) {
          candidates.push({ tabId: t.id, frameId: 0, active: !!t.active });
          continue;
        }
        // Slow path: scan frames (requires "webNavigation" permission)
        try {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id });
          if (!frames) continue;
          for (const f of frames) {
            if (matchUrl(f.url)) {
              candidates.push({ tabId: t.id, frameId: f.frameId, active: !!t.active });
              break;
            }
          }
        } catch (e) { /* tab may be closed / no permission */ }
      }
      if (candidates.length === 0) return null;
      for (const c of candidates) if (c.active) return c;
      return candidates[0];
    } catch (err) { console.debug("[LI Bridge] findTab:", err?.message); }
    return null;
  }

  async function sendRequest(direction, responseDirection, payload) {
    let target = await findWebappTab();
    if (!target) {
      // Retry once after 2 seconds if no tab found initially
      await new Promise(r => setTimeout(r, 2000));
      target = await findWebappTab();
    }
    if (!target) {
      return {
        success: false,
        error: "Nessuna scheda Cockpit trovata. Apri https://*.lovable.app o l'editor Lovable in un tab e riprova.",
        code: "NO_WEBAPP_TAB",
      };
    }

    const requestId = nextId();
    const promise = new Promise(function (resolve) {
      const timer = setTimeout(function () {
        _pending.delete(requestId);
        resolve({ success: false, error: "BRIDGE_TIMEOUT", code: "TIMEOUT" });
      }, REQUEST_TIMEOUT_MS);
      _pending.set(requestId, { resolve: resolve, timer: timer });
    });

    try {
      await chrome.tabs.sendMessage(target.tabId, {
        action: "aiBridgeRequest",
        direction: direction,
        responseDirection: responseDirection,
        requestId: requestId,
        payload: payload || {},
      }, { frameId: target.frameId });
    } catch (err) {
      const entry = _pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        _pending.delete(requestId);
      }
      return { success: false, error: err.message, code: "TAB_SEND_FAILED" };
    }

    return promise;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.source !== "li-ai-bridge-response") return false;
    const entry = _pending.get(msg.requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    _pending.delete(msg.requestId);
    entry.resolve(msg.payload || { success: false, error: "EMPTY_RESPONSE" });
    return false;
  });

  function aiExtractRequest(payload) {
    return sendRequest(
      "from-extension-ai-request",
      "from-webapp-ai-response",
      payload,
    );
  }

  function liCookieRequest(payload) {
    return sendRequest(
      "from-extension-li-cookie-request",
      "from-webapp-li-cookie-response",
      payload,
    );
  }

  function liCredsRequest() {
    return sendRequest(
      "from-extension-li-creds-request",
      "from-webapp-li-creds-response",
      {},
    );
  }

  return {
    aiExtractRequest: aiExtractRequest,
    liCookieRequest: liCookieRequest,
    liCredsRequest: liCredsRequest,
    sendRequest: sendRequest,
  };
})();
globalThis.AiBridge = AiBridge;
