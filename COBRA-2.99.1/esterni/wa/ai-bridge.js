// ==================================================
// WhatsApp Extension v5.4 — AI Bridge Module
// Routes all Supabase edge function calls through
// the webapp bridge to avoid CORS issues.
// Extension (chrome-extension://) cannot call Supabase
// directly — only the webapp (https://*.lovable.app)
// can.
// ==================================================

var AiBridge = globalThis.AiBridge || (function () {

  let _pendingRequests = {};
  let _requestCounter = 0;

  // Generate unique request ID
  function generateId() {
    _requestCounter++;
    return "aib_" + Date.now() + "_" + _requestCounter;
  }

  // Send a request to the webapp via the content script bridge
  // The webapp will call the Supabase edge function and return the result
  async function callViaWebapp(functionName, payload, timeoutMs) {
    const timeout = timeoutMs || 30000;
    const requestId = generateId();

    // Find a tab/frame running our webapp (the webapp may live inside an
    // iframe — e.g. id-preview--*.lovable.app embedded in lovable.dev editor).
    let target = null;
    try {
      const matchUrl = (u) => !!u && (
        /lovable\.app/i.test(u) ||
        /lovableproject\.com/i.test(u) ||
        /localhost/i.test(u) ||
        /127\.0\.0\.1/i.test(u)
      );
      const tabs = await chrome.tabs.query({});
      const candidates = [];
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        if (!t || typeof t.id !== "number") continue;
        if (matchUrl(t.url)) {
          candidates.push({ tabId: t.id, frameId: 0, active: !!t.active });
          continue;
        }
        try {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id });
          if (!frames) continue;
          for (const f of frames) {
            if (matchUrl(f.url)) {
              candidates.push({ tabId: t.id, frameId: f.frameId, active: !!t.active });
              break;
            }
          }
        } catch (e) { /* tab closed or no permission */ }
      }
      if (candidates.length > 0) {
        target = candidates.find((c) => c.active) || candidates[0];
      }
    } catch (e) {
      console.error("[AiBridge] Tab query failed:", e);
    }

    if (!target) {
      console.warn("[AiBridge] No webapp tab/frame found for bridge relay");
      return null;
    }

    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        delete _pendingRequests[requestId];
        console.warn("[AiBridge] Request timed out:", functionName);
        resolve(null);
      }, timeout);

      _pendingRequests[requestId] = function (response) {
        clearTimeout(timer);
        delete _pendingRequests[requestId];
        resolve(response);
      };

      // Send to content script in the webapp tab
      chrome.tabs.sendMessage(target.tabId, {
        source: "wa-background-bridge",
        type: "ai-bridge-request",
        requestId: requestId,
        functionName: functionName,
        payload: payload,
      }, { frameId: target.frameId }).catch(function (e) {
        clearTimeout(timer);
        delete _pendingRequests[requestId];
        console.warn("[AiBridge] sendMessage failed:", e);
        resolve(null);
      });
    });
  }

  // Handle response from webapp (called by background.js message listener)
  function handleResponse(message) {
    if (!message || message.type !== "ai-bridge-response") return false;
    var requestId = message.requestId;
    if (requestId && _pendingRequests[requestId]) {
      _pendingRequests[requestId](message.data || null);
      return true;
    }
    return false;
  }

  // Convenience: call whatsapp-ai-extract edge function via webapp
  async function callAiExtract(html, mode) {
    return await callViaWebapp("whatsapp-ai-extract", { html: html, mode: mode }, 30000);
  }

  return {
    callViaWebapp: callViaWebapp,
    handleResponse: handleResponse,
    callAiExtract: callAiExtract,
  };
})();
globalThis.AiBridge = AiBridge;
