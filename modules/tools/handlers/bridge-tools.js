// modules/tools/handlers/bridge-tools.js — Bridge v2.0 tools with Puppeteer fallback
// Source: server.js lines 6694-6870

async function typeHuman(args, ctx) {
  ctx.emitThinking(`Digito "${(args.text || '').substring(0, 20)}..."...`);
  if (ctx.isBridgeReady()) { const r = await ctx.bridgeCommand('type_human', { text: args.text, selector: args.selector || null, delay: args.delay || 80 }); return JSON.stringify({ ...r, via: 'bridge' }); }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try { if (args.selector) await ap.focus(args.selector); await ap.keyboard.type(args.text, { delay: args.delay || 80 }); return JSON.stringify({ ok: true, typed: args.text.length, method: 'puppeteer' }); }
  catch (e) { return JSON.stringify({ error: e.message }); }
}

async function keyCombo(args, ctx) {
  ctx.emitThinking(`Combo "${args.combo}"...`);
  if (ctx.isBridgeReady()) { const r = await ctx.bridgeCommand('key_combo', { combo: args.combo }); return JSON.stringify({ ...r, via: 'bridge' }); }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try {
    const parts = args.combo.split('+').map(s => s.trim());
    for (let i = 0; i < parts.length - 1; i++) await ap.keyboard.down(parts[i]);
    await ap.keyboard.press(parts[parts.length - 1]);
    for (let i = parts.length - 2; i >= 0; i--) await ap.keyboard.up(parts[i]);
    return JSON.stringify({ ok: true, combo: args.combo });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

async function detectBlock(args, ctx) {
  ctx.emitThinking('Analizzo possibili blocchi...');
  if (ctx.isBridgeReady()) {
    const r = await ctx.bridgeCommand('detect_block');
    if (r.ok && r.blocked && r.blocks.length > 0) ctx.emitReasoning(`⚠️ Rilevati blocchi: ${r.blocks.join(', ')}`, '🔒');
    return JSON.stringify(r);
  }
  const ap = ctx.getState('activePage');
  if (ap) { try { const c = await ctx.detectCaptcha(ap); return JSON.stringify({ ok: true, blocked: !!c, blocks: c ? [c] : [] }); } catch (_) { /* best-effort */ } }
  return JSON.stringify({ ok: true, blocked: false, blocks: [] });
}

async function verifyAction(args, ctx) {
  ctx.emitThinking('Verifico risultato azione...');
  let checks; try { checks = typeof args.checks === 'string' ? JSON.parse(args.checks) : args.checks; } catch { return JSON.stringify({ error: 'Formato checks non valido' }); }
  if (ctx.isBridgeReady()) { const r = await ctx.bridgeCommand('verify_action', { checks }); return JSON.stringify(r); }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ ok: true, allPassed: false, error: 'Nessuna pagina' });
  try {
    const results = [];
    for (const check of checks) {
      if (check.type === 'url_contains') results.push({ check: check.type, passed: ap.url().includes(check.value) });
      else if (check.type === 'element_exists') { const exists = await ap.$(check.selector); results.push({ check: check.type, passed: !!exists }); }
      else if (check.type === 'no_error') { const errs = await ap.evaluate(() => [...document.querySelectorAll('.error,[class*="error"],[role="alert"]')].filter(e=>e.offsetParent).map(e=>e.textContent.trim().substring(0,80))); results.push({ check: check.type, passed: errs.length === 0, errors: errs }); }
      else results.push({ check: check.type, passed: false, error: 'Unknown' });
    }
    return JSON.stringify({ ok: true, allPassed: results.every(r => r.passed), results });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

async function selectDropdown(args, ctx) {
  ctx.emitThinking(`Seleziono "${args.value}" da dropdown...`);
  if (ctx.isBridgeReady()) {
    const r = await ctx.bridgeCommand('select_dropdown', { selector: args.selector, value: args.value, searchable: args.searchable });
    const ss = await ctx.bridgeCommand('screenshot', { quality: 70 });
    if (ss.ok) ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage?.url || '' });
    return JSON.stringify({ ...r, via: 'bridge' });
  }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try { await ap.select(args.selector, args.value); return JSON.stringify({ ok: true, selected: args.value, method: 'puppeteer' }); }
  catch (e) { return JSON.stringify({ error: e.message }); }
}

async function setDatepicker(args, ctx) {
  ctx.emitThinking(`Imposto data "${args.value}"...`);
  if (ctx.isBridgeReady()) { const r = await ctx.bridgeCommand('set_datepicker', { selector: args.selector, value: args.value }); return JSON.stringify({ ...r, via: 'bridge' }); }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try {
    await ap.evaluate((sel, val) => { const el = document.querySelector(sel); if (!el) return; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (s) s.call(el, val); else el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, args.selector, args.value);
    return JSON.stringify({ ok: true, value: args.value });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

async function readTable(args, ctx) {
  ctx.emitThinking('Leggo tabella...');
  if (ctx.isBridgeReady()) { const r = await ctx.bridgeCommand('read_table', { selector: args.selector, maxRows: args.maxRows }); return JSON.stringify(r); }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try {
    const data = await ap.evaluate((sel, max) => { const t = sel ? document.querySelector(sel) : document.querySelector('table'); if (!t) return { ok: false, error: 'No table' }; const headers = [...t.querySelectorAll('thead th,tr:first-child th')].map(th => th.textContent.trim()); const rows = []; for (const tr of [...t.querySelectorAll('tbody tr,tr')].slice(0, max || 50)) { const cells = [...tr.querySelectorAll('td,th')].map(td => td.textContent.trim().substring(0, 200)); if (cells.length) rows.push(cells); } return { ok: true, headers, rows, totalRows: t.querySelectorAll('tr').length }; }, args.selector || null, args.maxRows || 50);
    return JSON.stringify(data);
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

async function waitNetworkIdle(args, ctx) {
  if (ctx.isBridgeReady()) { const r = await ctx.bridgeCommand('wait_network_idle', { idleMs: args.idleMs, timeout: args.timeout }); return JSON.stringify(r); }
  const ap = ctx.getState('activePage');
  if (ap) { try { await ap.waitForNetworkIdle({ idleTime: args.idleMs || 1000, timeout: args.timeout || 15000 }); return JSON.stringify({ ok: true }); } catch (_) { return JSON.stringify({ ok: true, note: 'timeout reached' }); } }
  return JSON.stringify({ ok: true });
}

async function clipboardWrite(args, ctx) {
  if (ctx.isBridgeReady()) { const r = await ctx.bridgeCommand('clipboard_write', { text: args.text }); return JSON.stringify(r); }
  const ap = ctx.getState('activePage');
  if (ap) { try { await ap.evaluate(t => navigator.clipboard.writeText(t), args.text); return JSON.stringify({ ok: true }); } catch (_) { return JSON.stringify({ ok: true, note: 'clipboard may not be available' }); } }
  return JSON.stringify({ ok: true });
}

module.exports = {
  type_human: typeHuman, key_combo: keyCombo, detect_block: detectBlock, verify_action: verifyAction,
  select_dropdown: selectDropdown, set_datepicker: setDatepicker, read_table: readTable,
  wait_network_idle: waitNetworkIdle, clipboard_write: clipboardWrite,
};
