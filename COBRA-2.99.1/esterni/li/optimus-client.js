var OptimusClient = globalThis.OptimusClient || (function() {
  var _pendingResolve = null;
  var _pendingTimeout = null;

  function simplifyDom(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>')
      .replace(/src="data:[^"]*"/gi, 'src="[data]"')
      .replace(/src="https?:\/\/[^\"]{50,}"/gi, 'src="[url]"')
      .replace(/style="[^"]*"/gi, '')
      .replace(/\s{2,}/g, ' ');
  }

  function computeHash(str) {
    var hash = 5381;
    for (var i = 0; i < Math.min(str.length, 2000); i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return 'h' + Math.abs(hash).toString(36);
  }

  function requestPlan(channel, pageType, domHtml, opts) {
    opts = opts || {};
    var snapshot = simplifyDom(domHtml);
    var domHash = computeHash(snapshot);
    return {
      channel: channel,
      pageType: pageType,
      domSnapshot: snapshot,
      domHash: domHash,
      previousPlanFailed: opts.previousPlanFailed || false,
      failureContext: opts.failureContext || null
    };
  }

  function executePlan(plan, elements) {
    if (!plan || !plan.selectors) return [];
    var items = [];
    var sel = plan.selectors;
    elements.forEach(function(el) {
      var item = {};
      var fieldCount = 0;
      var fields = ['contact_name','last_message','timestamp',
        'unread_indicator','message_text','message_sender',
        'message_time','thread_url','participant_name'];
      fields.forEach(function(field) {
        if (sel[field] && sel[field].primary) {
          var found = el.querySelector(sel[field].primary);
          if (!found && sel[field].fallback)
            found = el.querySelector(sel[field].fallback);
          if (found) {
            item[field] = found.textContent.trim();
            fieldCount++;
          }
        }
      });
      if (fieldCount >= 2) items.push(item);
    });
    return items;
  }

  return { requestPlan: requestPlan, executePlan: executePlan,
           simplifyDom: simplifyDom, computeHash: computeHash };
})();
globalThis.OptimusClient = OptimusClient;

// ══════════════════════════════════════════════
// Optimus Client — LinkedIn Extension
// Background-side helpers: dom-hash, plan request via webapp bridge,
// page-injectable simplifyDom + executePlan.
// ══════════════════════════════════════════════

var Optimus = globalThis.Optimus || (function () {

  // ── Page-context: simplify a subtree to compact HTML ──
  // Designed to be injected via chrome.scripting.executeScript,
  // so it cannot reference outer-scope variables.
  function _pageSimplifyAndHash(rootSelector, fallbackUseBody, maxDepth, maxLength) {
    function pickRoot() {
      if (rootSelector) {
        const el = document.querySelector(rootSelector);
        if (el) return el;
      }
      return fallbackUseBody ? document.body : null;
    }

    const STRIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "CANVAS", "VIDEO", "AUDIO", "IFRAME"]);
    const KEEP_ATTRS = new Set(["role", "aria-label", "aria-labelledby", "data-testid", "data-tab", "data-id", "title", "tabindex", "href", "alt"]);
    const DROP_ATTR_PREFIX = ["x", "x1", "x2", "_ngcontent", "_nghost"];

    function isDroppedAttr(name) {
      const ln = name.toLowerCase();
      if (KEEP_ATTRS.has(ln)) return false;
      if (ln.startsWith("aria-")) return false;
      if (ln.startsWith("data-")) return false;
      for (const p of DROP_ATTR_PREFIX) if (ln.startsWith(p)) return true;
      return ["style", "src", "srcset", "loading", "decoding", "crossorigin"].indexOf(ln) !== -1;
    }

    function classFilter(cls) {
      if (!cls) return "";
      return String(cls).split(/\s+/).filter(function (c) {
        if (!c) return false;
        // Drop offuscated short classes like x1n2onr6
        if (/^x[a-z0-9]{4,}$/.test(c)) return false;
        if (/^_[A-Za-z0-9]{4,}$/.test(c)) return false;
        if (c.length > 30) return false;
        return true;
      }).slice(0, 4).join(" ");
    }

    function simplifyNode(node, depth) {
      if (depth > maxDepth) return "";
      if (node.nodeType === 3) {
        const t = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!t) return "";
        return t.length > 100 ? (t.slice(0, 100) + "…") : t;
      }
      if (node.nodeType !== 1) return "";
      if (STRIP_TAGS.has(node.tagName)) return "";

      const tag = node.tagName.toLowerCase();
      const attrs = [];
      for (const a of Array.from(node.attributes || [])) {
        if (a.name === "class") {
          const cf = classFilter(a.value);
          if (cf) attrs.push('class="' + cf + '"');
          continue;
        }
        if (isDroppedAttr(a.name)) continue;
        let v = (a.value || "").slice(0, 80);
        v = v.replace(/"/g, "'");
        attrs.push(a.name + '="' + v + '"');
      }
      const open = "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">";
      let inner = "";
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        inner += simplifyNode(kids[i], depth + 1);
        if (inner.length > maxLength) break;
      }
      return open + inner + "</" + tag + ">";
    }

    // SHA-256 via SubtleCrypto (page context has it)
    async function sha256Hex(str) {
      const buf = new TextEncoder().encode(str);
      const hash = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(hash)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    }

    // Structural-only fingerprint (drops text values)
    function structuralOnly(html) {
      return html
        .replace(/>[^<]+</g, "><")
        .replace(/="[^"]*"/g, '=""');
    }

    return new Promise(async function (resolve) {
      const root = pickRoot();
      if (!root) { resolve({ ok: false, error: "root_not_found" }); return; }
      let snapshot = simplifyNode(root, 0);
      if (snapshot.length > maxLength) snapshot = snapshot.slice(0, maxLength) + "<!--truncated-->";
      const structural = structuralOnly(snapshot);
      const hash = await sha256Hex(structural);
      resolve({ ok: true, snapshot: snapshot, hash: hash, size: snapshot.length });
    });
  }

  // Inject simplify+hash and return result
  async function snapshotPage(tabId, rootSelector, maxDepth, maxLength) {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: _pageSimplifyAndHash,
      args: [rootSelector || null, true, maxDepth || 6, maxLength || 3000],
    });
    return r && r[0] && r[0].result ? r[0].result : { ok: false, error: "no_result" };
  }

  // ── Request plan via webapp bridge ──
  async function _findAppTab() {
    try {
      var tabs = await chrome.tabs.query({});
      var candidates = [];
      for (var i = 0; i < tabs.length; i++) {
        var url = tabs[i].url || "";
        if (
          url.match(/lovable\.app/i) ||
          url.match(/lovableproject\.com/i) ||
          url.match(/localhost(:\d+)?/i) ||
          url.match(/127\.0\.0\.1(:\d+)?/i)
        ) {
          candidates.push(tabs[i]);
        }
      }
      if (candidates.length === 0) return null;
      // Prefer active tab, then most recently accessed
      for (var j = 0; j < candidates.length; j++) {
        if (candidates[j].active) return candidates[j];
      }
      return candidates[0];
    } catch (err) { console.debug("[LI Optimus] plan:", err?.message); }
    return null;
  }

  async function getPlan(params) {
    const appTab = await _findAppTab();
    if (!appTab) {
      return { success: false, error: "webapp_tab_not_found", code: "NO_APP_TAB" };
    }

    const requestId = "optimus_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    const timeoutMs = 18000;

    return new Promise(async function (resolve) {
      let resolved = false;
      const timer = setTimeout(function () {
        if (resolved) return;
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        resolve({ success: false, error: "timeout", code: "PLAN_TIMEOUT" });
      }, timeoutMs);

      function handler(message) {
        if (!message || message.source !== "wca-optimus-response") return;
        if (message.requestId !== requestId) return;
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(handler);
        resolve(message.payload || { success: false, error: "empty_response" });
      }
      chrome.runtime.onMessage.addListener(handler);

      try {
        await chrome.scripting.executeScript({
          target: { tabId: appTab.id },
          func: function (req) {
            window.postMessage({
              direction: "from-extension-optimus-request",
              requestId: req.requestId,
              channel: req.channel,
              pageType: req.pageType,
              snapshot: req.snapshot,
              hash: req.hash,
              previousPlanFailed: !!req.previousPlanFailed,
              failureContext: req.failureContext || null,
            }, window.location.origin);
          },
          args: [{
            requestId: requestId,
            channel: params.channel,
            pageType: params.pageType,
            snapshot: params.snapshot,
            hash: params.hash,
            previousPlanFailed: params.previousPlanFailed,
            failureContext: params.failureContext,
          }],
        });
      } catch (e) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(handler);
        resolve({ success: false, error: "dispatch_failed: " + (e && e.message ? e.message : String(e)), code: "DISPATCH_FAILED" });
      }
    });
  }

  // ── Page-context: execute an extraction plan against a root ──
  function _pageExecutePlan(rootSelector, fallbackBody, plan) {
    function trySel(root, sel) {
      if (!sel) return null;
      try { return root.querySelector(sel); } catch (err) { console.debug("[LI Optimus] sel:", err?.message); return null; }
    }
    function tryAll(root, sel) {
      if (!sel) return [];
      try { return Array.from(root.querySelectorAll(sel)); } catch (err) { console.debug("[LI Optimus] selAll:", err?.message); return []; }
    }
    function pickFirst(root, primary, fallback) {
      const a = trySel(root, primary);
      if (a) return a;
      return trySel(root, fallback);
    }
    function getText(el) {
      if (!el) return "";
      // For links, prefer href attribute (critical for thread_url extraction)
      if (el.tagName === "A" && el.getAttribute("href")) {
        return el.getAttribute("href").trim();
      }
      return (el.getAttribute("title") || el.getAttribute("aria-label") || el.textContent || "").trim();
    }

    let root = null;
    if (rootSelector) root = document.querySelector(rootSelector);
    if (!root && fallbackBody) root = document.body;
    if (!root) return { success: false, error: "root_not_found", items: [] };

    const sels = (plan && plan.selectors) || {};
    const containerSel = sels.container || {};
    const itemSel = sels.thread_item || sels.message_bubble || {};
    const containerEl = pickFirst(root, containerSel.primary, containerSel.fallback) || root;

    let itemEls = tryAll(containerEl, itemSel.primary);
    if (itemEls.length === 0) itemEls = tryAll(containerEl, itemSel.fallback);

    const fieldKeys = Object.keys(sels).filter(function (k) { return k !== "container" && k !== "thread_item" && k !== "message_bubble"; });

    // Fields that should extract href instead of text
    var URL_FIELDS = ["thread_url", "profile_url", "url", "link", "href"];

    const items = [];
    let dropped = 0;
    for (const itemEl of itemEls) {
      const obj = {};
      let foundFields = 0;
      for (const k of fieldKeys) {
        const f = sels[k] || {};
        const el = pickFirst(itemEl, f.primary, f.fallback);
        if (el) {
          // For URL fields, prefer href; for others, prefer text content
          if (URL_FIELDS.indexOf(k) !== -1 && el.tagName === "A" && el.getAttribute("href")) {
            obj[k] = el.getAttribute("href").trim();
          } else {
            obj[k] = getText(el);
          }
          if (obj[k]) foundFields++;
        }
      }
      const required = Math.max(1, Math.ceil(fieldKeys.length * 0.5));
      if (foundFields < required) { dropped++; continue; }

      // ── Robust fallback for thread_url / profile_url ──
      // The AI plan often omits a selector for the URL field, or picks a
      // non-anchor element. Always try to harvest a real LinkedIn link from
      // inside the item before giving up.
      try {
        if (!obj.thread_url) {
          var anchor = itemEl.querySelector("a[href*='/messaging/thread/']")
            || itemEl.querySelector("a[href*='/messaging/']");
          if (anchor && anchor.getAttribute("href")) {
            obj.thread_url = anchor.getAttribute("href").trim();
          } else if (itemEl.tagName === "A" && itemEl.getAttribute("href")) {
            obj.thread_url = itemEl.getAttribute("href").trim();
          } else {
            var parentA = itemEl.closest && itemEl.closest("a[href*='/messaging/']");
            if (parentA && parentA.getAttribute("href")) {
              obj.thread_url = parentA.getAttribute("href").trim();
            }
          }
        }
        if (!obj.profile_url) {
          var pAnchor = itemEl.querySelector("a[href*='/in/']");
          if (pAnchor && pAnchor.getAttribute("href")) {
            obj.profile_url = pAnchor.getAttribute("href").trim();
          }
        }
        // Resolve relative URLs to absolute
        if (obj.thread_url && obj.thread_url.indexOf("http") !== 0) {
          obj.thread_url = new URL(obj.thread_url, location.origin).href;
        }
        if (obj.profile_url && obj.profile_url.indexOf("http") !== 0) {
          obj.profile_url = new URL(obj.profile_url, location.origin).href;
        }
      } catch (e) { /* ignore */ }

      items.push(obj);
    }
    return { success: true, items: items, dropped: dropped, candidates: itemEls.length };
  }

  async function executePlanInTab(tabId, rootSelector, plan) {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: _pageExecutePlan,
      args: [rootSelector || null, true, plan],
    });
    return r && r[0] && r[0].result ? r[0].result : { success: false, items: [], error: "no_result" };
  }

  return {
    snapshotPage: snapshotPage,
    getPlan: getPlan,
    executePlanInTab: executePlanInTab,
  };
})();
globalThis.Optimus = Optimus;
