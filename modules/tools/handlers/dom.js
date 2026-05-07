// modules/tools/handlers/dom.js — inspect/mutate/execute JS, get_page_elements, get_page_snapshot
// Source: server.js lines 5495-6041

const MUTATIVE_PATTERNS = /\.value\s*=|\.innerhtml\s*=|\.textcontent\s*=|\.setattribute|\.removeattribute|\.classlist\.|\.style\.|\.appendchild|\.removechild|\.insertbefore|\.replacechild|\.remove\(\)|\.click\(\)|\.submit\(\)|\.focus\(\)|\.dispatchevent|document\.write|document\.execcommand|\.createelement|fetch\s*\(|xmlhttprequest|\.send\(|localStorage|sessionStorage|\.cookie\s*=/i;
const PAYMENT_JS = /card.?number|credit.?card|cvv|cvc|expir|scadenza|carta.?credito|iban|routing.?number/i;

async function inspectDomJs(args, ctx) {
  ctx.emitThinking('Lettura DOM...');
  if (MUTATIVE_PATTERNS.test((args.code || '').toLowerCase())) return JSON.stringify({ error: 'inspect_dom_js è read-only. Per modifiche usa mutate_dom_js.' });
  if (ctx.isBridgeReady()) { try { const r = await ctx.bridgeCommand('execute_js', { code: args.code }); if (r.ok) return JSON.stringify({ ok: true, result: typeof r.result === 'object' ? JSON.stringify(r.result).substring(0, 5000) : String(r.result).substring(0, 5000), via: 'bridge' }); } catch (_) { /* best-effort */ } }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva. Usa navigate prima.' });
  try { const r = await ap.evaluate(args.code); return JSON.stringify({ ok: true, result: typeof r === 'object' ? JSON.stringify(r).substring(0, 5000) : String(r).substring(0, 5000) }); }
  catch (e) { return JSON.stringify({ error: `JS error: ${e.message}` }); }
}

async function mutateDomJs(args, ctx) {
  ctx.emitThinking('Esecuzione JS mutativo...');
  if (args.code && PAYMENT_JS.test(args.code)) { ctx.log(`[SECURITY] BLOCKED payment JS`); return JSON.stringify({ error: 'BLOCCATO: Non posso eseguire JS su campi di pagamento.', security: 'payment_block' }); }
  if (ctx.isBridgeReady()) { try { const r = await ctx.bridgeCommand('execute_js', { code: args.code }); if (r.ok) return JSON.stringify({ ok: true, result: typeof r.result === 'object' ? JSON.stringify(r.result).substring(0, 5000) : String(r.result).substring(0, 5000), via: 'bridge' }); } catch (_) { /* best-effort */ } }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva. Usa navigate prima.' });
  try { const r = await ap.evaluate(args.code); await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title); return JSON.stringify({ ok: true, result: typeof r === 'object' ? JSON.stringify(r).substring(0, 5000) : String(r).substring(0, 5000) }); }
  catch (e) { return JSON.stringify({ error: `JS error: ${e.message}` }); }
}

async function executeJs(args, ctx) {
  ctx.emitThinking('Esecuzione JS...');
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva. Usa navigate prima.' });
  try { const r = await ap.evaluate(args.code); await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title); return JSON.stringify({ ok: true, result: typeof r === 'object' ? JSON.stringify(r).substring(0, 5000) : String(r).substring(0, 5000) }); }
  catch (e) { return JSON.stringify({ error: `JS error: ${e.message}` }); }
}

