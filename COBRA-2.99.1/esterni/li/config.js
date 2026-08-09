// ══════════════════════════════════════════════════
// LinkedIn Extension — Configuration Module
// Dynamic config via chrome.storage (no hardcoded keys)
// ══════════════════════════════════════════════════

var Config = globalThis.Config || (function () {
  const _cache = { supabaseUrl: "", supabaseAnonKey: "" };
  let _loaded = false;

  // Error codes standardizzati
  const ERROR = {
    NO_CONFIG: "ERR_NO_CONFIG",
    NO_COOKIE: "ERR_NO_COOKIE",
    TAB_CLOSED: "ERR_TAB_CLOSED",
    TIMEOUT: "ERR_TIMEOUT",
    AX_ATTACH_FAILED: "ERR_AX_ATTACH",
    AI_LEARN_FAILED: "ERR_AI_LEARN",
    EXTRACTION_FAILED: "ERR_EXTRACTION",
    MESSAGE_FAILED: "ERR_MESSAGE",
    CONNECT_FAILED: "ERR_CONNECT",
    SEARCH_FAILED: "ERR_SEARCH",
    INBOX_FAILED: "ERR_INBOX",
    LOGIN_FAILED: "ERR_LOGIN",
    UNKNOWN: "ERR_UNKNOWN",
  };

  async function load() {
    try {
      const data = await chrome.storage.local.get(["li_supabase_url", "li_supabase_anon_key"]);
      if (data.li_supabase_url) _cache.supabaseUrl = data.li_supabase_url;
      if (data.li_supabase_anon_key) _cache.supabaseAnonKey = data.li_supabase_anon_key;
      _loaded = true;
    } catch (err) { console.debug("[LI Config]", err?.message); }
    return _cache;
  }

  async function save(url, key) {
    _cache.supabaseUrl = url || _cache.supabaseUrl;
    _cache.supabaseAnonKey = key || _cache.supabaseAnonKey;
    try {
      await chrome.storage.local.set({
        li_supabase_url: _cache.supabaseUrl,
        li_supabase_anon_key: _cache.supabaseAnonKey,
      });
      _loaded = true;
    } catch (err) { console.debug("[LI Config]", err?.message); }
  }

  function getUrl() { return _cache.supabaseUrl; }
  function getKey() { return _cache.supabaseAnonKey; }
  function isReady() { return !!(_cache.supabaseUrl && _cache.supabaseAnonKey); }

  // Structured error response builder
  function errorResponse(code, detail) {
    return { success: false, error: detail || code, errorCode: code };
  }

  function successResponse(data) {
    const resp = { success: true };
    if (data && typeof data === "object") {
      for (const k in data) {
        if (data.hasOwnProperty(k)) resp[k] = data[k];
      }
    }
    return resp;
  }

  return {
    load: load,
    save: save,
    getUrl: getUrl,
    getKey: getKey,
    isReady: isReady,
    ERROR: ERROR,
    errorResponse: errorResponse,
    successResponse: successResponse,
  };
})();
globalThis.Config = Config;
