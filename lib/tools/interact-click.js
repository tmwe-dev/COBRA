// ═════════════════════════════════════════════════════════════
// interact-click.js — CLICK TOOL
// Extracted from interact-click.js: toolClickElement only
// ═════════════════════════════════════════════════════════════

module.exports = function createInteractClickTools(deps) {
  const {
    log, session, wsBroadcast, emitThinking,
    isBridgeReady, bridgeCommand, bridgeClick,
    dismissModals, takeActiveScreenshot, _getActivePage
  } = deps;

  async function toolClickElement(args) {
    emitThinking(`Clicco su "${args.selector}"...`);
    const sel = args.selector || '';

    // ── P1-7: PAYMENT BUTTON BLOCK — legge testo reale dal DOM ──
    {
      const PAYMENT_BUTTONS = /\b(paga ora|pay now|conferma pagamento|confirm payment|completa acquisto|complete purchase|place order|acquista ora|buy now|procedi al pagamento|proceed to payment|finalizza ordine|submit payment|conferma ordine|paga|checkout)\b/i;
      // Check 1: selector string
      let paymentBlocked = PAYMENT_BUTTONS.test(sel);
      // Check 2: testo reale dal DOM (bridge)
      if (!paymentBlocked && isBridgeReady()) {
        try {
          const elInfo = await bridgeCommand('execute_js', { code: `(function(){
            var el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return null;
            return { text: (el.textContent||'').trim().substring(0,100), aria: el.getAttribute('aria-label')||'', value: el.value||'', type: el.type||'', formAction: el.form?.action||'' };
          })()` });
          if (elInfo.ok && elInfo.result) {
            const r = elInfo.result;
            const haystack = `${r.text} ${r.aria} ${r.value} ${r.formAction}`.toLowerCase();
            if (PAYMENT_BUTTONS.test(haystack)) {
              paymentBlocked = true;
              log(`[SECURITY] Payment detected via DOM text: "${r.text}" aria="${r.aria}"`);
            }
          }
        } catch (e) { /* DOM read failed, proceed with selector-only check */ }
      }
      if (paymentBlocked) {
        log(`[SECURITY] BLOCKED payment button click: ${sel}`);
        return JSON.stringify({ error: 'BLOCCATO: Non posso cliccare bottoni di pagamento. Per completare l\'acquisto devi procedere tu.', security: 'payment_block' });
      }
    }

    // ── BRIDGE PATH: click realistico nel browser reale ──
    if (isBridgeReady()) {
      try {
        const result = await bridgeClick(sel);
        if (result.newUrl) session.lastPage = { ...session.lastPage, url: result.newUrl, title: result.newTitle || '' };
        wsBroadcast({ type: 'page_loaded', url: result.newUrl || session.lastPage?.url, title: result.newTitle || '' });
        return JSON.stringify({ ok: true, clicked: sel, newUrl: result.newUrl, newTitle: result.newTitle, via: 'bridge' });
      } catch (e) {
        log(`[Bridge] click failed, fallback to Puppeteer: ${e.message}`);
      }
    }

    // ── PUPPETEER PATH ──
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva. Usa navigate prima.' });
    try { await dismissModals(_activePage); } catch (e) { /* silent */ }
    try {
      let clicked = false;
      if (sel.startsWith('text:')) {
        const searchText = sel.substring(5).trim().toLowerCase();
        clicked = await _activePage.evaluate((txt) => {
          const els = [...document.querySelectorAll('a, button, input[type="submit"], [role="button"], label, span, div[onclick]')];
          for (const el of els) {
            if ((el.textContent || '').trim().toLowerCase().includes(txt) && el.offsetParent !== null) {
              el.click();
              return true;
            }
          }
          return false;
        }, searchText);
      } else {
        await _activePage.click(sel);
        clicked = true;
      }
      if (!clicked) return JSON.stringify({ ok: false, error: `Elemento "${sel}" non trovato sulla pagina` });
      await new Promise(r => setTimeout(r, 2000));
      const newUrl = _activePage.url();
      const newTitle = await _activePage.title();
      session.lastPage = { ...session.lastPage, url: newUrl, title: newTitle };
      await takeActiveScreenshot(newUrl, newTitle);
      wsBroadcast({ type: 'page_loaded', url: newUrl, title: newTitle });
      return JSON.stringify({ ok: true, clicked: sel, newUrl, newTitle });
    } catch (e) {
      return JSON.stringify({ error: `Click failed: ${e.message}` });
    }
  }

  return { toolClickElement };
};
