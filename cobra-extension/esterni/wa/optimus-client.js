// ══════════════════════════════════════════════
// Optimus Client — WhatsApp Extension
// Background-side helpers: dom-hash, plan request via content.js relay,
// page-injectable simplifyDom + executePlan.
// ══════════════════════════════════════════════

var OptimusClient = globalThis.OptimusClient || (function() {

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

    // F4 — validate selectors against malicious patterns before execution
    var SELECTOR_BLACKLIST = /javascript:|on\w+\s*=|<script|eval\(|Function\(/i;
    var planFields = plan.fields || plan.selectors || {};
    for (var fk in planFields) {
      if (!Object.prototype.hasOwnProperty.call(planFields, fk)) continue;
      var field = planFields[fk] || {};
      var selStr = field.primary || field.selector || "";
      var fbStr = field.fallback || "";
      if (SELECTOR_BLACKLIST.test(selStr) || SELECTOR_BLACKLIST.test(fbStr)) {
        console.warn("[Optimus] Rejected malicious selector:", selStr);
        return { items: [], error: "invalid_selector" };
      }
    }

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


var Optimus = globalThis.Optimus || (function () {

  // ── Pending plan requests: requestId → { resolve, timer } ──
  var _pendingPlans = {};

  // ── Page-context: simplify a subtree to compact HTML ──
  function _pageSimplifyAndHash(rootSelector, fallbackUseBody, maxDepth, maxLength) {
    function pickRoot() {
      if (rootSelector) {
        var el = document.querySelector(rootSelector);
        if (el) return el;
      }
      return fallbackUseBody ? document.body : null;
    }

    var STRIP_TAGS_SET = ["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "CANVAS", "VIDEO", "AUDIO", "IFRAME"];
    var KEEP_ATTRS_SET = ["role", "aria-label", "aria-labelledby", "data-testid", "data-tab", "data-id", "title", "tabindex", "href", "alt"];
    var DROP_ATTR_PREFIX = ["x", "x1", "x2", "_ngcontent", "_nghost"];

    function inSet(arr, val) { return arr.indexOf(val) !== -1; }

    function isDroppedAttr(name) {
      var ln = name.toLowerCase();
      if (inSet(KEEP_ATTRS_SET, ln)) return false;
      if (ln.indexOf("aria-") === 0) return false;
      if (ln.indexOf("data-") === 0) return false;
      for (var p = 0; p < DROP_ATTR_PREFIX.length; p++) {
        if (ln.indexOf(DROP_ATTR_PREFIX[p]) === 0) return true;
      }
      return inSet(["style", "src", "srcset", "loading", "decoding", "crossorigin"], ln);
    }

    function classFilter(cls) {
      if (!cls) return "";
      return String(cls).split(/\s+/).filter(function (c) {
        if (!c) return false;
        if (/^x[a-z0-9]{4,}$/.test(c)) return false;
        if (/^_[A-Za-z0-9]{4,}$/.test(c)) return false;
        if (c.length > 30) return false;
        return true;
      }).slice(0, 4).join(" ");
    }

    function simplifyNode(node, depth) {
      if (depth > maxDepth) return "";
      if (node.nodeType === 3) {
        var t = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!t) return "";
        return t.length > 100 ? (t.slice(0, 100) + "…") : t;
      }
      if (node.nodeType !== 1) return "";
      if (inSet(STRIP_TAGS_SET, node.tagName)) return "";

      var tag = node.tagName.toLowerCase();
      var attrs = [];
      var nodeAttrs = node.attributes || [];
      for (var ai = 0; ai < nodeAttrs.length; ai++) {
        var a = nodeAttrs[ai];
        if (a.name === "class") {
          var cf = classFilter(a.value);
          if (cf) attrs.push('class="' + cf + '"');
          continue;
        }
        if (isDroppedAttr(a.name)) continue;
        var v = (a.value || "").slice(0, 80);
        v = v.replace(/"/g, "'");
        attrs.push(a.name + '="' + v + '"');
      }
      var open = "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">";
      var inner = "";
      var kids = node.childNodes;
      for (var ki = 0; ki < kids.length; ki++) {
        inner += simplifyNode(kids[ki], depth + 1);
        if (inner.length > maxLength) break;
      }
      return open + inner + "</" + tag + ">";
    }

    function sha256Hex(str) {
      var buf = new TextEncoder().encode(str);
      return crypto.subtle.digest("SHA-256", buf).then(function (hash) {
        return Array.from(new Uint8Array(hash)).map(function (b) {
          return b.toString(16).padStart(2, "0");
        }).join("");
      });
    }

    function structuralOnly(html) {
      return html
        .replace(/>[^<]+</g, "><")
        .replace(/="[^"]*"/g, '=""');
    }

    var root = pickRoot();
    if (!root) return Promise.resolve({ ok: false, error: "root_not_found" });
    var snapshot = simplifyNode(root, 0);
    if (snapshot.length > maxLength) snapshot = snapshot.slice(0, maxLength) + "<!--truncated-->";
    var structural = structuralOnly(snapshot);
    return sha256Hex(structural).then(function (hash) {
      return { ok: true, snapshot: snapshot, hash: hash, size: snapshot.length };
    });
  }

  function snapshotPage(tabId, rootSelector, maxDepth, maxLength) {
    return chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: _pageSimplifyAndHash,
      args: [rootSelector || null, true, maxDepth || 6, maxLength || 3000],
    }).then(function (r) {
      return r && r[0] && r[0].result ? r[0].result : { ok: false, error: "no_result" };
    }).catch(function (err) {
      return { ok: false, error: "inject_failed: " + (err && err.message ? err.message : String(err)) };
    });
  }

  // ── Find the webapp content script tab to relay Optimus requests ──
  // Prefers the active tab to avoid talking to the wrong Lovable tab.
  function _findWebappTab() {
    try {
      return chrome.tabs.query({}).then(function (tabs) {
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
        for (var j = 0; j < candidates.length; j++) {
          if (candidates[j].active) return candidates[j];
        }
        return candidates[0];
      });
    } catch (err) { console.debug("[WA Optimus] plan request:", err?.message); return Promise.resolve(null); }
  }

  // ── Request plan via content.js relay ──
  function getPlan(params) {
    var requestId = "optimus_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    var timeoutMs = 18000;

    return new Promise(function (resolve) {
      var resolved = false;

      var timer = setTimeout(function () {
        if (resolved) return;
        resolved = true;
        delete _pendingPlans[requestId];
        resolve({ success: false, error: "timeout", code: "PLAN_TIMEOUT" });
      }, timeoutMs);

      _pendingPlans[requestId] = {
        resolve: function (data) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          delete _pendingPlans[requestId];
          resolve(data || { success: false, error: "empty_response" });
        },
        timer: timer
      };

      _findWebappTab().then(function (tab) {
        if (!tab) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          delete _pendingPlans[requestId];
          resolve({ success: false, error: "webapp_tab_not_found", code: "NO_APP_TAB" });
          return;
        }

        try {
          chrome.tabs.sendMessage(tab.id, {
            source: "wa-background-bridge",
            type: "optimus-request",
            requestId: requestId,
            domSnapshot: params.snapshot,
            pageType: params.pageType,
            channel: params.channel || "whatsapp",
            hash: params.hash,
            previousPlanFailed: !!params.previousPlanFailed,
            failureContext: params.failureContext || null,
          });
        } catch (err) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          delete _pendingPlans[requestId];
          resolve({ success: false, error: "send_failed: " + (err && err.message ? err.message : String(err)), code: "SEND_FAILED" });
        }
      }).catch(function (err) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        delete _pendingPlans[requestId];
        resolve({ success: false, error: "find_tab_failed: " + String(err), code: "TAB_ERROR" });
      });
    });
  }

  function handlePlanResponse(message) {
    var reqId = message.requestId;
    if (!reqId || !_pendingPlans[reqId]) return false;
    _pendingPlans[reqId].resolve(message.data || message.payload || { success: false, error: "empty" });
    return true;
  }

  // ── Page-context: execute an extraction plan against a root ──
  function _pageExecutePlan(rootSelector, fallbackBody, plan) {
    function trySel(root, sel) {
      if (!sel) return null;
      try { return root.querySelector(sel); } catch (err) { console.debug("[WA Optimus] sel:", err?.message); return null; }
    }
    function tryAll(root, sel) {
      if (!sel) return [];
      try { return Array.from(root.querySelectorAll(sel)); } catch (err) { console.debug("[WA Optimus] selAll:", err?.message); return []; }
    }
    function pickFirst(root, primary, fallback) {
      var a = trySel(root, primary);
      if (a) return a;
      return trySel(root, fallback);
    }
    function getText(el) {
      if (!el) return "";
      if (el.tagName === "A" && el.getAttribute("href")) {
        return el.getAttribute("href").trim();
      }
      return (el.getAttribute("title") || el.getAttribute("aria-label") || el.textContent || "").trim();
    }

    var root = null;
    if (rootSelector) root = document.querySelector(rootSelector);
    if (!root && fallbackBody) root = document.body;
    if (!root) return { success: false, error: "root_not_found", items: [] };

    var sels = (plan && plan.selectors) || {};
    var containerSel = sels.container || {};
    var itemSel = sels.thread_item || sels.message_bubble || {};
    var containerEl = pickFirst(root, containerSel.primary, containerSel.fallback) || root;

    var itemEls = tryAll(containerEl, itemSel.primary);
    if (itemEls.length === 0) itemEls = tryAll(containerEl, itemSel.fallback);

    var fieldKeys = Object.keys(sels).filter(function (k) {
      return k !== "container" && k !== "thread_item" && k !== "message_bubble";
    });

    var URL_FIELDS = ["thread_url", "profile_url", "url", "link", "href"];

    var items = [];
    var dropped = 0;
    for (var ii = 0; ii < itemEls.length; ii++) {
      var itemEl = itemEls[ii];
      var obj = {};
      var foundFields = 0;
      for (var ki = 0; ki < fieldKeys.length; ki++) {
        var k = fieldKeys[ki];
        var f = sels[k] || {};
        var el = pickFirst(itemEl, f.primary, f.fallback);
        if (el) {
          if (URL_FIELDS.indexOf(k) !== -1 && el.tagName === "A" && el.getAttribute("href")) {
            obj[k] = el.getAttribute("href").trim();
          } else {
            obj[k] = getText(el);
          }
          if (obj[k]) foundFields++;
        }
      }
      var required = Math.max(1, Math.ceil(fieldKeys.length * 0.5));
      if (foundFields < required) { dropped++; continue; }
      items.push(obj);
    }
    return { success: true, items: items, dropped: dropped, candidates: itemEls.length };
  }

  function executePlanInTab(tabId, rootSelector, plan) {
    return chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: _pageExecutePlan,
      args: [rootSelector || null, true, plan],
    }).then(function (r) {
      return r && r[0] && r[0].result ? r[0].result : { success: false, items: [], error: "no_result" };
    }).catch(function (err) {
      return { success: false, items: [], error: "exec_failed: " + (err && err.message ? err.message : String(err)) };
    });
  }

  return {
    snapshotPage: snapshotPage,
    getPlan: getPlan,
    executePlanInTab: executePlanInTab,
    handlePlanResponse: handlePlanResponse,
  };
})();
globalThis.Optimus = Optimus;
