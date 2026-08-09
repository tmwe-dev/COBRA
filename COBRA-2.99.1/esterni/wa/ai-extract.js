// ══════════════════════════════════════════════
// WhatsApp Extension v5.0 — AI Extract Module
// Schema cache with composite key, AI edge
// function calls, DOM learning with failure-based
// invalidation
// ══════════════════════════════════════════════

var AiExtract = globalThis.AiExtract || (function () {
  const SCHEMA_TTL_MS = 3 * 60 * 60 * 1000; // 3h
  const MAX_FAILURES_BEFORE_INVALIDATE = 3;

  let _schema = null;
  let _schemaAt = 0;
  let _schemaKey = "";
  let _failureCount = 0;
  let _learning = false;

  // ── Composite cache key ──
  function buildCacheKey(hostname) {
    return "wa_" + (hostname || "web.whatsapp.com");
  }

  // ── Load from storage ──
  async function loadSchema() {
    try {
      const data = await chrome.storage.local.get(["waSchema", "waSchemaAt", "waSchemaKey"]);
      if (data.waSchema && data.waSchemaAt) {
        _schema = data.waSchema;
        _schemaAt = data.waSchemaAt;
        _schemaKey = data.waSchemaKey || "";
      }
    } catch (err) { console.debug("[WA Extract]", err?.message); }
    return _schema;
  }

  // ── Save to storage ──
  async function saveSchema(schema, hostname) {
    _schema = schema;
    _schemaAt = Date.now();
    _schemaKey = buildCacheKey(hostname);
    _failureCount = 0;
    try {
      await chrome.storage.local.set({
        waSchema: _schema,
        waSchemaAt: _schemaAt,
        waSchemaKey: _schemaKey,
      });
    } catch (err) { console.debug("[WA Extract]", err?.message); }
  }

  function isSchemaStale() {
    if (!_schema) return true;
    if (Date.now() - _schemaAt > SCHEMA_TTL_MS) return true;
    if (_failureCount >= MAX_FAILURES_BEFORE_INVALIDATE) return true;
    return false;
  }

  function getSchema() { return _schema; }

  function reportFailure() {
    _failureCount++;
    if (_failureCount >= MAX_FAILURES_BEFORE_INVALIDATE) {
      console.warn("[WA AI] Schema invalidated after " + _failureCount + " failures");
      _schema = null;
      _schemaAt = 0;
    }
  }

  // OPTIMUS V2 (N2): direct-first, bridge come fallback opzionale
  async function callAiExtract(html, mode) {
    if (!Config.hasConfig()) return null;

    // PRIMARIO: chiamata diretta alla edge function
    try {
      const url = Config.getUrl();
      const key = Config.getKey();
      const token = Config.getToken();
      if (url && key) {
        console.log("[WA AI] direct-first → edge function");
        const directResp = await fetch(`${url}/functions/v1/whatsapp-ai-extract`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token || key}`,
            "apikey": key,
          },
          body: JSON.stringify({ html: html, mode: mode }),
        });
        if (directResp.ok) return await directResp.json();
        console.warn("[WA AI] Direct call HTTP:", directResp.status);
      }
    } catch (e) {
      console.warn("[WA AI] Direct call failed:", e?.message);
    }

    // FALLBACK: bridge via webapp (bonus, non critico)
    try {
      const result = await AiBridge.callAiExtract(html, mode);
      if (result && result.success) return result;
    } catch (e) {
      console.warn("[WA AI] Bridge fallback failed:", e?.message);
    }

    return null;
  }

  // ── Grab sidebar HTML ──
  async function grabSidebarHtml(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        function scanShadowRoots(root, roots, seen) {
          try {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const el = walker.currentNode;
              if (el && el.shadowRoot && !seen.has(el.shadowRoot)) {
                seen.add(el.shadowRoot);
                roots.push(el.shadowRoot);
                scanShadowRoots(el.shadowRoot, roots, seen);
              }
            }
          } catch (err) { console.debug("[WA Extract]", err?.message); }
        }
        let rootsCache = null;
        function getRoots() {
          if (rootsCache) return rootsCache;
          const roots = [document]; const seen = new Set([document]);
          scanShadowRoots(document, roots, seen);
          rootsCache = roots; return roots;
        }
        function qsaDeep(sel) {
          const out = [], seen = new Set();
          for (const root of getRoots()) {
            try {
              root.querySelectorAll(sel).forEach(function (el) {
                if (!seen.has(el)) { seen.add(el); out.push(el); }
              });
            } catch (err) { console.debug("[WA Extract]", err?.message); }
          }
          return out;
        }
        function qsDeep(sel) { return qsaDeep(sel)[0] || null; }

        const candidates = [
          '#pane-side', '#side',
          '[data-testid="chatlist"]', '[data-testid="chat-list"]',
          '[role="navigation"]',
          '[aria-label*="chat" i]', '[aria-label*="elenco" i]',
        ];
        for (const sel of candidates) {
          const el = qsDeep(sel);
          if (el && el.outerHTML.length > 100) return el.outerHTML;
        }
        // Fallback: container with most span[title] density
        const allContainers = qsaDeep('div, nav, section, aside');
        let best = null, bestScore = 0;
        for (const cont of allContainers) {
          const titleCount = cont.querySelectorAll('span[title]').length;
          const html = cont.outerHTML;
          if (titleCount >= 3 && html.length > 200 && html.length < 500000) {
            const score = titleCount / (html.length / 1000);
            if (score > bestScore) { bestScore = score; best = cont; }
          }
        }
        return best ? best.outerHTML : null;
      },
    });
    return results && results[0] ? results[0].result : null;
  }

  // ── Learn DOM selectors via AI ──
  async function learnDomSelectors(tabId) {
    if (_learning) return { success: false, error: "Learning already in progress" };
    _learning = true;
    try {
      if (!tabId) {
        const r = await TabManager.getOrCreateWaTab();
        tabId = r.tab.id;
        await TabManager.sleep(r.reused ? 1000 : 4000);
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          function scanShadowRoots(root, roots, seen) {
            try {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              while (walker.nextNode()) {
                const el = walker.currentNode;
                if (el && el.shadowRoot && !seen.has(el.shadowRoot)) {
                  seen.add(el.shadowRoot);
                  roots.push(el.shadowRoot);
                  scanShadowRoots(el.shadowRoot, roots, seen);
                }
              }
            } catch (err) { console.debug("[WA Extract]", err?.message); }
          }
          let rootsCache = null;
          function getRoots() {
            if (rootsCache) return rootsCache;
            const roots = [document]; const seen = new Set([document]);
            scanShadowRoots(document, roots, seen);
            rootsCache = roots; return roots;
          }
          function qsaDeep(sel) {
            const out = [], seen = new Set();
            for (const root of getRoots()) {
              try { root.querySelectorAll(sel).forEach(function (el) { if (!seen.has(el)) { seen.add(el); out.push(el); } }); }
              catch (err) { console.debug("[WA Extract]", err?.message); }
            }
            return out;
          }
          function qsDeep(sel) { return qsaDeep(sel)[0] || null; }

          const snapshot = { timestamp: Date.now() };

          // data-testid inventory
          const testIds = [];
          qsaDeep('[data-testid]').forEach(function (e) {
            testIds.push({
              testId: e.getAttribute('data-testid'),
              tag: e.tagName.toLowerCase(),
              role: e.getAttribute('role'),
              ariaLabel: e.getAttribute('aria-label'),
            });
          });
          snapshot.dataTestIds = testIds.slice(0, 100);

          // Role inventory
          const roles = {};
          qsaDeep('[role]').forEach(function (e) {
            const r = e.getAttribute('role');
            roles[r] = (roles[r] || 0) + 1;
          });
          snapshot.roles = roles;

          // Aria-labels
          const labels = [];
          qsaDeep('[aria-label]').forEach(function (e) {
            labels.push({
              label: e.getAttribute('aria-label'),
              tag: e.tagName.toLowerCase(),
              testId: e.getAttribute('data-testid'),
            });
          });
          snapshot.ariaLabels = labels.slice(0, 60);

          // HTML samples
          const sidebar = qsDeep('#pane-side') || qsDeep('#side') ||
            qsDeep('[data-testid="chatlist"]') || qsDeep('[role="navigation"]');
          if (sidebar) snapshot.sidebarSample = sidebar.outerHTML.slice(0, 5000);

          const main = qsDeep('#main') || qsDeep('[data-testid="conversation-panel-messages"]');
          if (main) snapshot.mainSample = main.outerHTML.slice(0, 3000);

          if (!snapshot.sidebarSample) {
            const app = document.querySelector('#app') || document.body;
            snapshot.broadSample = app.outerHTML.slice(0, 8000);
          }

          // J5 — Sample chat items (RICH: outerHTML + ancestors + spans dettagliati)
          var chatItemSamples = [];
          var rowCandidates = qsaDeep('[role="row"], [data-testid="cell-frame-container"], [tabindex="-1"][role="listitem"]');
          for (var ci = 0; ci < Math.min(rowCandidates.length, 3); ci++) {
            var row = rowCandidates[ci];
            var sample = { outerHTML: row.outerHTML.slice(0, 3000), ancestors: [], spans: [], elements: [] };

            // Ancestors 3 livelli
            var anc = row.parentElement;
            for (var a = 0; a < 3 && anc; a++) {
              sample.ancestors.push({
                tag: anc.tagName.toLowerCase(),
                role: anc.getAttribute('role'),
                ariaLabel: anc.getAttribute('aria-label'),
                testId: anc.getAttribute('data-testid'),
                childCount: anc.children.length,
              });
              anc = anc.parentElement;
            }
            // Prev/next sibling
            if (row.previousElementSibling) sample.prevSibling = { tag: row.previousElementSibling.tagName.toLowerCase(), role: row.previousElementSibling.getAttribute('role') };
            if (row.nextElementSibling) sample.nextSibling = { tag: row.nextElementSibling.tagName.toLowerCase(), role: row.nextElementSibling.getAttribute('role') };

            // Spans con dettagli completi (max 25)
            var rowSpans = row.querySelectorAll('span');
            for (var rsi = 0; rsi < Math.min(rowSpans.length, 25); rsi++) {
              var sp = rowSpans[rsi];
              var rect = sp.getBoundingClientRect();
              var ps = sp.parentElement ? window.getComputedStyle(sp.parentElement) : null;
              sample.spans.push({
                text: (sp.textContent || '').trim().slice(0, 80),
                title: sp.getAttribute('title'),
                ariaLabel: sp.getAttribute('aria-label'),
                dir: sp.getAttribute('dir'),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                bgColor: window.getComputedStyle(sp).backgroundColor,
                parentBgColor: ps ? ps.backgroundColor : null,
                parentBorderRadius: ps ? ps.borderRadius : null,
              });
            }
            // Elementi con attributi stabili (max 30)
            var rowAll = row.querySelectorAll('*');
            for (var rai = 0; rai < Math.min(rowAll.length, 60) && sample.elements.length < 30; rai++) {
              var el = rowAll[rai];
              var attrs = {};
              for (var aa = 0; aa < el.attributes.length; aa++) {
                var an = el.attributes[aa].name;
                if (['role','aria-label','data-testid','title','tabindex','dir','href'].indexOf(an) !== -1) {
                  attrs[an] = el.attributes[aa].value;
                }
              }
              if (Object.keys(attrs).length > 0) {
                sample.elements.push({
                  tag: el.tagName.toLowerCase(),
                  attrs: attrs,
                  text: (el.textContent || '').trim().slice(0, 40),
                });
              }
            }
            chatItemSamples.push(sample);
          }
          if (chatItemSamples.length > 0) snapshot.chatItemSamples = chatItemSamples;

          // J5 — Visible buttons
          var buttons = [];
          qsaDeep('button, [role="button"]').forEach(function(btn) {
            if (btn.offsetParent === null) return;
            buttons.push({
              text: (btn.textContent || '').trim().slice(0, 50),
              ariaLabel: btn.getAttribute('aria-label') || '',
              testId: btn.getAttribute('data-testid') || '',
            });
          });
          snapshot.buttons = buttons.slice(0, 20);

          // J5 — Tabindex elements (WhatsApp uses tabindex extensively)
          var tabIndexEls = [];
          qsaDeep('[tabindex]').forEach(function(el) {
            var ti = el.getAttribute('tabindex');
            tabIndexEls.push({
              tag: el.tagName.toLowerCase(),
              tabindex: ti,
              role: el.getAttribute('role') || '',
              testId: el.getAttribute('data-testid') || '',
            });
          });
          snapshot.tabIndexElements = tabIndexEls.slice(0, 30);

          // J5 — Page language
          snapshot.lang = document.documentElement.lang || navigator.language || 'unknown';

          return snapshot;
        },
      });

      const snapshot = results && results[0] ? results[0].result : null;
      if (!snapshot) { _learning = false; return { success: false, error: "Could not capture snapshot" }; }

      if (!Config.hasConfig()) { _learning = false; return { success: false, error: "No config for AI call" }; }

      const aiResult = await callAiExtract(JSON.stringify(snapshot), "learnDom");
      if (aiResult && aiResult.success && aiResult.items && aiResult.items.length > 0) {
        const schema = aiResult.items[0];
        await saveSchema(schema, "web.whatsapp.com");
        // I4: Cache learned plan for Optimus executor (24h TTL on read side)
        try {
          await chrome.storage.local.set({
            optimus_learned_plan: schema,
            optimus_learned_at: Date.now(),
            optimus_learned_domain: "web.whatsapp.com",
          });
          console.log("[WA AI] Plan cached for Optimus");
        } catch (cacheErr) { console.debug("[WA AI] Cache save failed:", cacheErr?.message); }
        console.log("[WA AI] ✅ Learned " + Object.keys(schema).length + " selectors");
        _learning = false;
        return { success: true, schema: schema };
      }

      console.warn("[WA AI] LearnDom returned no results");
      _learning = false;
      return { success: false, error: "AI could not map selectors" };
    } catch (err) {
      console.error("[WA AI] LearnDom error:", err);
      _learning = false;
      return { success: false, error: err.message };
    }
  }

  return {
    loadSchema: loadSchema,
    saveSchema: saveSchema,
    isSchemaStale: isSchemaStale,
    getSchema: getSchema,
    reportFailure: reportFailure,
    callAiExtract: callAiExtract,
    grabSidebarHtml: grabSidebarHtml,
    learnDomSelectors: learnDomSelectors,
  };
})();
globalThis.AiExtract = AiExtract;
