// ═════════════════════════════════════════════════════════════
// interact-keyboard.js — KEYBOARD & TYPING TOOLS
// Extracted from server.js cases: type_human, press_key, key_combo, clipboard_write
// ═════════════════════════════════════════════════════════════

module.exports = function createInteractKeyboardTools(deps) {
  const {
    log, session, wsBroadcast, emitThinking,
    isBridgeReady, bridgeCommand, takeActiveScreenshot,
    _getActivePage
  } = deps;

  async function toolTypeHuman(args) {
    emitThinking(`Digito "${(args.text || '').substring(0, 20)}..."...`);
    if (isBridgeReady()) {
      const result = await bridgeCommand('type_human', { text: args.text, selector: args.selector || null, delay: args.delay || 80 });
      return JSON.stringify({ ...result, via: 'bridge' });
    }
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try {
      if (args.selector) await _activePage.focus(args.selector);
      await _activePage.keyboard.type(args.text, { delay: args.delay || 80 });
      return JSON.stringify({ ok: true, typed: args.text.length, method: 'puppeteer' });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  }

  async function toolPressKey(args) {
    // ── BRIDGE PATH ──
    if (isBridgeReady()) {
      try {
        const result = await bridgeCommand('press_key', { key: args.key, repeat: args.repeat || 1 });
        if (result.ok) return JSON.stringify({ ok: true, key: args.key, via: 'bridge' });
      } catch (e) {
        log(`[Bridge] press_key failed: ${e.message}`);
      }
    }
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try {
      if (args.selector) {
        await _activePage.focus(args.selector);
      }
      await _activePage.keyboard.press(args.key);
      await new Promise(r => setTimeout(r, 300));
      await takeActiveScreenshot(session.lastPage?.url, session.lastPage?.title);
      return JSON.stringify({ ok: true, key: args.key, target: args.selector || 'active element' });
    } catch (e) {
      return JSON.stringify({ error: `Key press failed: ${e.message}` });
    }
  }

  async function toolKeyCombo(args) {
    emitThinking(`Combo "${args.combo}"...`);
    if (isBridgeReady()) {
      const result = await bridgeCommand('key_combo', { combo: args.combo });
      return JSON.stringify({ ...result, via: 'bridge' });
    }
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try {
      const parts = args.combo.split('+').map(s => s.trim());
      for (let i = 0; i < parts.length - 1; i++) await _activePage.keyboard.down(parts[i]);
      await _activePage.keyboard.press(parts[parts.length - 1]);
      for (let i = parts.length - 2; i >= 0; i--) await _activePage.keyboard.up(parts[i]);
      return JSON.stringify({ ok: true, combo: args.combo });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  }

  async function toolClipboardWrite(args) {
    if (isBridgeReady()) {
      const result = await bridgeCommand('clipboard_write', { text: args.text });
      return JSON.stringify(result);
    }
    const _activePage = _getActivePage();
    if (_activePage) {
      try {
        await _activePage.evaluate((t) => navigator.clipboard.writeText(t), args.text);
        return JSON.stringify({ ok: true });
      } catch { return JSON.stringify({ ok: true, note: 'clipboard may not be available in headless' }); }
    }
    return JSON.stringify({ ok: true });
  }

  return {
    toolTypeHuman,
    toolPressKey,
    toolKeyCombo,
    toolClipboardWrite
  };
};
