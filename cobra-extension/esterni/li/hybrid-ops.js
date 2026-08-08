// ══════════════════════════════════════════════════
// LinkedIn Extension — Hybrid Operations Module
// 3-Level Fallback: AX Tree → AI Self-Healing → Structural
// Uses InputNative instead of execCommand
// ══════════════════════════════════════════════════

var HybridOps = globalThis.HybridOps || (function () {

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error(label + " timeout " + ms + "ms")); }, ms);
      }),
    ]);
  }

  // ── Anti-double-send (3.9.54): blocca stesso messaggio identico
  // sulla stessa tab+path entro 2s. In-memory (service-worker scope).
  var _lastSendMap = {};
  function _hashMsg(s) {
    s = String(s || "");
    var h = 0; for (var i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return String(h);
  }
  async function _antiDoubleKey(tabId, message) {
    var path = "";
    try {
      var t = await chrome.tabs.get(tabId);
      var u = new URL(t.url || t.pendingUrl || "about:blank");
      path = u.hostname + u.pathname;
    } catch (e) { /* ignore */ }
    return tabId + "|" + path + "|" + _hashMsg(message);
  }
  async function checkAndRegisterAntiDouble(tabId, message) {
    var key = await _antiDoubleKey(tabId, message);
    var now = Date.now();
    var prev = _lastSendMap[key] || 0;
    if (now - prev < 2000) return { blocked: true, since: now - prev };
    _lastSendMap[key] = now;
    // GC light
    var keys = Object.keys(_lastSendMap);
    if (keys.length > 200) {
      for (var i = 0; i < keys.length; i++) {
        if (now - _lastSendMap[keys[i]] > 60000) delete _lastSendMap[keys[i]];
      }
    }
    return { blocked: false };
  }

  function isMacPlatform() {
    return new Promise(function (resolve) {
      try { chrome.runtime.getPlatformInfo(function (info) { resolve(info && info.os === "mac"); }); }
      catch (e) { resolve(false); }
    });
  }

  async function composerCleared(tabId, timeoutMs) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function (maxWait) {
          function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
          function findBox() {
            var scopes = document.querySelectorAll(".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']");
            for (var s = 0; s < scopes.length; s++) {
              var boxes = scopes[s].querySelectorAll("[contenteditable='true'], div[role='textbox'], [role='textbox']");
              for (var i = 0; i < boxes.length; i++) {
                var el = boxes[i];
                if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
              }
            }
            return null;
          }
          return (async function () {
            var loops = Math.max(1, Math.ceil((maxWait || 3000) / 150));
            for (var i = 0; i < loops; i++) {
              var box = findBox();
              if (!box) return true;
              var current = (box.innerText || box.textContent || "").trim();
              if (!current) return true;
              await sleep(150);
            }
            return false;
          })();
        },
        args: [timeoutMs || 3000],
      });
      return !!(res && res[0] && res[0].result);
    } catch (e) { return false; }
  }

  // ── InputNative: replaces execCommand for contenteditable ──
  function nativeInsertText(text) {
    // Use InputEvent API where available (modern Chrome)
    const el = document.activeElement;
    if (!el) return false;
    // Try insertText via InputEvent (standard API)
    const inserted = el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
    if (inserted) {
      // For contenteditable, use Selection API
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
      return true;
    }
    // Final fallback: execCommand (deprecated but still works)
    return document.execCommand("insertText", false, text);
  }

  // ── Profile extraction ──
  async function extractProfile(tabId) {
    console.log("[LI-Hybrid] extractProfile — trying AX Tree...");

    // Level 1: AX Tree
    try {
      const axResult = await AXTree.extractProfile(tabId);
      if (axResult && axResult.name) {
        console.log("[LI-Hybrid] ✅ AX Tree succeeded:", axResult.name);
        try {
          const photoRes = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: function () {
              const img = document.querySelector("img[alt*='photo'], img[alt*='foto'], img[class*='profile-photo'], img[class*='pv-top-card']");
              return img ? img.src : null;
            },
          });
          if (photoRes[0] && photoRes[0].result) axResult.photoUrl = photoRes[0].result;
        } catch (err) { console.debug("[LI Hybrid]", err?.message); }
        axResult.profileUrl = (await chrome.tabs.get(tabId)).url;
        return Config.successResponse({ profile: axResult, method: "ax_tree" });
      }
    } catch (e) { console.warn("[LI-Hybrid] AX Tree failed:", e.message); }

    // Level 2: AI Self-Healing
    console.log("[LI-Hybrid] extractProfile — trying AI Learn...");
    try {
      let schema = await AILearn.getCached("profile");
      if (!schema && Config.isReady()) {
        schema = await AILearn.learnFromAI(tabId, "profile", Config.getUrl(), Config.getKey());
      }
      if (schema) {
        const learnRes = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: AILearn.extractWithSchema,
          args: [schema],
        });
        const learnResult = learnRes[0] && learnRes[0].result;
        if (learnResult && learnResult.name) {
          console.log("[LI-Hybrid] ✅ AI Learn succeeded:", learnResult.name);
          return Config.successResponse({ profile: learnResult, method: "ai_learn" });
        }
        // Stale — re-learn
        if (Config.isReady()) {
          console.log("[LI-Hybrid] AI Learn stale, re-learning...");
          await AILearn.clearCache();
          schema = await AILearn.learnFromAI(tabId, "profile", Config.getUrl(), Config.getKey());
          if (schema) {
            const retryRes = await chrome.scripting.executeScript({
              target: { tabId: tabId },
              func: AILearn.extractWithSchema,
              args: [schema],
            });
            const retryResult = retryRes[0] && retryRes[0].result;
            if (retryResult && retryResult.name) {
              return Config.successResponse({ profile: retryResult, method: "ai_learn_retry" });
            }
          }
        }
      }
    } catch (e) { console.warn("[LI-Hybrid] AI Learn failed:", e.message); }

    // Level 3: Structural fallback
    console.log("[LI-Hybrid] extractProfile — structural fallback...");
    try {
      const fallbackRes = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          const result = { name: null, headline: null, location: null, about: null, photoUrl: null, profileUrl: window.location.href, connectionStatus: "unknown" };
          function isNavNoise(s) {
            if (!s) return true;
            const t = String(s).trim();
            if (!t || t.length < 2) return true;
            if (/^\d+\s*(notif|messag|conness|invit|new|nuov)/i.test(t)) return true;
            if (/^(notifiche|notifications|messaging|messaggistica|search|cerca|home|rete|network|lavoro|jobs|me|tu|profilo|premium)$/i.test(t)) return true;
            return false;
          }
          const main = document.querySelector("main") || document.body;
          // Nome: scoped al top-card del profilo, mai alla nav.
          const h1Candidates = Array.from(main.querySelectorAll(
            "section.pv-top-card h1, h1.inline.t-24, h1.text-heading-xlarge, h1"
          ));
          for (let i = 0; i < h1Candidates.length; i++) {
            const t = (h1Candidates[i].textContent || "").trim().replace(/\s+/g, " ");
            if (!isNavNoise(t) && t.length >= 2 && t.length <= 120) { result.name = t; break; }
          }
          // Headline (sotto il nome).
          const headlineEl = main.querySelector(
            "section.pv-top-card .text-body-medium.break-words, .pv-text-details__left-panel .text-body-medium, .text-body-medium.break-words"
          );
          if (headlineEl) {
            const t = (headlineEl.textContent || "").trim().replace(/\s+/g, " ");
            if (!isNavNoise(t) && t.length >= 3 && t.length <= 200) result.headline = t;
          }
          // Location.
          const locEl = main.querySelector(
            "section.pv-top-card .text-body-small.inline.t-black--light.break-words, .pv-text-details__left-panel .text-body-small, .text-body-small.inline.t-black--light.break-words"
          );
          if (locEl) {
            const t = (locEl.textContent || "").trim().replace(/\s+/g, " ");
            if (!isNavNoise(t) && t.length >= 2 && t.length <= 200) result.location = t;
          }
          // Photo.
          const photo = main.querySelector(
            "img.pv-top-card-profile-picture__image, img[class*='profile-picture'], img[alt*='photo'], img[alt*='foto']"
          );
          if (photo && photo.src) result.photoUrl = photo.src;
          const allBtns = Array.from(document.querySelectorAll("button")).filter(function (b) { return b.offsetParent !== null; });
          for (let i = 0; i < allBtns.length; i++) {
            const t = allBtns[i].textContent.trim().toLowerCase();
            if (/^(connect|collegati|connetti)$/.test(t)) { result.connectionStatus = "not_connected"; break; }
            if (/^(messag|scrivi)/.test(t)) { result.connectionStatus = "connected"; break; }
            if (/^(pending|in attesa)/.test(t)) { result.connectionStatus = "pending"; break; }
          }
          return result;
        },
      });
      const fallbackResult = fallbackRes[0] && fallbackRes[0].result;
      if (fallbackResult && fallbackResult.name) {
        return Config.successResponse({ profile: fallbackResult, method: "structural_fallback" });
      }
    } catch (e) { console.warn("[LI-Hybrid] Structural fallback failed:", e.message); }

    return Config.errorResponse(Config.ERROR.EXTRACTION_FAILED, "All 3 extraction strategies failed");
  }

  // ── Send message ──
  async function sendMessage(tabId, message) {
    // Guardia URL: la tab deve essere ancora su una pagina profilo /in/<slug>.
    // Se è derivata (es. /messaging/, /feed/) abortiamo: il caller può ri-navigare e ritentare.
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      const currentUrl = (tabInfo && (tabInfo.url || tabInfo.pendingUrl)) || "";
      if (!/linkedin\.com\/(in|pub|messaging)\//i.test(currentUrl)) {
        return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "navigation_drifted: tab fuori da profilo/messaging (" + currentUrl + ")");
      }
    } catch (e) { /* se tabs.get fallisce, lasciamo procedere */ }

    // 3.9.54 — Anti-double-send 2s su (tab + url path + msg hash).
    try {
      var ad = await checkAndRegisterAntiDouble(tabId, message);
      if (ad.blocked) {
        return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "anti_double_send_2s (last " + ad.since + "ms ago)");
      }
    } catch (e) { /* fail-open su errore storage */ }
    // P23 — POLITICA SINGLE WRITER (no AX/AI in produzione):
    //   1) clickMessage scoped (gestito dal caller / structural fallback)
    //   2) DOM writer deterministico (paste → execCommand → textContent)
    //   3) verifica testuale composer (hasText)
    //   4) verifica Send button abilitato
    //   5) physical click → form submit → Ctrl/Cmd+Enter (cascata sotto)
    // AX/AILearn restano definiti SOLO come read-only/diagnostica.
    // NESSUN writer parallelo: una sola fonte di scrittura, fallimento esplicito.

    // 3.9.56 — AI VERIFY (read-only): chiediamo ad AILearn lo schema
    // "messaging" per ottenere il sendButtonSelector. NON è un writer:
    // il selector viene passato all'injected fn che lo prova PRIMA della
    // regex storica. Cache-first; relearn solo su cache miss / button not
    // found. Fallback completo alla regex se AI non disponibile.
    let aiSendSelector = null;
    let schemaSource = "none";
    let schemaLearnedAt = null;
    try {
      if (typeof AILearn !== "undefined") {
        const cached = await AILearn.getCached("messaging");
        if (cached && cached.sendButtonSelector) {
          aiSendSelector = cached.sendButtonSelector;
          schemaSource = "cache";
          schemaLearnedAt = cached.learnedAt || null;
        } else if (Config.isReady()) {
          const fresh = await AILearn.learnFromAI(tabId, "messaging", Config.getUrl(), Config.getKey());
          if (fresh && fresh.sendButtonSelector) {
            aiSendSelector = fresh.sendButtonSelector;
            schemaSource = "fresh";
            schemaLearnedAt = fresh.learnedAt || Date.now();
          }
        }
      }
    } catch (e) { /* fail-open: regex fallback */ }

    // Level 3: Structural fallback with native input
    try {
      const fbRes = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function (msg, aiSendSelector) {
          // Poll up to 8s for the message textbox to appear after the dialog opens.
          // If still missing, try clicking the profile-scoped "Messaggia"/"Message"
          // button (including the "Altro/More" menu), then poll again.
          // Walk the DOM including open shadow roots.
          function deepQueryAll(selector, root) {
            const out = [];
            const r = root || document;
            try { out.push.apply(out, r.querySelectorAll(selector)); } catch (e) {}
            const all = r.querySelectorAll ? r.querySelectorAll("*") : [];
            for (const el of all) {
              if (el.shadowRoot) {
                try { out.push.apply(out, deepQueryAll(selector, el.shadowRoot)); } catch (e) {}
              }
            }
            return out;
          }
          function findBox() {
            // P3 — Textbox scoped: cerchiamo SOLO dentro composer LinkedIn
            // (msg-form / dialog / overlay-conversation-bubble), mai globale.
            // Senza questo scope vince la search-bar o un campo filtri.
            var composerScopes = deepQueryAll(
              ".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']"
            );
            for (var s = 0; s < composerScopes.length; s++) {
              var scope = composerScopes[s];
              var boxes = scope.querySelectorAll(
                "[contenteditable='true'], div[role='textbox'], [role='textbox']"
              );
              for (var i = 0; i < boxes.length; i++) {
                var el = boxes[i];
                var visible = el.offsetParent !== null || el.getClientRects().length > 0;
                if (visible) return el;
              }
            }
            return null;
          }
          function isInGlobalNav(el) {
            return !!(el.closest("nav") ||
                      el.closest("header[role='banner']") ||
                      el.closest("[data-test-global-nav]") ||
                      el.closest(".global-nav"));
          }
          function findMessageBtn() {
            const root = document.querySelector("main") || document.body;
            return Array.from(root.querySelectorAll("button, a, [role='button'], [role='menuitem']")).find(function (b) {
              if (!(b.offsetParent !== null || b.getClientRects().length > 0)) return false;
              if (isInGlobalNav(b)) return false;
              const t = (b.textContent || "").trim();
              const al = (b.getAttribute("aria-label") || "").trim();
              return /^(message|messaggia)$/i.test(t)
                || /^(messaggio|scrivi|invia messaggio|send message)$/i.test(t)
                || /messaggia|messaggio|message|send message/i.test(al);
            });
          }
          function findMoreBtn() {
            const root = document.querySelector("main") || document.body;
            return Array.from(root.querySelectorAll("button, [role='button']")).find(function (b) {
              if (!(b.offsetParent !== null || b.getClientRects().length > 0)) return false;
              const t = (b.textContent || "").trim();
              const al = (b.getAttribute("aria-label") || "").trim();
              return /^(more|altro|più)$/i.test(t) || /^(more actions|altro|più azioni)/i.test(al);
            });
          }
          function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
          // P12 — Anti-double-overlay guard: ritorna true se esiste già un
          // composer/overlay LinkedIn aperto. In quel caso NON dobbiamo
          // ri-cliccare "Messaggia"/"Message" perché LinkedIn aprirebbe una
          // SECONDA finestra (anti-pattern che fa scattare i radar antifrode).
          function hasOpenComposer() {
            try {
              var scopes = deepQueryAll(
                ".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']"
              );
              for (var i = 0; i < scopes.length; i++) {
                var s = scopes[i];
                if (s.offsetParent !== null || s.getClientRects().length > 0) return true;
              }
            } catch (e) {}
            return false;
          }
          return (async function () {
            // Wait for full page load + thread container before polling textbox.
            for (let i = 0; i < 20 && document.readyState !== "complete"; i++) await sleep(250);
            for (let i = 0; i < 40; i++) {
              if (document.querySelector(".msg-form, [class*='msg-form'], .msg-thread, [class*='msg-thread'], [class*='msg-convo']")) break;
              await sleep(500);
            }
            let msgBox = findBox();
            if (!msgBox) {
              // Up to 20s polling (was 8s).
              for (let i = 0; i < 40 && !msgBox; i++) { await sleep(500); msgBox = findBox(); }
            }
            if (!msgBox) {
              const mb = findMessageBtn();
              if (mb && mb.tagName !== "A" && mb.offsetParent !== null && !hasOpenComposer()) {
                mb.click();
                for (let i = 0; i < 16 && !msgBox; i++) { await sleep(500); msgBox = findBox(); }
              } else if (hasOpenComposer()) {
                // Composer già aperto altrove: aspetta che diventi raggiungibile
                // dallo scope corretto invece di aprirne un secondo.
                for (let i = 0; i < 16 && !msgBox; i++) { await sleep(500); msgBox = findBox(); }
              }
            }
            if (!msgBox) {
              const more = findMoreBtn();
              if (more && !hasOpenComposer()) {
                more.click();
                await sleep(800);
                const mb = findMessageBtn();
                if (mb && mb.tagName !== "A" && !hasOpenComposer()) {
                  mb.click();
                  for (let i = 0; i < 16 && !msgBox; i++) { await sleep(500); msgBox = findBox(); }
                }
              }
            }
            if (!msgBox) {
              // ── Diagnostic probe (read-only DOM snapshot) ──
              const probe = {
                href: location.href,
                contenteditable: document.querySelectorAll("[contenteditable='true']").length,
                contenteditableDeep: deepQueryAll("[contenteditable='true']").length,
                roleTextbox: document.querySelectorAll("[role='textbox']").length,
                roleTextboxDeep: deepQueryAll("[role='textbox']").length,
                shadowHosts: Array.from(document.querySelectorAll("*")).filter(function (e) { return !!e.shadowRoot; }).length,
                iframes: document.querySelectorAll("iframe").length,
                msgFormContainers: document.querySelectorAll(".msg-form, [class*='msg-form'], [class*='msg-thread'], [class*='msg-convo']").length,
                readyState: document.readyState,
                msgOverlay: document.querySelectorAll(".msg-overlay-conversation-bubble, [class*='msg-overlay']").length,
                dialogs: document.querySelectorAll("[role='dialog']").length,
                dialogText: (document.querySelector("[role='dialog']")?.innerText || "").slice(0, 200),
                dialogButtons: Array.from(document.querySelectorAll("[role='dialog'] button"))
                  .slice(0, 5)
                  .map(function (b) { return (b.textContent || "").trim().slice(0, 40); }),
                hasMain: !!document.querySelector("main"),
              };
              return { success: false, error: "Fallback: no textbox found __probe__=" + JSON.stringify(probe) };
            }
            // 3.9.54 — Cleanup overlay stale: chiude (via bottone X) i bubble
            // flottanti che NON contengono il msgBox target. Mai chiudere il
            // composer della pagina profilo o il .msg-form target.
            try {
              var targetForm = msgBox.closest(".msg-form, [class*='msg-form']");
              var targetOverlay = msgBox.closest(".msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']");
              var overlays = document.querySelectorAll(".msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']");
              for (var oi = 0; oi < overlays.length; oi++) {
                var ov = overlays[oi];
                if (ov === targetOverlay) continue;
                if (targetForm && ov.contains(targetForm)) continue;
                if (!(ov.offsetParent !== null || ov.getClientRects().length > 0)) continue;
                var closeBtn = ov.querySelector("[aria-label*='Chiudi'], [aria-label*='Close'], [aria-label*='chiudi'], [aria-label*='close'], button.msg-overlay-bubble-header__control");
                if (closeBtn) { try { closeBtn.click(); } catch (e) {} }
              }
            } catch (e) { /* best-effort */ }
            // ── WA-aligned writer: cascata paste → execCommand → textContent
            // con verifica DOM reale dopo ogni step (nessun doppio invio).
            // Specchio di __waH.modernClearAndType in WhatsApp actions.js.
            (function modernClearAndType(input, text) {
              try { input.focus(); } catch (e) {}
              try { if (typeof input.click === "function") input.click(); } catch (e) {}
              // Clear current contents via selectAll + delete
              try {
                var r = document.createRange();
                r.selectNodeContents(input);
                var s2 = window.getSelection();
                s2.removeAllRanges();
                s2.addRange(r);
                document.execCommand("delete", false);
              } catch (e) { /* ignore */ }
              function hasText() {
                var tc = (input.textContent || "");
                return tc.indexOf(text) !== -1 || tc.trim() === text.trim();
              }
              // STEP 1 — ClipboardEvent paste (Draft.js handler nativo aggiorna EditorState)
              if (!hasText()) {
                try {
                  var dt = new DataTransfer();
                  dt.setData("text/plain", text);
                  var evt = new ClipboardEvent("paste", {
                    clipboardData: dt, bubbles: true, cancelable: true,
                  });
                  input.dispatchEvent(evt);
                } catch (e) { /* ignore */ }
              }
              // STEP 2 — execCommand insertText (legacy ma update Draft.js in alcuni build)
              if (!hasText()) {
                try { document.execCommand("insertText", false, text); } catch (e) {}
              }
              // STEP 3 — Backup writer funzionante: Selection API + text node.
              // Scrive visibilmente nel composer senza cliccare Invia.
              if (!hasText()) {
                try {
                  var sel = window.getSelection();
                  if (sel) {
                    sel.selectAllChildren(input);
                    sel.deleteFromDocument();
                  }
                  input.appendChild(document.createTextNode(text));
                  sel = window.getSelection();
                  if (sel) {
                    var rr = document.createRange();
                    rr.selectNodeContents(input);
                    rr.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(rr);
                  }
                  input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true, composed: true }));
                } catch (e) { /* ignore */ }
              }
              // STEP 4 — Fallback duro: textContent + InputEvent composed
              if (!hasText()) {
                try {
                  input.textContent = text;
                  input.dispatchEvent(new InputEvent("input", {
                    inputType: "insertText", data: text, bubbles: true, composed: true,
                  }));
                } catch (e) { /* ignore */ }
              }
            })(msgBox, msg);
            // Ping aggiuntivo per forzare validazione del bottone Send (no keydown finto).
            try {
              msgBox.dispatchEvent(new Event("change", { bubbles: true }));
            } catch (e) { /* best-effort */ }
            // Wait for the send button to become enabled (LinkedIn validates async).
            // P4 — Send button robusto: match per classe msg-form__send-button,
            // aria-label Send/Invia, type=submit dentro composer. Esclude
            // disabled e aria-disabled. Solo dentro composer.
            function findSendBtn() {
              // 3.9.56 — AI VERIFY: prova prima il selector AI (read-only).
              if (aiSendSelector && typeof aiSendSelector === "string") {
                try {
                  var aiNodes = document.querySelectorAll(aiSendSelector);
                  for (var ai = 0; ai < aiNodes.length; ai++) {
                    var bb = aiNodes[ai];
                    if (!(bb.offsetParent !== null || bb.getClientRects().length > 0)) continue;
                    if (bb.disabled || bb.getAttribute("aria-disabled") === "true") continue;
                    // Deve essere dentro un composer scope (no global nav).
                    if (!bb.closest(".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble")) continue;
                    bb.__matchedBy = "ai_schema";
                    return bb;
                  }
                } catch (e) { /* selector invalido → fallback regex */ }
              }
              var scopes = document.querySelectorAll(
                ".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble"
              );
              for (var s = 0; s < scopes.length; s++) {
                var scope = scopes[s];
                var btns = scope.querySelectorAll("button, [role='button']");
                for (var i = 0; i < btns.length; i++) {
                  var b = btns[i];
                  if (!(b.offsetParent !== null || b.getClientRects().length > 0)) continue;
                  if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
                  var cls = (b.className && typeof b.className === "string") ? b.className : "";
                  var al = (b.getAttribute("aria-label") || "").trim();
                  var t = (b.textContent || "").trim();
                  var typ = (b.getAttribute("type") || "").toLowerCase();
                  if (/msg-form__send-button|msg-form__send|send-button/i.test(cls)) { b.__matchedBy = "regex_class"; return b; }
                  if (/^(send|invia|invia messaggio|send message)$/i.test(al)) { b.__matchedBy = "regex_aria"; return b; }
                  if (/^(send|invia)$/i.test(t)) { b.__matchedBy = "regex_text"; return b; }
                  if (typ === "submit" && /msg-form/i.test(scope.className || "")) { b.__matchedBy = "regex_submit"; return b; }
                }
              }
              return null;
            }
            function firePhysicalClick(el) {
              if (!el) return false;
              try {
                el.scrollIntoView({ block: "center", inline: "center" });
                var rect = el.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
                try { el.dispatchEvent(new PointerEvent("pointerover", Object.assign({ pointerType: "mouse", pointerId: 1, isPrimary: true }, opts))); } catch (e) {}
                el.dispatchEvent(new MouseEvent("mouseover", opts));
                try { el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerType: "mouse", pointerId: 1, isPrimary: true }, opts))); } catch (e) {}
                el.dispatchEvent(new MouseEvent("mousedown", opts));
                try { el.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerType: "mouse", pointerId: 1, isPrimary: true }, opts))); } catch (e) {}
                el.dispatchEvent(new MouseEvent("mouseup", opts));
                el.dispatchEvent(new MouseEvent("click", opts));
                try { el.click(); } catch (e) {}
                return true;
              } catch (e) {
                try { el.click(); return true; } catch (e2) { return false; }
              }
            }
            function submitComposer() {
              try {
                var form = msgBox.closest("form") || document.querySelector("form.msg-form, .msg-form form, [class*='msg-form'] form");
                if (!form) return false;
                // Do NOT call requestSubmit(): on LinkedIn it can trigger a real
                // navigation/unload, leaving chrome.scripting.executeScript hung.
                // Dispatch only the React/SPA submit listeners, bounded and no-page-change.
                var evt;
                try {
                  evt = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: findSendBtn() || undefined });
                } catch (e) {
                  evt = new Event("submit", { bubbles: true, cancelable: true });
                }
                form.dispatchEvent(evt);
                return true;
              } catch (e) { return false; }
            }
            // P13 — Polling esteso a 8s (era 3s).
            let sendBtn = null;
            for (let i = 0; i < 80; i++) {
              sendBtn = findSendBtn();
              if (sendBtn) break;
              await sleep(100);
            }
            // 3.9.54 — Click ottimistico: se Send è trovato + abilitato,
            // un solo physical click. Verifica soft di textboxCleared (1.5s),
            // ma NON blocca il successo: ritorniamo verified=true|false.
            // Niente submitComposer / Ctrl+Enter / CDP fallback dopo il click,
            // per non generare doppi invii.
            if (!sendBtn) {
              return { success: false, error: "send_button_not_found" };
            }
            if (sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true") {
              return { success: false, error: "send_button_disabled" };
            }
            async function textboxCleared() {
              for (let i = 0; i < 15; i++) {
                await sleep(100);
                var current = (msgBox.innerText || msgBox.textContent || "").trim();
                if (!current) return true;
              }
              return false;
            }
            if (!firePhysicalClick(sendBtn)) {
              return { success: false, error: "send_button_click_dispatch_failed" };
            }
            const cleared = await textboxCleared();
            var matchedBy = sendBtn.__matchedBy || "regex_unknown";
            var selectorMatched = matchedBy === "ai_schema" ? "ai_schema" : "regex_fallback";
            if (cleared) {
              return { success: true, method: "physical_click", verified: true, selectorMatched: selectorMatched, matchedBy: matchedBy };
            }
            return {
              success: true,
              method: "physical_click",
              verified: false,
              warning: "textbox_not_cleared_after_click_unverified",
              selectorMatched: selectorMatched,
              matchedBy: matchedBy,
            };
          })();
        },
        args: [message, aiSendSelector],
      });
      let fbResult = fbRes[0] && fbRes[0].result;

      // 3.9.56 — Relearn + 1 retry SOLO se send_button_not_found e schema
      // veniva da cache (nessun click avvenuto = no rischio doppio invio).
      if (
        fbResult && fbResult.success === false &&
        fbResult.error === "send_button_not_found" &&
        schemaSource === "cache" &&
        Config.isReady() && typeof AILearn !== "undefined"
      ) {
        try {
          await AILearn.clearCache();
          const fresh = await AILearn.learnFromAI(tabId, "messaging", Config.getUrl(), Config.getKey());
          if (fresh && fresh.sendButtonSelector) {
            schemaSource = "fresh_after_cache_miss";
            aiSendSelector = fresh.sendButtonSelector;
            // Retry minimale: il textbox è già scritto dal primo run, quindi
            // qui ricerchiamo SOLO il bottone con il nuovo selector AI e clicchiamo.
            // Guardia anti-doppio: se il composer è vuoto = primo invio andato.
            const retryRes2 = await chrome.scripting.executeScript({
              target: { tabId: tabId },
              func: function (msg, sel) {
                // Versione minimale del retry: cerca il bottone usando SOLO
                // il selector AI fresh + scope composer. Non rifa la scrittura
                // (textbox già contiene msg dal primo run).
                function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
                function findBtn() {
                  try {
                    var nodes = document.querySelectorAll(sel);
                    for (var i = 0; i < nodes.length; i++) {
                      var b = nodes[i];
                      if (!(b.offsetParent !== null || b.getClientRects().length > 0)) continue;
                      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
                      if (!b.closest(".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble")) continue;
                      return b;
                    }
                  } catch (e) {}
                  return null;
                }
                function findBox() {
                  var scopes = document.querySelectorAll(".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble");
                  for (var s = 0; s < scopes.length; s++) {
                    var boxes = scopes[s].querySelectorAll("[contenteditable='true'], div[role='textbox'], [role='textbox']");
                    for (var i = 0; i < boxes.length; i++) {
                      var el = boxes[i];
                      if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
                    }
                  }
                  return null;
                }
                return (async function () {
                  var box = findBox();
                  if (!box) return { success: false, error: "send_button_not_found", relearned: true };
                  // Verifica che il composer contenga ancora il messaggio (no doppio invio).
                  var current = (box.innerText || box.textContent || "").trim();
                  if (!current || current.indexOf((msg || "").trim().slice(0, 20)) < 0) {
                    return { success: true, method: "skipped_already_sent", verified: false, relearned: true, warning: "composer_empty_skipping_retry" };
                  }
                  var btn = null;
                  for (var i = 0; i < 30; i++) { btn = findBtn(); if (btn) break; await sleep(100); }
                  if (!btn) return { success: false, error: "send_button_not_found", relearned: true };
                  try {
                    btn.scrollIntoView({ block: "center", inline: "center" });
                    var rect = btn.getBoundingClientRect();
                    var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
                    btn.dispatchEvent(new MouseEvent("mousedown", opts));
                    btn.dispatchEvent(new MouseEvent("mouseup", opts));
                    btn.dispatchEvent(new MouseEvent("click", opts));
                    try { btn.click(); } catch (e) {}
                  } catch (e) { return { success: false, error: "send_button_click_dispatch_failed", relearned: true }; }
                  // textboxCleared
                  var clearedOk = false;
                  for (var j = 0; j < 15; j++) {
                    await sleep(100);
                    var cur = (box.innerText || box.textContent || "").trim();
                    if (!cur) { clearedOk = true; break; }
                  }
                  return {
                    success: true,
                    method: "physical_click",
                    verified: clearedOk,
                    selectorMatched: "ai_schema",
                    matchedBy: "ai_schema_relearned",
                    relearned: true,
                  };
                })();
              },
              args: [message, fresh.sendButtonSelector],
            }).catch(function () { return null; });
            const retryResult = retryRes2 && retryRes2[0] && retryRes2[0].result;
            if (retryResult) {
              retryResult.schemaSource = "fresh_after_cache_miss";
              retryResult.verifiedBy = "ai_schema_relearned";
              if (retryResult.success) return retryResult;
              fbResult = retryResult;
            }
          }
        } catch (e) { /* fall through con fbResult originale */ }
      }

      if (fbResult) {
        if (typeof fbResult.relearned === "undefined") fbResult.relearned = false;
        if (typeof fbResult.schemaSource === "undefined") fbResult.schemaSource = schemaSource;
        if (typeof fbResult.verifiedBy === "undefined") {
          fbResult.verifiedBy = fbResult.selectorMatched === "ai_schema" ? "ai_schema" : "regex_fallback";
        }
        // 3.9.56 — Diagnostica selector + age schema (sempre presenti).
        if (typeof fbResult.selectorUsed === "undefined") fbResult.selectorUsed = aiSendSelector || null;
        if (typeof fbResult.schemaAgeMs === "undefined") {
          fbResult.schemaAgeMs = schemaLearnedAt ? (Date.now() - schemaLearnedAt) : null;
        }
        if (typeof fbResult.clickMethod === "undefined") fbResult.clickMethod = fbResult.method || null;
        // A2 — Su verified=false (click partito ma textbox non svuotato):
        // invalida la cache messaging così il prossimo invio ricostruisce
        // lo schema. NESSUN secondo click automatico (single writer).
        if (fbResult.success === true && fbResult.verified === false) {
          try {
            if (typeof AILearn !== "undefined") {
              await AILearn.clearCache("messaging");
              fbResult.cacheInvalidated = "messaging";
            }
          } catch (e) { /* best-effort */ }
          if (!fbResult.suggestion) {
            fbResult.suggestion = "manual_retry: textbox non svuotato dopo click. Cache AI invalidata: prossimo invio rilearn dello schema. Verifica visivamente prima di ritentare.";
          }
        }
      }
      if (fbResult && fbResult.success) return fbResult;
      // 3.9.54 — Niente fallback CDP/keyboard: il click ottimistico DOM
      // è autoritativo.
      return fbResult || Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "All message strategies failed");
    } catch (e) { return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, e.message); }
  }

  // ── Click Connect ──
  async function clickConnect(tabId) {
    // Level 1: AX Tree
    try {
      const axResult = await AXTree.clickConnect(tabId);
      if (axResult && axResult.success) return axResult;
    } catch (e) { console.warn("[LI-Hybrid] AX Tree connect failed:", e.message); }

    // Level 2: AI Learn
    try {
      let schema = await AILearn.getCached("profile");
      if (!schema && Config.isReady()) schema = await AILearn.learnFromAI(tabId, "profile", Config.getUrl(), Config.getKey());
      if (schema) {
        const learnRes = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: AILearn.clickConnectWithSchema,
          args: [schema],
        });
        const learnResult = learnRes[0] && learnRes[0].result;
        if (learnResult && learnResult.success) return learnResult;
      }
    } catch (e) {}

    // Level 3: Structural fallback
    try {
      const fbRes = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          const btn = Array.from(document.querySelectorAll("button")).find(function (el) {
            return /^(connect|collegati|connetti)$/i.test(el.textContent.trim()) && el.offsetParent !== null;
          });
          if (btn) { btn.click(); return { success: true, method: "structural_fallback" }; }
          const moreBtn = Array.from(document.querySelectorAll("button")).find(function (el) {
            return /^(more|altro)$/i.test(el.textContent.trim()) && el.offsetParent !== null;
          });
          if (moreBtn) {
            moreBtn.click();
            return new Promise(function (resolve) {
              setTimeout(function () {
                const dropItem = Array.from(document.querySelectorAll("[role='option'], [role='menuitem'], li, span")).find(function (el) {
                  return /connect|collegati|connetti/i.test(el.textContent.trim()) && el.offsetParent !== null;
                });
                if (dropItem) { dropItem.click(); resolve({ success: true, method: "structural_more_dropdown" }); }
                else resolve({ success: false, error: "Connect not found in dropdown" });
              }, 1200);
            });
          }
          return { success: false, error: "Fallback: Connect button not found" };
        },
      });
      return (fbRes[0] && fbRes[0].result) || Config.errorResponse(Config.ERROR.CONNECT_FAILED, "All connect strategies failed");
    } catch (e) { return Config.errorResponse(Config.ERROR.CONNECT_FAILED, e.message); }
  }

  // ── Click Message button ──
  async function clickMessage(tabId) {
    // P2 — AX Tree DISABILITATO per clickMessage: cerca globalmente e finisce
    // per cliccare "Messaging/Messaggi" della top-nav, navigando l'utente in
    // /messaging/ invece di aprire il composer del profilo. Usiamo solo il
    // fallback strutturale che filtra dentro <main> ed esclude la global-nav.
    try {
      const fbRes = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          // P22 — Scope al TOP-CARD del profilo aperto, non a tutto <main>.
          // Senza questo restringimento, su pagine miste (es. profilo che mostra
          // "Persone che potresti conoscere" o cards adiacenti) trovavamo più
          // bottoni "Messaggia" e LinkedIn apriva overlay multipli/sbagliati.
          var root = document.querySelector("section.pv-top-card")
                   || document.querySelector("[class*='pv-top-card']")
                   || document.querySelector("main section:first-of-type")
                   || document.querySelector("main")
                   || document.body;
          function isInGlobalNav(el) {
            return !!(el.closest("nav") ||
                      el.closest("header[role='banner']") ||
                      el.closest("[data-test-global-nav]") ||
                      el.closest(".global-nav"));
          }
          function isVisible(el) {
            return el.offsetParent !== null || el.getClientRects().length > 0;
          }
          function findProfileMessageBtn(scope) {
            var nodes = Array.from(scope.querySelectorAll("button, a, [role='button'], [role='menuitem']"));
            return nodes.find(function (el) {
              if (!isVisible(el) || isInGlobalNav(el)) return false;
              var t = (el.textContent || "").replace(/\s+/g, " ").trim();
              var al = (el.getAttribute("aria-label") || "").trim();
              return /^(messaggia|message)$/i.test(t)
                  || /^(messaggia|message)$/i.test(al)
                  || /^(invia messaggio|send message)$/i.test(t)
                  || /^(invia messaggio|send message)$/i.test(al);
            });
          }
          function findMoreBtn(scope) {
            return Array.from(scope.querySelectorAll("button, [role='button']")).find(function (b) {
              if (!isVisible(b) || isInGlobalNav(b)) return false;
              var t = (b.textContent || "").trim();
              var al = (b.getAttribute("aria-label") || "").trim();
              return /^(more|altro|più|piu)$/i.test(t) || /^(more actions|altro|più azioni|piu azioni)/i.test(al);
            });
          }
          function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
          return (async function () {
            // P12 — Anti-double-overlay: se esiste già un composer/overlay
            // visibile, NON ri-clicchiamo "Messaggia". Il caller userà il
            // composer esistente. Aprire una seconda finestra è il pattern
            // che fa scattare l'antifrode LinkedIn.
            var existingScopes = document.querySelectorAll(
              ".msg-form, [class*='msg-form'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation'], [role='dialog']"
            );
            for (var es = 0; es < existingScopes.length; es++) {
              var existingComposer = existingScopes[es];
              var existingVisible = existingComposer.offsetParent !== null || existingComposer.getClientRects().length > 0;
              if (!existingVisible) continue;
              if (!existingComposer.querySelector("[contenteditable='true'], div[role='textbox'], [role='textbox']")) continue;
              return { success: true, method: "composer_already_open" };
            }
            var btn = findProfileMessageBtn(root);
            if (btn) { btn.click(); return { success: true, method: "structural_fallback_main" }; }
            // Tenta "Altro/More" → voce "Messaggia"
            var more = findMoreBtn(root);
            if (more) {
              more.click();
              await sleep(800);
              // Le voci di menu possono finire fuori da main
              btn = findProfileMessageBtn(document) ||
                    Array.from(document.querySelectorAll("[role='menuitem'], li, [role='option']")).find(function (el) {
                      if (!isVisible(el) || isInGlobalNav(el)) return false;
                      var t = (el.textContent || "").replace(/\s+/g, " ").trim();
                      return /^(messaggia|message|invia messaggio|send message)$/i.test(t);
                    });
              if (btn) { btn.click(); return { success: true, method: "structural_more_dropdown" }; }
            }
            return { success: false, error: "Profile-scoped message button not found" };
          })();
        },
      });
      return (fbRes[0] && fbRes[0].result) || { success: false, error: "Message button not found" };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Add connection note ──
  async function addNote(tabId, noteText) {
    try {
      const axResult = await AXTree.addNote(tabId, noteText);
      if (axResult && axResult.success) return axResult;
    } catch (err) { console.debug("[LI Hybrid]", err?.message); }
    try {
      const fbRes = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function (note) {
          const addBtn = Array.from(document.querySelectorAll("button")).find(function (el) {
            return /add a note|aggiungi nota/i.test(el.textContent.trim());
          });
          if (!addBtn) return { success: false, error: "Add Note button not found" };
          addBtn.click();
          return new Promise(function (resolve) {
            setTimeout(function () {
              const textarea = document.querySelector("textarea");
              if (!textarea) { resolve({ success: false, error: "Note textarea not found" }); return; }
              const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
              textarea.focus();
              nativeSet.call(textarea, note);
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              setTimeout(function () {
                const sendBtn = Array.from(document.querySelectorAll("button")).find(function (el) {
                  return /^(send|invia)$/i.test(el.textContent.trim()) && el.offsetParent !== null;
                });
                if (sendBtn) { sendBtn.click(); resolve({ success: true, method: "structural_fallback" }); }
                else resolve({ success: false, error: "Send button not found" });
              }, 500);
            }, 1000);
          });
        },
        args: [noteText],
      });
      return (fbRes[0] && fbRes[0].result) || { success: false, error: "Note adding failed" };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ────────────────────────────────────────────────────────────────────
  // sendMessageWithMethod — DIAGNOSTIC ONLY
  // FAST-PATH (v3.9.39): presuppone che il composer sia GIÀ aperto e visibile
  // nella tab LinkedIn attiva. Niente attesa "apri da zero", niente polling lunghi.
  // Se il composer non c'è, fallisce in <1s con messaggio chiaro.
  //   method = "physical_click" | "form_submit" | "keyboard_shortcut"
  //          | "cdp_physical_click" | "cdp_ctrl_enter"
  // Per i metodi CDP eseguiamo direttamente la chiamata debugger, senza il
  // round-trip "pending_cdp" (che oggi raddoppia la latenza).
  // ────────────────────────────────────────────────────────────────────
  async function sendMessageWithMethod(tabId, message, method) {
    const allowed = ["physical_click", "form_submit", "keyboard_shortcut", "cdp_physical_click", "cdp_ctrl_enter"];
    if (allowed.indexOf(method) === -1) {
      return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "invalid_method: " + method);
    }
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      const currentUrl = (tabInfo && (tabInfo.url || tabInfo.pendingUrl)) || "";
      if (!/linkedin\.com\/(in|pub|messaging)\//i.test(currentUrl)) {
        return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "navigation_drifted: " + currentUrl);
      }
    } catch (e) { /* tolleriamo */ }

    try {
      const isCdp = (method === "cdp_physical_click" || method === "cdp_ctrl_enter");
      // Budget: 4s per metodi DOM in-page, 6s per metodi CDP (debugger round-trip).
      const externalTimeout = isCdp ? 6000 : 4000;
      const fbRes = await withTimeout(chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function (msg, methodName) {
          function deepQueryAll(selector, root) {
            const out = [];
            const r = root || document;
            try { out.push.apply(out, r.querySelectorAll(selector)); } catch (e) {}
            const all = r.querySelectorAll ? r.querySelectorAll("*") : [];
            for (const el of all) {
              if (el.shadowRoot) {
                try { out.push.apply(out, deepQueryAll(selector, el.shadowRoot)); } catch (e) {}
              }
            }
            return out;
          }
          function findBox() {
            var scopes = deepQueryAll(
              ".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']"
            );
            for (var s = 0; s < scopes.length; s++) {
              var scope = scopes[s];
              var boxes = scope.querySelectorAll(
                "[contenteditable='true'], div[role='textbox'], [role='textbox']"
              );
              for (var i = 0; i < boxes.length; i++) {
                var el = boxes[i];
                var visible = el.offsetParent !== null || el.getClientRects().length > 0;
                if (visible) return el;
              }
            }
            return null;
          }
          function findSendBtn() {
            var scopes = document.querySelectorAll(
              ".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble"
            );
            for (var s = 0; s < scopes.length; s++) {
              var scope = scopes[s];
              var btns = scope.querySelectorAll("button, [role='button']");
              for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                if (!(b.offsetParent !== null || b.getClientRects().length > 0)) continue;
                if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
                var cls = (b.className && typeof b.className === "string") ? b.className : "";
                var al = (b.getAttribute("aria-label") || "").trim();
                var t = (b.textContent || "").trim();
                var typ = (b.getAttribute("type") || "").toLowerCase();
                if (/msg-form__send-button|msg-form__send|send-button/i.test(cls)) return b;
                if (/^(send|invia|invia messaggio|send message)$/i.test(al)) return b;
                if (/^(send|invia)$/i.test(t)) return b;
                if (typ === "submit" && /msg-form/i.test(scope.className || "")) return b;
              }
            }
            return null;
          }
          function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

          return (async function () {
            // FAST-PATH: composer atteso già aperto. Max ~600ms di tolleranza.
            let msgBox = findBox();
            for (let i = 0; i < 6 && !msgBox; i++) { await sleep(100); msgBox = findBox(); }
            if (!msgBox) {
              return {
                success: false,
                error: "composer_not_open: apri la chat LinkedIn (composer visibile) e ripremi",
                attempted_method: methodName,
              };
            }

            // Write text with the same WA-aligned verified cascade used by production sendMessage.
            (function modernClearAndType(input, text) {
              try { input.focus(); } catch (e) {}
              try { if (typeof input.click === "function") input.click(); } catch (e) {}
              try {
                var r = document.createRange();
                r.selectNodeContents(input);
                var s2 = window.getSelection();
                s2.removeAllRanges();
                s2.addRange(r);
                document.execCommand("delete", false);
              } catch (e) {}
              function hasText() {
                var tc = (input.textContent || "");
                return tc.indexOf(text) !== -1 || tc.trim() === text.trim();
              }
              if (!hasText()) {
                try {
                  var dt = new DataTransfer();
                  dt.setData("text/plain", text);
                  input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
                } catch (e) {}
              }
              if (!hasText()) { try { document.execCommand("insertText", false, text); } catch (e) {} }
              // Backup writer 3.9.37: Selection API + text node. Questo è il
              // punto stabile che scriveva nel campo; l'ultimo miglio resta separato.
              if (!hasText()) {
                try {
                  var sel = window.getSelection();
                  if (sel) {
                    sel.selectAllChildren(input);
                    sel.deleteFromDocument();
                  }
                  input.appendChild(document.createTextNode(text));
                  sel = window.getSelection();
                  if (sel) {
                    var rr = document.createRange();
                    rr.selectNodeContents(input);
                    rr.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(rr);
                  }
                  input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true, composed: true }));
                } catch (e) {}
              }
              if (!hasText()) {
                try {
                  input.textContent = text;
                  input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true, composed: true }));
                } catch (e) {}
              }
            })(msgBox, msg);
            try { msgBox.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* best-effort */ }

            var writtenText = (msgBox.innerText || msgBox.textContent || "").trim();
            var expectedText = String(msg || "").trim();
            if (!expectedText || (writtenText.indexOf(expectedText) === -1 && writtenText !== expectedText)) {
              return { success: false, error: "text_not_written", attempted_method: methodName, wrote_length: writtenText.length };
            }

            async function textboxCleared() {
              // FAST-PATH: 8 × 75ms = 600ms (era 1.5s).
              for (let i = 0; i < 8; i++) {
                await sleep(75);
                var current = (msgBox.innerText || msgBox.textContent || "").trim();
                if (!current) return true;
              }
              return false;
            }

            // Wait for send button only for click-based diagnostics.
            let sendBtn = null;
            if (methodName === "physical_click") {
              // FAST-PATH: 8 × 100ms = 800ms (era 8s).
              for (let i = 0; i < 8; i++) {
                sendBtn = findSendBtn();
                if (sendBtn) break;
                await sleep(100);
              }
            }

            // ── Apply ONLY the requested method ──
            if (methodName === "physical_click") {
              if (!sendBtn) return { success: false, error: "send_button_not_found", attempted_method: methodName };
              try {
                sendBtn.scrollIntoView({ block: "center", inline: "center" });
                await sleep(80);
                var rect = sendBtn.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
                try { sendBtn.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerType: "mouse", pointerId: 1, isPrimary: true }, opts))); } catch (e) {}
                sendBtn.dispatchEvent(new MouseEvent("mousedown", opts));
                try { sendBtn.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerType: "mouse", pointerId: 1, isPrimary: true }, opts))); } catch (e) {}
                sendBtn.dispatchEvent(new MouseEvent("mouseup", opts));
                sendBtn.dispatchEvent(new MouseEvent("click", opts));
                // v3.9.42 — ULTIMO MIGLIO: gli eventi sintetici da soli non
                // attivano sempre il React handler di LinkedIn. Aggiungiamo il
                // .click() nativo (HTMLElement.click) come trigger primario,
                // e in fallback un form.requestSubmit() solo se il composer
                // non si svuota nei 600ms successivi.
                try { sendBtn.click(); } catch (e) {}
                await sleep(250);
                var stillFull = (msgBox.innerText || msgBox.textContent || "").trim().length > 0;
                if (stillFull) {
                  try {
                    var formFb = sendBtn.closest("form") || msgBox.closest("form");
                    if (formFb && typeof formFb.requestSubmit === "function") {
                      formFb.requestSubmit(sendBtn);
                    }
                  } catch (e) {}
                }
              } catch (e) {
                return { success: false, error: "physical_click_threw: " + e.message, attempted_method: methodName };
              }
            } else if (methodName === "form_submit") {
              var form = msgBox.closest("form") || document.querySelector(".msg-form, [class*='msg-form'] form, form.msg-form");
              if (!form) return { success: false, error: "msg_form_not_found", attempted_method: methodName };
              try {
                // requestSubmit() is intentionally avoided here: it can navigate
                // the LinkedIn page and strand the injected script until the UI
                // bridge times out. This test now probes only the SPA submit handler.
                var evt;
                try {
                  evt = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: findSendBtn() || undefined });
                } catch (e2) {
                  evt = new Event("submit", { bubbles: true, cancelable: true });
                }
                form.dispatchEvent(evt);
              } catch (e) {
                return { success: false, error: "form_submit_threw: " + e.message, attempted_method: methodName };
              }
            } else if (methodName === "keyboard_shortcut") {
              try {
                msgBox.focus();
                var isMac = /Mac|iPhone|iPad/i.test(navigator.platform || "");
                var keyOpts = {
                  key: "Enter", code: "Enter", keyCode: 13, which: 13,
                  ctrlKey: !isMac, metaKey: isMac,
                  bubbles: true, cancelable: true, composed: true,
                };
                msgBox.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
                msgBox.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
                msgBox.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
              } catch (e) {
                return { success: false, error: "keyboard_shortcut_threw: " + e.message, attempted_method: methodName };
              }
            } else if (methodName === "cdp_physical_click" || methodName === "cdp_ctrl_enter") {
              // FAST-PATH: il dispatcher esterno eseguirà la chiamata CDP direttamente.
              // Qui il testo è già scritto nel composer, niente altro da fare in-page.
              return { success: false, pending_cdp: true, attempted_method: methodName, text_written: true };
            }

            var cleared = await textboxCleared();
            if (!cleared) {
              return { success: false, error: "textbox_not_cleared", attempted_method: methodName };
            }
            return { success: true, method: methodName };
          })();
        },
        args: [message, method],
      }), externalTimeout, "sendMessageWithMethod " + method);
      const fbResult = fbRes[0] && fbRes[0].result;
      if (fbResult && fbResult.pending_cdp && fbResult.attempted_method === "cdp_physical_click") {
        const cdpClick = await AXTree.clickSendButtonPhysical(tabId);
        if (cdpClick && cdpClick.success && await composerCleared(tabId, 1500)) return { success: true, method: "cdp_physical_click" };
        return { success: false, error: (cdpClick && cdpClick.error) || "cdp_physical_click_failed", attempted_method: "cdp_physical_click" };
      }
      if (fbResult && fbResult.pending_cdp && fbResult.attempted_method === "cdp_ctrl_enter") {
        const cdpKey = await AXTree.pressCtrlEnter(tabId, await isMacPlatform());
        if (cdpKey && cdpKey.success && await composerCleared(tabId, 1500)) return { success: true, method: cdpKey.method || "cdp_ctrl_enter" };
        return { success: false, error: "cdp_ctrl_enter_textbox_not_cleared", attempted_method: "cdp_ctrl_enter" };
      }
      return fbResult || Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "no_result");
    } catch (e) {
      return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, e.message);
    }
  }

  return {
    extractProfile: extractProfile,
    sendMessage: sendMessage,
    sendMessageWithMethod: sendMessageWithMethod,
    clickConnect: clickConnect,
    clickMessage: clickMessage,
    addNote: addNote,
  };
})();
globalThis.HybridOps = HybridOps;
