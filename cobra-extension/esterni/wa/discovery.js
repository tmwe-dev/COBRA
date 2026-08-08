// ══════════════════════════════════════════════
// WhatsApp Extension v5.0 — Discovery Module
// Deep DOM scanning, Shadow DOM, multi-strategy
// element discovery without hardcoded selectors
// ══════════════════════════════════════════════

var Discovery = globalThis.Discovery || (function () {

  // ── Injected discovery script (runs inside WA tab) ──
  function buildDiscoveryScript() {
    return function () {
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
        } catch (err) { console.debug("[WA Discovery]", err?.message); }
      }

      let searchRootsCache = null;
      function getSearchRoots() {
        if (searchRootsCache) return searchRootsCache;
        const roots = [document];
        const seen = new Set([document]);
        scanShadowRoots(document, roots, seen);
        searchRootsCache = roots;
        return roots;
      }

      function qsaDeep(sel) {
        const out = [], seen = new Set();
        for (const root of getSearchRoots()) {
          try {
            root.querySelectorAll(sel).forEach(function (el) {
              if (!seen.has(el)) { seen.add(el); out.push(el); }
            });
          } catch (err) { console.debug("[WA Discovery]", err?.message); }
        }
        return out;
      }

      function qsDeep(sel) { return qsaDeep(sel)[0] || null; }

      function filterVisible(els) {
        return Array.from(els || []).filter(function (el) {
          try {
            const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            return !rect || rect.width > 0 || rect.height > 0;
          } catch (err) { console.debug("[WA Discovery] rect:", err?.message); return true; }
        });
      }

      function byTestId(id) { return qsDeep('[data-testid="' + id + '"]'); }

      const result = {
        url: location.href,
        title: document.title,
        isWhatsApp: location.hostname === "web.whatsapp.com",
        visibilityState: document.visibilityState || null,
        hidden: !!document.hidden,
        shadowRootCount: Math.max(0, getSearchRoots().length - 1),
      };

      // ── QR detection ──
      result.hasQR = !!(
        byTestId("qrcode") ||
        document.querySelector('canvas[aria-label*="QR"]') ||
        document.querySelector('canvas[aria-label*="qr"]') ||
        document.querySelector('[data-ref]')
      );

      // ── Sidebar discovery ──
      result.sidebar = null;
      result.sidebarSelector = null;
      const sidebarCandidates = [
        { sel: '#pane-side', name: 'pane-side' },
        { sel: '#side', name: 'side' },
        { sel: '[data-testid="chatlist"]', name: 'chatlist-testid' },
        { sel: '[data-testid="chat-list"]', name: 'chat-list-testid' },
        { sel: '[aria-label*="chat list" i]', name: 'aria-chatlist' },
        { sel: '[aria-label*="elenco chat" i]', name: 'aria-elenco' },
        { sel: 'nav [role="list"]', name: 'nav-list' },
        { sel: '[role="navigation"]', name: 'role-nav' },
      ];
      for (const c of sidebarCandidates) {
        const el = qsDeep(c.sel);
        if (el && ((el.children && el.children.length > 0) || (el.textContent || "").trim().length > 0)) {
          result.sidebar = true;
          result.sidebarSelector = c.name;
          result.sidebarChildCount = el.children.length;
          break;
        }
      }

      // ── Chat items discovery (5 strategies) ──
      result.chatItems = 0;
      result.chatItemsMethod = null;

      // S1: data-testid patterns
      const chatItemStrategies = [
        { sel: '[data-testid="cell-frame-container"]', name: 'cell-frame' },
        { sel: '[data-testid="chat-cell-wrapper"]', name: 'cell-wrapper' },
        { sel: '[data-testid="list-item"]', name: 'list-item' },
        { sel: '[role="listitem"]', name: 'role-listitem' },
        { sel: '[role="row"]', name: 'role-row' },
        { sel: '[tabindex="-1"][role="row"]', name: 'tabindex-row' },
      ];
      for (const s of chatItemStrategies) {
        const items = filterVisible(qsaDeep(s.sel));
        if (items.length > 0) {
          result.chatItems = items.length;
          result.chatItemsMethod = s.name;
          break;
        }
      }

      // S2: role container children
      if (result.chatItems === 0) {
        const containers = filterVisible(qsaDeep('[role="list"], [role="listbox"], [role="grid"]'));
        for (const cont of containers) {
          const visibleChildren = filterVisible(Array.from(cont.children || []));
          if (visibleChildren.length >= 3) {
            result.chatItems = visibleChildren.length;
            result.chatItemsMethod = 'role-container-children';
            result.discoveredContainerRole = cont.getAttribute("role");
            break;
          }
        }
      }

      // S3: span[title] heuristic
      if (result.chatItems === 0 && !result.hasQR) {
        const allSpansWithTitle = filterVisible(qsaDeep('span[title]'));
        const parentCounts = new Map();
        for (const sp of allSpansWithTitle) {
          const p = sp.parentElement && sp.parentElement.parentElement && sp.parentElement.parentElement.parentElement;
          if (p) {
            const key = p.tagName + '.' + (p.className || '').split(' ')[0];
            parentCounts.set(key, (parentCounts.get(key) || 0) + 1);
          }
        }
        let bestKey = null, bestCount = 0;
        for (const entry of parentCounts) {
          if (entry[1] > bestCount) { bestCount = entry[1]; bestKey = entry[0]; }
        }
        if (bestCount >= 3) {
          result.chatItems = bestCount;
          result.chatItemsMethod = 'span-title-heuristic';
          result.heuristicPattern = bestKey;
        }
      }

      // ── Compose box detection ──
      result.hasComposeBox = !!(
        byTestId("conversation-compose-box-input") ||
        qsDeep('#main [contenteditable="true"]') ||
        qsDeep('[role="textbox"][contenteditable="true"]') ||
        qsDeep('[data-testid="compose-box"]')
      );
      result.textboxCount = qsaDeep('[role="textbox"], [contenteditable="true"]').length;

      // ── Loading/auth shell markers ──
      result.hasLoadingScreen = !!(
        qsDeep('[data-testid="intro-md-beta-logo"]') ||
        qsDeep('.landing-window') ||
        qsDeep('[data-testid="startup"]')
      );
      result.hasServiceWorker = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
      result.storageMarkers = [];
      try {
        const storageKeys = Object.keys(window.localStorage || {});
        const authMarkerPatterns = ['last-wid', 'last-wid-md', 'remember-me', 'rememberme', 'md-opted-in'];
        result.storageMarkers = storageKeys.filter(function (key) {
          const lower = String(key || '').toLowerCase();
          return authMarkerPatterns.some(function (m) { return lower.indexOf(m) !== -1; });
        }).slice(0, 12);
      } catch (err) { console.debug("[WA Discovery]", err?.message); }

      // ── App loaded check ──
      result.appLoaded = !!(qsDeep('#app') || qsDeep('[id="app"]'));
      result.bodyChildCount = document.body ? document.body.children.length : 0;

      // ── Sample first chat HTML for AI learning ──
      if (result.chatItems > 0 && result.chatItemsMethod) {
        try {
          let firstItem;
          if (result.chatItemsMethod === 'role-container-children') {
            const cont2 = qsDeep('[role="list"], [role="listbox"], [role="grid"]');
            firstItem = cont2 && cont2.children[0];
          } else if (result.chatItemsMethod === 'span-title-heuristic') {
            firstItem = (qsDeep('span[title]') || {}).closest && qsDeep('span[title]').closest('[tabindex]') ||
              (qsDeep('span[title]') || {}).parentElement && qsDeep('span[title]').parentElement.parentElement;
          } else {
            const selectorMap = {
              'cell-frame': '[data-testid="cell-frame-container"]',
              'cell-wrapper': '[data-testid="chat-cell-wrapper"]',
              'list-item': '[data-testid="list-item"]',
              'role-listitem': '[role="listitem"]',
              'role-row': '[role="row"]',
              'tabindex-row': '[tabindex="-1"][role="row"]',
            };
            firstItem = qsDeep(selectorMap[result.chatItemsMethod]);
          }
          if (firstItem) {
            result.firstChatHTML = firstItem.outerHTML.slice(0, 2000);
            const titleEl = firstItem.querySelector('span[title]');
            result.firstTitle = titleEl ? titleEl.getAttribute("title") : null;
          }
        } catch (err) { console.debug("[WA Discovery]", err?.message); }
      }

      // ── data-testid inventory ──
      const testIds = new Set();
      qsaDeep('[data-testid]').forEach(function (e) { testIds.add(e.getAttribute('data-testid')); });
      result.dataTestIds = Array.from(testIds).slice(0, 80);

      return result;
    };
  }

  // ── Run discovery on a tab ──
  async function runDiscoveryScript(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: buildDiscoveryScript(),
    });
    return results && results[0] ? results[0].result : null;
  }

  function hasRenderableWaUi(result) {
    if (!result) return false;
    if (result.sidebar) return true;
    if ((result.chatItems || 0) > 0) return true;
    if (result.hasComposeBox || (result.textboxCount || 0) > 0) return true;
    return Array.isArray(result.dataTestIds) && result.dataTestIds.length >= 6;
  }

  function hasShellSignals(result) {
    if (!result) return false;
    return (
      Array.isArray(result.dataTestIds) && result.dataTestIds.length >= 12 && result.bodyChildCount >= 10
    ) || (
      result.hasServiceWorker && result.bodyChildCount >= 10
    ) || (
      Array.isArray(result.storageMarkers) && result.storageMarkers.length > 0 && result.bodyChildCount >= 8
    );
  }

  async function waitForRenderableWaUi(tabId, maxAttempts, delayPlan) {
    let lastResult = null;
    for (let attempt = 0; attempt < (maxAttempts || 1); attempt++) {
      if (attempt > 0) {
        const delay = Array.isArray(delayPlan)
          ? (delayPlan[Math.min(attempt - 1, delayPlan.length - 1)] || 1200)
          : (delayPlan || 1200);
        await TabManager.sleep(delay);
      }
      try {
        lastResult = await runDiscoveryScript(tabId);
        if (lastResult && (lastResult.hasQR || hasRenderableWaUi(lastResult))) {
          return lastResult;
        }
      } catch (err) { console.debug("[WA Discovery]", err?.message); }
    }
    return lastResult;
  }

  function compactDiscovery(result) {
    if (!result) return null;
    return {
      url: result.url || null,
      title: result.title || null,
      hasQR: !!result.hasQR,
      hasLoadingScreen: !!result.hasLoadingScreen,
      sidebar: !!result.sidebar,
      sidebarSelector: result.sidebarSelector || null,
      chatItems: Number(result.chatItems || 0),
      chatItemsMethod: result.chatItemsMethod || null,
      hasComposeBox: !!result.hasComposeBox,
      textboxCount: Number(result.textboxCount || 0),
      appLoaded: !!result.appLoaded,
      bodyChildCount: Number(result.bodyChildCount || 0),
      dataTestIdsCount: Array.isArray(result.dataTestIds) ? result.dataTestIds.length : 0,
      storageMarkers: Array.isArray(result.storageMarkers) ? result.storageMarkers : [],
      hasServiceWorker: !!result.hasServiceWorker,
      visibilityState: result.visibilityState || null,
      hidden: !!result.hidden,
      shadowRootCount: Number(result.shadowRootCount || 0),
    };
  }

  return {
    runDiscoveryScript: runDiscoveryScript,
    hasRenderableWaUi: hasRenderableWaUi,
    hasShellSignals: hasShellSignals,
    waitForRenderableWaUi: waitForRenderableWaUi,
    compactDiscovery: compactDiscovery,
  };
})();
globalThis.Discovery = Discovery;
