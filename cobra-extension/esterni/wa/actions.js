// ══════════════════════════════════════════════
// WhatsApp Extension v5.1 — Actions Module
// CSP-compliant: no new Function() / eval
// Uses inject-once helpers pattern
// ══════════════════════════════════════════════

var Actions = globalThis.Actions || (function () {

  // ══════════════════════════════════════════════
  // INJECT-ONCE: Page helpers (shadow DOM, input)
  // Called once per tab, installs window.__waH
  // ══════════════════════════════════════════════
  async function ensurePageHelpers(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        if (window.__waH) return;

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
          } catch (err) { console.debug("[WA Actions] page helper setup:", err?.message); }
        }

        let _rootsCache = null;
        function getGlobalRoots() {
          if (_rootsCache) return _rootsCache;
          const roots = [document]; const seen = new Set([document]);
          scanShadowRoots(document, roots, seen);
          _rootsCache = roots; return roots;
        }

        // F2 — Auto-invalidate shadow DOM cache on major DOM changes
        let _cacheObserver = null;
        function setupCacheObserver() {
          if (_cacheObserver) return;
          try {
            _cacheObserver = new MutationObserver(function (mutations) {
              const dominated = mutations.some(function (m) {
                return m.addedNodes.length > 3 || m.removedNodes.length > 3;
              });
              if (dominated) {
                _rootsCache = null;
              }
            });
            _cacheObserver.observe(document.body, { childList: true, subtree: true });
          } catch (err) { console.debug("[WA Actions] cache observer setup:", err?.message); }
        }

        function getNestedRoots(root) {
          const roots = [root]; const seen = new Set([root]);
          scanShadowRoots(root, roots, seen);
          return roots;
        }

        function queryAllFromRoots(roots, sel) {
          const out = []; const seen = new Set();
          for (const root of roots) {
            try { root.querySelectorAll(sel).forEach(function(el) { if (!seen.has(el)) { seen.add(el); out.push(el); } }); }
            catch (err) { console.debug("[WA Actions] selector failed:", err?.message); }
          }
          return out;
        }

        function qsaDeep(sel) { return queryAllFromRoots(getGlobalRoots(), sel); }
        function qsDeep(sel) { return qsaDeep(sel)[0] || null; }
        function qsaWithin(root, sel) { return queryAllFromRoots(getNestedRoots(root), sel); }
        function qsWithin(root, sel) { return qsaWithin(root, sel)[0] || null; }

        function filterVisible(els) {
          return Array.from(els || []).filter(function(el) {
            try {
              const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              return !rect || rect.width > 0 || rect.height > 0;
            } catch (err) { console.debug("[WA Actions] rect check:", err?.message); return true; }
          });
        }

        function modernClearAndType(el, text) {
          let input = el;
          if (el.querySelector) {
            input = el.querySelector('[contenteditable="true"], input') || el;
          }
          input.focus();
          if (typeof input.click === "function") input.click();

          const sel = window.getSelection();
          if (sel && input.childNodes.length > 0) {
            const range = document.createRange();
            range.selectNodeContents(input);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          if (sel && !sel.isCollapsed) {
            sel.deleteFromDocument();
          }

          if (input.getAttribute("contenteditable") === "true") {
            // ── Svuotare la casella, e VERIFICARE che si sia svuotata ──
            //
            // Il 7 agosto a Jose e' arrivato "test cobratest cobratest cobra":
            // tre tentativi accodati nella stessa casella. Il difetto era qui,
            // ed erano due difetti che si tenevano.
            //
            // Primo: la pulizia era un execCommand("delete") dentro un
            // try/catch che ingoiava tutto. Su Lexical — l'editor di WhatsApp —
            // quel comando a volte non fa niente, e nessuno se ne accorgeva.
            //
            // Secondo, piu' insidioso: hasText() rispondeva "c'e' gia'" se il
            // testo compariva DA QUALCHE PARTE nella casella. Con un residuo
            // dentro, il primo controllo era gia' vero, tutti gli step
            // saltavano, e si premeva invio su quello che c'era: residuo piu'
            // testo nuovo. Il controllo che doveva impedire i duplicati era
            // quello che li causava.
            //
            // Adesso si svuota finche' non e' vuota davvero, e si considera
            // riuscito solo se il contenuto e' ESATTAMENTE il testo.
            const svuota = function () {
              try {
                const r = document.createRange();
                r.selectNodeContents(input);
                const s2 = window.getSelection();
                s2.removeAllRanges();
                s2.addRange(r);
                document.execCommand("delete", false);
              } catch (e) { /* si riprova sotto */ }
            };

            let residuo = "";
            for (let tentativo = 0; tentativo < 3; tentativo++) {
              svuota();
              residuo = (input.textContent || "").trim();
              if (residuo === "") break;
              // Lexical non ha risposto al comando: si toglie a mano e si
              // avvisa l'editor che il contenuto e' cambiato.
              try {
                input.textContent = "";
                input.dispatchEvent(new InputEvent("input", {
                  inputType: "deleteContentBackward", bubbles: true, composed: true,
                }));
              } catch (e) { /* ignore */ }
              residuo = (input.textContent || "").trim();
              if (residuo === "") break;
            }

            // Se dopo tre tentativi c'e' ancora qualcosa, NON si scrive sopra:
            // si esce. Meglio un messaggio non partito che un messaggio partito
            // sbagliato — quello non si richiama.
            if (residuo !== "") {
              return {
                success: false,
                error: "casella_non_vuota",
                residuo: residuo.slice(0, 120),
                perche: "Nella casella di WhatsApp e' rimasto del testo che non riesco a togliere. "
                  + "Se scrivessi adesso, partirebbe quello vecchio attaccato al nuovo. "
                  + "Svuotala a mano e richiama.",
              };
            }

            // Riuscito = la casella contiene ESATTAMENTE il testo. Non "lo
            // contiene": lo e'.
            const hasText = function () {
              return (input.textContent || "").trim() === text.trim();
            };

            // STEP 1 — ClipboardEvent paste (modo nativo gestito da Lexical)
            if (!hasText()) {
              try {
                const dt = new DataTransfer();
                dt.setData("text/plain", text);
                const evt = new ClipboardEvent("paste", {
                  clipboardData: dt, bubbles: true, cancelable: true,
                });
                input.dispatchEvent(evt);
              } catch (e) { /* ignore */ }
            }

            // STEP 2 — execCommand('insertText') se paste non ha funzionato
            if (!hasText()) {
              try { document.execCommand("insertText", false, text); }
              catch (e) { /* ignore */ }
            }

            // STEP 3 — Fallback duro: scrittura diretta + InputEvent
            if (!hasText()) {
              try {
                input.textContent = text;
                input.dispatchEvent(new InputEvent("input", {
                  inputType: "insertText", data: text, bubbles: true, composed: true,
                }));
              } catch (e) { /* ignore */ }
            }
          } else if (input.tagName === "INPUT" || input.tagName === "TEXTAREA") {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value"
            ).set;
            nativeSetter.call(input, text);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        function modernInsertText(el, text) {
          el.focus();
          if (el.getAttribute("contenteditable") === "true") {
            el.dispatchEvent(new InputEvent("beforeinput", {
              inputType: "insertText", data: text, bubbles: true, cancelable: true, composed: true
            }));
            const dt = new DataTransfer();
            dt.setData("text/plain", text);
            el.dispatchEvent(new InputEvent("input", {
              inputType: "insertText", data: text, dataTransfer: dt,
              bubbles: true, composed: true
            }));
            if (!el.textContent.includes(text)) {
              el.textContent = text;
              el.dispatchEvent(new InputEvent("input", {
                inputType: "insertText", data: text, bubbles: true, composed: true
              }));
            }
          }
        }

        function invalidateCache() { _rootsCache = null; }

        window.__waH = {
          qsDeep: qsDeep, qsaDeep: qsaDeep,
          qsWithin: qsWithin, qsaWithin: qsaWithin,
          filterVisible: filterVisible,
          modernClearAndType: modernClearAndType,
          modernInsertText: modernInsertText,
          invalidateCache: invalidateCache,
        };

        // F2 — start MutationObserver after helpers are installed
        setupCacheObserver();
      },
    });
  }

  // ══════════════════════════════════════════════
  // VERIFY SESSION
  // ══════════════════════════════════════════════
  async function verifySession() {
    try {
      const existing = await TabManager.getBestExistingWaTab();
      let waTab;
      if (existing) {
        waTab = existing;
        if (waTab.status !== "complete") await TabManager.waitForLoad(waTab.id, 8000);
      } else {
        const r = await TabManager.getOrCreateWaTab();
        waTab = r.tab;
        await TabManager.sleep(3000);
      }

      let result = await Discovery.waitForRenderableWaUi(waTab.id, 3, [1200, 1800]);
      const shouldHydrate = !waTab.active && (!result || (!result.hasQR && !Discovery.hasRenderableWaUi(result) && (Discovery.hasShellSignals(result) || result.appLoaded)));

      if (shouldHydrate) {
        result = await TabManager.withTemporarilyVisibleTab(waTab.id, async function () {
          return await Discovery.waitForRenderableWaUi(waTab.id, 4, [900, 1400, 2000]);
        }) || result;
      }

      const diag = Discovery.compactDiscovery(result);
      if (result && result.hasQR) return { success: true, authenticated: false, reason: "qr_required", diagnostic: diag };
      // Confirm-popup di WhatsApp (es. "WhatsApp aperto su un altro browser - Usa qui")
      if (result && Array.isArray(result.dataTestIds) && result.dataTestIds.indexOf("confirm-popup") !== -1) {
        // Auto-dismiss: clicca "Usa qui" / "Use here" per riprendere la sessione
        // sul tab dell'estensione invece di lasciare l'utente bloccato.
        try {
          await chrome.scripting.executeScript({
            target: { tabId: waTab.id },
            func: function () {
              try {
                var popup = document.querySelector('[data-testid="confirm-popup"]')
                  || document.querySelector('[data-animate-modal-popup="true"]');
                if (!popup) return false;
                var btns = popup.querySelectorAll('button, [role="button"]');
                for (var i = 0; i < btns.length; i++) {
                  var t = (btns[i].innerText || btns[i].textContent || "").trim().toLowerCase();
                  if (/usa qui|use here|usar aqu|utiliser ici|hier verwenden|continuar|continue/.test(t)) {
                    btns[i].click();
                    return true;
                  }
                }
                // Fallback: ultimo bottone primario del popup
                if (btns.length) { btns[btns.length - 1].click(); return true; }
                return false;
              } catch (e) { return false; }
            },
          });
          await TabManager.sleep(2500);
          // Re-probe dopo il click
          const after = await Discovery.waitForRenderableWaUi(waTab.id, 3, [1000, 1500, 2000]);
          const diag2 = Discovery.compactDiscovery(after);
          if (after && after.sidebar) return { success: true, authenticated: true, method: "sidebar-after-popup", diagnostic: diag2 };
          if ((after && after.chatItems || 0) > 0) return { success: true, authenticated: true, method: "chat-items-after-popup", diagnostic: diag2 };
          if (after && (after.hasComposeBox || (after.textboxCount || 0) > 0)) return { success: true, authenticated: true, method: "compose-after-popup", diagnostic: diag2 };
          if (Discovery.hasShellSignals(after)) return { success: true, authenticated: true, method: "shell-after-popup", diagnostic: diag2 };
          return { success: true, authenticated: false, reason: "confirm_popup", message: "Popup 'Usa qui' rilevato e cliccato, ma WhatsApp non si è ancora stabilizzato. Riprova fra qualche secondo.", diagnostic: diag2 };
        } catch (e) {
          return { success: true, authenticated: false, reason: "confirm_popup", message: "WhatsApp Web mostra un popup di conferma ('Usa qui'). Click automatico fallito: " + (e && e.message ? e.message : String(e)), diagnostic: diag };
        }
      }
      if (result && (result.hasLoadingScreen || !result.appLoaded || result.bodyChildCount < 3)) return { success: true, authenticated: false, reason: "loading", diagnostic: diag };
      if (result && result.sidebar) return { success: true, authenticated: true, method: "sidebar:" + (result.sidebarSelector || "discovered"), diagnostic: diag };
      if ((result && result.chatItems || 0) > 0) return { success: true, authenticated: true, method: "chat-items:" + (result.chatItemsMethod || "discovered"), diagnostic: diag };
      if (result && (result.hasComposeBox || (result.textboxCount || 0) > 0)) return { success: true, authenticated: true, method: result.hasComposeBox ? "compose-box" : "textbox", diagnostic: diag };
      if (Discovery.hasShellSignals(result)) return { success: true, authenticated: true, method: "app-shell-fallback", diagnostic: diag };
      return { success: true, authenticated: false, reason: "unknown_state", diagnostic: diag };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════
  // READ UNREAD — injected page function
  // ══════════════════════════════════════════════
  function _pageReadUnreadDOM(schema) {
    const H = window.__waH;
    // Removed VERIFY_COUNT: only return chats with actual unread messages

    if (H.qsDeep('canvas[aria-label]') || H.qsDeep('[data-testid="qrcode"]') || H.qsDeep('[data-ref]'))
      return { success: false, error: "QR code visibile - accedi a WhatsApp Web" };

    let chatItems = [];
    let method = "none";

    // S1: Learned schema
    if (schema && schema.chatItem) {
      chatItems = H.filterVisible(H.qsaDeep(schema.chatItem));
      if (chatItems.length > 0) method = "learned:" + schema.chatItem;
    }
    if (chatItems.length === 0 && schema && schema.chatItemAlt) {
      chatItems = H.filterVisible(H.qsaDeep(schema.chatItemAlt));
      if (chatItems.length > 0) method = "learned-alt:" + schema.chatItemAlt;
    }

    // S2: data-testid
    if (chatItems.length === 0) {
      const testIdPatterns = ['cell-frame-container','chat-cell-wrapper','list-item','chatlist-item','chat-list-item'];
      for (const tid of testIdPatterns) {
        chatItems = H.filterVisible(H.qsaDeep('[data-testid="' + tid + '"]'));
        if (chatItems.length > 0) { method = "testid:" + tid; break; }
      }
    }

    // S3: role-based
    if (chatItems.length === 0) {
      const rolePatterns = [
        { sel: '[role="listitem"]', name: 'listitem' },
        { sel: '[role="row"]', name: 'row' },
        { sel: '[role="option"]', name: 'option' },
      ];
      for (const rp of rolePatterns) {
        chatItems = H.filterVisible(H.qsaDeep(rp.sel));
        if (chatItems.length >= 3) { method = "role:" + rp.name; break; }
      }
    }

    // S4: Container children
    if (chatItems.length === 0) {
      const containers = H.filterVisible(H.qsaDeep('[role="list"],[role="listbox"],[role="grid"],[role="navigation"]'));
      for (const cont of containers) {
        const vc = H.filterVisible(Array.from(cont.children || []));
        if (vc.length >= 3) { chatItems = vc; method = "container:" + cont.getAttribute("role"); break; }
      }
    }

    // S5: Heuristic
    if (chatItems.length === 0) {
      const allTitled = H.filterVisible(H.qsaDeep('span[title]'));
      const parentMap = new Map();
      for (const sp of allTitled) {
        const ancestor = sp.closest('[tabindex],[role="row"],[role="listitem"],[data-testid]');
        if (ancestor && !parentMap.has(ancestor)) parentMap.set(ancestor, true);
      }
      if (parentMap.size >= 3) { chatItems = Array.from(parentMap.keys()); method = "heuristic-titled-ancestors"; }
    }

    if (chatItems.length === 0) return { success: true, messages: [], scanned: 0, method: "none", error: "No chat items found" };

    const messages = [];
    let processed = 0;

    for (let i = 0; i < chatItems.length; i++) {
      const chat = chatItems[i];
      let badge = null, count = 0;

      // S1: data-testid (può essere assente nel DOM attuale)
      badge = H.qsWithin(chat, '[data-testid="icon-unread-count"]') || H.qsWithin(chat, '[data-testid="unread-count"]');
      if (badge) count = parseInt(badge.textContent) || 1;

      // S2: aria-label con testo "unread" / "non letti" / "da leggere"
      if (!badge) {
        const ariaEls = H.qsaWithin(chat, 'span[aria-label]');
        for (const ae of ariaEls) {
          const label = (ae.getAttribute("aria-label") || "").toLowerCase();
          if (label.includes("unread") || label.includes("non lett") || label.includes("da leggere")) {
            count = parseInt(ae.textContent) || 1; badge = ae; break;
          }
        }
      }

      // M3-S3: Badge numerica — qualsiasi span con solo cifre in un contenitore piccolo
      // WhatsApp usa classi obfuscate ma la struttura è: piccolo span con "1", "2", etc.
      // dentro un div circolare. Cerchiamo senza dipendere dal colore (fallisce in background tab).
      if (!badge) {
        const spans = H.qsaWithin(chat, 'span');
        for (const s of spans) {
          const txt = s.textContent.trim();
          if (txt && /^\d{1,3}$/.test(txt)) {
            // Verifica che sia un badge e non un orario o altro numero
            const rect = s.getBoundingClientRect ? s.getBoundingClientRect() : null;
            const isSmall = rect && rect.width > 0 && rect.width < 40 && rect.height < 30;
            // Controlla colore verde O dimensione badge-like
            const bg = window.getComputedStyle(s).backgroundColor;
            const parentBg = s.parentElement ? window.getComputedStyle(s.parentElement).backgroundColor : "";
            const isGreen = (bg + parentBg).match(/37,\s*211|25d366|00a884|rgb\(0,\s*168|rgb\(37/i);
            // Controlla se il parent è "rotondo" (border-radius alto = badge)
            const parentStyle = s.parentElement ? window.getComputedStyle(s.parentElement) : null;
            const borderRadius = parentStyle ? parseFloat(parentStyle.borderRadius) || 0 : 0;
            const isBadgeShaped = borderRadius >= 8;
            if (isGreen || (isSmall && isBadgeShaped)) {
              count = parseInt(txt) || 1; badge = s; break;
            }
          }
        }
      }

      // M3-S4: Classe CSS con pattern badge/unread (WhatsApp obfusca ma alcuni pattern restano)
      if (!badge) {
        const allEls = H.qsaWithin(chat, '[class*="unread"], [class*="badge"], [aria-label*="unread"], [aria-label*="non lett"]');
        for (const el of allEls) {
          const txt = el.textContent.trim();
          if (txt && /^\d{1,3}$/.test(txt)) {
            count = parseInt(txt) || 1; badge = el; break;
          }
          // Badge senza numero (punto verde) = almeno 1
          const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (rect && rect.width > 0 && rect.width < 20 && rect.height > 0 && rect.height < 20) {
            count = 1; badge = el; break;
          }
        }
      }

      // Solo unread: salta item senza badge confermato
      if (count === 0) continue;

      let contactName = "Sconosciuto";
      // M7: Priorità a selettori strutturali (span[title][dir]) — data-testid potrebbe non esistere
      const titleEl = H.qsWithin(chat, 'span[title][dir="auto"]') || H.qsWithin(chat, 'span[title]') || H.qsWithin(chat, '[data-testid="cell-frame-title"] span') || H.qsWithin(chat, '[role="gridcell"] span[dir="auto"]');
      if (titleEl) contactName = titleEl.getAttribute("title") || titleEl.textContent?.trim() || "Sconosciuto";

      let lastMessage = "";
      // M7: Selettori strutturali prima di data-testid; ultimo fallback su secondo gridcell
      let msgEl = H.qsWithin(chat, '[data-testid="last-msg-status"]') || H.qsWithin(chat, '[data-testid="cell-frame-secondary"] span[title]') || H.qsWithin(chat, '[data-testid="cell-frame-secondary"] span') || H.qsWithin(chat, '[data-testid="last-msg"] span');
      if (!msgEl) {
        const allSpans = H.qsaWithin(chat, 'span');
        const candidates = [];
        for (const sp2 of allSpans) {
          const t = sp2.textContent?.trim();
          if (t && t.length > 3 && t !== contactName && !/^\d+$/.test(t)) candidates.push(sp2);
        }
        if (candidates.length > 0) msgEl = candidates[candidates.length - 1];
      }
      if (msgEl) lastMessage = msgEl.textContent?.trim() || "";

      let time = new Date().toISOString();
      let timeEl = H.qsWithin(chat, '[data-testid="cell-frame-primary-detail"]') || H.qsWithin(chat, '[data-testid="msg-time"]') || H.qsWithin(chat, 'time');
      if (!timeEl) {
        const smallSpans = H.qsaWithin(chat, 'span');
        for (const ss of smallSpans) {
          const st = ss.textContent?.trim();
          if (st && /^\d{1,2}[:.]\d{2}/.test(st)) { timeEl = ss; break; }
        }
      }
      if (timeEl) time = timeEl.textContent?.trim() || time;

      messages.push({ contact: contactName, lastMessage: lastMessage, time: time, unreadCount: count });
      processed++;
    }
    return { success: true, messages: messages, scanned: chatItems.length, method: method };
  }

  async function readUnreadDOM(tabId) {
    await AiExtract.loadSchema();
    const schema = AiExtract.getSchema();
    await ensurePageHelpers(tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      args: [schema],
      func: _pageReadUnreadDOM,
    });
    return results && results[0] ? results[0].result : { success: false, error: "No result" };
  }

  // ══════════════════════════════════════════════
  // OPTIMUS V2 — readUnreadMessages: stabilize → unified extract → relearn → restore
  // ══════════════════════════════════════════════
  async function readUnreadMessages() {
    try {
      const r = await TabManager.getOrCreateWaTab();

      // STEP 1: Stabilize (N1)
      const activation = await TabManager.activateAndStabilize(r.tab.id, 3000);
      if (!activation.stable) {
        await activation.restore();
        return { success: false, error: "DOM non stabile dopo activation" };
      }

      try {
        // STEP 2: Unified extract (singola executeScript con multi-segnale + scoring)
        await ensurePageHelpers(r.tab.id);
        let result = await unifiedExtract(r.tab.id);

        // STEP 3: AI relearn se 0 contatti (ma item trovati → DOM rotto, non vuoto)
        if (result.itemsTotal > 0 && result.itemsWithContact === 0) {
          console.log("[WA V2] 0 contacts on " + result.itemsTotal + " items → triggering relearn");
          const relearned = await aiRelearnAndExtract(r.tab.id, result.diagnosticInfo);
          if (relearned && relearned.itemsWithContact > 0) result = relearned;
        }

        const messages = (result.items || [])
          .filter(function (it) { return it.contactName; })
          .map(function (it) {
            return {
              contact: it.contactName,
              lastMessage: it.lastMessage || "",
              time: it.timestamp || new Date().toISOString(),
              unreadCount: it.unreadCount || 0,
              hasUnread: !!it.hasUnread,
              confidence: it.confidence || 0,
            };
          });

        return {
          success: true,
          messages: messages,
          scanned: result.itemsTotal || 0,
          method: result.method || "unified-v2",
          meta: {
            itemsTotal: result.itemsTotal,
            itemsWithContact: result.itemsWithContact,
            itemsWithUnread: result.itemsWithUnread,
            strategy: result.strategy,
            scores: result.scores,
          },
        };
      } finally {
        // STEP 4: Restore tab precedente
        await activation.restore();
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════
  // OPTIMUS V2 — unifiedExtract: page-injected multi-strategy
  // ══════════════════════════════════════════════
  async function unifiedExtract(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: _pageUnifiedExtract,
    });
    return (results && results[0] && results[0].result)
      || { itemsTotal: 0, itemsWithContact: 0, itemsWithUnread: 0, items: [], method: "unified-v2-empty" };
  }

  function _pageUnifiedExtract() {
    const H = window.__waH;
    if (!H) return { itemsTotal: 0, itemsWithContact: 0, itemsWithUnread: 0, items: [], method: "no-helpers" };

    function avg(arr) {
      if (!arr.length) return 0;
      return Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length);
    }

    // ── A. Find chat items (multi-strategia con scoring) ──
    const strategies = [
      { sel: '[data-testid="cell-frame-container"]', score: 90, name: "testid-cell" },
      { sel: '[role="row"]', score: 80, name: "role-row" },
      { sel: '[role="listitem"]', score: 75, name: "role-listitem" },
      { sel: '[role="grid"] > *', score: 60, name: "grid-children" },
    ];
    let chatItems = [];
    let strategy = "none";
    let strategyScore = 0;
    for (let si = 0; si < strategies.length; si++) {
      const s = strategies[si];
      const found = H.filterVisible(H.qsaDeep(s.sel));
      if (found.length >= 3 && (found.length * s.score > chatItems.length * strategyScore)) {
        chatItems = found; strategy = s.name; strategyScore = s.score;
      }
    }
    if (chatItems.length === 0) {
      const titled = H.filterVisible(H.qsaDeep('span[title]'));
      const parentMap = new Map();
      for (let ti = 0; ti < titled.length; ti++) {
        const sp = titled[ti];
        const ancestor = sp.closest('[tabindex],[role="row"],[role="listitem"]');
        if (ancestor && !parentMap.has(ancestor)) parentMap.set(ancestor, true);
      }
      if (parentMap.size >= 3) { chatItems = Array.from(parentMap.keys()); strategy = "heuristic-title"; strategyScore = 40; }
    }
    if (chatItems.length === 0) {
      return {
        itemsTotal: 0, itemsWithContact: 0, itemsWithUnread: 0,
        items: [], strategy: "none", method: "unified-v2",
        diagnosticInfo: { error: "no_chat_items", bodyChildren: document.body ? document.body.children.length : 0 },
      };
    }

    // ── B. Extract per item ──
    const items = [];
    let itemsWithContact = 0, itemsWithUnread = 0;
    const scores = { contact: [], badge: [] };

    for (let i = 0; i < chatItems.length; i++) {
      const chat = chatItems[i];
      const item = { contactName: null, lastMessage: null, timestamp: null, unreadCount: 0, hasUnread: false, confidence: 0 };
      let contactScore = 0, badgeScore = 0;

      // Contact name
      const cstr = [
        { fn: function () { return H.qsWithin(chat, 'span[title][dir="auto"]'); }, get: function (el) { return el.getAttribute("title"); }, score: 95 },
        { fn: function () { return H.qsWithin(chat, '[data-testid="cell-frame-title"] span'); }, get: function (el) { return el.textContent && el.textContent.trim(); }, score: 90 },
        { fn: function () { return H.qsWithin(chat, 'span[title]'); }, get: function (el) { return el.getAttribute("title"); }, score: 85 },
        { fn: function () { return H.qsWithin(chat, '[role="gridcell"] span[dir="auto"]'); }, get: function (el) { return el.textContent && el.textContent.trim(); }, score: 70 },
        { fn: function () {
            const spans = H.qsaWithin(chat, 'span');
            for (let k = 0; k < spans.length; k++) {
              const t = (spans[k].textContent || "").trim();
              if (t.length > 1 && t.length < 50 && !/^\d+$/.test(t) && !/^\d{1,2}[:.]\d{2}/.test(t)) return spans[k];
            }
            return null;
          }, get: function (el) { return el.textContent && el.textContent.trim(); }, score: 30 },
      ];
      for (let cs = 0; cs < cstr.length; cs++) {
        const el = cstr[cs].fn();
        if (el) {
          const v = cstr[cs].get(el);
          if (v && v.length > 0 && v.length < 80) { item.contactName = v; contactScore = cstr[cs].score; break; }
        }
      }

      // Unread badge — 6 strategie ordinate
      const bstr = [
        { fn: function () { return H.qsWithin(chat, '[data-testid="icon-unread-count"]') || H.qsWithin(chat, '[data-testid="unread-count"]'); },
          get: function (el) { return parseInt(el.textContent) || 1; }, score: 95 },
        { fn: function () {
            const ar = H.qsaWithin(chat, 'span[aria-label]');
            for (let k = 0; k < ar.length; k++) {
              const lbl = (ar[k].getAttribute("aria-label") || "").toLowerCase();
              if (lbl.includes("unread") || lbl.includes("non lett") || lbl.includes("da leggere")) return ar[k];
            }
            return null;
          }, get: function (el) { return parseInt(el.textContent) || 1; }, score: 90 },
        { fn: function () {
            const spans = H.qsaWithin(chat, 'span');
            for (let k = 0; k < spans.length; k++) {
              const txt = spans[k].textContent.trim();
              if (!/^\d{1,3}$/.test(txt)) continue;
              const ps = spans[k].parentElement ? window.getComputedStyle(spans[k].parentElement) : null;
              const br = ps ? parseFloat(ps.borderRadius) || 0 : 0;
              if (br >= 8) return spans[k];
            }
            return null;
          }, get: function (el) { return parseInt(el.textContent) || 1; }, score: 85 },
        { fn: function () {
            const spans = H.qsaWithin(chat, 'span');
            for (let k = 0; k < spans.length; k++) {
              const txt = spans[k].textContent.trim();
              if (!/^\d{1,3}$/.test(txt)) continue;
              const bg = window.getComputedStyle(spans[k]).backgroundColor;
              const pbg = spans[k].parentElement ? window.getComputedStyle(spans[k].parentElement).backgroundColor : "";
              if ((bg + pbg).match(/37,\s*211|25d366|00a884|rgb\(0,\s*168|rgb\(37/i)) return spans[k];
            }
            return null;
          }, get: function (el) { return parseInt(el.textContent) || 1; }, score: 80 },
        { fn: function () {
            const els = H.qsaWithin(chat, '[class*="unread"], [class*="badge"]');
            for (let k = 0; k < els.length; k++) {
              const txt = els[k].textContent.trim();
              if (/^\d{1,3}$/.test(txt)) return els[k];
              const rect = els[k].getBoundingClientRect ? els[k].getBoundingClientRect() : null;
              if (rect && rect.width > 0 && rect.width < 20 && rect.height > 0 && rect.height < 20) return els[k];
            }
            return null;
          }, get: function (el) { const n = parseInt(el.textContent); return n > 0 ? n : 1; }, score: 70 },
        { fn: function () {
            const spans = H.qsaWithin(chat, 'span');
            for (let k = 0; k < spans.length; k++) {
              const txt = spans[k].textContent.trim();
              if (!/^\d{1,3}$/.test(txt)) continue;
              const rect = spans[k].getBoundingClientRect ? spans[k].getBoundingClientRect() : null;
              if (rect && rect.width > 0 && rect.width < 40 && rect.height > 0 && rect.height < 30) return spans[k];
            }
            return null;
          }, get: function (el) { return parseInt(el.textContent) || 1; }, score: 50 },
      ];
      for (let bi = 0; bi < bstr.length; bi++) {
        const el = bstr[bi].fn();
        if (el) { item.unreadCount = bstr[bi].get(el); item.hasUnread = true; badgeScore = bstr[bi].score; break; }
      }

      // Last message
      let msgEl = H.qsWithin(chat, '[data-testid="last-msg-status"]')
        || H.qsWithin(chat, '[data-testid="cell-frame-secondary"] span[title]')
        || H.qsWithin(chat, '[data-testid="cell-frame-secondary"] span')
        || H.qsWithin(chat, '[data-testid="last-msg"] span');
      if (!msgEl) {
        const sps = H.qsaWithin(chat, 'span');
        const cands = [];
        for (let k = 0; k < sps.length; k++) {
          const t = sps[k].textContent && sps[k].textContent.trim();
          if (t && t.length > 3 && t !== item.contactName && !/^\d+$/.test(t) && !/^\d{1,2}[:.]\d{2}/.test(t)) cands.push(sps[k]);
        }
        if (cands.length > 0) msgEl = cands[cands.length - 1];
      }
      if (msgEl) item.lastMessage = (msgEl.textContent || "").trim();

      // Timestamp
      let timeEl = H.qsWithin(chat, '[data-testid="cell-frame-primary-detail"]')
        || H.qsWithin(chat, '[data-testid="msg-time"]')
        || H.qsWithin(chat, 'time');
      if (!timeEl) {
        const sps = H.qsaWithin(chat, 'span');
        for (let k = 0; k < sps.length; k++) {
          const st = sps[k].textContent && sps[k].textContent.trim();
          if (st && /^\d{1,2}[:.]\d{2}/.test(st)) { timeEl = sps[k]; break; }
          if (st && /^(ieri|oggi|luned|marted|mercoled|gioved|venerd|sabato|domenic)/i.test(st)) { timeEl = sps[k]; break; }
        }
      }
      if (timeEl) item.timestamp = (timeEl.textContent || "").trim();

      item.confidence = Math.round((contactScore + badgeScore) / 2);
      if (item.contactName) {
        itemsWithContact++;
        if (item.hasUnread) itemsWithUnread++;
      }
      items.push(item);
      scores.contact.push(contactScore);
      scores.badge.push(badgeScore);
    }

    // Diagnostic per relearn
    let diagnosticInfo = null;
    if (itemsWithContact === 0 && chatItems.length > 0) {
      const sampleHtml = [];
      for (let si = 0; si < Math.min(chatItems.length, 3); si++) {
        sampleHtml.push(chatItems[si].outerHTML.slice(0, 2500));
      }
      diagnosticInfo = {
        error: "zero_contacts_extracted",
        itemsFound: chatItems.length,
        strategy: strategy,
        sampleItems: sampleHtml,
        dataTestIds: Array.from(new Set(
          Array.from(document.querySelectorAll('[data-testid]')).map(function (e) { return e.getAttribute('data-testid'); })
        )).slice(0, 30),
        roles: Array.from(new Set(
          Array.from(document.querySelectorAll('[role]')).map(function (e) { return e.getAttribute('role'); })
        )),
      };
    }

    return {
      itemsTotal: chatItems.length,
      itemsWithContact: itemsWithContact,
      itemsWithUnread: itemsWithUnread,
      items: items,
      strategy: strategy,
      method: "unified-v2",
      scores: { avgContact: avg(scores.contact), avgBadge: avg(scores.badge) },
      diagnosticInfo: diagnosticInfo,
    };
  }

  // ══════════════════════════════════════════════
  // OPTIMUS V2 — aiRelearnAndExtract: rich snapshot → AI direct-first → validate in-context
  // ══════════════════════════════════════════════
  async function aiRelearnAndExtract(tabId, diagnosticInfo) {
    // 1. Rich snapshot (riusa AiExtract.learnDomSelectors che ora è direct-first)
    const learnRes = await AiExtract.learnDomSelectors(tabId);
    if (!learnRes || !learnRes.success || !learnRes.schema) return null;

    // 2. Validate + extract in-context
    const validated = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: _pageValidateAndExtract,
      args: [learnRes.schema],
    });
    const result = validated && validated[0] && validated[0].result;
    if (!result || result.itemsWithContact === 0) return null;

    // 3. Cache solo selettori validati (TTL 12h gestito dal consumer)
    try {
      const validatedPlan = {};
      for (const k in learnRes.schema) {
        if (result.validatedSelectors && result.validatedSelectors[k]) validatedPlan[k] = learnRes.schema[k];
      }
      if (Object.keys(validatedPlan).length > 0) {
        await chrome.storage.local.set({
          optimus_v2_plan: validatedPlan,
          optimus_v2_at: Date.now(),
          optimus_v2_validation: result.validationMeta,
        });
      }
    } catch (e) { console.debug("[WA V2] cache save failed:", e?.message); }

    return result;
  }

  function _pageValidateAndExtract(selectors) {
    const H = window.__waH;
    if (!H) return { itemsTotal: 0, itemsWithContact: 0, items: [], method: "ai-relearn-v2-no-helpers" };

    const validatedSelectors = {};
    for (const k in (selectors || {})) {
      const sel = selectors[k];
      if (!sel) continue;
      const selectorStr = typeof sel === "string" ? sel : (sel.primary || sel.selector || String(sel));
      try {
        const matches = H.qsaDeep(selectorStr);
        if (matches.length > 0) validatedSelectors[k] = { selector: selectorStr, matchCount: matches.length };
      } catch (e) { /* invalid selector */ }
    }

    const containerSel = (validatedSelectors.chatItem && validatedSelectors.chatItem.selector)
      || (validatedSelectors.container && validatedSelectors.container.selector)
      || '[role="row"]';
    const chatItems = H.filterVisible(H.qsaDeep(containerSel));

    const items = [];
    let itemsWithContact = 0, itemsWithUnread = 0;

    for (let i = 0; i < chatItems.length; i++) {
      const chat = chatItems[i];
      const item = { contactName: null, lastMessage: null, timestamp: null, unreadCount: 0, hasUnread: false, confidence: 70 };

      // Contact: AI selector validato → fallback strutturale
      const contactSel = validatedSelectors.contactName && validatedSelectors.contactName.selector;
      if (contactSel) {
        const el = H.qsWithin(chat, contactSel);
        if (el) item.contactName = el.getAttribute("title") || (el.textContent || "").trim();
      }
      if (!item.contactName) {
        const el = H.qsWithin(chat, 'span[title][dir="auto"]') || H.qsWithin(chat, 'span[title]');
        if (el) item.contactName = el.getAttribute("title") || (el.textContent || "").trim();
      }

      // Badge: AI → fallback aria/numeric
      const badgeSel = validatedSelectors.unreadBadge && validatedSelectors.unreadBadge.selector;
      if (badgeSel) {
        const el = H.qsWithin(chat, badgeSel);
        if (el) { item.unreadCount = parseInt(el.textContent) || 1; item.hasUnread = true; }
      }
      if (!item.hasUnread) {
        const ar = H.qsaWithin(chat, 'span[aria-label]');
        for (let k = 0; k < ar.length; k++) {
          const lbl = (ar[k].getAttribute("aria-label") || "").toLowerCase();
          if (lbl.includes("unread") || lbl.includes("non lett") || lbl.includes("da leggere")) {
            item.unreadCount = parseInt(ar[k].textContent) || 1; item.hasUnread = true; break;
          }
        }
      }

      // Last message + timestamp: fallback strutturali
      const msgSel = validatedSelectors.lastMessage && validatedSelectors.lastMessage.selector;
      const msgEl = (msgSel && H.qsWithin(chat, msgSel)) || H.qsWithin(chat, '[data-testid="cell-frame-secondary"] span');
      if (msgEl) item.lastMessage = (msgEl.textContent || "").trim();

      const timeSel = validatedSelectors.timestamp && validatedSelectors.timestamp.selector;
      const timeEl = (timeSel && H.qsWithin(chat, timeSel)) || H.qsWithin(chat, '[data-testid="cell-frame-primary-detail"]') || H.qsWithin(chat, 'time');
      if (timeEl) item.timestamp = (timeEl.textContent || "").trim();

      if (item.contactName) {
        itemsWithContact++;
        if (item.hasUnread) itemsWithUnread++;
      }
      items.push(item);
    }

    return {
      itemsTotal: chatItems.length,
      itemsWithContact: itemsWithContact,
      itemsWithUnread: itemsWithUnread,
      items: items,
      validatedSelectors: validatedSelectors,
      validationMeta: {
        selectorsReceived: Object.keys(selectors || {}).length,
        selectorsValidated: Object.keys(validatedSelectors).length,
        timestamp: Date.now(),
      },
      method: "ai-relearn-v2",
    };
  }

  // ── I3: Map AI learn output keys to Optimus executor keys ──
  function convertSchemaToOptimusPlan(schema) {
    if (!schema || typeof schema !== "object") return null;

    const keyMap = {
      chatItem: "container",
      chatItemAlt: "container_fallback",
      contactName: "contact_name",
      chatTitle: "contact_name",
      chatName: "contact_name",
      title: "contact_name",
      lastMessage: "last_message",
      snippet: "last_message",
      preview: "last_message",
      timestamp: "timestamp",
      timeStamp: "timestamp",
      time: "timestamp",
      unreadBadge: "unread_badge",
      unreadCount: "unread_badge",
      badge: "unread_badge",
    };

    const plan = { fields: {} };
    for (const [aiKey, selector] of Object.entries(schema)) {
      const optimusKey = keyMap[aiKey];
      if (!optimusKey || !selector) continue;
      const primary = typeof selector === "string"
        ? selector
        : (selector.primary || selector.selector || String(selector));
      const fallback = typeof selector === "object" ? (selector.fallback || selector.alt || null) : null;
      plan.fields[optimusKey] = { primary: primary, fallback: fallback };
    }

    if (!plan.fields.container && !plan.fields.contact_name) {
      console.warn("[WA Optimus] Schema conversion failed: missing container or contact_name");
      return null;
    }
    return plan;
  }

  // ── I4: Local cache for learned plans (24h TTL) ──
  const LEARNED_PLAN_CACHE_KEY = "optimus_learned_plan";
  const LEARNED_PLAN_AT_KEY = "optimus_learned_at";
  const LEARNED_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  async function loadCachedLearnedPlan() {
    try {
      const stored = await chrome.storage.local.get([LEARNED_PLAN_CACHE_KEY, LEARNED_PLAN_AT_KEY]);
      if (!stored[LEARNED_PLAN_CACHE_KEY] || !stored[LEARNED_PLAN_AT_KEY]) return null;
      const ageMs = Date.now() - stored[LEARNED_PLAN_AT_KEY];
      if (ageMs >= LEARNED_PLAN_MAX_AGE_MS) {
        console.log("[WA Optimus] Cached plan expired, will relearn");
        return null;
      }
      const schema = typeof stored[LEARNED_PLAN_CACHE_KEY] === "string"
        ? JSON.parse(stored[LEARNED_PLAN_CACHE_KEY])
        : stored[LEARNED_PLAN_CACHE_KEY];
      const plan = convertSchemaToOptimusPlan(schema);
      if (plan) console.log("[WA Optimus] Loaded cached learned plan (age: " + Math.round(ageMs / 60000) + " min)");
      return plan;
    } catch (err) {
      console.debug("[WA Optimus] Cache load failed:", err?.message);
      return null;
    }
  }

  // ── Optimus-first: try AI extraction plan, fallback to legacy on 503 ──
  async function tryOptimusReadUnread(tabId, previousFailed, failureContext) {
    const sidebarSelector = '[data-tab="3"], #pane-side, [role="grid"]';

    // I4: Try cached learned plan first (skip if forcing relearn)
    if (!previousFailed) {
      const cachedPlan = await loadCachedLearnedPlan();
      if (cachedPlan) {
        try {
          const cacheExec = await Optimus.executePlanInTab(tabId, sidebarSelector, cachedPlan);
          if (cacheExec && cacheExec.success && cacheExec.items && cacheExec.items.length > 0) {
            return {
              success: true, cached: true, planVersion: 0, confidence: 0.85, latencyMs: 0,
              items: cacheExec.items, candidates: cacheExec.candidates || 0, dropped: cacheExec.dropped || 0,
            };
          }
          console.log("[WA Optimus] Cached learned plan returned 0 items, will try bridge/relearn");
        } catch (cacheErr) {
          console.debug("[WA Optimus] Cached plan exec failed:", cacheErr?.message);
        }
      }
    }

    // 1. snapshot the sidebar
    const snap = await Optimus.snapshotPage(tabId, sidebarSelector, 6, 3000);
    if (!snap || !snap.ok) return { success: false, error: snap && snap.error || "snapshot_failed", optimusUnavailable: false };

    // 2. build request payload with OptimusClient compatibility helper
    const req = OptimusClient.requestPlan("whatsapp", "sidebar", snap.snapshot, {
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
      // I1: Auto-relearn — Optimus plan failed, try AI learning directly
      console.log("[WA Optimus] Plan failed, triggering auto-relearn...", planRes && planRes.error);
      try {
        const learnResult = await AiExtract.learnDomSelectors(tabId);
        if (learnResult && learnResult.success && learnResult.schema) {
          console.log("[WA Optimus] Relearn succeeded, retrying with fresh selectors");
          const freshPlan = convertSchemaToOptimusPlan(learnResult.schema);
          if (freshPlan) {
            const retryExec = await Optimus.executePlanInTab(tabId, sidebarSelector, freshPlan);
            if (retryExec && retryExec.success && retryExec.items && retryExec.items.length > 0) {
              return {
                success: true, cached: false, planVersion: 0, confidence: 0.7, latencyMs: 0,
                items: retryExec.items, candidates: retryExec.candidates || 0, dropped: retryExec.dropped || 0,
                method: "optimus-relearned",
              };
            }
          }
        }
      } catch (learnErr) {
        console.warn("[WA Optimus] Auto-relearn failed:", learnErr?.message);
      }
      return { success: false, error: planRes && planRes.error || "plan_failed", optimusUnavailable: true };
    }

    // 3. execute plan against the page
    const execRes = await Optimus.executePlanInTab(tabId, sidebarSelector, planRes.plan || planRes);
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


  // ── Optimus-first: extract messages from open chat panel ──
  // Returns { success, optimusUnavailable, items, cached, planVersion, confidence, latencyMs, dropped, candidates }
  async function tryOptimusReadThread(tabId, previousFailed, failureContext) {
    const panelSelector = '[data-testid="conversation-panel-messages"], #main [role="application"], #main';
    const snap = await Optimus.snapshotPage(tabId, panelSelector, 6, 3000);
    if (!snap || !snap.ok) return { success: false, error: snap && snap.error || "snapshot_failed", optimusUnavailable: false };

    const req = OptimusClient.requestPlan("whatsapp", "thread", snap.snapshot, {
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
      return { success: false, error: planRes && planRes.error || "plan_failed", optimusUnavailable: true };
    }

    const execRes = await Optimus.executePlanInTab(tabId, panelSelector, planRes.plan || planRes);
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

  // Map Optimus extracted items to legacy message shape used by useWhatsAppAdaptiveSync
  function mapOptimusThreadItems(items, contactName) {
    return items.map(function (it) {
      // Optimus may return keys like message_text, message_sender, message_time, direction
      const text = it.message_text || it.text || it.body || "";
      const senderRaw = it.message_sender || it.sender || "";
      const timestamp = it.message_time || it.timestamp || it.time || "";
      // Detect direction: explicit field wins, otherwise infer from sender = "Tu"/"You"/"Me"
      let direction = it.direction || "";
      if (!direction) {
        const s = String(senderRaw).toLowerCase().trim();
        direction = (s === "tu" || s === "you" || s === "me" || s === "io") ? "outbound" : "inbound";
      }
      return {
        direction: direction,
        text: text,
        timestamp: timestamp,
        contact: direction === "outbound" ? "me" : (senderRaw || contactName),
      };
    }).filter(function (m) { return !!m.text; });
  }

  async function readThread(contactName, maxMessages) {
    const LIMIT = maxMessages || 50;
    try {
      const r = await TabManager.getOrCreateWaTab();
      // Bring the WA tab to foreground BEFORE sleep — background tabs throttle DOM
      await TabManager.ensureTabVisibleAndWait(r.tab.id, 1200);
      await TabManager.sleep(r.reused ? 1500 : 5000);
      await ensurePageHelpers(r.tab.id);

      // Step 1: open the target chat (this part stays as-is)
      const results = await chrome.scripting.executeScript({
        target: { tabId: r.tab.id },
        args: [contactName],
        func: _pageOpenAndReadThread,
      });

      const scriptResult = results && results[0] ? results[0].result : null;
      if (!scriptResult || !scriptResult.success) return scriptResult || { success: false, error: "Script error" };

      // Step 2: Optimus-first extraction
      let optimus = await tryOptimusReadThread(r.tab.id, false, null);
      if (optimus.success && optimus.items.length === 0 && optimus.cached) {
        optimus = await tryOptimusReadThread(r.tab.id, true, "Cached plan returned 0 messages from thread panel for " + contactName);
      }

      if (optimus.success) {
        const allMessages = mapOptimusThreadItems(optimus.items, contactName);
        const messages = allMessages.slice(-LIMIT);
        return {
          success: true,
          messages: messages,
          contact: contactName,
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

      // Any Optimus failure (unreachable OR structural) → fall through to legacy
      console.warn("[WA Actions] Optimus readThread failed, falling through to legacy:", optimus.error);

      // ── Legacy fallback (only if Optimus unreachable: 503/no-app-tab/timeout) ──
      // Legacy Path A: AI extraction on the panel HTML
      if (scriptResult.html && Config.hasConfig()) {
        const aiResult = await AiExtract.callAiExtract(scriptResult.html, "thread");
        if (aiResult && aiResult.success && aiResult.items && aiResult.items.length > 0) {
          return {
            success: true,
            messages: aiResult.items.map(function (m) {
              return {
                direction: String(m.direction || (m.is_outbound ? "outbound" : "inbound")).trim(),
                text: String(m.text || m.message || m.content || "").trim(),
                timestamp: String(m.timestamp || m.time || m.date || "").trim(),
                contact: String(m.contact || m.sender || m.from || contactName).trim(),
              };
            }).slice(-LIMIT),
            contact: contactName,
            method: "legacy-ai",
          };
        }
      }

      // Legacy Path B: hardcoded DOM extraction
      const domResults = await chrome.scripting.executeScript({
        target: { tabId: r.tab.id },
        args: [contactName, LIMIT],
        func: _pageDomReadMessages,
      });
      const domRes = domResults && domResults[0] ? domResults[0].result : null;
      if (domRes) domRes.method = "legacy-dom:" + (domRes.method || "unknown");
      return domRes || { success: false, error: "DOM fallback failed" };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Page-side fallback: after navigating to wa.me?phone=..., focus composer and click send
  function _pageSendUrlFallback(messageText) {
    const H = window.__waH;
    function findComposer() {
      return H.qsDeep('footer [contenteditable="true"][data-tab]')
        || H.qsDeep('footer [contenteditable="true"]')
        || H.qsDeep('[data-testid="conversation-compose-box-input"]')
        || H.qsDeep('[data-testid="compose-box-input"]');
    }
    function dismissPopups() {
      // "Use here" / "Continue" / "Use WhatsApp Web here" / phone-not-on-WA dialogs
      const okBtn = H.qsDeep('[data-testid="popup-controls-ok"]')
        || H.qsDeep('div[role="button"][tabindex="0"][data-testid*="ok"]');
      if (okBtn) { try { okBtn.click(); } catch (e) {} }
    }
    const findSendBtn = function () {
      return H.qsDeep('[data-testid="send"]') ||
        H.qsDeep('button[aria-label*="send" i]') ||
        H.qsDeep('button[aria-label*="invia" i]') ||
        (H.qsDeep('span[data-icon="send"]') && H.qsDeep('span[data-icon="send"]').closest('button'));
    };
    return new Promise(function (resolve) {
      // Phase 1: wait up to ~12s for composer to appear (heavy WA loads, cold tab)
      let waitForComposer = 0;
      const maxWaitForComposer = 120; // 12s
      const composerTick = function () {
        waitForComposer++;
        dismissPopups();
        const composer = findComposer();
        if (composer) {
          composer.focus();
          // If composer is empty (text not pre-filled by ?text=), type it ourselves.
          const current = (composer.textContent || "").trim();
          if (!current && messageText) {
            try { H.modernClearAndType(composer, messageText); } catch (e) {}
          }
          startSendLoop(composer);
          return;
        }
        if (waitForComposer >= maxWaitForComposer) {
          resolve({ success: false, error: "Composer not found after URL nav (timeout 12s)" });
          return;
        }
        setTimeout(composerTick, 100);
      };
      function startSendLoop(composer) {
      let attempts = 0;
      const maxAttempts = 50; // ~5s
      const tick = function () {
        attempts++;
        dismissPopups();
        const btn = findSendBtn();
        const enabled = btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
        if (enabled) {
          btn.click();
          resolve({ success: true, sent: true, method: "url-fallback" });
          return;
        }
        if (attempts >= maxAttempts) {
          try {
            composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
            composer.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
            composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
          } catch (e) { /* ignore */ }
          if (btn) { try { btn.click(); } catch (e) {} resolve({ success: true, sent: true, method: "url-fallback-enter" }); }
          else resolve({ success: false, error: "Send button not found after URL nav" });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
      }
      composerTick();
    });
  }

  // Page-side primary path: search the contact in sidebar then send
  function _pageSendWhatsApp(target, messageText, plan) {
    const H = window.__waH;
    function tryPlan(field) {
      if (!plan || !plan.selectors || !plan.selectors[field]) return null;
      const f = plan.selectors[field] || {};
      try {
        if (f.primary) { const el = H.qsDeep(f.primary); if (el) return el; }
        if (f.fallback) { const el = H.qsDeep(f.fallback); if (el) return el; }
      } catch (e) { /* invalid selector */ }
      return null;
    }
    const searchBox =
      tryPlan("search_box") ||
      H.qsDeep('[data-testid="chat-list-search-container"] [contenteditable="true"]') ||
      H.qsDeep('[data-testid="chat-list-search"] [contenteditable="true"]') ||
      H.qsDeep('[data-testid="chat-list-search-container"]') ||
      H.qsDeep('[data-testid="chat-list-search"]') ||
      H.qsDeep('div[contenteditable="true"][data-tab="3"]') ||
      H.qsDeep('div[contenteditable="true"][role="textbox"]') ||
      H.qsDeep('[title*="earch" i]') || H.qsDeep('[title*="erca" i]');
    if (!searchBox) return { success: false, error: "Search box not found", needsRemap: true };

    H.modernClearAndType(searchBox, target);
    return new Promise(function (resolve) {
      setTimeout(function () {
        const planChatItem = plan && plan.selectors && plan.selectors.chat_item ? plan.selectors.chat_item : null;
        let chats = [];
        if (planChatItem && planChatItem.primary) {
          try { chats = H.qsaDeep(planChatItem.primary) || []; } catch (e) { chats = []; }
        }
        if (chats.length === 0 && planChatItem && planChatItem.fallback) {
          try { chats = H.qsaDeep(planChatItem.fallback) || []; } catch (e) { chats = []; }
        }
        if (chats.length === 0) {
          chats = H.qsaDeep('[data-testid="cell-frame-container"],[data-testid="chat-cell-wrapper"],[role="listitem"],[role="row"]');
        }
        // Match selector: exact (case-insensitive) wins over substring; ambiguous substring => abort
        const targetLower = String(target || "").trim().toLowerCase();
        const candidates = [];
        for (const c of chats) {
          const titleEl = c.querySelector('span[title]');
          const title = titleEl ? ((titleEl.getAttribute("title") || titleEl.textContent || "").trim()) : "";
          if (!title) continue;
          const tl = title.toLowerCase();
          if (tl === targetLower) candidates.push({ el: c, title: title, exact: true });
          else if (tl.includes(targetLower)) candidates.push({ el: c, title: title, exact: false });
        }
        const exacts = candidates.filter(function (x) { return x.exact; });
        let chosen = null;
        if (exacts.length === 1) chosen = exacts[0];
        else if (exacts.length === 0 && candidates.length === 1) chosen = candidates[0];
        const clearBtn = H.qsDeep('[data-testid="search-input-clear"]') || H.qsDeep('[data-testid="x-alt"]') || H.qsDeep('[data-testid="search-close"]');
        if (!chosen) {
          if (clearBtn) clearBtn.click();
          if (candidates.length === 0) { resolve({ success: false, error: "Chat non trovata nella sidebar: " + target }); return; }
          resolve({ success: false, error: "Match ambiguo per \"" + target + "\" (" + candidates.length + " contatti corrispondenti). Inserisci il numero E.164 per invio diretto." });
          return;
        }
        const c = chosen.el;
        (c.closest('[data-testid="cell-frame-container"]') || c.closest('[data-testid="chat-cell-wrapper"]') || c).click();
        if (clearBtn) clearBtn.click();
        const chosenTitleLower = chosen.title.toLowerCase();

        setTimeout(function () {
          // Verify the open chat header matches the chosen contact before composing.
          const headerStart = Date.now();
          const headerDeadline = headerStart + 2500;
          function readHeader() {
            const h = H.qsDeep('#main header span[title]')
              || H.qsDeep('[data-testid="conversation-header"] span[title]')
              || H.qsDeep('#main header [dir="auto"]');
            if (!h) return "";
            return ((h.getAttribute && h.getAttribute("title")) || h.textContent || "").trim();
          }
          function headerMatches() {
            const label = readHeader().toLowerCase();
            if (!label) return false;
            return label === chosenTitleLower || label.includes(targetLower) || chosenTitleLower.includes(label);
          }
          function awaitHeader(cb) {
            if (headerMatches()) { cb(true); return; }
            if (Date.now() >= headerDeadline) { cb(false); return; }
            setTimeout(function () { awaitHeader(cb); }, 150);
          }
          awaitHeader(function (ok) {
            if (!ok) {
              resolve({ success: false, error: "Header chat non corrisponde al destinatario \"" + target + "\" (header=\"" + readHeader() + "\"). Invio bloccato." });
              return;
            }
            proceedCompose();
          });

          function proceedCompose() {
          const composer = tryPlan("composer") ||
            H.qsDeep('footer [contenteditable="true"]') ||
            H.qsDeep('[data-testid="conversation-compose-box-input"]') ||
            H.qsDeep('[data-testid="compose-box-input"]');
          if (!composer) { resolve({ success: false, error: "Composer not found", needsRemap: true }); return; }
          H.modernClearAndType(composer, messageText);
          // Poll for an enabled send button (WA enables it only after the editor registers the input)
          const findSendBtn = function () {
            return tryPlan("send_button") ||
              H.qsDeep('[data-testid="send"]') ||
              H.qsDeep('button[aria-label*="send" i]') ||
              H.qsDeep('button[aria-label*="invia" i]') ||
              (H.qsDeep('span[data-icon="send"]') && H.qsDeep('span[data-icon="send"]').closest('button'));
          };
          let attempts = 0;
          const maxAttempts = 30; // ~3s
          const tick = function () {
            attempts++;
            const btn = findSendBtn();
            const enabled = btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
            if (enabled) {
              btn.click();
              resolve({ success: true, sent: true, method: plan ? "search+plan" : "search" });
              return;
            }
            if (attempts >= maxAttempts) {
              // Fallback: Enter key on composer (WA submits on Enter when textarea-mode)
              try {
                const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true });
                composer.dispatchEvent(ev);
                composer.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
                composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
              } catch (e) { /* ignore */ }
              if (btn) {
                try { btn.click(); } catch (e) {}
                resolve({ success: true, sent: true, method: "click-after-enter" });
              } else {
                resolve({ success: false, error: "Send button not found/enabled after type", needsRemap: true });
              }
              return;
            }
            setTimeout(tick, 100);
          };
          tick();
          }
        }, 1500);
      }, 1500);
    });
  }

  async function sendWhatsAppMessage(phone, text) {
    try {
      // Determine if input is a phone number or contact name
      var cleanPhone = String(phone || "").replace(/[^0-9+]/g, "");
      var isPhoneNumber = cleanPhone.length >= 7;

      var existingTabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });

      if (existingTabs.length > 0) {
        var tabId = existingTabs[0].id;
        if (existingTabs[0].status !== "complete") await TabManager.waitForLoad(tabId, 10000);
        await TabManager.ensureTabVisibleAndWait(tabId, 1200);
        await ensurePageHelpers(tabId);

        // ── HARD GUARD: se è un numero, navighiamo SEMPRE all'URL /send?phone=
        // dell'estensione richiesto. Mai riusare la chat aperta in WA — il
        // search-based send finirebbe per scrivere nella conversazione attiva
        // se la sidebar non aggiorna in tempo.
        if (isPhoneNumber) {
          var numericPhoneFirst = cleanPhone.replace(/^\+/, "");
          var sendUrlFirst = Config.WA_BASE + "/send?phone=" + numericPhoneFirst + "&text=" + encodeURIComponent(text);
          await chrome.tabs.update(tabId, { url: sendUrlFirst });
          await TabManager.waitForLoad(tabId, 15000);
          await TabManager.sleep(3000);
          await ensurePageHelpers(tabId);
          var urlResultsFirst = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            args: [text],
            func: _pageSendUrlFallback,
          });
          return urlResultsFirst && urlResultsFirst[0] ? urlResultsFirst[0].result : { success: false, error: "URL send failed" };
        }

        // Load cached AI plan (if any) — robust against WA DOM changes
        var cachedPlan = null;
        try {
          var st = await chrome.storage.local.get("wa_send_plan");
          if (st && st.wa_send_plan && st.wa_send_plan.plan) cachedPlan = st.wa_send_plan.plan;
        } catch (e) { /* ignore */ }

        // Non è un numero: cerchiamo il contatto per nome nella sidebar.
        var results = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          args: [phone, text, cachedPlan],
          func: _pageSendWhatsApp,
        });
        var result = results && results[0] ? results[0].result : null;
        return result || { success: false, error: "Nessun risultato" };
      }

      // No existing WA tab — create one with send URL if phone number
      if (isPhoneNumber) {
        var numericPhone2 = cleanPhone.replace(/^\+/, "");
        var url = Config.WA_BASE + "/send?phone=" + numericPhone2 + "&text=" + encodeURIComponent(text);
        var tab = await TabManager.safeCreateTab(url, false);
        var loaded = await TabManager.waitForLoad(tab.id, 30000);
        if (!loaded) { await TabManager.safeRemoveTab(tab.id); return { success: false, error: "WA non caricato" }; }
        await TabManager.sleep(4000);
        await ensurePageHelpers(tab.id);
        var results2 = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [text],
          func: _pageSendUrlFallback,
        });
        return results2 && results2[0] ? results2[0].result : { success: false, error: "Nessun risultato" };
      }

      // Not a phone number and no existing tab — can't search
      return { success: false, error: "Nessuna tab WhatsApp aperta e il contatto non è un numero di telefono" };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════
  // BACKFILL CHAT — injected page functions
  // ══════════════════════════════════════════════
  async function _pageOpenChatForBackfill(target) {
    const H = window.__waH;

    function currentChatMatches(name) {
      const header = H.qsDeep('#main header span[title]') || H.qsDeep('#main header [dir="auto"]') || H.qsDeep('[data-testid="conversation-header"] span[title]');
      const label = header ? ((header.getAttribute("title") || header.textContent || "").trim()) : "";
      return !!label && label.toLowerCase().includes(name.toLowerCase());
    }

    if (currentChatMatches(target)) return { success: true };

    const searchBox =
      H.qsDeep('[data-testid="chat-list-search-container"] [contenteditable="true"]') ||
      H.qsDeep('[data-testid="chat-list-search"] [contenteditable="true"]') ||
      H.qsDeep('[data-testid="chat-list-search-container"]') ||
      H.qsDeep('[data-testid="chat-list-search"]') ||
      H.qsDeep('div[contenteditable="true"][data-tab="3"]') ||
      H.qsDeep('div[contenteditable="true"][role="textbox"]') ||
      H.qsDeep('[title*="earch" i]') || H.qsDeep('[title*="erca" i]') ||
      H.qsDeep('[aria-label*="search" i]') || H.qsDeep('[aria-label*="cerca" i]');
    if (!searchBox) return { success: false, error: "Search box not found" };

    H.modernClearAndType(searchBox, target);
    await new Promise(function(r) { setTimeout(r, 1500); });

    const chats = H.qsaDeep('[data-testid="cell-frame-container"],[data-testid="chat-cell-wrapper"],[role="listitem"],[role="row"]');
    let clicked = false;
    for (const c of chats) {
      const titleEl = c.querySelector('span[title]');
      const title = titleEl ? (titleEl.getAttribute("title") || "") : "";
      if (title.toLowerCase().includes(target.toLowerCase())) {
        (c.closest('[data-testid="cell-frame-container"]') || c.closest('[data-testid="chat-cell-wrapper"]') || c).click();
        clicked = true; break;
      }
    }
    const clearBtn = H.qsDeep('[data-testid="search-input-clear"]') || H.qsDeep('[data-testid="x-alt"]') || H.qsDeep('[data-testid="search-close"]');
    if (clearBtn) clearBtn.click();
    if (!clicked) return { success: false, error: "Chat non trovata: " + target };
    await new Promise(function(r) { setTimeout(r, 2000); });
    return { success: true };
  }

  function _pageScrollAndRead(contact, lastText) {
    const H = window.__waH;
    const panel = H.qsDeep('[data-testid="conversation-panel-messages"]') || H.qsDeep('#main [role="application"]') || H.qsDeep("#main");
    if (!panel) return { success: false, error: "Panel not found" };
    const scrollContainer = panel.closest('[data-testid="conversation-panel-body"]') || panel.parentElement;
    if (scrollContainer) scrollContainer.scrollTop = 0;

    let msgEls = H.qsaDeep('[data-testid="msg-container"]');
    if (!msgEls.length) msgEls = H.qsaDeep('[role="row"][data-id]');
    const msgs = [];
    let hitLast = false;
    for (const el of msgEls) {
      const isOut = !!(el.querySelector('[data-testid="msg-dblcheck"]') || el.querySelector('[data-testid="msg-check"]'));
      const textEl = el.querySelector('[data-testid="balloon-text"] span') || el.querySelector('.selectable-text span') || el.querySelector('[dir="ltr"]');
      const text = textEl?.textContent?.trim() || "";
      if (!text) continue;
      if (lastText && text === lastText) { hitLast = true; break; }
      const timeEl = el.querySelector('[data-testid="msg-meta"] span') || el.querySelector('time');
      msgs.push({ direction: isOut ? "outbound" : "inbound", text: text, timestamp: timeEl?.textContent?.trim() || "", contact: isOut ? "me" : contact });
    }
    return { success: true, messages: msgs, foundLast: hitLast, totalInDom: msgEls.length };
  }

  // Page-only scroller: scrolls the panel up and signals if reached top
  function _pageScrollUpOnly() {
    const H = window.__waH;
    const panel = H.qsDeep('[data-testid="conversation-panel-messages"]') || H.qsDeep('#main [role="application"]') || H.qsDeep("#main");
    if (!panel) return { success: false, error: "Panel not found" };
    const scrollContainer = panel.closest('[data-testid="conversation-panel-body"]') || panel.parentElement;
    if (!scrollContainer) return { success: false, error: "Scroll container not found" };
    const before = scrollContainer.scrollTop;
    scrollContainer.scrollTop = 0;
    const after = scrollContainer.scrollTop;
    return { success: true, scrollBefore: before, scrollAfter: after, reachedTop: after === 0 && before === 0 };
  }

  async function backfillChat(contactName, lastKnownText, maxScrolls) {
    const MAX_SCROLLS = maxScrolls || 30;
    try {
      const r = await TabManager.getOrCreateWaTab();
      await TabManager.ensureTabVisibleAndWait(r.tab.id, 1200);
      await TabManager.sleep(r.reused ? 1500 : 5000);
      await ensurePageHelpers(r.tab.id);

      // 1. Open the target chat
      const openResult = await chrome.scripting.executeScript({
        target: { tabId: r.tab.id },
        args: [contactName],
        func: _pageOpenChatForBackfill,
      });
      const openRes = openResult && openResult[0] ? openResult[0].result : null;
      if (!openRes || !openRes.success) return openRes || { success: false, error: "Open failed" };

      const panelSelector = '[data-testid="conversation-panel-messages"], #main [role="application"], #main';
      const allMessages = [];
      const seen = new Set();
      const scrollDelays = [1, 2, 1.5, 3, 1, 2.5, 2, 1, 3, 1.5];
      let foundLast = false;
      let scrollIdx = 0;
      let optimusUnavailable = false;
      let plan = null;
      let cached = false;
      let planVersion = 0;
      let confidence = 0;

      // 2. Get an Optimus plan ONCE before the loop
      const initialSnap = await Optimus.snapshotPage(r.tab.id, panelSelector, 6, 3000);
      if (initialSnap && initialSnap.ok) {
        const planRes = await Optimus.getPlan({
          channel: "whatsapp",
          pageType: "thread",
          snapshot: initialSnap.snapshot,
          hash: initialSnap.hash,
          previousPlanFailed: false,
          failureContext: null,
        });
        if (planRes && planRes.success) {
          plan = planRes.plan || planRes;
          cached = !!planRes.cached;
          planVersion = planRes.plan_version || 0;
          confidence = planRes.confidence || 0;
        } else {
          optimusUnavailable = true;
        }
      } else {
        optimusUnavailable = true;
      }

      function pushUnique(msg) {
        // F3 — include sender/direction in dedup key to avoid collisions
        const key = (msg.sender || msg.direction || "?") + "|" + (msg.text || "") + "|" + (msg.timestamp || "");
        if (seen.has(key)) return false;
        seen.add(key);
        if (lastKnownText && msg.text === lastKnownText) return "stop";
        allMessages.push(msg);
        return true;
      }

      // 3. Loop: extract → scroll → extract
      for (scrollIdx = 0; scrollIdx < MAX_SCROLLS && !foundLast; scrollIdx++) {
        if (plan && !optimusUnavailable) {
          // Optimus extraction with cached plan
          let exec = await Optimus.executePlanInTab(r.tab.id, panelSelector, plan);
          let items = (exec && exec.items) || [];

          // Retry once with fresh plan if cache returned 0
          if (items.length === 0 && cached) {
            const freshSnap = await Optimus.snapshotPage(r.tab.id, panelSelector, 6, 3000);
            if (freshSnap && freshSnap.ok) {
              const freshRes = await Optimus.getPlan({
                channel: "whatsapp",
                pageType: "thread",
                snapshot: freshSnap.snapshot,
                hash: freshSnap.hash,
                previousPlanFailed: true,
                failureContext: "Cached plan returned 0 messages during backfill scroll " + scrollIdx + " for " + contactName,
              });
              if (freshRes && freshRes.success) {
                plan = freshRes.plan || freshRes;
                cached = !!freshRes.cached;
                planVersion = freshRes.plan_version || 0;
                confidence = freshRes.confidence || 0;
                exec = await Optimus.executePlanInTab(r.tab.id, panelSelector, plan);
                items = (exec && exec.items) || [];
              }
            }
            if (items.length === 0) break; // DOM no longer recognized
          }

          const mapped = mapOptimusThreadItems(items, contactName);
          for (const m of mapped) {
            const r2 = pushUnique(m);
            if (r2 === "stop") { foundLast = true; break; }
          }
        } else {
          // Legacy fallback: scroll-and-read with hardcoded selectors
          const scrollResult = await chrome.scripting.executeScript({
            target: { tabId: r.tab.id },
            args: [contactName, lastKnownText || ""],
            func: _pageScrollAndRead,
          });
          const res = scrollResult && scrollResult[0] ? scrollResult[0].result : null;
          if (!res || !res.success) break;
          if (res.messages) {
            for (const m of res.messages) {
              const r2 = pushUnique(m);
              if (r2 === "stop") { foundLast = true; break; }
            }
          }
          if (res.foundLast) { foundLast = true; break; }
        }

        if (foundLast) break;

        // 4. Scroll up to load older messages
        if (plan && !optimusUnavailable) {
          const scrollRes = await chrome.scripting.executeScript({
            target: { tabId: r.tab.id },
            func: _pageScrollUpOnly,
          });
          const sr = scrollRes && scrollRes[0] ? scrollRes[0].result : null;
          if (sr && sr.reachedTop) break;
        }
        await TabManager.sleep(scrollDelays[scrollIdx % scrollDelays.length] * 1000);
      }

      return {
        success: true,
        messages: allMessages,
        contact: contactName,
        foundLast: foundLast,
        scrollCount: scrollIdx,
        method: optimusUnavailable ? "legacy-dom" : (cached ? "optimus-cache" : "optimus-ai"),
        optimus: optimusUnavailable ? null : {
          cached: cached,
          planVersion: planVersion,
          confidence: confidence,
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════
  // DIAGNOSTIC
  // ══════════════════════════════════════════════
  async function diagnostic() {
    try {
      const r = await TabManager.getOrCreateWaTab();
      await TabManager.sleep(r.reused ? 1000 : 4000);
      let result = await Discovery.runDiscoveryScript(r.tab.id);
      const shouldHydrate = !r.tab.active && (!result || (!result.hasQR && !Discovery.hasRenderableWaUi(result) && (Discovery.hasShellSignals(result) || result.appLoaded)));
      if (shouldHydrate) {
        result = await TabManager.withTemporarilyVisibleTab(r.tab.id, async function () {
          return await Discovery.waitForRenderableWaUi(r.tab.id, 4, [900, 1400, 2000]);
        }) || result;
      }
      if (result) {
        result.success = true;
        return result;
      }
      return { success: false, error: "no result" };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ══════════════════════════════════════════════
  // REMAP SEND DOM — Manuale: AI rilegge il DOM e salva
  // selettori freschi per search_box / chat_item / composer / send_button / chat_header.
  // Nessun auto-retry: solo su click esplicito dell'operatore.
  // ══════════════════════════════════════════════
  async function remapSendDom() {
    try {
      const r = await TabManager.getOrCreateWaTab();
      await TabManager.ensureTabVisibleAndWait(r.tab.id, 1500);
      await TabManager.sleep(r.reused ? 800 : 3000);

      // 1) Snapshot della sidebar
      const snap = await Optimus.snapshotPage(r.tab.id, "#pane-side", 8, 8000);
      if (!snap || !snap.ok) return { success: false, error: "snapshot failed: " + (snap && snap.error || "unknown") };

      // 2) Chiedi piano a optimus-analyze (page_type send_form)
      const planRes = await Optimus.getPlan({
        channel: "whatsapp",
        pageType: "send_form",
        snapshot: snap.snapshot,
        hash: snap.hash,
        previousPlanFailed: true,
        failureContext: "manual remap requested by operator",
      });
      if (!planRes || planRes.success === false) {
        return { success: false, error: "optimus failed: " + (planRes && (planRes.error || planRes.code) || "unknown") };
      }
      const plan = planRes.plan || planRes.data && planRes.data.plan || planRes;
      const sels = plan && plan.selectors;
      if (!sels || typeof sels !== "object") return { success: false, error: "plan has no selectors", rawPlan: plan };

      // 3) Validazione: i 3 campi obbligatori devono esserci
      const required = ["search_box", "composer", "send_button"];
      const missing = [];
      for (const k of required) {
        if (!sels[k] || !sels[k].primary) missing.push(k);
      }
      if (missing.length > 0) {
        return { success: false, error: "missing required selectors: " + missing.join(", "), plan: plan };
      }

      const fields = {};
      ["search_box", "chat_item", "chat_header", "composer", "send_button"].forEach(function (k) {
        if (sels[k]) fields[k] = { primary: sels[k].primary || null, fallback: sels[k].fallback || null, confidence: sels[k].confidence || null };
      });

      // 4) Salva nel chrome.storage
      const savedAt = Date.now();
      await chrome.storage.local.set({
        wa_send_plan: {
          plan: { selectors: fields },
          savedAt: savedAt,
          domHash: snap.hash,
          planVersion: planRes.plan_version || null,
          confidence: planRes.confidence || null,
        },
      });

      return {
        success: true,
        savedAt: savedAt,
        domHash: snap.hash,
        fields: fields,
        planVersion: planRes.plan_version || null,
        cached: planRes.cached || false,
        aiLatencyMs: planRes.ai_latency_ms || null,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return {
    verifySession: verifySession,
    readUnreadMessages: readUnreadMessages,
    sendWhatsAppMessage: sendWhatsAppMessage,
    readThread: readThread,
    backfillChat: backfillChat,
    diagnostic: diagnostic,
    remapSendDom: remapSendDom,
  };
})();
globalThis.Actions = Actions;
