// ══════════════════════════════════════════════════
// LinkedIn Extension — High-Level Actions Module
// Orchestrates hybrid operations into user-facing actions
// ══════════════════════════════════════════════════

var Actions = globalThis.Actions || (function () {

  function withTimeout(label, ms, work) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ success: false, error: label + "_timeout_" + ms + "ms", timedOut: true });
      }, ms);

      Promise.resolve().then(work).then(function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      }, function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ success: false, error: (err && err.message) || String(err) });
      });
    });
  }

  function noExistingLinkedInTab(errorCode, actionLabel) {
    return Config.errorResponse(errorCode, "no_existing_linkedin_tab: apri LinkedIn una volta in Chrome; " + actionLabel + " non apre nuove tab e non cambia pagina");
  }

  async function extractProfileByUrl(url) {
    if (!url) return Config.errorResponse(Config.ERROR.EXTRACTION_FAILED, "URL mancante");
    const tab = await TabManager.getLinkedInTab(url, false, false);
    if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.EXTRACTION_FAILED, "Estrai profilo");
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    return await HybridOps.extractProfile(tab.id);
  }

  async function sendLinkedInMessage(profileUrl, message) {
    if (!profileUrl) return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "URL profilo mancante");
    if (!message) return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "Messaggio mancante");
    const target = profileUrl.replace(/\/$/, "");
    // P1 — Thread URL detection: se l'URL è un thread di messaggistica, il
    // bottone "Messaggia" non esiste. Saltiamo clickMessage e andiamo dritti
    // a sendMessage, che cerca direttamente la textbox del composer.
    const isThreadUrl = /linkedin\.com\/messaging\/thread\//i.test(target);
    async function attempt() {
      // P21 — Come backup funzionante: NON usiamo skipNavigateIfSameDomain.
      // Se la tab LinkedIn esiste ma è su /messaging/inbox o su un altro
      // profilo, dobbiamo navigarla al target (chrome.tabs.update con solo
      // {url} NON attiva la tab, quindi resta focus-safe). Senza questo,
      // clickMessage gira sulla pagina sbagliata e fallisce con
      // "Profile-scoped message button not found".
      const tab = await TabManager.getLinkedInTab(target, false, false);
      if (!tab || !tab.id) {
        return { tabId: null, result: Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "no_existing_linkedin_tab: apri LinkedIn una volta in Chrome; l'invio non apre nuove tab e non cambia pagina") };
      }
      // P17 — Focus-safe come WhatsApp: NON attiviamo mai la tab LinkedIn
      // durante l'invio. L'utente deve restare sulla webapp e continuare a lavorare.
      // La scrittura/click avvengono via chrome.scripting in background.
      await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
      // P15 — Chiudi SOLO le chat fluttuanti stale (msg-overlay-conversation-bubble)
      // di conversazioni precedenti. NON tocchiamo .msg-form della pagina /messaging
      // né i [role='dialog'] del profilo: quelli sono il composer corretto.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            try {
              var overlays = document.querySelectorAll(
                ".msg-overlay-conversation-bubble, [class*='msg-overlay-conversation-bubble']"
              );
              for (var i = 0; i < overlays.length; i++) {
                var ov = overlays[i];
                var closeBtn = ov.querySelector(
                  "button[aria-label*='hiudi' i], button[aria-label*='lose' i], button[data-control-name*='close' i]"
                );
                if (closeBtn) { try { closeBtn.click(); } catch (e) {} continue; }
                try { ov.remove(); } catch (e) {}
              }
              return overlays.length;
            } catch (e) { return 0; }
          },
        });
        await TabManager.sleep(300);
      } catch (e) { /* best-effort */ }
      let composerAlreadyOpen = false;
      try {
        const composerProbe = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            var scopes = document.querySelectorAll(
              ".msg-form, [class*='msg-form'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation'], [role='dialog']"
            );
            for (var i = 0; i < scopes.length; i++) {
              var scope = scopes[i];
              var visible = scope.offsetParent !== null || scope.getClientRects().length > 0;
              if (!visible) continue;
              if (scope.querySelector("[contenteditable='true'], div[role='textbox'], [role='textbox']")) return true;
            }
            return false;
          },
        });
        composerAlreadyOpen = !!(composerProbe[0] && composerProbe[0].result);
      } catch (e) { composerAlreadyOpen = false; }
      // P11 — Verifica URL stretta: dopo navigate dobbiamo essere ESATTAMENTE
      // sul profilo richiesto (/in/<slug>). Niente scorciatoia "qualsiasi
      // /messaging/thread/ va bene": se la tab era già su una chat diversa,
      // si mandava al destinatario sbagliato. Abortiamo anche se il composer
      // è "già aperto" su un thread non verificato.
      try {
        const tabInfo = await chrome.tabs.get(tab.id);
        const currentUrl = (tabInfo && (tabInfo.url || tabInfo.pendingUrl)) || "";
        const targetSlug = (target.match(/linkedin\.com\/(?:in|pub)\/([^\/?#]+)/i) || [])[1];
        const onTarget = !!(targetSlug && currentUrl.toLowerCase().includes("/in/" + targetSlug.toLowerCase()));
        if (!isThreadUrl && !onTarget) {
          console.warn("[LI Send] wrong_recipient", { wanted: targetSlug, currentUrl: currentUrl });
          return { tabId: tab.id, result: Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "wrong_recipient: tab non sul profilo richiesto (" + currentUrl + ")") };
        }
      } catch (e) { /* se tabs.get fallisce, lasciamo procedere */ }
      if (!isThreadUrl && !composerAlreadyOpen) {
        const clickResult = await HybridOps.clickMessage(tab.id);
        if (!clickResult || !clickResult.success) {
          return { tabId: tab.id, result: Config.errorResponse(Config.ERROR.MESSAGE_FAILED, (clickResult && clickResult.error) || "Message button not found") };
        }
        await TabManager.sleep(3000);
      } else {
        // Thread/composer già aperto: diamo solo il tempo al composer di montarsi.
        await TabManager.sleep(composerAlreadyOpen ? 500 : 1500);
      }
      const sendResult = await HybridOps.sendMessage(tab.id, message);
      return { tabId: tab.id, result: sendResult };
    }
    let { tabId, result } = await attempt();
    // Se la guardia URL ha intercettato un drift (es. click finito sulla nav inbox),
    // forziamo la ri-navigazione al profilo e ritentiamo UNA sola volta.
    if (result && !result.success && /navigation_drifted/i.test(result.error || "")) {
      try { await chrome.tabs.update(tabId, { url: target }); } catch (e) { /* ignore */ }
      await TabManager.sleep(2500);
      const retry = await attempt();
      result = retry.result;
    }
    return result;
  }

  async function findLinkedInTabWithOpenComposer(targetClean) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: "*://*.linkedin.com/*" }); } catch (e) { tabs = []; }
    let best = null;
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (!t || !t.id) continue;
      try {
        const probe = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: function (targetUrl) {
            function isVisible(el) { return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0)); }
            var scopes = document.querySelectorAll(".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']");
            var visibleScopes = 0;
            var textboxes = 0;
            for (var s = 0; s < scopes.length; s++) {
              if (!isVisible(scopes[s])) continue;
              visibleScopes++;
              var boxes = scopes[s].querySelectorAll("[contenteditable='true'], div[role='textbox'], [role='textbox']");
              for (var b = 0; b < boxes.length; b++) if (isVisible(boxes[b])) textboxes++;
            }
            var clean = location.href.split("?")[0].replace(/\/$/, "");
            var target = String(targetUrl || "");
            var score = 0;
            if (textboxes > 0) score += 100;
            if (/linkedin\.com\/messaging\/thread\//i.test(clean)) score += 30;
            if (target && clean === target) score += 20;
            if (document.hasFocus()) score += 5;
            return { hasComposer: textboxes > 0, score: score, url: location.href, visibleScopes: visibleScopes, textboxes: textboxes, title: document.title };
          },
          args: [targetClean],
        });
        const r = probe && probe[0] && probe[0].result;
        if (r && r.hasComposer && (!best || r.score > best.score)) best = { id: t.id, score: r.score, probe: r };
      } catch (e) { /* tab non iniettabile/discarded: ignora */ }
    }
    return best;
  }

  // v3.9.44 — Background mode: il test diagnostico apre da solo il composer
  // (come l'invio standard) e poi esegue il metodo scelto. L'operatore non
  // deve più aprire manualmente la chat. Riusa la stessa logica di
  // sendLinkedInMessage: navigate focus-safe → clickMessage se serve →
  // attesa composer → HybridOps.sendMessageWithMethod.
  async function sendLinkedInMessageWithMethod(profileUrl, message, method) {
    if (!profileUrl) return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "URL profilo mancante");
    if (!message) return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "Messaggio mancante");
    if (!method) return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "method mancante");
    const target = profileUrl.replace(/\/$/, "");
    const isThreadUrl = /linkedin\.com\/messaging\/thread\//i.test(target);
    const targetClean = target.split("?")[0].replace(/\/$/, "");
    // Anti-doppio-invio: se l'utente ri-clicca entro 2s sulla stessa coppia (url, msg), no-op.
    try {
      const now = Date.now();
      const stored = (globalThis.__lvLiDiagInflight || null);
      if (stored && stored.url === targetClean && stored.msg === message && (now - stored.at) < 2000) {
        return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "duplicate_send_blocked: invio identico entro 2s, atteso debounce");
      }
      globalThis.__lvLiDiagInflight = { url: targetClean, msg: message, at: now };
    } catch (e) { /* best-effort */ }
    // 1) Naviga SEMPRE focus-safe la tab LinkedIn esistente al target.
    //    Non preferire più "qualunque composer aperto": se Chrome era già su
    //    una thread diversa, il test rapido finiva lì. La guardia resta sotto,
    //    ma prima di bloccare diamo al tab-manager la possibilità di portarsi
    //    sul profilo/thread richiesto.
    const tab = await TabManager.getLinkedInTab(target, false, false);
    if (!tab || !tab.id) {
      return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "no_existing_linkedin_tab: apri LinkedIn una volta in Chrome; il test non apre nuove tab");
    }
    // 2) Focus-safe ready (non porta la tab in foreground).
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    // 2.ter) Aspetta che la tab sia "complete" (max 4s, poll 250ms). In
    // background il renderer monta più lento; senza questa attesa il probe
    // del bottone Messaggia parte troppo presto.
    let lastTabStatus = "unknown";
    let lastTabUrl = "";
    for (let i = 0; i < 16; i++) {
      try {
        const ti = await chrome.tabs.get(tab.id);
        lastTabStatus = (ti && ti.status) || "unknown";
        lastTabUrl = (ti && (ti.url || ti.pendingUrl)) || "";
        if (lastTabStatus === "complete") break;
      } catch (e) { /* ignore */ }
      await TabManager.sleep(250);
    }
    // 2.bis) HARD GUARD destinatario: dopo navigate la tab DEVE essere sul
    // profilo richiesto (`/in/<slug>`) o su un thread URL esplicito passato
    // dal chiamante. Senza questo check, se la tab era già aperta su una
    // chat diversa, mandavamo al destinatario sbagliato.
    try {
      const tabInfo = await chrome.tabs.get(tab.id);
      const currentUrl = (tabInfo && (tabInfo.url || tabInfo.pendingUrl)) || "";
      const targetSlug = (target.match(/linkedin\.com\/(?:in|pub)\/([^\/?#]+)/i) || [])[1];
      const onTarget = !!(targetSlug && currentUrl.toLowerCase().includes("/in/" + targetSlug.toLowerCase()));
      if (!isThreadUrl && !onTarget) {
        console.warn("[LI Send] wrong_recipient (withMethod)", { wanted: targetSlug, currentUrl: currentUrl });
        return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, "wrong_recipient: tab non sul profilo richiesto (" + currentUrl + ")");
      }
    } catch (e) { /* se tabs.get fallisce, lasciamo procedere */ }
    // 3) Probe composer.
    async function probeComposer() {
      try {
        const probe = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            // Deep query (include shadow roots) come fa HybridOps.sendMessageWithMethod.
            function deepQueryAll(selector, root) {
              var out = [];
              var r = root || document;
              try { out.push.apply(out, r.querySelectorAll(selector)); } catch (e) {}
              var all = r.querySelectorAll ? r.querySelectorAll("*") : [];
              for (var i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) {
                  try { out.push.apply(out, deepQueryAll(selector, all[i].shadowRoot)); } catch (e) {}
                }
              }
              return out;
            }
            var scopes = deepQueryAll(
              ".msg-form, [class*='msg-form'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation'], [role='dialog']"
            );
            for (var i = 0; i < scopes.length; i++) {
              var scope = scopes[i];
              var visible = scope.offsetParent !== null || scope.getClientRects().length > 0;
              if (!visible) continue;
              var boxes = scope.querySelectorAll("[contenteditable='true'], div[role='textbox'], [role='textbox']");
              for (var j = 0; j < boxes.length; j++) {
                var el = boxes[j];
                if (el.offsetParent !== null || el.getClientRects().length > 0) return true;
              }
            }
            return false;
          },
        });
        return !!(probe[0] && probe[0].result);
      } catch (e) { return false; }
    }

    // v3.9.48 — Gate stile WhatsApp: prima aspetta davvero pagina + campo,
    // poi permette al writer di copiare/inviare. Questo evita il vecchio errore
    // “composer non montato”: se il campo non esiste, NON scriviamo nulla.
    async function waitForComposerReady(maxWaitMs) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function (timeoutMs) {
            function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
            function deepQueryAll(selector, root) {
              var out = [];
              var r = root || document;
              try { out.push.apply(out, r.querySelectorAll(selector)); } catch (e) {}
              var all = r.querySelectorAll ? r.querySelectorAll("*") : [];
              for (var i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) {
                  try { out.push.apply(out, deepQueryAll(selector, all[i].shadowRoot)); } catch (e) {}
                }
              }
              return out;
            }
            function visible(el) { return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0)); }
            function findBox() {
              var scopes = deepQueryAll(
                ".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']"
              );
              for (var s = 0; s < scopes.length; s++) {
                if (!visible(scopes[s])) continue;
                var boxes = scopes[s].querySelectorAll("[contenteditable='true'], div[role='textbox'], [role='textbox']");
                for (var b = 0; b < boxes.length; b++) if (visible(boxes[b])) return boxes[b];
              }
              return null;
            }
            function isInGlobalNav(el) {
              return !!(el && (el.closest("nav") || el.closest("header[role='banner']") || el.closest("[data-test-global-nav]") || el.closest(".global-nav")));
            }
            function hasOpenComposerShell() {
              var scopes = deepQueryAll(
                ".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']"
              );
              for (var i = 0; i < scopes.length; i++) if (visible(scopes[i])) return true;
              return false;
            }
            function findMessageBtn() {
              var root = document.querySelector("main") || document.body;
              var btns = Array.from(root.querySelectorAll("button, a, [role='button'], [role='menuitem']"));
              for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                if (!visible(b) || isInGlobalNav(b)) continue;
                var label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).trim().toLowerCase();
                if (/^(message|messaggia|messaggio|scrivi|invia messaggio|send message)$/i.test(label)) return b;
                if (/messaggia|messaggio|message|send message|nachricht|mensaje|mensagem|wiadomo|envoyer/i.test(label)) return b;
              }
              return null;
            }
            function findMoreBtn() {
              var root = document.querySelector("main") || document.body;
              var btns = Array.from(root.querySelectorAll("button, [role='button']"));
              for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                if (!visible(b) || isInGlobalNav(b)) continue;
                var label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).trim().toLowerCase();
                if (/^(more|altro|più|more actions|più azioni)$/i.test(label)) return b;
              }
              return null;
            }
            return (async function () {
              var started = Date.now();
              var limit = Math.max(12000, timeoutMs || 30000);
              var clickedMessage = false;
              var clickedMore = false;
              var last = { readyState: document.readyState, hasMain: !!document.querySelector("main"), clickedMessage: false, clickedMore: false, shells: 0, boxes: 0 };
              while (Date.now() - started < limit) {
                last.readyState = document.readyState;
                last.hasMain = !!document.querySelector("main");
                var box = findBox();
                if (box) return { success: true, method: "wa_style_composer_gate", waitedMs: Date.now() - started };
                var shells = deepQueryAll(".msg-form, [class*='msg-form'], [role='dialog'], .msg-overlay-conversation-bubble, [class*='msg-overlay-conversation']");
                last.shells = shells.filter(visible).length;
                last.boxes = deepQueryAll("[contenteditable='true'], div[role='textbox'], [role='textbox']").filter(visible).length;
                if (!clickedMessage && !hasOpenComposerShell()) {
                  var mb = findMessageBtn();
                  if (mb) {
                    try { mb.click(); clickedMessage = true; last.clickedMessage = true; } catch (e) {}
                  }
                }
                if (!clickedMessage && !clickedMore && !hasOpenComposerShell() && Date.now() - started > 2500) {
                  var more = findMoreBtn();
                  if (more) {
                    try { more.click(); clickedMore = true; last.clickedMore = true; } catch (e) {}
                    await sleep(700);
                    var mb2 = findMessageBtn();
                    if (mb2) {
                      try { mb2.click(); clickedMessage = true; last.clickedMessage = true; } catch (e) {}
                    }
                  }
                }
                await sleep(100);
              }
              return { success: false, error: "composer_gate_timeout", waitedMs: Date.now() - started, diagnostic: last };
            })();
          },
          args: [maxWaitMs || 30000],
        });
        return (res && res[0] && res[0].result) || { success: false, error: "composer_gate_no_result" };
      } catch (e) {
        return { success: false, error: "composer_gate_exception: " + (e && e.message ? e.message : String(e)) };
      }
    }
    let composerAlreadyOpen = await probeComposer();
    // 3.bis) Aspetta che il PROFILO sia pronto in background prima di cercare
    // "Messaggia": tab in background montano il DOM più lentamente. Polling
    // fino a 6s (20 × 300ms) per la presenza del bottone "Messaggia" oppure
    // di un composer già aperto. Non si applica ai thread URL.
    async function probeMessageButton() {
      try {
        const r = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            // Selettori strutturali (più affidabili del testo).
            var structural = document.querySelectorAll(
              "a[href*='/messaging/compose'], a[href*='/messaging/thread/']," +
              " button[data-control-name*='message' i]," +
              " .pv-top-card button, .pvs-profile-actions button, .artdeco-card button[aria-label]"
            );
            for (var i = 0; i < structural.length; i++) {
              var s = structural[i];
              var lab = ((s.getAttribute("aria-label") || "") + " " + (s.textContent || "")).toLowerCase();
              var vis = s.offsetParent !== null || s.getClientRects().length > 0;
              if (!vis) continue;
              if (/messaggi|message|messa|nachricht|mensaje|mensagem|wiadomo|envoyer/i.test(lab)) return true;
              // Se è un anchor di compose/thread, basta la presenza visibile.
              if (s.tagName === "A") return true;
            }
            // Fallback testuale globale.
            var btns = document.querySelectorAll("button, a[role='button']");
            for (var j = 0; j < btns.length; j++) {
              var b = btns[j];
              var label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).toLowerCase();
              if (!label.trim()) continue;
              if (/messaggi|message|messa|invia messaggio|nachricht|enviar mensaje|envoyer un message|mensagem|wiadomo/i.test(label)) {
                var visible = b.offsetParent !== null || b.getClientRects().length > 0;
                if (visible) return true;
              }
            }
            return false;
          },
        });
        return !!(r[0] && r[0].result);
      } catch (e) { return false; }
    }
    if (!composerAlreadyOpen && !isThreadUrl) {
      let profileReady = await probeMessageButton();
      // Polling esteso: 30 × 500ms = 15s.
      for (let i = 0; i < 30 && !profileReady && !composerAlreadyOpen; i++) {
        await TabManager.sleep(500);
        profileReady = await probeMessageButton();
        if (!profileReady) composerAlreadyOpen = await probeComposer();
      }
      if (!profileReady && !composerAlreadyOpen) {
        // Tentativo ottimistico: clickMessage ha scoping interno che a volte
        // trova il bottone anche quando il probe esterno non lo vede.
        try {
          const ti = await chrome.tabs.get(tab.id);
          lastTabStatus = (ti && ti.status) || lastTabStatus;
          lastTabUrl = (ti && (ti.url || ti.pendingUrl)) || lastTabUrl;
        } catch (e) { /* ignore */ }
        const optimistic = await HybridOps.clickMessage(tab.id);
        if (!optimistic || !optimistic.success) {
          var shortUrl = (lastTabUrl || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 80);
          return Config.errorResponse(
            Config.ERROR.MESSAGE_FAILED,
            "profile_not_ready: profilo LinkedIn non pronto in background (status=" + lastTabStatus + ", url=" + shortUrl + "), riprova"
          );
        }
        // Click ottimistico riuscito: passiamo direttamente al polling composer.
        for (let i = 0; i < 32; i++) {
          await TabManager.sleep(250);
          if (await probeComposer()) { composerAlreadyOpen = true; break; }
        }
      }
    }
    // 4) Se composer non aperto e non siamo su un thread URL, clicca "Messaggia"
    //    con un retry in caso di fallimento transitorio.
    if (!composerAlreadyOpen && !isThreadUrl) {
      let clickResult = await HybridOps.clickMessage(tab.id);
      if (!clickResult || !clickResult.success) {
        await TabManager.sleep(1500);
        clickResult = await HybridOps.clickMessage(tab.id);
      }
      if (!clickResult || !clickResult.success) {
        return Config.errorResponse(Config.ERROR.MESSAGE_FAILED, (clickResult && clickResult.error) || "open_composer_failed: bottone Messaggia non trovato sul profilo");
      }
      const gateAfterClick = await waitForComposerReady(30000);
      composerAlreadyOpen = !!(gateAfterClick && gateAfterClick.success);
    } else if (isThreadUrl && !composerAlreadyOpen) {
      // Thread URL: aspetta il campo reale come WhatsApp, non un timer fisso.
      const threadGate = await waitForComposerReady(30000);
      composerAlreadyOpen = !!(threadGate && threadGate.success);
    }
    if (!composerAlreadyOpen) {
      // Ultimo gate stile WhatsApp: apri/attendi il campo disponibile prima di
      // qualsiasi copia. Se fallisce, solo allora deleghiamo al writer produzione,
      // che comunque scrive esclusivamente dopo aver trovato la textbox.
      const finalGate = await waitForComposerReady(30000);
      if (finalGate && finalGate.success) {
        composerAlreadyOpen = true;
      } else {
        console.warn("[LI Send] composer gate timeout → fallback HybridOps.sendMessage", finalGate);
        var fallbackResult = await HybridOps.sendMessage(tab.id, message);
        if (fallbackResult && fallbackResult.success) {
          return Object.assign({}, fallbackResult, { method: (fallbackResult.method || "fallback") + "_after_composer_gate", attempted_method: method });
        }
        var fbErr = (fallbackResult && fallbackResult.error) || (finalGate && finalGate.error) || "unknown";
        var gateDiag = finalGate && finalGate.diagnostic ? " gate=" + JSON.stringify(finalGate.diagnostic) : "";
      return Config.errorResponse(
        Config.ERROR.MESSAGE_FAILED,
        "composer_gate_failed + fallback_failed: " + fbErr + " (status=" + lastTabStatus + ")" + gateDiag
      );
      }
    }
    await TabManager.sleep(150);
    return await HybridOps.sendMessageWithMethod(tab.id, message, method);
  }

  // (legacy block sotto rimosso: la nuova implementazione sopra apre il composer da sola)
  async function _legacyManualDiagnostic_unused() {
    let composerAlreadyOpen = false;
    try {
    } catch (e) { /* unused */ }
    return null;
  }

  async function sendConnectionRequest(profileUrl, note) {
    if (!profileUrl) return Config.errorResponse(Config.ERROR.CONNECT_FAILED, "URL profilo mancante");
    const tab = await TabManager.getLinkedInTab(profileUrl.replace(/\/$/, ""), false, false);
    if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.CONNECT_FAILED, "Collegati");
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    const clickResult = await HybridOps.clickConnect(tab.id);
    if (!clickResult || !clickResult.success) return Config.errorResponse(Config.ERROR.CONNECT_FAILED, (clickResult && clickResult.error) || "Connect button not found");
    await TabManager.sleep(2000);
    if (note && note.trim()) {
      return await HybridOps.addNote(tab.id, note);
    }
    // Send without note
    try {
      const sendRes = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          const btn = Array.from(document.querySelectorAll("button")).find(function (el) {
            return /send without|invia senza|send now/i.test(el.textContent.trim());
          }) || Array.from(document.querySelectorAll("button")).find(function (el) {
            return /^(send|invia)$/i.test(el.textContent.trim()) && el.offsetParent !== null;
          });
          if (btn) { btn.click(); return { success: true }; }
          return { success: false, error: "Send button not found" };
        },
      });
      return (sendRes[0] && sendRes[0].result) || { success: false, error: "Send failed" };
    } catch (e) { return Config.errorResponse(Config.ERROR.CONNECT_FAILED, e.message); }
  }

  async function searchProfile(query) {
    if (!query) return Config.errorResponse(Config.ERROR.SEARCH_FAILED, "Query mancante");
    const searchUrl = "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(query);
    const tab = await TabManager.getLinkedInTab(searchUrl, false, false);
    if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.SEARCH_FAILED, "Search");
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    await TabManager.sleep(3000);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          const allLinks = document.querySelectorAll("a[href*='/in/']");
          for (let i = 0; i < allLinks.length; i++) {
            const href = allLinks[i].href || "";
            if (/linkedin\.com\/in\/[^/]+/.test(href) && !/\/in\/miniprofile/.test(href) && !/\/in\/ACo/.test(href)) {
              const cleanUrl = href.split("?")[0].replace(/\/$/, "");
              const container = allLinks[i].closest("li, [data-chameleon-result-urn]");
              let name = "";
              let headline = "";
              if (container) {
                const nameEl = container.querySelector("span[aria-hidden='true']");
                if (nameEl) name = nameEl.textContent.trim();
                if (!name) { const dirEl = container.querySelector("h3 span[dir='ltr'], a span[dir='ltr'], span[dir='ltr']"); if (dirEl) name = dirEl.textContent.trim(); }
                if (!name && allLinks[i].textContent) { const lt = allLinks[i].textContent.replace(/\s+/g, " ").trim(); if (lt.length > 1 && lt.length < 80) name = lt; }
                if (!name) { const h = container.querySelector("h3, h4"); if (h) name = h.textContent.replace(/\s+/g, " ").trim(); }
                const secEl = container.querySelector("div[class*='subtitle'], p[class*='summary']");
                if (secEl) headline = secEl.textContent.replace(/\s+/g, " ").trim().substring(0, 200);
                if (!headline) { const ps = container.querySelectorAll("p, div[class*='t-']"); for (let pp = 0; pp < ps.length; pp++) { const pt = ps[pp].textContent.replace(/\s+/g, " ").trim(); if (pt && pt !== name && pt.length > 3 && pt.length < 200) { headline = pt; break; } } }
              }
              if (!name) { const al = allLinks[i].getAttribute("aria-label") || ""; if (al.length > 1) name = al.split(",")[0].trim(); }
              return { profileUrl: cleanUrl, name: name, headline: headline };
            }
          }
          return null;
        },
      });
      const profileData = results[0] && results[0].result;
      if (profileData && profileData.profileUrl) return Config.successResponse({ profile: profileData });
      return Config.errorResponse(Config.ERROR.SEARCH_FAILED, "Nessun profilo trovato per: " + query);
    } catch (err) { return Config.errorResponse(Config.ERROR.SEARCH_FAILED, err.message); }
  }

  // ── Schema → Optimus plan converter ──
  function buildPlanFromKeyMap(schema, keyMap) {
    const plan = { fields: {} };
    for (const schemaKey in schema) {
      if (!schema.hasOwnProperty(schemaKey)) continue;
      if (schemaKey === "learnedAt" || schemaKey === "pageType") continue;
      const optimusKey = keyMap[schemaKey];
      const selector = schema[schemaKey];
      if (!optimusKey || !selector) continue;
      plan.fields[optimusKey] = {
        primary: typeof selector === "string"
          ? selector
          : (selector.primary || selector.selector || String(selector)),
        fallback: typeof selector === "object"
          ? (selector.fallback || selector.alt || null)
          : null,
      };
    }
    if (!plan.fields.container && !plan.fields.contact_name && !plan.fields.sender_name) {
      console.warn("[LI Optimus] Schema conversion failed: missing key fields");
      return null;
    }
    return plan;
  }

  function convertLinkedInSchemaToOptimusPlan(schema, pageType) {
    if (!schema) return null;

    if (pageType === "messaging" || pageType === "inbox") {
      const keyMap = {
        // Container
        threadItem: "container",
        conversationItem: "container",
        conversationListSelector: "container",
        messageItem: "container",
        // Contact name
        contactName: "contact_name",
        participantName: "contact_name",
        senderName: "contact_name",
        conversationNameSelector: "contact_name",
        // Last message
        lastMessage: "last_message",
        snippet: "last_message",
        messagePreview: "last_message",
        messageBodySelector: "last_message",
        // Timestamp
        timestamp: "timestamp",
        time: "timestamp",
        date: "timestamp",
        messageTimeSelector: "timestamp",
        // Unread badge
        // Unread badge
        unreadBadge: "unread_badge",
        unreadIndicator: "unread_badge",
        unreadDot: "unread_badge",
        // J10 — Thread URL
        threadUrl: "thread_url",
        conversationUrl: "thread_url",
        url: "thread_url",
      };
      return buildPlanFromKeyMap(schema, keyMap);
    }

    if (pageType === "thread") {
      const keyMap = {
        messageItem: "container",
        messageBubble: "container",
        messageItemSelector: "container",
        senderName: "sender_name",
        authorName: "sender_name",
        participantName: "sender_name",
        messageSenderSelector: "sender_name",
        messageText: "message_text",
        messageBody: "message_text",
        messageContent: "message_text",
        messageBodySelector: "message_text",
        timestamp: "timestamp",
        time: "timestamp",
        date: "timestamp",
        messageTimeSelector: "timestamp",
        // J9 — Direction (AI returns this from prompt J6)
        direction: "direction",
        messageDirection: "direction",
      };
      return buildPlanFromKeyMap(schema, keyMap);
    }

    return null;
  }

  // ── Optimus-first helpers ──
  async function tryOptimusInbox(tabId, previousFailed, failureContext) {
    const inboxSelector = '[class*="msg-overlay-list-bubble"], [class*="msg-conversations-container"], main, [role="main"]';
    const snap = await Optimus.snapshotPage(tabId, inboxSelector, 6, 3000);
    if (!snap || !snap.ok) return { success: false, error: snap && snap.error || "snapshot_failed", optimusUnavailable: false };

    const req = OptimusClient.requestPlan("linkedin", "messaging", snap.snapshot, {
      previousPlanFailed: !!previousFailed,
      failureContext: failureContext || null,
    });
    const planRes = await Optimus.getPlan({
      channel: req.channel,
      pageType: req.pageType,
      snapshot: req.domSnapshot,
      hash: req.domHash,
      previousPlanFailed: req.previousPlanFailed,
      failureContext: req.failureContext,
    });
    if (!planRes || !planRes.success) {
      // I7 — Auto-relearn: Optimus plan failed, try AI learning
      console.log("[LI Optimus] Inbox plan failed, triggering auto-relearn...");
      try {
        const learnResult = await AILearn.learnFromAI(tabId, "messaging", Config.getUrl(), Config.getKey());
        if (learnResult && !learnResult.error) {
          const freshPlan = convertLinkedInSchemaToOptimusPlan(learnResult, "messaging");
          if (freshPlan) {
            const retryExec = await Optimus.executePlanInTab(tabId, inboxSelector, freshPlan);
            if (retryExec && retryExec.items && retryExec.items.length > 0) {
              return {
                success: true,
                cached: false,
                planVersion: 0,
                confidence: 0,
                latencyMs: 0,
                items: retryExec.items,
                candidates: retryExec.candidates || 0,
                dropped: retryExec.dropped || 0,
                method: "optimus-relearned",
              };
            }
          }
        }
      } catch (learnErr) {
        console.warn("[LI Optimus] Inbox auto-relearn failed:", learnErr?.message);
      }
      return { success: false, error: planRes && planRes.error || "plan_failed", optimusUnavailable: true };
    }

    const execRes = await Optimus.executePlanInTab(tabId, inboxSelector, planRes.plan || planRes);
    if (!execRes || !execRes.success) return { success: false, error: execRes && execRes.error || "execute_failed", optimusUnavailable: false };

    return {
      success: true,
      cached: !!planRes.cached,
      planVersion: planRes.plan_version || 0,
      confidence: planRes.confidence || 0,
      latencyMs: planRes.ai_latency_ms || 0,
      items: execRes.items || [],
      candidates: execRes.candidates || 0,
      dropped: execRes.dropped || 0,
    };
  }

  async function tryOptimusThread(tabId, previousFailed, failureContext) {
    const threadSelector = '[class*="msg-s-message-list"], [class*="msg-thread"], main, [role="main"]';
    const snap = await Optimus.snapshotPage(tabId, threadSelector, 6, 3000);
    if (!snap || !snap.ok) return { success: false, error: snap && snap.error || "snapshot_failed", optimusUnavailable: false };

    const req = OptimusClient.requestPlan("linkedin", "thread", snap.snapshot, {
      previousPlanFailed: !!previousFailed,
      failureContext: failureContext || null,
    });
    const planRes = await Optimus.getPlan({
      channel: req.channel,
      pageType: req.pageType,
      snapshot: req.domSnapshot,
      hash: req.domHash,
      previousPlanFailed: req.previousPlanFailed,
      failureContext: req.failureContext,
    });
    if (!planRes || !planRes.success) {
      // I7 — Auto-relearn: Optimus thread plan failed, try AI learning
      console.log("[LI Optimus] Thread plan failed, triggering auto-relearn...");
      try {
        const learnResult = await AILearn.learnFromAI(tabId, "thread", Config.getUrl(), Config.getKey());
        if (learnResult && !learnResult.error) {
          const freshPlan = convertLinkedInSchemaToOptimusPlan(learnResult, "thread");
          if (freshPlan) {
            const retryExec = await Optimus.executePlanInTab(tabId, threadSelector, freshPlan);
            if (retryExec && retryExec.items && retryExec.items.length > 0) {
              return {
                success: true,
                cached: false,
                planVersion: 0,
                confidence: 0,
                latencyMs: 0,
                items: retryExec.items,
                candidates: retryExec.candidates || 0,
                dropped: retryExec.dropped || 0,
                method: "optimus-relearned",
              };
            }
          }
        }
      } catch (learnErr) {
        console.warn("[LI Optimus] Thread auto-relearn failed:", learnErr?.message);
      }
      return { success: false, error: planRes && planRes.error || "plan_failed", optimusUnavailable: true };
    }

    const execRes = await Optimus.executePlanInTab(tabId, threadSelector, planRes.plan || planRes);
    if (!execRes || !execRes.success) return { success: false, error: execRes && execRes.error || "execute_failed", optimusUnavailable: false };

    return {
      success: true,
      cached: !!planRes.cached,
      planVersion: planRes.plan_version || 0,
      confidence: planRes.confidence || 0,
      latencyMs: planRes.ai_latency_ms || 0,
      items: execRes.items || [],
      candidates: execRes.candidates || 0,
      dropped: execRes.dropped || 0,
    };
  }

  function mapOptimusInboxItems(items) {
    return items.map(function (it) {
      var threadUrl = it.thread_url || it.url || "";
      var profileUrl = it.profile_url || it.profileUrl || "";
      var ids = extractLinkedInIds(threadUrl, profileUrl);
      // If LinkedIn doesn't expose a /messaging/thread/ anchor on the card,
      // fall back to the participant profile URL: sendMessage() accepts both
      // a thread URL and a profile URL.
      if (!threadUrl && profileUrl) threadUrl = profileUrl;
      return {
        name: it.participant_name || it.thread_name || it.name || "",
        threadUrl: threadUrl,
        profileUrl: profileUrl,
        linkedinId: ids.linkedinId,
        profileId: ids.profileId,
        threadId: ids.threadId,
        unread: !!(it.unread_indicator && String(it.unread_indicator).trim()),
        lastMessage: it.last_message_preview || it.last_message || it.preview || "",
        lastActivity: it.last_activity_time || it.timestamp || "",
      };
    }).filter(function (t) { return !!t.name; });
  }

  function extractLinkedInIds(threadUrl, profileUrl) {
    var profileMatch = String(profileUrl || threadUrl || "").match(/\/in\/([^/?#]+)/i);
    var threadMatch = String(threadUrl || "").match(/\/messaging\/thread\/([^/?#]+)/i);
    return {
      profileId: profileMatch ? decodeURIComponent(profileMatch[1]) : "",
      threadId: threadMatch ? decodeURIComponent(threadMatch[1]) : "",
      linkedinId: profileMatch ? decodeURIComponent(profileMatch[1]) : (threadMatch ? decodeURIComponent(threadMatch[1]) : ""),
    };
  }

  async function harvestInboxUrls(tabId, scrollPasses) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async function (maxScrollPasses) {
        function cleanText(v) { return String(v || "").replace(/\s+/g, " ").trim(); }
        function cleanUrl(v) {
          if (!v) return "";
          try { return new URL(String(v), location.origin).href.split("?")[0].replace(/\/$/, ""); }
          catch (e) { return String(v).split("?")[0].replace(/\/$/, ""); }
        }
        function ids(threadUrl, profileUrl) {
          var p = String(profileUrl || threadUrl || "").match(/\/in\/([^/?#]+)/i);
          var t = String(threadUrl || "").match(/\/messaging\/thread\/([^/?#]+)/i);
          return { profileId: p ? decodeURIComponent(p[1]) : "", threadId: t ? decodeURIComponent(t[1]) : "", linkedinId: p ? decodeURIComponent(p[1]) : (t ? decodeURIComponent(t[1]) : "") };
        }
        var out = [];
        var seen = {};
        function collect() {
          var cards = document.querySelectorAll('[class*="msg-conversation-card"], [class*="msg-convo-wrapper"], [data-control-name*="conversation"], li');
          cards.forEach(function (card) {
            var text = cleanText(card.textContent).slice(0, 240);
            if (!text || text.length < 2) return;
            var name = "";
            var h = card.querySelector('h3, h4, [class*="msg-conversation-card__participant-names"], [class*="participant"]');
            if (h) name = cleanText(h.textContent);
            if (!name) {
              var img = card.querySelector('img[alt]');
              if (img) name = cleanText(img.getAttribute('alt')).replace(/'s profile photo|foto del profilo|profile photo/ig, "").trim();
            }
            if (!name) {
              var spans = card.querySelectorAll('span[aria-hidden="true"], span');
              for (var i = 0; i < Math.min(spans.length, 8); i++) {
                var s = cleanText(spans[i].textContent);
                if (s.length > 1 && s.length < 80 && !/^\d{1,2}[:/.]/.test(s)) { name = s; break; }
              }
            }
            var threadA = card.querySelector('a[href*="/messaging/thread/"], a[href*="/messaging/"]');
            var profileA = card.querySelector('a[href*="/in/"]');
            var threadUrl = cleanUrl(threadA && threadA.getAttribute('href'));
            var profileUrl = cleanUrl(profileA && profileA.getAttribute('href'));
            var msgEl = card.querySelector('p, [class*="snippet"], [class*="preview"], [class*="message"]');
            var lastMessage = msgEl ? cleanText(msgEl.textContent).slice(0, 240) : "";
            var key = threadUrl || profileUrl || name;
            if (!key || seen[key]) return;
            seen[key] = true;
            var idObj = ids(threadUrl, profileUrl);
            if ((threadUrl || profileUrl) && (name || text)) out.push({ name: name, text: text, lastMessage: lastMessage, threadUrl: threadUrl, profileUrl: profileUrl, linkedinId: idObj.linkedinId, profileId: idObj.profileId, threadId: idObj.threadId });
          });
        }
        collect();
        var scroller = document.querySelector('[class*="msg-conversations-container"]') || document.querySelector('[class*="msg-conversations-container__conversations-list"]') || document.querySelector('main');
        var originalTop = scroller ? scroller.scrollTop : 0;
        for (var pass = 0; scroller && pass < (maxScrollPasses || 0); pass++) {
          var before = scroller.scrollTop;
          scroller.scrollTop = before + Math.max(320, Math.floor((scroller.clientHeight || 600) * 0.85));
          await new Promise(function (resolve) { setTimeout(resolve, 650); });
          collect();
          if (scroller.scrollTop === before) break;
        }
        if (scroller) scroller.scrollTop = originalTop;
        return out;
      },
      args: [scrollPasses || 0],
    });
    return (results[0] && results[0].result) || [];
  }

  function findUrlForName(urlMap, name) {
    var n = String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!n) return null;
    for (var i = 0; i < urlMap.length; i++) {
      var candidateName = String(urlMap[i].name || "").toLowerCase().replace(/\s+/g, " ").trim();
      var candidateText = String(urlMap[i].text || "").toLowerCase().replace(/\s+/g, " ").trim();
      if ((candidateName && (candidateName === n || candidateName.indexOf(n) !== -1 || n.indexOf(candidateName) !== -1)) || candidateText.indexOf(n) !== -1) return urlMap[i];
    }
    return null;
  }

  function mapOptimusThreadMessages(items) {
    return items.map(function (it) {
      const sender = it.message_sender || it.sender || it.sender_name || "";
      const dirField = it.direction || "";
      let direction;
      if (dirField && (dirField === "outbound" || dirField === "inbound")) {
        direction = dirField;
      } else if (dirField) {
        // J11 — AI might return a CSS class like "msg-s-event--outbound" — check for "outbound" substring
        direction = String(dirField).toLowerCase().includes("outbound") ? "outbound" : "inbound";
      } else {
        // Fallback: infer from sender name
        const s = String(sender).toLowerCase().trim();
        direction = (s === "tu" || s === "you" || s === "me" || s === "io") ? "outbound" : "inbound";
      }
      return {
        text: it.message_text || it.text || it.body || "",
        sender: sender,
        timestamp: it.message_time || it.timestamp || it.time || new Date().toISOString(),
        direction: direction,
      };
    }).filter(function (m) { return !!m.text; });
  }

  async function readInbox() {
    // 3.9.55 — usa il resolver READ-ONLY: non dirotta MAI la tab LinkedIn
    // dell'utente verso /messaging/. Se l'utente è su un profilo, apre una
    // nuova tab in background per leggere l'inbox e lascia la pagina attiva
    // intatta. Path completamente separato da sendMessage.
    const tab = await TabManager.getLinkedInTabForRead("https://www.linkedin.com/messaging/");
    if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.INBOX_FAILED, "Leggi Inbox");
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    await TabManager.sleep(2500);

    // ── Optimus-first ──
    // 3.9.59 — Bound the AI/bridge path. If the webapp bridge stalls, fall
    // through to deterministic legacy extraction instead of blocking readInbox.
    let optimus = await withTimeout("optimus_inbox", 12000, function () {
      return tryOptimusInbox(tab.id, false, null);
    });
    if (optimus.success && optimus.items.length === 0) {
      console.log("[LI Optimus] 0 threads, forcing relearn...");
      optimus = await withTimeout("optimus_inbox_relearn", 8000, function () {
        return tryOptimusInbox(tab.id, true, "Plan returned 0 threads, DOM may have changed");
      });
    }

    if (optimus.success) {
      const threads = mapOptimusInboxItems(optimus.items);
      // P0.3 — Marker method/confidence anche per il ramo Optimus, per uniformità.
      threads.forEach(function (t) {
        if (!t.method) t.method = optimus.cached ? "optimus" : "optimus";
        if (typeof t.confidence !== "number") t.confidence = typeof optimus.confidence === "number" ? optimus.confidence : 0.85;
      });
      // Post-process: harvest URL dalla pagina e fai match per nome.
      // Optimus spesso non include thread_url/profile_url se il piano cached
      // non aveva quei selettori — qui li recuperiamo direttamente dal DOM.
      try {
        const urlMap = await harvestInboxUrls(tab.id, 8);
        if (urlMap && urlMap.length) {
          for (let i = 0; i < threads.length; i++) {
            const match = findUrlForName(urlMap, threads[i].name);
            if (match) {
              if (!threads[i].threadUrl) threads[i].threadUrl = match.threadUrl || match.profileUrl || "";
              if (!threads[i].profileUrl) threads[i].profileUrl = match.profileUrl || "";
              if (!threads[i].lastMessage && match.lastMessage) threads[i].lastMessage = match.lastMessage;
              if (!threads[i].linkedinId) threads[i].linkedinId = match.linkedinId || "";
              if (!threads[i].profileId) threads[i].profileId = match.profileId || "";
              if (!threads[i].threadId) threads[i].threadId = match.threadId || "";
            }
          }
          // P0.1 — Dedup key: mai per nome solo. Usa cascata stabile.
          // Due "Marco Rossi" diversi devono entrambi sopravvivere.
          function _dedupKey(t) {
            return (
              t.threadUrl ||
              t.profileUrl ||
              t.linkedinId ||
              t.profileId ||
              ((t.name || "") + "|" + (t.lastMessage || "") + "|" + (t.lastActivity || ""))
            );
          }
          const seenKeys = {};
          threads.forEach(function (t) { seenKeys[_dedupKey(t)] = true; });
          urlMap.forEach(function (item) {
            var candidate = {
              name: item.name,
              threadUrl: item.threadUrl || item.profileUrl || "",
              profileUrl: item.profileUrl || "",
              linkedinId: item.linkedinId || "",
              profileId: item.profileId || "",
              threadId: item.threadId || "",
              lastMessage: item.lastMessage || "",
              lastActivity: "",
            };
            var key = _dedupKey(candidate);
            if (!key || seenKeys[key]) return;
            seenKeys[key] = true;
            threads.push({
              name: item.name,
              threadUrl: item.threadUrl || item.profileUrl || "",
              profileUrl: item.profileUrl || "",
              linkedinId: item.linkedinId || "",
              profileId: item.profileId || "",
              threadId: item.threadId || "",
              unread: false,
              lastMessage: item.lastMessage || "",
              lastActivity: "",
              method: "structural",
              confidence: 0.7,
            });
          });
        }
      } catch (e) { console.warn("[LI Inbox] URL harvest failed:", e?.message); }
      return {
        success: true,
        threads: threads,
        method: optimus.cached ? "optimus-cache" : "optimus-ai",
        optimus: {
          cached: optimus.cached,
          planVersion: optimus.planVersion,
          confidence: optimus.confidence,
          latencyMs: optimus.latencyMs,
          dropped: optimus.dropped,
        },
      };
    }

    // Any Optimus failure → fall through to legacy AX/structural
    // (previously only fell through if optimusUnavailable was true,
    //  which missed cases where Optimus responded but plan execution failed)
    console.warn("[LI Actions] Optimus inbox failed, falling through to legacy:", optimus.error);

    // ── Legacy fallback ──
    // Legacy A: AX Tree
    let axError = null;
    try {
      const axResult = await withTimeout("ax_inbox", 10000, function () {
        return AXTree.readInbox(tab.id);
      });
      if (axResult && axResult.threads && axResult.threads.length > 0) {
        axResult.method = "legacy-ax";
        return axResult;
      }
      axError = "ax_tree returned 0 threads";
    } catch (e) { axError = e.message || String(e); }

    // Legacy B: structural fallback (kept here, used only when Optimus is down)
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          const threads = [];
          const seen = {};
          const seenKeys = {}; // P0.1 — dedup composite key (threadUrl|profileUrl|linkedinId|profileId|name+lastMsg)
          // M2: pattern per notification badge da filtrare
          var notifPattern = /^\d+\s+\d*\s*(nuov[aoe]|new)\s*(notifich?[ae]?|message|notification)/i;

          function getIds(threadUrl, profileUrl) {
            var p = String(profileUrl || threadUrl || "").match(/\/in\/([^/?#]+)/i);
            var t = String(threadUrl || "").match(/\/messaging\/thread\/([^/?#]+)/i);
            return { profileId: p ? decodeURIComponent(p[1]) : "", threadId: t ? decodeURIComponent(t[1]) : "", linkedinId: p ? decodeURIComponent(p[1]) : (t ? decodeURIComponent(t[1]) : "") };
          }

          function addThread(name, threadUrl, unread, lastMsg, profileUrl) {
            // M2: filtra notification badge estratte come thread
            if (notifPattern.test(name)) return;
            // M2: filtra "Sponsorizzata" come nome contatto standalone
            if (/^sponsorizzat[ao]$/i.test(name.trim())) return;
            // M2: dedup per threadUrl
            if (threadUrl && seen[threadUrl]) return;
            if (threadUrl) seen[threadUrl] = true;
            var ids = getIds(threadUrl, profileUrl);
            // P0.1 — dedup chiave composita (mai solo nome).
            var dedupKey = threadUrl || profileUrl || ids.linkedinId || ids.profileId || (name.toLowerCase().trim() + "|" + (lastMsg || "").toLowerCase().trim());
            if (!dedupKey || seenKeys[dedupKey]) return;
            seenKeys[dedupKey] = true;
            threads.push({
              name: name,
              threadUrl: threadUrl,
              profileUrl: profileUrl || "",
              linkedinId: ids.linkedinId,
              profileId: ids.profileId,
              threadId: ids.threadId,
              unread: unread,
              lastMessage: lastMsg,
              lastActivity: "",
              method: "structural",
              confidence: 0.65,
            });
          }

          const modernCards = document.querySelectorAll('[class*="msg-conversation-card"], [class*="msg-convo-wrapper"], [data-control-name*="conversation"]');
          modernCards.forEach(function (card) {
            const link = card.querySelector("a[href*='/messaging/']") || card.closest("a[href*='/messaging/']");
            let threadUrl = link ? (link.href || "") : "";
            // Fallback: many cards no longer expose a messaging anchor;
            // use the participant profile URL instead so the contact has
            // a usable target in the UI.
            if (!threadUrl) {
              const pLink = card.querySelector("a[href*='/in/']");
              if (pLink && pLink.href) threadUrl = pLink.href;
            }
            const profileLink = card.querySelector("a[href*='/in/']");
            const profileUrl = profileLink && profileLink.href ? profileLink.href : (/\/in\//.test(threadUrl) ? threadUrl : "");
            let name = "";
            const h3 = card.querySelector("h3");
            if (h3) name = h3.textContent.replace(/\s+/g, " ").trim();
            if (!name) { const spans = card.querySelectorAll("span"); for (let s = 0; s < Math.min(spans.length, 10); s++) { const t = (spans[s].textContent || "").trim(); if (t.length > 1 && t.length < 60 && !/^\d{1,2}[\/:\.]/.test(t)) { name = t; break; } } }
            if (!name || name.length < 2) return;
            let lastMsg = "";
            const msgEl = card.querySelector("p, [class*='snippet'], [class*='preview']");
            if (msgEl) lastMsg = msgEl.textContent.replace(/\s+/g, " ").trim().substring(0, 120);
            const unread = !!card.querySelector("[class*='unread'], [class*='badge'], [class*='dot']");
            addThread(name, threadUrl, unread, lastMsg, profileUrl);
          });
          if (threads.length === 0) {
            const threadLinks = document.querySelectorAll("a[href*='/messaging/thread/']");
            threadLinks.forEach(function (link) {
              const threadUrl = link.href || "";
              const container = link.closest("li") || link.parentElement;
              if (!container) return;
              let name = "";
              const h3 = container.querySelector("h3");
              if (h3) { const h3t = h3.textContent.replace(/\s+/g, " ").trim(); if (h3t.length > 1 && h3t.length < 80) name = h3t; }
              if (!name) { const img = container.querySelector("img[alt]"); if (img) { const alt = (img.getAttribute("alt") || "").trim(); if (alt.length > 1 && alt.length < 60 && !/photo|foto|avatar/i.test(alt)) name = alt; } }
              if (!name) return;
              const msgP = container.querySelector("p, [class*='snippet']");
              const lastMsg = msgP ? msgP.textContent.replace(/\s+/g, " ").trim().substring(0, 120) : "";
              addThread(name, threadUrl, false, lastMsg);
            });
          }
          return { success: true, threads: threads, method: "legacy-structural" };
        },
      });
      const out = (results[0] && results[0].result) || Config.errorResponse(Config.ERROR.INBOX_FAILED, "No inbox data");
      if (out && out.success) out.legacyReason = "optimus_unavailable: " + (optimus.error || "unknown");
      return out;
    } catch (e) {
      return Config.errorResponse(Config.ERROR.INBOX_FAILED, e.message + (axError ? " | AX: " + axError : ""));
    }
  }

  async function readThread(threadUrl) {
    if (!threadUrl) return Config.errorResponse(Config.ERROR.INBOX_FAILED, "Thread URL mancante");
    const isProfileUrl = /linkedin\.com\/(in|pub)\//i.test(threadUrl);
    // P22 — Per profilo: NON usare skipNavigateIfSameDomain. Vogliamo essere
    // certi di stare sul profilo richiesto, altrimenti clickMessage agirebbe
    // sulla pagina sbagliata (es. /messaging/inbox o profilo precedente).
    const tab = await TabManager.getLinkedInTab(threadUrl, false, false);
    if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.INBOX_FAILED, "Leggi Thread");
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    if (isProfileUrl) {
      try {
        const opened = await HybridOps.clickMessage(tab.id);
        if (opened && opened.success) await TabManager.sleep(1500);
      } catch (err) { console.debug("[LI Actions] profile readThread open composer:", err?.message); }
    }
    await TabManager.sleep(2500);

    // ── Optimus-first ──
    let optimus = await tryOptimusThread(tab.id, false, null);
    if (optimus.success && optimus.items.length === 0) {
      console.log("[LI Optimus] 0 messages in thread, forcing relearn...");
      optimus = await tryOptimusThread(tab.id, true, "Plan returned 0 messages from LI thread " + threadUrl);
    }

    if (optimus.success) {
      const messages = mapOptimusThreadMessages(optimus.items);
      return {
        success: true,
        messages: messages,
        method: optimus.cached ? "optimus-cache" : "optimus-ai",
        optimus: {
          cached: optimus.cached,
          planVersion: optimus.planVersion,
          confidence: optimus.confidence,
          latencyMs: optimus.latencyMs,
          dropped: optimus.dropped,
        },
      };
    }

    // Any Optimus failure → fall through to legacy AX/structural
    console.warn("[LI Actions] Optimus thread failed, falling through to legacy:", optimus.error);

    // ── Legacy fallback ──
    try {
      const axResult = await AXTree.readThread(tab.id);
      if (axResult && axResult.messages && axResult.messages.length > 0) {
        axResult.method = "legacy-ax";
        return axResult;
      }
    } catch (err) { console.debug("[LI Actions]", err?.message); }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          const messages = [];
          let items = document.querySelectorAll("li[class*='msg-'], li[class*='message'], [class*='msg-s-event']");
          if (items.length === 0) items = document.querySelectorAll("main li, [role='main'] li");
          items.forEach(function (item) {
            const bodyEl = item.querySelector("p, [class*='body'], [class*='content']");
            const senderEl = item.querySelector("h3, span[class*='name'], [class*='sender']");
            const timeEl = item.querySelector("time, [class*='time']");
            const text = bodyEl ? bodyEl.textContent.trim() : "";
            const sender = senderEl ? senderEl.textContent.trim() : "";
            const timestamp = timeEl ? (timeEl.getAttribute("datetime") || timeEl.textContent.trim()) : new Date().toISOString();
            if (!text) return;
            // P0.2 — Direction honest: senza segnali certi, "unknown" (NON "inbound").
            var cls = String((item.className || "")).toLowerCase();
            var senderLower = (sender || "").toLowerCase();
            var direction = "unknown";
            if (/outbound|from-me|msg-s-event--outbound|msg-s-message-list__event--own/i.test(cls)) direction = "outbound";
            else if (/inbound|from-them|msg-s-event--inbound/i.test(cls)) direction = "inbound";
            else if (senderLower === "you" || senderLower === "tu" || senderLower === "me" || senderLower === "io") direction = "outbound";
            messages.push({ text: text, sender: sender, timestamp: timestamp, direction: direction, method: "structural", confidence: direction === "unknown" ? 0.4 : 0.7 });
          });
          return { success: true, messages: messages, method: "legacy-structural", confidence: 0.6 };
        },
      });
      return (results[0] && results[0].result) || Config.errorResponse(Config.ERROR.INBOX_FAILED, "No thread data");
    } catch (e) { return Config.errorResponse(Config.ERROR.INBOX_FAILED, e.message); }
  }

  async function backfillThread(threadUrl, lastKnownText, maxScrolls) {
    var MAX_SCROLLS = maxScrolls || 20;
    if (!threadUrl) return Config.errorResponse(Config.ERROR.INBOX_FAILED, "threadUrl richiesto");

    try {
      var isProfileUrl = /linkedin\.com\/(in|pub)\//i.test(threadUrl);
        // P22 — Stesso fix di readThread: navighiamo sempre al target profilo.
        var tab = await TabManager.getLinkedInTab(threadUrl, false, false);
        if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.INBOX_FAILED, "Backfill Thread");
      await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
      if (isProfileUrl) {
        try {
          var opened = await HybridOps.clickMessage(tab.id);
          if (opened && opened.success) await TabManager.sleep(1500);
        } catch (err) { console.debug("[LI Actions] profile backfill open composer:", err?.message); }
      }
      await TabManager.sleep(2500);

      var threadSelector = '[class*="msg-s-message-list"], [class*="msg-thread"], main, [role="main"]';
      var allMessages = [];
      var seen = {};
      var foundLast = false;
      var scrollIdx = 0;
      var optimusUnavailable = false;
      var plan = null;
      var cached = false;

      // Get Optimus plan ONCE before the loop
      var initialSnap = await Optimus.snapshotPage(tab.id, threadSelector, 6, 3000);
      if (initialSnap && initialSnap.ok) {
        var planRes = await Optimus.getPlan({
          channel: "linkedin",
          pageType: "thread",
          snapshot: initialSnap.snapshot,
          hash: initialSnap.hash,
          previousPlanFailed: false,
          failureContext: null,
        });
        if (planRes && planRes.success) {
          plan = planRes.plan || planRes;
          cached = !!planRes.cached;
        } else {
          optimusUnavailable = true;
        }
      } else {
        optimusUnavailable = true;
      }

      function pushUnique(msg) {
        // Composite key: sender + text + timestamp (no shifting indices).
        var key = (msg.sender || "") + "|" + (msg.text || "") + "|" + (msg.timestamp || "");
        if (seen[key]) return false;
        seen[key] = true;
        if (lastKnownText && msg.text && msg.text.trim().toLowerCase() === lastKnownText.trim().toLowerCase()) return "stop";
        allMessages.push(msg);
        return true;
      }

      // P1 — Honest stop: 2 cicli senza crescita = fine reale, non sintomo di scroll lento.
      var noGrowthCount = 0;
      var prevMessageCount = 0;
      var NO_GROWTH_LIMIT = 3;

      // Loop: extract → scroll up → extract
      var scrollDelays = [1.5, 2, 2.5, 3, 1.5, 2, 3, 2.5, 1.5, 2];
      for (scrollIdx = 0; scrollIdx < MAX_SCROLLS && !foundLast; scrollIdx++) {

        if (plan && !optimusUnavailable) {
          // Optimus extraction
          var exec = await Optimus.executePlanInTab(tab.id, threadSelector, plan);
          var items = (exec && exec.items) || [];

          // Retry once with fresh plan if cache returned 0
          if (items.length === 0 && cached) {
            var freshSnap = await Optimus.snapshotPage(tab.id, threadSelector, 6, 3000);
            if (freshSnap && freshSnap.ok) {
              var freshRes = await Optimus.getPlan({
                channel: "linkedin",
                pageType: "thread",
                snapshot: freshSnap.snapshot,
                hash: freshSnap.hash,
                previousPlanFailed: true,
                failureContext: "Cached plan returned 0 messages during LI backfill scroll " + scrollIdx,
              });
              if (freshRes && freshRes.success) {
                plan = freshRes.plan || freshRes;
                cached = !!freshRes.cached;
                exec = await Optimus.executePlanInTab(tab.id, threadSelector, plan);
                items = (exec && exec.items) || [];
              }
            }
            if (items.length === 0) break;
          }

          var mapped = mapOptimusThreadMessages(items);
          for (var mi = 0; mi < mapped.length; mi++) {
            var r2 = pushUnique(mapped[mi]);
            if (r2 === "stop") { foundLast = true; break; }
          }
        } else {
          // Legacy fallback: DOM extraction
          var domResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: function () {
              var messages = [];
              var items = document.querySelectorAll("li[class*='msg-'], li[class*='message'], [class*='msg-s-event']");
              if (items.length === 0) items = document.querySelectorAll("main li, [role='main'] li");
              items.forEach(function (item) {
                var bodyEl = item.querySelector("p, [class*='body'], [class*='content']");
                var senderEl = item.querySelector("h3, span[class*='name'], [class*='sender']");
                var timeEl = item.querySelector("time, [class*='time']");
                var text = bodyEl ? bodyEl.textContent.trim() : "";
                var sender = senderEl ? senderEl.textContent.trim() : "";
                var timestamp = timeEl ? (timeEl.getAttribute("datetime") || timeEl.textContent.trim()) : new Date().toISOString();
              // P1 — Direction honest in legacy backfill: senza segnali certi → "unknown".
              var clsBack = String((item.className || "")).toLowerCase();
              var senderLowerBack = (sender || "").toLowerCase();
              var dirBack = "unknown";
              if (/outbound|from-me|msg-s-event--outbound|msg-s-message-list__event--own/i.test(clsBack)) dirBack = "outbound";
              else if (/inbound|from-them|msg-s-event--inbound/i.test(clsBack)) dirBack = "inbound";
              else if (senderLowerBack === "you" || senderLowerBack === "tu" || senderLowerBack === "me" || senderLowerBack === "io") dirBack = "outbound";
              if (text) messages.push({ text: text, sender: sender, timestamp: timestamp, direction: dirBack, method: "legacy-structural-backfill", confidence: dirBack === "unknown" ? 0.4 : 0.65 });
              });
              return { success: true, messages: messages };
            },
          });
          var domRes = domResults && domResults[0] ? domResults[0].result : null;
          if (domRes && domRes.messages) {
            for (var di = 0; di < domRes.messages.length; di++) {
              var r3 = pushUnique(domRes.messages[di]);
              if (r3 === "stop") { foundLast = true; break; }
            }
          }
        }

        if (foundLast) break;

        // P1 — Honest stop: nessuna crescita per N cicli = abbiamo davvero raggiunto il top.
        if (allMessages.length === prevMessageCount) {
          noGrowthCount++;
          if (noGrowthCount >= NO_GROWTH_LIMIT) {
            console.log("[LI Backfill] No growth for " + NO_GROWTH_LIMIT + " cycles, stopping.");
            break;
          }
        } else {
          noGrowthCount = 0;
          prevMessageCount = allMessages.length;
        }

        // Scroll up to load older messages
        var scrollRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            var container = document.querySelector('[class*="msg-s-message-list"]')
              || document.querySelector('[class*="msg-thread"]')
              || document.querySelector("main");
            if (!container) return { success: false, error: "Scroll container not found" };
            var scrollEl = container.closest('[class*="msg-s-message-list-container"]') || container;
            var before = scrollEl.scrollTop;
            scrollEl.scrollTop = 0;
            var after = scrollEl.scrollTop;
            return { success: true, reachedTop: (after === 0 && before === 0) };
          },
        });
        var sr = scrollRes && scrollRes[0] ? scrollRes[0].result : null;
        if (sr && sr.reachedTop) break;

        await TabManager.sleep(scrollDelays[scrollIdx % scrollDelays.length] * 1000);
      }

      return {
        success: true,
        messages: allMessages,
        threadUrl: threadUrl,
        foundLast: foundLast,
        scrollCount: scrollIdx,
        method: optimusUnavailable ? "legacy-dom" : (cached ? "optimus-cache" : "optimus-ai"),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function diagnostic() {
    const tab = await TabManager.getLinkedInTab("https://www.linkedin.com/messaging/", false, false);
    if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.UNKNOWN, "Diagnostica DOM");
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    await TabManager.sleep(2500);

    let axAvailable = false;
    try { axAvailable = await AXTree.isAvailable(tab.id); } catch (err) { console.debug("[LI Actions] AX check:", err?.message); }

    const schema = await AILearn.getCached("messaging");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        const url = window.location.href;
        const title = document.title;
        const bodyLen = (document.body.innerText || "").length;
        const hasMain = !!document.querySelector("main, [role='main']");
        const hasNav = !!document.querySelector("nav, [role='banner'], [role='navigation']");
        const hasTextbox = !!document.querySelector("[role='textbox'], [contenteditable='true']");
        const threadLinks = document.querySelectorAll("a[href*='/messaging/thread/']").length;
        const buttons = [];
        document.querySelectorAll("button").forEach(function (b) {
          if (b.offsetParent !== null) buttons.push(b.textContent.trim().substring(0, 40));
        });
        const roles = [];
        document.querySelectorAll("[role]").forEach(function (el) {
          const r = el.getAttribute("role");
          if (roles.indexOf(r) === -1) roles.push(r);
        });
        return {
          success: true, url: url, title: title, bodyLength: bodyLen,
          hasMain: hasMain, hasNav: hasNav, hasTextbox: hasTextbox,
          threadLinksCount: threadLinks, visibleButtons: buttons.slice(0, 20), uniqueRoles: roles,
        };
      },
    });

    const domResult = (results[0] && results[0].result) || {};
    domResult.axTreeAvailable = axAvailable;
    domResult.aiLearnCached = !!schema;
    domResult.aiLearnAge = schema && schema.learnedAt ? Math.round((Date.now() - schema.learnedAt) / 60000) + " min ago" : "never";
    return domResult;
  }

  async function learnDom(pageType) {
    if (!Config.isReady()) return Config.errorResponse(Config.ERROR.NO_CONFIG, "Configurazione AI mancante");
    const url = pageType === "messaging" ? "https://www.linkedin.com/messaging/" : "https://www.linkedin.com/in/me/";
    const tab = await TabManager.getLinkedInTab(url, false, false);
    if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.AI_LEARN_FAILED, "Learn DOM");
    await TabManager.ensureTabVisibleAndWait(tab.id, 1200);
    await TabManager.sleep(2500);
    const schema = await AILearn.learnFromAI(tab.id, pageType || "profile", Config.getUrl(), Config.getKey());
    if (schema) return Config.successResponse({ schema: schema, keysCount: Object.keys(schema).length });
    return Config.errorResponse(Config.ERROR.AI_LEARN_FAILED, "AI learning failed");
  }

  // ══════════════════════════════════════════════
  // REMAP SEND DOM — Manuale: invalida la cache "messaging" + "profile"
  // e forza l'AI a rileggere il DOM ora. Nessun auto-retry: solo on demand.
  // ══════════════════════════════════════════════
  async function remapSendDom() {
    if (!Config.isReady()) return { success: false, error: "Configurazione AI mancante" };
    try {
      // 1) Invalida cache schema esistenti
      await AILearn.clearCache("messaging");
      await AILearn.clearCache("profile");

      // 2) Re-learn messaging (schema usato da HybridOps.sendMessage)
      const tab = await TabManager.getLinkedInTab("https://www.linkedin.com/messaging/", false, false);
      if (!tab || !tab.id) return noExistingLinkedInTab(Config.ERROR.AI_LEARN_FAILED, "Rimappa DOM invio");
      await TabManager.ensureTabVisibleAndWait(tab.id, 1500);
      await TabManager.sleep(3000);
      try {
        const openThread = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            const link = Array.from(document.querySelectorAll("a[href*='/messaging/thread/']")).find(function (a) {
              return a.offsetParent !== null || a.getClientRects().length > 0;
            });
            if (link) { link.click(); return true; }
            return false;
          },
        });
        if (openThread[0] && openThread[0].result) await TabManager.sleep(3500);
      } catch (e) { console.debug("[LI remap] open first thread:", e?.message); }
      const messagingSchema = await AILearn.learnFromAI(tab.id, "messaging", Config.getUrl(), Config.getKey());

      // 3) Re-learn profile (schema usato per click "Message"/"Connect")
      const profTab = await TabManager.getLinkedInTab("https://www.linkedin.com/in/me/", false, false);
      if (!profTab || !profTab.id) return noExistingLinkedInTab(Config.ERROR.AI_LEARN_FAILED, "Rimappa DOM profilo");
      await TabManager.ensureTabVisibleAndWait(profTab.id, 1200);
      await TabManager.sleep(2500);
      const profileSchema = await AILearn.learnFromAI(profTab.id, "profile", Config.getUrl(), Config.getKey());

      const ok = !!(messagingSchema || profileSchema);
      return {
        success: ok,
        savedAt: Date.now(),
        messagingFields: messagingSchema ? Object.keys(messagingSchema).filter(function (k) { return k !== "learnedAt" && k !== "pageType"; }) : [],
        profileFields: profileSchema ? Object.keys(profileSchema).filter(function (k) { return k !== "learnedAt" && k !== "pageType"; }) : [],
        error: ok ? null : "AI learning failed for both messaging and profile",
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return {
    extractProfileByUrl: extractProfileByUrl,
    sendLinkedInMessage: sendLinkedInMessage,
    sendLinkedInMessageWithMethod: sendLinkedInMessageWithMethod,
    sendConnectionRequest: sendConnectionRequest,
    searchProfile: searchProfile,
    readInbox: readInbox,
    readThread: readThread,
    backfillThread: backfillThread,
    diagnostic: diagnostic,
    learnDom: learnDom,
    remapSendDom: remapSendDom,
  };
})();
globalThis.Actions = Actions;
