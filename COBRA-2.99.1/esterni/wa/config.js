// ══════════════════════════════════════════════
// WhatsApp Extension v5.0 — Config Module
// Constants, error codes, config persistence
// ══════════════════════════════════════════════

var Config = globalThis.Config || (function () {
  const WA_BASE = "https://web.whatsapp.com";

  const APP_URL_PATTERNS = [
    /^https:\/\/[^/]*\.lovable\.app\//i,
    /^https:\/\/[^/]*\.lovableproject\.com\//i,
    /^https?:\/\/localhost(?::\d+)?\//i,
    /^https?:\/\/127\.0\.0\.1(?::\d+)?\//i,
  ];

  const ERROR = {
    NO_CONFIG:         "ERR_NO_CONFIG",
    SESSION_FAILED:    "ERR_SESSION_FAILED",
    SEND_FAILED:       "ERR_SEND_FAILED",
    READ_FAILED:       "ERR_READ_FAILED",
    THREAD_FAILED:     "ERR_THREAD_FAILED",
    BACKFILL_FAILED:   "ERR_BACKFILL_FAILED",
    LEARN_FAILED:      "ERR_LEARN_FAILED",
    DIAGNOSTIC_FAILED: "ERR_DIAGNOSTIC_FAILED",
    UNKNOWN:           "ERR_UNKNOWN",
    VALIDATION:        "ERR_VALIDATION",
    TAB_FAILED:        "ERR_TAB_FAILED",
    QR_REQUIRED:       "ERR_QR_REQUIRED",
  };

  // Allowed actions whitelist for bridge validation
  const ALLOWED_ACTIONS = [
    "ping", "setConfig", "verifySession", "sendWhatsApp",
    "readUnread", "learnDom", "diagnosticDom", "readThread",
    "backfillChat",
  ];

  const MAX_STRING_LENGTH = 5000;

  let _url = "";
  let _key = "";
  let _token = "";

  function isAppUrl(url) {
    return typeof url === "string" && APP_URL_PATTERNS.some(function (p) { return p.test(url); });
  }

  async function load() {
    try {
      const data = await chrome.storage.local.get(["supabaseUrl", "anonKey"]);
      _url = data.supabaseUrl || "";
      _key = data.anonKey || "";
      // authToken is never persisted — always received fresh via setConfig
      _token = "";
    } catch (err) { console.debug("[WA Config]", err?.message); }
  }

  async function save(url, key, token) {
    _url = url || "";
    _key = key || "";
    _token = token || "";
    try {
      // Only persist non-sensitive config. authToken is kept in memory only.
      await chrome.storage.local.set({ supabaseUrl: _url, anonKey: _key });
    } catch (err) { console.debug("[WA Config]", err?.message); }
  }

  function getUrl() { return _url; }
  function getKey() { return _key; }
  function getToken() { return _token; }
  function hasConfig() { return !!_url && !!_key; }

  function errorResponse(code, detail) {
    return { success: false, error: detail || code, errorCode: code };
  }

  return {
    WA_BASE: WA_BASE,
    ERROR: ERROR,
    ALLOWED_ACTIONS: ALLOWED_ACTIONS,
    MAX_STRING_LENGTH: MAX_STRING_LENGTH,
    isAppUrl: isAppUrl,
    load: load,
    save: save,
    getUrl: getUrl,
    getKey: getKey,
    getToken: getToken,
    hasConfig: hasConfig,
    errorResponse: errorResponse,
  };
})();
globalThis.Config = Config;
