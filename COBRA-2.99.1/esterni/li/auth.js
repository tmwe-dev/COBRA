// ══════════════════════════════════════════════════
// LinkedIn Extension — Auth & Session Module
// Cookie management, session verification, auto-login
// Uses native input API instead of execCommand
// ══════════════════════════════════════════════════

var Auth = globalThis.Auth || (function () {

  // ── Cookie ──
  async function getLiAtCookie() {
    try {
      const cookie = await chrome.cookies.get({ url: "https://www.linkedin.com/", name: "li_at" });
      return cookie ? cookie.value : null;
    } catch (err) {
      console.warn("[LI Auth] cookie read failed:", (err && err.message) || err);
      return null;
    }
  }

  async function syncCookieToServer() {
    try {
      const liAt = await getLiAtCookie();
      if (!liAt) return Config.errorResponse(Config.ERROR.NO_COOKIE, "Cookie li_at non trovato");

      // VIA BRIDGE: niente fetch diretto a Supabase (CORS blocca chrome-extension://)
      if (typeof AiBridge === "undefined" || !AiBridge.liCookieRequest) {
        // Fallback: store cookie locally for later sync when Cockpit opens
        try {
          await chrome.storage.local.set({ "li_at_pending": liAt, "li_at_timestamp": Date.now() });
          console.log("[LI Auth] Cookie stored locally for later sync (webapp bridge unavailable)");
          return Config.successResponse({ saved: true, stored_locally: true });
        } catch (storageErr) {
          console.error("[LI Auth] Local storage fallback failed:", (storageErr && storageErr.message) || storageErr);
          return Config.errorResponse(Config.ERROR.NO_CONFIG, "Bridge webapp non disponibile e fallback storage fallito");
        }
      }
      const bridgeResp = await AiBridge.liCookieRequest({ cookie: liAt });
      if (!bridgeResp || bridgeResp.success === false) {
        return Config.errorResponse(Config.ERROR.UNKNOWN, (bridgeResp && bridgeResp.error) || "Bridge cookie sync failed");
      }
      const data = bridgeResp.data || {};
      return Config.successResponse({ saved: data.success !== false });
    } catch (err) {
      console.error("[LI Auth] syncCookieToServer failed:", (err && err.message) || err);
      throw err; // Propagate to caller for visible error handling
    }
  }

  // ── Session verification (URL + minimal DOM) ──
  async function verifySession() {
    const liAt = await getLiAtCookie();
    if (!liAt) return { authenticated: false, reason: "no_cookie" };

    const tab = await TabManager.getLinkedInTab("https://www.linkedin.com/feed/", true);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          const url = window.location.href || "";
          const title = document.title || "";
          const onLoggedPage = /linkedin\.com\/(feed|messaging|in\/|search\/results|mynetwork|jobs)/i.test(url);
          const loginPage = /\/login|\/checkpoint|uas\/login/i.test(url);
          const hasSignIn = /Sign in|Accedi|Log in/i.test(title);
          const hasMainContent = !!document.querySelector("main, [role='main']");
          const hasNav = !!document.querySelector("nav, header.global-nav, #global-nav");
          const isCheckpoint = /\/checkpoint\//i.test(url) ||
            !!document.querySelector("#captcha-internal, input[name='pin'], form[action*='challenge']");
          const hasLoginForm = !!document.querySelector(
            "#username, input[name='session_key'], form[action*='login-submit']"
          );
          const authenticated = (onLoggedPage || hasMainContent) && !loginPage && !hasSignIn && !isCheckpoint && !hasLoginForm;
          let reason = "unknown_state";
          if (authenticated) reason = "session_active";
          else if (isCheckpoint) reason = "checkpoint";
          else if (hasLoginForm || loginPage || hasSignIn) reason = "auth_required";
          else if (!hasMainContent && !hasNav) reason = "loading";
          return {
            authenticated: authenticated,
            reason: reason,
            url: url,
            title: title,
          };
        },
      });
      const sessionResult = results[0] && results[0].result;
      if (sessionResult && sessionResult.authenticated) {
        syncCookieToServer().catch(function () {});
        return sessionResult;
      }
      // Conservative: cookie alone is not enough — need page-level confirmation
      return sessionResult || { authenticated: false, reason: "cookie_only_no_page_verify", cookie: true };
    } catch (err) {
      console.warn("[LI Auth] verifySession DOM inspect failed:", (err && err.message) || err);
      // Page script failed: do NOT trust cookie alone
      return { authenticated: false, reason: "cookie_only_script_error", cookie: true, cookieLength: liAt.length };
    }
  }

  // ── Page inspection (stable login form IDs) ──
  function inspectPage() {
    try {
      function firstVisible(selectorList) {
        for (let i = 0; i < selectorList.length; i++) {
          const nodes = document.querySelectorAll(selectorList[i]);
          for (let j = 0; j < nodes.length; j++) {
            const el = nodes[j];
            if (!el) continue;
            const style = window.getComputedStyle(el);
            if (style.display !== "none" && style.visibility !== "hidden" && !el.disabled && (el.offsetParent !== null || style.position === "fixed")) return el;
          }
        }
        return null;
      }
      const url = window.location.href;
      const title = document.title || "";
      const userInput = firstVisible(["#username", "input[name='session_key']", "input[autocomplete='username']"]);
      const passInput = firstVisible(["#password", "input[name='session_password']", "input[autocomplete='current-password']"]);
      const loginForm = !!(userInput || passInput || document.querySelector("form[action*='login-submit']"));
      const hasMainContent = !!document.querySelector("main, [role='main']");
      const onLoggedPage = /linkedin\.com\/(feed|messaging|in\/|search|mynetwork|jobs)/i.test(url);
      const loginPage = /\/login|\/checkpoint|uas\/login/i.test(url);
      const hasSignIn = /Sign in|Accedi|Log in/i.test(title);
      const authenticated = (onLoggedPage || hasMainContent) && !loginPage && !hasSignIn;
      const hasCaptcha = !!document.querySelector("iframe[src*='captcha'], #captcha, .recaptcha, [data-captcha]");
      const hasPhoneVerify = !!document.querySelector("#input__phone_verification_pin, input[name='pin']");
      const hasTwoStep = !!document.querySelector("input[name='verificationCode'], input[name='otpPin'], input[autocomplete='one-time-code']");
      const googleButton = Array.from(document.querySelectorAll("a, button")).find(function (el) {
        return /continue with google|continua con google|sign in with google|accedi con google/i.test(el.textContent || "") && el.offsetParent !== null;
      });
      const signInLink = Array.from(document.querySelectorAll("a, button")).find(function (el) {
        const text = (el.textContent || "").trim();
        if (!el || el.offsetParent === null) return false;
        if (/google/i.test(text)) return false;
        if (/join|iscriviti|registrati/i.test(text)) return false;
        if (/^sign in$|^log in$|^accedi$/i.test(text)) return true;
        if (el.tagName === "A" && /\/login/.test(el.getAttribute("href") || "")) return true;
        return false;
      });
      return {
        url: url, title: title, authenticated: authenticated,
        hasLoginForm: loginForm, hasUsername: !!userInput, hasPassword: !!passInput,
        hasGoogleButton: !!googleButton, hasSignInLink: !!signInLink,
        isChallenge: /checkpoint|challenge|security-verification|two-step|verify|captcha/i.test(url) || hasCaptcha || hasPhoneVerify || hasTwoStep,
      };
    } catch (e) {
      return { url: window.location.href, title: document.title || "", authenticated: false, hasLoginForm: false, error: e.message };
    }
  }

  function prepareLoginPage() {
    try {
      const state = Auth.inspectPage();
      if (state.authenticated) return { success: true, state: "authenticated", url: state.url };
      if (state.hasLoginForm) return { success: true, state: "form_ready", url: state.url };
      const signInLink = Array.from(document.querySelectorAll("a, button")).find(function (el) {
        const text = (el.textContent || "").trim();
        if (!el || el.offsetParent === null || /google/i.test(text) || /join|iscriviti/i.test(text)) return false;
        return /^sign in$|^log in$|^accedi$/i.test(text) || (el.tagName === "A" && /\/login/.test(el.getAttribute("href") || ""));
      });
      if (signInLink) { signInLink.click(); return { success: true, state: "clicked_sign_in", url: window.location.href }; }
      window.location.href = "https://www.linkedin.com/login";
      return { success: true, state: "navigated_to_login", url: window.location.href };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Native input fill (replaces execCommand) ──
  function fillLoginForm(email, password) {
    try {
      function firstVisible(selectorList) {
        for (let i = 0; i < selectorList.length; i++) {
          const nodes = document.querySelectorAll(selectorList[i]);
          for (let j = 0; j < nodes.length; j++) {
            const el = nodes[j];
            if (!el) continue;
            const style = window.getComputedStyle(el);
            if (style.display !== "none" && style.visibility !== "hidden" && !el.disabled && (el.offsetParent !== null || style.position === "fixed")) return el;
          }
        }
        return null;
      }
      const userInput = firstVisible(["#username", "input[name='session_key']", "input[autocomplete='username']"]);
      const passInput = firstVisible(["#password", "input[name='session_password']", "input[autocomplete='current-password']"]);
      if (!userInput || !passInput) return { success: false, error: "Login fields not found" };

      // Use native setter + synthetic events (no execCommand)
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      userInput.focus();
      nativeSet.call(userInput, email);
      userInput.dispatchEvent(new Event("input", { bubbles: true }));
      userInput.dispatchEvent(new Event("change", { bubbles: true }));
      passInput.focus();
      nativeSet.call(passInput, password);
      passInput.dispatchEvent(new Event("input", { bubbles: true }));
      passInput.dispatchEvent(new Event("change", { bubbles: true }));

      const submitBtn = firstVisible(["button[type='submit']", "button[data-litms-control-urn*='login-submit']"]);
      if (submitBtn) { submitBtn.click(); return { success: true, method: "button" }; }
      const form = userInput.closest("form");
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return { success: true, method: "form" }; }
      return { success: false, error: "No submit found" };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Polling for auth completion ──
  async function pollForAuthCompletion(tabId, timeoutMs, options) {
    timeoutMs = timeoutMs || 180000;
    options = options || {};
    let sawGoogle = !!options.sawGoogle;
    let sawChallenge = !!options.sawChallenge;
    let lastUrl = "";
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      await new Promise(function (r) { setTimeout(r, 2000); });
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch (err) {
        return Config.errorResponse(Config.ERROR.TAB_CLOSED, "Tab chiuso durante il login");
      }
      lastUrl = tab && tab.url ? tab.url : lastUrl;
      if (/accounts\.google\.com/i.test(lastUrl)) sawGoogle = true;
      if (/checkpoint|challenge|security-verification|two-step|verify|captcha/i.test(lastUrl)) sawChallenge = true;

      const liAt = await getLiAtCookie();
      if (liAt) {
        const syncResult = await syncCookieToServer();
        return Config.successResponse({
          authenticated: true,
          cookieSynced: !!syncResult.success,
          reason: sawGoogle ? "google_auth_completed" : sawChallenge ? "challenge_resolved" : "login_success",
          currentUrl: lastUrl,
        });
      }

      if (/linkedin\.com/i.test(lastUrl)) {
        try {
          const stateRes = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: inspectPage });
          const state = stateRes[0] && stateRes[0].result;
          if (state && state.authenticated) {
            const syncAuth = await syncCookieToServer();
            return Config.successResponse({
              authenticated: true,
              cookieSynced: !!syncAuth.success,
              reason: "login_success",
              currentUrl: state.url || lastUrl,
            });
          }
          if (state && state.isChallenge) sawChallenge = true;
        } catch (err) {
          console.warn("[LI Auth] poll inspectPage failed:", (err && err.message) || err);
        }
      }
    }

    return Config.errorResponse(
      Config.ERROR.TIMEOUT,
      sawChallenge ? "Timeout verifica manuale" : "Timeout login"
    );
  }

  // ── Auto login flow ──
  async function autoLogin() {
    const existingCookie = await getLiAtCookie();
    if (existingCookie) {
      const sessionCheck = await verifySession();
      if (sessionCheck.authenticated) {
        const syncAlready = await syncCookieToServer();
        return Config.successResponse({ authenticated: true, reason: "already_logged_in", cookieSynced: !!syncAlready.success });
      }
    }

    if (!Config.isReady()) return Config.errorResponse(Config.ERROR.NO_CONFIG, "Configurazione non impostata");

    // VIA BRIDGE: niente fetch diretto a Supabase (CORS blocca chrome-extension://)
    if (typeof AiBridge === "undefined" || !AiBridge.liCredsRequest) {
      return Config.errorResponse(Config.ERROR.NO_CONFIG, "Bridge webapp non disponibile per credenziali");
    }
    const credsBridge = await AiBridge.liCredsRequest();
    if (!credsBridge || credsBridge.success === false) {
      return Config.errorResponse(Config.ERROR.LOGIN_FAILED, (credsBridge && credsBridge.error) || "Lettura credenziali fallita");
    }
    const creds = (credsBridge.data || {});
    if (!creds.email || !creds.password) return Config.errorResponse(Config.ERROR.LOGIN_FAILED, "Credenziali LinkedIn non configurate");

    const tab = await TabManager.getLinkedInTab("https://www.linkedin.com/");
    // STEALTH: do NOT activate/focus the tab — keep work in background to avoid
    // hijacking the user's Cockpit window. executeScript works on inactive tabs.

    try {
      const initialStateRes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPage });
      const initialState = initialStateRes[0] && initialStateRes[0].result;
      if (initialState && initialState.authenticated) {
        const syncInitial = await syncCookieToServer();
        return Config.successResponse({ authenticated: true, cookieSynced: !!syncInitial.success, reason: "already_logged_in" });
      }

      const prepRes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: prepareLoginPage });
      const prep = prepRes[0] && prepRes[0].result;
      if (!prep || !prep.success) return Config.errorResponse(Config.ERROR.LOGIN_FAILED, "Preparazione login fallita");
      if (prep.state !== "form_ready" && prep.state !== "authenticated") await TabManager.waitForLoad(tab.id, 25000);

      const readyStateRes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPage });
      const readyState = readyStateRes[0] && readyStateRes[0].result;
      if (readyState && readyState.authenticated) {
        const syncReady = await syncCookieToServer();
        return Config.successResponse({ authenticated: true, cookieSynced: !!syncReady.success, reason: "already_logged_in" });
      }
      if (readyState && readyState.hasGoogleButton && !readyState.hasLoginForm) {
        return await pollForAuthCompletion(tab.id, 180000, { sawGoogle: true });
      }
      if (!readyState || !readyState.hasLoginForm) return Config.errorResponse(Config.ERROR.LOGIN_FAILED, "Form di login non trovato");

      const injRes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillLoginForm, args: [creds.email, creds.password] });
      const formResult = injRes[0] && injRes[0].result;
      if (!formResult || !formResult.success) return Config.errorResponse(Config.ERROR.LOGIN_FAILED, formResult && formResult.error || "Fill fallito");

      await TabManager.waitForLoad(tab.id, 30000);
      return await pollForAuthCompletion(tab.id, 180000);
    } catch (err) {
      return Config.errorResponse(Config.ERROR.LOGIN_FAILED, err.message);
    }
  }

  return {
    getLiAtCookie: getLiAtCookie,
    syncCookieToServer: syncCookieToServer,
    verifySession: verifySession,
    inspectPage: inspectPage,
    fillLoginForm: fillLoginForm,
    autoLogin: autoLogin,
  };
})();
globalThis.Auth = Auth;
