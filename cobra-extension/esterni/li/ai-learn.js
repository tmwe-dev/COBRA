// ══════════════════════════════════════════════════
// AI DOM Learning Module for LinkedIn v3.0
// - Composite cache key (pageType + hostname + lang)
// - TTL + failure-based invalidation
// - No execCommand — uses Selection API + InputEvent
// ══════════════════════════════════════════════════

var AILearn = globalThis.AILearn || (function () {
  const CACHE_PREFIX = "li_dom_schema_";
  const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
  const MAX_FAILURES = 3;
  let _learning = false;
  let _failureCount = 0;

  // ── Composite cache key ──
  function cacheKey(pageType) {
    return CACHE_PREFIX + (pageType || "profile");
  }

  async function getCached(pageType) {
    try {
      const key = cacheKey(pageType);
      const data = await chrome.storage.local.get(key);
      if (data && data[key]) {
        const schema = data[key];
        if (schema.learnedAt && Date.now() - schema.learnedAt < CACHE_TTL) {
          return schema;
        }
      }
    } catch (err) { console.debug("[LI Learn]", err?.message); }
    return null;
  }

  async function saveSchema(schema, pageType) {
    schema.learnedAt = Date.now();
    schema.pageType = pageType || "profile";
    const obj = {};
    obj[cacheKey(pageType)] = schema;
    await chrome.storage.local.set(obj);
    _failureCount = 0; // reset on successful learn
    return schema;
  }

  async function clearCache(pageType) {
    if (pageType) {
      await chrome.storage.local.remove(cacheKey(pageType));
    } else {
      // Clear all schema keys
      const keys = ["profile", "messaging", "search", "inbox"].map(function (t) { return cacheKey(t); });
      await chrome.storage.local.remove(keys);
    }
  }

  // ── Record selector failure (triggers re-learn after threshold) ──
  function recordFailure() {
    _failureCount++;
    if (_failureCount >= MAX_FAILURES) {
      console.warn("[AI-Learn] " + _failureCount + " consecutive failures — invalidating cache");
      clearCache();
      _failureCount = 0;
      return true; // should re-learn
    }
    return false;
  }

  // ── DOM snapshot capture (injected into page) ──
  function captureDomSnapshot() {
    try {
      const snapshot = {
        url: window.location.href,
        title: document.title,
        lang: document.documentElement.lang || navigator.language || "unknown",
        hostname: window.location.hostname,
        dataTestIds: [],
        ariaLabels: [],
        roles: [],
        headings: [],
        buttons: [],
        textboxes: [],
        links: [],
        htmlSamples: {},
      };

      const testIds = document.querySelectorAll("[data-testid]");
      for (let i = 0; i < Math.min(testIds.length, 50); i++) {
        snapshot.dataTestIds.push({
          id: testIds[i].getAttribute("data-testid"),
          tag: testIds[i].tagName.toLowerCase(),
          text: (testIds[i].textContent || "").trim().substring(0, 80),
        });
      }

      const ariaEls = document.querySelectorAll("[aria-label]");
      for (let j = 0; j < Math.min(ariaEls.length, 50); j++) {
        snapshot.ariaLabels.push({
          label: ariaEls[j].getAttribute("aria-label"),
          tag: ariaEls[j].tagName.toLowerCase(),
          role: ariaEls[j].getAttribute("role") || "",
        });
      }

      const roleEls = document.querySelectorAll("[role]");
      for (let k = 0; k < Math.min(roleEls.length, 50); k++) {
        snapshot.roles.push({
          role: roleEls[k].getAttribute("role"),
          tag: roleEls[k].tagName.toLowerCase(),
          text: (roleEls[k].textContent || "").trim().substring(0, 60),
          ariaLabel: roleEls[k].getAttribute("aria-label") || "",
        });
      }

      const headings = document.querySelectorAll("h1, h2, h3");
      for (let h = 0; h < Math.min(headings.length, 20); h++) {
        snapshot.headings.push({
          level: headings[h].tagName,
          text: (headings[h].textContent || "").trim().substring(0, 100),
          classes: (headings[h].className || "").substring(0, 100),
        });
      }

      const buttons = document.querySelectorAll("button");
      for (let b = 0; b < Math.min(buttons.length, 30); b++) {
        if (buttons[b].offsetParent === null) continue;
        snapshot.buttons.push({
          text: (buttons[b].textContent || "").trim().substring(0, 60),
          ariaLabel: buttons[b].getAttribute("aria-label") || "",
          classes: (buttons[b].className || "").substring(0, 100),
        });
      }

      const textboxes = document.querySelectorAll("[contenteditable='true'], textarea, input[type='text']");
      for (let t = 0; t < Math.min(textboxes.length, 10); t++) {
        snapshot.textboxes.push({
          tag: textboxes[t].tagName.toLowerCase(),
          role: textboxes[t].getAttribute("role") || "",
          classes: (textboxes[t].className || "").substring(0, 100),
          placeholder: textboxes[t].getAttribute("placeholder") || textboxes[t].getAttribute("aria-placeholder") || "",
        });
      }

      const areas = {
        navBar: "nav, header, [role='banner']",
        mainContent: "main, [role='main']",
        sidebar: "aside, [role='complementary']",
        messageOverlay: "[class*='msg-overlay'], [class*='messaging']",
      };
      for (const area in areas) {
        const el = document.querySelector(areas[area]);
        if (el) snapshot.htmlSamples[area] = el.outerHTML.substring(0, 1500);
      }

      return snapshot;
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── AI learning call ──
  async function learnFromAI(tabId, pageType, supabaseUrl, supabaseKey) {
    if (_learning) return await getCached(pageType);
    _learning = true;

    try {
      const snapResults = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: captureDomSnapshot,
      });
      const snapshot = snapResults[0] && snapResults[0].result;
      if (!snapshot || snapshot.error) {
        _learning = false;
        return null;
      }

      let bridgeResp = null;

      // OPTIMUS V2 (N2): direct-first
      if (supabaseUrl && supabaseKey) {
        console.log("[AI-Learn] direct-first → linkedin-ai-extract");
        try {
          const directResp = await fetch(`${supabaseUrl}/functions/v1/linkedin-ai-extract`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseKey}`,
              "apikey": supabaseKey,
            },
            body: JSON.stringify({ mode: "learnDom", pageType: pageType || "profile", snapshot: snapshot }),
          });
          if (directResp.ok) {
            const directData = await directResp.json();
            bridgeResp = { success: true, data: directData };
          } else {
            console.warn("[AI-Learn] Direct HTTP", directResp.status);
          }
        } catch (directErr) {
          console.warn("[AI-Learn] Direct failed:", directErr?.message);
        }
      }

      // FALLBACK bridge
      if (!bridgeResp && typeof AiBridge !== "undefined" && AiBridge.aiExtractRequest) {
        try {
          bridgeResp = await AiBridge.aiExtractRequest({
            channel: "linkedin",
            mode: "learnDom",
            pageType: pageType || "profile",
            snapshot: snapshot,
          });
        } catch (bridgeErr) {
          console.warn("[AI-Learn] Bridge fallback failed:", bridgeErr?.message);
        }
      }

      if (!bridgeResp || bridgeResp.success === false) {
        console.warn("[AI-Learn] AI error:", bridgeResp && bridgeResp.error);
        _learning = false;
        return null;
      }

      const data = bridgeResp.data || {};
      if (data.schema) {
        const schema = await saveSchema(data.schema, pageType);
        console.log("[AI-Learn] ✅ Selectors learned for '" + pageType + "':", Object.keys(schema).length, "keys");
        _learning = false;
        return schema;
      }

      _learning = false;
      return null;
    } catch (e) {
      console.error("[AI-Learn] Error:", e);
      _learning = false;
      return null;
    }
  }

  // ── Schema-based extraction (injected into page) ──
  function extractWithSchema(schema) {
    try {
      const result = { name: null, headline: null, location: null, about: null, connectionStatus: "unknown" };

      if (schema.nameSelector) {
        const nameEl = document.querySelector(schema.nameSelector);
        if (nameEl) result.name = nameEl.textContent.trim();
      }
      if (schema.headlineSelector) {
        const hlEl = document.querySelector(schema.headlineSelector);
        if (hlEl) result.headline = hlEl.textContent.trim();
      }
      if (schema.locationSelector) {
        const locEl = document.querySelector(schema.locationSelector);
        if (locEl) result.location = locEl.textContent.trim();
      }
      if (schema.aboutSelector) {
        const aboutEl = document.querySelector(schema.aboutSelector);
        if (aboutEl) result.about = aboutEl.textContent.trim();
      }
      if (schema.photoSelector) {
        const photoEl = document.querySelector(schema.photoSelector);
        if (photoEl && photoEl.src) result.photoUrl = photoEl.src;
      }
      if (schema.connectButtonSelector) {
        const cb = document.querySelector(schema.connectButtonSelector);
        if (cb) result.connectionStatus = "not_connected";
      }
      if (schema.messageButtonSelector) {
        const mb = document.querySelector(schema.messageButtonSelector);
        if (mb && !document.querySelector(schema.connectButtonSelector || "____")) result.connectionStatus = "connected";
      }

      result.profileUrl = window.location.href;
      return result;
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Type message using Selection API (no execCommand) ──
  function typeMessageWithSchema(schema, messageText) {
    try {
      let msgBox = null;
      if (schema.messageInputSelector) {
        msgBox = document.querySelector(schema.messageInputSelector);
      }
      if (!msgBox) {
        msgBox = document.querySelector("div[role='textbox'][contenteditable='true']");
      }
      if (!msgBox) return { success: false, error: "AI-Learn: Message input not found" };

      msgBox.focus();

      // Clear and insert using Selection API
      let sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(msgBox);
        sel.deleteFromDocument();
      }
      const textNode = document.createTextNode(messageText);
      msgBox.appendChild(textNode);
      // Place cursor at end
      sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(msgBox);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      msgBox.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: messageText, bubbles: true }));

      let sendBtn = null;
      if (schema.sendButtonSelector) {
        sendBtn = document.querySelector(schema.sendButtonSelector);
      }
      if (!sendBtn) {
        sendBtn = Array.from(document.querySelectorAll("button")).find(function (b) {
          return /^(send|invia)$/i.test(b.textContent.trim()) && b.offsetParent !== null;
        });
      }

      if (sendBtn) {
        sendBtn.click();
        return { success: true, method: "ai_learn" };
      }
      return { success: false, error: "AI-Learn: Send button not found" };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Use learned selectors to click Connect
  function clickConnectWithSchema(schema) {
    try {
      let btn = null;
      if (schema.connectButtonSelector) {
        btn = document.querySelector(schema.connectButtonSelector);
      }
      if (!btn) {
        btn = Array.from(document.querySelectorAll("button")).find(function (el) {
          return /^(connect|collegati|connetti)$/i.test(el.textContent.trim()) && el.offsetParent !== null;
        });
      }
      if (btn) {
        btn.click();
        return { success: true, method: "ai_learn" };
      }
      return { success: false, error: "AI-Learn: Connect button not found" };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return {
    getCached: getCached,
    saveSchema: saveSchema,
    clearCache: clearCache,
    recordFailure: recordFailure,
    captureDomSnapshot: captureDomSnapshot,
    learnFromAI: learnFromAI,
    extractWithSchema: extractWithSchema,
    typeMessageWithSchema: typeMessageWithSchema,
    clickConnectWithSchema: clickConnectWithSchema,
  };
})();
globalThis.AILearn = AILearn;
