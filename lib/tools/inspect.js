// lib/tools/inspect.js — JavaScript execution (read-only and mutative)
module.exports = function createInspectTools(deps) {
  const { bridgeReady, bridgeCommand, activePage, log, emitThinking } = deps;

  async function toolInspectDomJs(args) {
    emitThinking('Reading DOM...');
    const code = (args.code || '').toLowerCase();
    const MUTATIVE_PATTERNS = /\.value\s*=|\.innerhtml\s*=|\.textcontent\s*=|\.click\(\)|\.submit\(\)|fetch|storage|\.send\(/i;
    if (MUTATIVE_PATTERNS.test(code)) {
      return JSON.stringify({ error: 'inspect_dom_js is read-only. Use mutate_dom_js for modifications.' });
    }
    if (bridgeReady()) {
      try {
        const result = await bridgeCommand('execute_js', { code: args.code });
        if (result.ok) return JSON.stringify({ ok: true, result: String(result.result).substring(0, 5000), via: 'bridge' });
      } catch (e) { /* fallback */ }
    }
    if (!activePage) return JSON.stringify({ error: 'No active page. Use navigate first.' });
    try {
      const result = await activePage.evaluate(args.code);
      return JSON.stringify({ ok: true, result: String(result).substring(0, 5000) });
    } catch (e) {
      return JSON.stringify({ error: `JS error: ${e.message}` });
    }
  }

  async function toolMutateDomJs(args) {
    emitThinking('Executing mutative JS...');
    if (args.code && /card.?number|cvv|iban|routing.?number/i.test(args.code)) {
      log(`[SECURITY] Blocked payment JS: ${args.code.substring(0, 50)}`);
      return JSON.stringify({ error: 'BLOCKED: Cannot execute JS on payment fields.', security: 'payment_block' });
    }
    if (bridgeReady()) {
      try {
        const result = await bridgeCommand('execute_js', { code: args.code });
        if (result.ok) return JSON.stringify({ ok: true, result: String(result.result).substring(0, 5000), via: 'bridge' });
      } catch (e) { /* fallback */ }
    }
    if (!activePage) return JSON.stringify({ error: 'No active page. Use navigate first.' });
    try {
      const result = await activePage.evaluate(args.code);
      return JSON.stringify({ ok: true, result: String(result).substring(0, 5000) });
    } catch (e) {
      return JSON.stringify({ error: `JS error: ${e.message}` });
    }
  }

  async function toolExecuteJs(args) {
    emitThinking('Executing JS...');
    if (!activePage) return JSON.stringify({ error: 'No active page.' });
    try {
      const result = await activePage.evaluate(args.code);
      return JSON.stringify({ ok: true, result: String(result).substring(0, 5000) });
    } catch (e) {
      return JSON.stringify({ error: `JS error: ${e.message}` });
    }
  }

  return { toolInspectDomJs, toolMutateDomJs, toolExecuteJs };
};
