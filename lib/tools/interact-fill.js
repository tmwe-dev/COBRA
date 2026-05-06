// ═════════════════════════════════════════════════════════════
// interact-fill.js — FORM FILLING TOOL
// Extracted from interact-click.js: toolFillForm only
// ═════════════════════════════════════════════════════════════

module.exports = function createInteractFillTools(deps) {
  const {
    log, session, wsBroadcast, emitThinking,
    isBridgeReady, bridgeCommand, bridgeFillForm,
    dismissModalsBridge, takeActiveScreenshot, _getActivePage
  } = deps;

  async function toolFillForm(args) {
    emitThinking('Compilo il form...');

    // ── PAYMENT FIELD BLOCK — HARDCODED, NON BYPASSABILE ──
    {
      const PAYMENT_SELECTORS = /card.?number|cc.?number|credit.?card|carta.?di.?credito|cvv|cvc|security.?code|expir|scadenza|card.?exp|billing.?card|numero.?carta|iban|routing.?number|account.?number|sort.?code/i;
      let fieldsToCheck;
      try { fieldsToCheck = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields; } catch { fieldsToCheck = {}; }
      const blockedFields = [];
      for (const [selector, value] of Object.entries(fieldsToCheck || {})) {
        if (PAYMENT_SELECTORS.test(selector) || PAYMENT_SELECTORS.test(String(value))) {
          blockedFields.push(selector);
        }
      }
      if (blockedFields.length > 0) {
        log(`[SECURITY] BLOCKED payment field fill attempt: ${blockedFields.join(', ')}`);
        return JSON.stringify({ error: 'BLOCCATO: Non posso compilare campi di pagamento (carta di credito, CVV, IBAN). Per il pagamento devi procedere tu.', blocked_fields: blockedFields, security: 'payment_block' });
      }
    }

    // ── BRIDGE PATH ──
    if (isBridgeReady()) {
      try {
        await dismissModalsBridge();
        let fields;
        try { fields = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields; }
        catch { return JSON.stringify({ error: 'Formato fields non valido.' }); }

        const fieldResults = [];

        // ── METODO 1: nativeSetter + dispatchEvent (Playwright pattern) ──
        log('[fill_form] Trying nativeSetter method (Playwright pattern) for all fields');
        for (const [selector, value] of Object.entries(fields)) {
          try {
            const safeSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const safeValue = String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const jsCode = `(function(){
              var el = document.querySelector('${safeSelector}');
              if (!el) return {ok:false, error:'not_found'};
              el.focus();
              var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
              var nativeSetter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
              if (nativeSetter) nativeSetter.call(el, '${safeValue}');
              else el.value = '${safeValue}';
              el.dispatchEvent(new Event('input', {bubbles:true}));
              el.dispatchEvent(new Event('change', {bubbles:true}));
              el.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, key:'a'}));
              el.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true, key:'a'}));
              el.dispatchEvent(new Event('blur', {bubbles:true}));
              return {ok:true, value:el.value};
            })()`;
            const jsResult = await bridgeCommand('execute_js', { code: jsCode });
            const innerOk = jsResult.ok && (jsResult.result?.ok !== false);
            fieldResults.push({ selector, ok: innerOk, value, via: 'nativeSetter' });
            if (innerOk) log(`[fill_form] nativeSetter OK: ${selector}`);
          } catch (e) {
            fieldResults.push({ selector, ok: false, value, error: e.message, via: 'nativeSetter' });
          }
        }

        // ── METODO 2: click + type_human per campi falliti ──
        const failed1 = fieldResults.filter(r => !r.ok);
        if (failed1.length > 0) {
          log(`[fill_form] ${failed1.length} fields failed nativeSetter, trying click+type_human`);
          for (const ff of failed1) {
            try {
              await bridgeCommand('click', { selector: ff.selector });
              await new Promise(r => setTimeout(r, 200));
              await bridgeCommand('key_combo', { keys: ['Control', 'a'] });
              await new Promise(r => setTimeout(r, 100));
              const typeResult = await bridgeCommand('type_human', { text: String(ff.value), selector: ff.selector, delay: 50 });
              if (typeResult.ok) { ff.ok = true; ff.via = 'type_human'; log(`[fill_form] type_human OK: ${ff.selector}`); }
            } catch (e) {
              log(`[fill_form] type_human failed: ${ff.selector}: ${e.message}`);
            }
          }
        }

        // ── METODO 3: bridge fill_form nativo per campi ancora falliti ──
        const failed2 = fieldResults.filter(r => !r.ok);
        if (failed2.length > 0) {
          log(`[fill_form] ${failed2.length} fields still failed, trying bridge native fill`);
          const retryFields = {};
          for (const ff of failed2) retryFields[ff.selector] = ff.value;
          try {
            const nativeResult = await bridgeFillForm(retryFields);
            if (nativeResult.ok) {
              for (const ff of failed2) { ff.ok = true; ff.via = 'bridge_native'; }
            }
          } catch (e) { /* silent */ }
        }

        // ── Screenshot + risultato ──
        try {
          const ssResult = await bridgeCommand('screenshot', { quality: 70 });
          if (ssResult.ok && ssResult.screenshot) {
            wsBroadcast({ type: 'screenshot', data: ssResult.screenshot, url: session.lastPage?.url || '', title: session.lastPage?.title || '' });
          }
        } catch (e) { /* silent */ }

        const allOk = fieldResults.every(r => r.ok);
        if (!allOk) {
          try {
            const interactiveResult = await bridgeCommand('get_interactive', {});
            if (interactiveResult.ok && interactiveResult.elements) {
              const inputFields = interactiveResult.elements
                .filter(el => ['input', 'select', 'textarea'].includes(el.tag) && !el.disabled)
                .slice(0, 15)
                .map(el => ({
                  selector: el.selector || (el.id ? '#' + el.id : el.name ? `[name="${el.name}"]` : el.tag),
                  type: el.type, placeholder: el.placeholder, label: el.ariaLabel || el.text
                }));
              return JSON.stringify({ ok: false, results: fieldResults, via: 'fill_form_3methods',
                hint: 'Alcuni campi non compilati. Ecco i campi REALI della pagina — usa QUESTI selettori:',
                available_fields: inputFields });
            }
          } catch (e) { /* silent */ }
        }
        return JSON.stringify({ ok: allOk, results: fieldResults, via: 'fill_form_3methods' });
      } catch (e) {
        log(`[Bridge] fill_form all paths failed, fallback to Puppeteer: ${e.message}`);
      }
    }

    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva e bridge non disponibile. Usa navigate prima.' });
    try { await dismissModals(_activePage); } catch (e) { /* silent */ }
    let fields;
    try { fields = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields; }
    catch { return JSON.stringify({ error: 'Formato fields non valido. Usa JSON: {"selector": "valore"}' }); }
    const results = [];
    for (const [selector, value] of Object.entries(fields)) {
      try {
        const fieldInfo = await _activePage.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          const editable = el.getAttribute('contenteditable');
          const ariaExpanded = el.getAttribute('aria-expanded');
          return {
            tag, role, editable,
            type: el.type || '',
            isInput: tag === 'input',
            isSelect: tag === 'select',
            isTextarea: tag === 'textarea',
            isCustom: role === 'searchbox' || role === 'combobox' || role === 'textbox' || editable === 'true',
            hasAutocomplete: ariaExpanded !== null || el.getAttribute('aria-autocomplete') !== null,
          };
        }, selector);

        if (!fieldInfo) {
          results.push({ selector, ok: false, error: 'Elemento non trovato' });
          continue;
        }

        if (fieldInfo.isSelect) {
          await _activePage.select(selector, value);
        } else if (fieldInfo.type === 'checkbox' || fieldInfo.type === 'radio') {
          if (value === 'true' || value === true) await _activePage.click(selector);
        } else if (fieldInfo.isCustom || fieldInfo.hasAutocomplete) {
          await _activePage.click(selector);
          await new Promise(r => setTimeout(r, 300));
          await _activePage.keyboard.down('Control');
          await _activePage.keyboard.press('a');
          await _activePage.keyboard.up('Control');
          await _activePage.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 200));
          await _activePage.type(selector, value, { delay: 80 });
          await new Promise(r => setTimeout(r, 1500));
          const picked = await _activePage.evaluate((sel) => {
            const lists = document.querySelectorAll('[role="listbox"] [role="option"], [class*="autocomplete"] li, [class*="dropdown"] li, [class*="suggestion"] li, [class*="result"] li, ul[role="listbox"] li');
            for (const opt of lists) {
              if (opt.offsetParent !== null) {
                opt.click();
                return opt.textContent.trim().substring(0, 60);
              }
            }
            return null;
          });
          if (!picked) {
            await _activePage.keyboard.press('ArrowDown');
            await new Promise(r => setTimeout(r, 300));
            await _activePage.keyboard.press('Enter');
          }
          await new Promise(r => setTimeout(r, 500));
          results.push({ selector, ok: true, value, picked: picked || 'enter', method: 'autocomplete' });
          continue;
        } else {
          await _activePage.click(selector, { clickCount: 3 });
          await _activePage.type(selector, value, { delay: 30 });
        }
        results.push({ selector, ok: true, value });
      } catch (e) {
        try {
          await _activePage.evaluate((sel, val) => {
            const el = document.querySelector(sel);
            if (!el) return;
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
              || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, selector, value);
          results.push({ selector, ok: true, value, method: 'js_fallback' });
        } catch (e2) {
          results.push({ selector, ok: false, error: e.message, fallback_error: e2.message });
        }
      }
    }
    await takeActiveScreenshot(session.lastPage?.url, session.lastPage?.title);
    const filled = results.filter(r => r.ok).length;
    return JSON.stringify({ ok: true, filled, total: results.length, results });
  }

  return {
    toolFillForm
  };
};
