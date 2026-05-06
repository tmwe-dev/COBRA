// ═════════════════════════════════════════════════════════════
// interact-select.js — DROPDOWN & DATE PICKER TOOLS
// Extracted from server.js cases: select_option, select_dropdown, set_datepicker
// ═════════════════════════════════════════════════════════════

module.exports = function createInteractSelectTools(deps) {
  const {
    log, session, wsBroadcast, emitThinking,
    isBridgeReady, bridgeCommand, dismissModals, dismissModalsBridge,
    takeActiveScreenshot, _getActivePage
  } = deps;

  async function toolSelectOption(args) {
    emitThinking(`Seleziono "${args.value}" in "${args.selector}"...`);

    // ── BRIDGE: 3 metodi ──
    if (isBridgeReady()) {
      await dismissModalsBridge();
      // METODO 1: bridge select_dropdown
      try {
        const result = await bridgeCommand('select_dropdown', { selector: args.selector, value: args.value, searchable: true });
        if (result.ok) {
          try { const ss = await bridgeCommand('screenshot', { quality: 70 }); if (ss.ok && ss.screenshot) wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: session.lastPage?.url || '' }); } catch (e) { /* silent */ }
          return JSON.stringify({ ok: true, selected: result.selected || args.value, selector: args.selector, via: 'bridge_select' });
        }
        log('[select_option] bridge select_dropdown failed, trying JS fallback');
      } catch (e) { log(`[select_option] bridge error: ${e.message}`); }

      // METODO 2: JS nativeSetter
      try {
        const safeSel = args.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const safeVal = String(args.value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const jsCode = `(function(){
          var el = document.querySelector('${safeSel}');
          if (!el) return {ok:false, error:'not_found'};
          if (el.tagName === 'SELECT') {
            var opts = Array.from(el.options);
            var match = opts.find(function(o){ return o.value === '${safeVal}' || o.textContent.trim().toLowerCase().includes('${safeVal}'.toLowerCase()); });
            if (match) { el.value = match.value; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); return {ok:true, selected:match.textContent.trim(), method:'js_select'}; }
            return {ok:false, error:'option_not_found', available:opts.slice(0,10).map(function(o){return o.textContent.trim();})};
          }
          el.click(); el.focus();
          return {ok:false, error:'custom_dropdown', hint:'opened'};
        })()`;
        const jsResult = await bridgeCommand('execute_js', { code: jsCode });
        if (jsResult.ok && jsResult.result?.ok) {
          try { const ss = await bridgeCommand('screenshot', { quality: 70 }); if (ss.ok && ss.screenshot) wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: session.lastPage?.url || '' }); } catch (e) { /* silent */ }
          return JSON.stringify({ ok: true, selected: jsResult.result.selected, selector: args.selector, via: 'bridge_js_select' });
        }

        // Custom dropdown aperto: cerca e clicca opzione
        if (jsResult.result?.hint === 'opened') {
          await new Promise(r => setTimeout(r, 400));
          const clickCode = `(function(){
            var lower = '${safeVal}'.toLowerCase();
            var candidates = document.querySelectorAll('[role="option"], [role="listbox"] > *, li[data-value], [class*="option"], [class*="item"], li, div[tabindex]');
            for (var i=0; i<candidates.length; i++) {
              var t = candidates[i].textContent.trim();
              if (t.toLowerCase().includes(lower) && candidates[i].offsetParent !== null) { candidates[i].click(); return {ok:true, selected:t}; }
            }
            return {ok:false, error:'option_not_visible'};
          })()`;
          const clickResult = await bridgeCommand('execute_js', { code: clickCode });
          if (clickResult.ok && clickResult.result?.ok) {
            try { const ss = await bridgeCommand('screenshot', { quality: 70 }); if (ss.ok && ss.screenshot) wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: session.lastPage?.url || '' }); } catch (e) { /* silent */ }
            return JSON.stringify({ ok: true, selected: clickResult.result.selected, selector: args.selector, via: 'bridge_custom_click' });
          }
        }
        if (jsResult.result?.available) {
          return JSON.stringify({ ok: false, error: `Opzione "${args.value}" non trovata`, available_options: jsResult.result.available });
        }
      } catch (e) { log(`[select_option] JS fallback error: ${e.message}`); }
    }

    // ── PUPPETEER fallback ──
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try { await dismissModals(_activePage); } catch (e) { /* silent */ }
    try {
      let selected = await _activePage.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const byValue = [...el.options].find(o => o.value === val);
        if (byValue) { el.value = byValue.value; el.dispatchEvent(new Event('change', { bubbles: true })); return byValue.text; }
        const byText = [...el.options].find(o => o.text.toLowerCase().includes(val.toLowerCase()));
        if (byText) { el.value = byText.value; el.dispatchEvent(new Event('change', { bubbles: true })); return byText.text; }
        return null;
      }, args.selector, args.value);
      if (selected === null) {
        await _activePage.click(args.selector);
        await new Promise(r => setTimeout(r, 500));
        const optClicked = await _activePage.evaluate((val) => {
          for (const el of document.querySelectorAll('li, div[role="option"], [class*="option"], [class*="item"]')) {
            if ((el.textContent || '').trim().toLowerCase().includes(val.toLowerCase()) && el.offsetParent !== null) { el.click(); return el.textContent.trim(); }
          }
          return null;
        }, args.value);
        if (optClicked) selected = optClicked;
      }
      await new Promise(r => setTimeout(r, 300));
      await takeActiveScreenshot(session.lastPage?.url, session.lastPage?.title);
      if (selected) return JSON.stringify({ ok: true, selected, selector: args.selector });
      return JSON.stringify({ ok: false, error: `Opzione "${args.value}" non trovata in "${args.selector}"` });
    } catch (e) { return JSON.stringify({ error: `Select failed: ${e.message}` }); }
  }

  async function toolSelectDropdown(args) {
    emitThinking(`Seleziono "${args.value}" da dropdown...`);
    if (isBridgeReady()) {
      const result = await bridgeCommand('select_dropdown', { selector: args.selector, value: args.value, searchable: args.searchable });
      const ss = await bridgeCommand('screenshot', { quality: 70 });
      if (ss.ok) wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: session.lastPage?.url || '', title: session.lastPage?.title || '' });
      return JSON.stringify({ ...result, via: 'bridge' });
    }
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try {
      await _activePage.select(args.selector, args.value);
      return JSON.stringify({ ok: true, selected: args.value, method: 'puppeteer' });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  }

  async function toolSetDatepicker(args) {
    emitThinking(`Imposto data "${args.value}"...`);
    if (isBridgeReady()) {
      const result = await bridgeCommand('set_datepicker', { selector: args.selector, value: args.value });
      return JSON.stringify({ ...result, via: 'bridge' });
    }
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try {
      await _activePage.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, args.selector, args.value);
      return JSON.stringify({ ok: true, value: args.value });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  }

  return {
    toolSelectOption,
    toolSelectDropdown,
    toolSetDatepicker
  };
};