async function getPageElements(args, ctx) {
  ctx.emitThinking('Analizzo gli elementi...');
  const filter = args.filter || 'all';
  // Bridge path with retry
  if (ctx.isBridgeReady()) {
    let interactive = null;
    for (let i = 0; i < 3; i++) {
      try { interactive = await ctx.bridgeCommand('get_interactive'); if (interactive?.ok && (interactive.elements || []).length > 0) break; if (i < 2) await new Promise(r => setTimeout(r, 1500)); }
      catch (_) { if (i < 2) await new Promise(r => setTimeout(r, 1500)); interactive = null; }
    }
    if (interactive?.ok) {
      const elements = { inputs: [], buttons: [], links: [], selects: [], textareas: [] };
      for (const el of (interactive.elements || [])) {
        const sel = el.selector || (el.id ? '#' + el.id : (el.name ? `[name="${el.name}"]` : el.tag));
        const item = { selector: sel, type: el.type || '', name: el.name || '', placeholder: el.placeholder || el.ariaLabel || '', value: '' };
        if (['input', 'textarea'].includes(el.tag) && !['submit', 'button', 'hidden'].includes(el.type)) elements.inputs.push(item);
        else if (['button'].includes(el.tag) || el.role === 'button' || ['submit', 'button'].includes(el.type)) elements.buttons.push({ selector: sel, text: el.text || '' });
        else if (el.tag === 'select' || el.role === 'listbox') elements.selects.push({ selector: sel, label: el.ariaLabel || el.name || '' });
        else if (el.tag === 'a') elements.links.push({ text: el.text || '', href: '' });
      }
      try { const fr = await ctx.bridgeCommand('get_forms'); if (fr.ok && fr.forms) for (const form of fr.forms) for (const f of (form.fields || [])) { if (f.type === 'hidden') continue; const s = f.selector || (f.id ? '#' + f.id : f.name ? `[name="${f.name}"]` : null); if (s && !elements.inputs.find(i => i.selector === s)) elements.inputs.push({ selector: s, type: f.type, name: f.name, placeholder: f.placeholder || f.label || '', value: f.value || '' }); } } catch (_) { /* best-effort */ }
      return JSON.stringify({ ok: true, live: true, elements, url: ctx.session.lastPage?.url || '', via: 'bridge' });
    }
  }
  // Puppeteer path
  const ap = ctx.getState('activePage');
  if (ap) {
    try {
      const elements = await ap.evaluate((filter) => {
        const result = { inputs: [], buttons: [], links: [], selects: [], textareas: [] };
        const getSel = (el) => { if (el.id) return '#'+el.id; if (el.name) return `[name="${el.name}"]`; if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`; if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`; if (el.placeholder) return `[placeholder="${el.placeholder}"]`; const cls = el.className && typeof el.className === 'string' ? '.'+el.className.split(/\s+/).filter(c=>c&&c.length<40).slice(0,2).join('.') : ''; return el.tagName.toLowerCase()+cls; };
        if (filter==='all'||filter==='inputs') for (const el of document.querySelectorAll('input,[contenteditable="true"],[role="searchbox"],[role="combobox"],[role="textbox"]')) { if (el.type==='hidden'||!(el.offsetParent!==null||getComputedStyle(el).display!=='none')) continue; result.inputs.push({ selector:getSel(el), type:el.type||el.getAttribute('role')||'text', placeholder:(el.placeholder||el.getAttribute('aria-label')||'').substring(0,60), value:(el.value||el.textContent||'').substring(0,40), name:el.name||'' }); if(result.inputs.length>=25) break; }
        if (filter==='all'||filter==='buttons') for (const el of document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')) { if (!(el.offsetParent!==null||getComputedStyle(el).display!=='none')) continue; const t=(el.textContent||el.value||el.getAttribute('aria-label')||'').trim(); if(!t||t.length>80) continue; result.buttons.push({ selector:getSel(el), text:t.substring(0,60) }); if(result.buttons.length>=20) break; }
        if (filter==='all'||filter==='links') for (const el of document.querySelectorAll('a[href]')) { if (!el.offsetParent) continue; const t=(el.textContent||'').trim(); if(!t||t.length>80) continue; result.links.push({ text:t.substring(0,60), href:el.href.substring(0,120) }); if(result.links.length>=15) break; }
        return result;
      }, filter);
      return JSON.stringify({ ok: true, live: true, elements, url: ap.url() });
    } catch (e) { return JSON.stringify({ error: `DOM query failed: ${e.message}` }); }
  }
  if (!ctx.session.lastPage) return JSON.stringify({ error: 'Nessuna pagina caricata.' });
  // Fallback: HTML statico
  const elements = { buttons: [], links: [], inputs: [] };
  const inputRegex = /<input[^>]+>/gi; let m;
  while ((m = inputRegex.exec(ctx.session.lastPage.html)) !== null && elements.inputs.length < 20) {
    elements.inputs.push({ type: m[0].match(/type="([^"]+)"/)?.[1] || 'text', name: m[0].match(/name="([^"]+)"/)?.[1] || '', id: m[0].match(/id="([^"]+)"/)?.[1] || '' });
  }
  return JSON.stringify({ ok: true, live: false, elements, url: ctx.session.lastPage.url });
}

async function getPageSnapshot(args, ctx) {
  ctx.emitThinking('Creo snapshot strutturato...');
  if (ctx.isBridgeReady()) { try { await ctx.dismissModalsBridge(); } catch (_) { /* best-effort */ } }
  else { const ap = ctx.getState('activePage'); if (ap) { try { await ctx.dismissModals(ap); } catch (_) { /* best-effort */ } } }
  if (ctx.isBridgeReady()) {
    try { const snap = await ctx.bridgeCommand('get_page_snapshot'); if (snap.ok) return JSON.stringify(snap); } catch (_) { /* best-effort */ }
    try { const inter = await ctx.bridgeCommand('get_interactive'); if (inter.ok) return JSON.stringify(inter); } catch (_) { /* best-effort */ }
  }
  return JSON.stringify({ error: 'Nessuna pagina disponibile. Naviga prima.' });
}

module.exports = { inspect_dom_js: inspectDomJs, mutate_dom_js: mutateDomJs, execute_js: executeJs, get_page_elements: getPageElements, get_page_snapshot: getPageSnapshot };
