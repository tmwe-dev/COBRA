// modules/tools/handlers/interaction.js — click_element, fill_form, select_option
// Source: server.js lines 5556-6663

const PAYMENT_BUTTONS = /\b(paga ora|pay now|conferma pagamento|confirm payment|completa acquisto|complete purchase|place order|acquista ora|buy now|procedi al pagamento|proceed to payment|finalizza ordine|submit payment|conferma ordine|paga|checkout)\b/i;
const PAYMENT_SELECTORS = /card.?number|cc.?number|credit.?card|carta.?di.?credito|cvv|cvc|security.?code|expir|scadenza|card.?exp|billing.?card|numero.?carta|iban|routing.?number|account.?number|sort.?code/i;

async function clickElement(args, ctx) {
  ctx.emitThinking(`Clicco su "${args.selector}"...`);
  const sel = args.selector || '';
  // Payment button block — check selector text + real DOM text
  let payBlocked = PAYMENT_BUTTONS.test(sel);
  if (!payBlocked && ctx.isBridgeReady()) {
    try {
      const ei = await ctx.bridgeCommand('execute_js', { code: `(function(){ var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; return {text:(el.textContent||'').trim().substring(0,100),aria:el.getAttribute('aria-label')||'',value:el.value||'',formAction:el.form?.action||''}; })()` });
      if (ei.ok && ei.result) { const h = `${ei.result.text} ${ei.result.aria} ${ei.result.value} ${ei.result.formAction}`.toLowerCase(); if (PAYMENT_BUTTONS.test(h)) payBlocked = true; }
    } catch (_) { /* best-effort */ }
  }
  if (payBlocked) return JSON.stringify({ error: 'BLOCCATO: Non posso cliccare bottoni di pagamento.', security: 'payment_block' });
  // Bridge path
  if (ctx.isBridgeReady()) {
    try {
      const r = await ctx.bridgeClick(sel);
      if (r.newUrl) ctx.session.lastPage = { ...ctx.session.lastPage, url: r.newUrl, title: r.newTitle || '' };
      ctx.wsBroadcast({ type: 'page_loaded', url: r.newUrl || ctx.session.lastPage?.url, title: r.newTitle || '' });
      return JSON.stringify({ ok: true, clicked: sel, newUrl: r.newUrl, newTitle: r.newTitle, via: 'bridge' });
    } catch (_) { /* best-effort */ }
  }
  // Puppeteer path
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva. Usa navigate prima.' });
  try { await ctx.dismissModals(ap); } catch (_) { /* best-effort */ }
  try {
    let clicked = false;
    if (sel.startsWith('text:')) {
      const searchText = sel.substring(5).trim().toLowerCase();
      clicked = await ap.evaluate((txt) => { const els=[...document.querySelectorAll('a,button,input[type="submit"],[role="button"],label,span,div[onclick]')]; for(const el of els){if((el.textContent||'').trim().toLowerCase().includes(txt)&&el.offsetParent!==null){el.click();return true;}} return false; }, searchText);
    } else { await ap.click(sel); clicked = true; }
    if (!clicked) return JSON.stringify({ ok: false, error: `Elemento "${sel}" non trovato` });
    await new Promise(r => setTimeout(r, 2000));
    const newUrl = ap.url(), newTitle = await ap.title();
    ctx.session.lastPage = { ...ctx.session.lastPage, url: newUrl, title: newTitle };
    await ctx.takeActiveScreenshot(newUrl, newTitle);
    ctx.wsBroadcast({ type: 'page_loaded', url: newUrl, title: newTitle });
    return JSON.stringify({ ok: true, clicked: sel, newUrl, newTitle });
  } catch (e) { return JSON.stringify({ error: `Click failed: ${e.message}` }); }
}

async function fillForm(args, ctx) {
  ctx.emitThinking('Compilo il form...');
  // Payment field block
  let fieldsToCheck; try { fieldsToCheck = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields; } catch { fieldsToCheck = {}; }
  const blocked = [];
  for (const [s, v] of Object.entries(fieldsToCheck || {})) { if (PAYMENT_SELECTORS.test(s) || PAYMENT_SELECTORS.test(String(v))) blocked.push(s); }
  if (blocked.length > 0) return JSON.stringify({ error: 'BLOCCATO: Non posso compilare campi di pagamento.', blocked_fields: blocked, security: 'payment_block' });
  // Bridge: 3 methods
  if (ctx.isBridgeReady()) {
    try {
      await ctx.dismissModalsBridge();
      let fields; try { fields = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields; } catch { return JSON.stringify({ error: 'Formato fields non valido.' }); }
      const results = [];
      // Method 1: nativeSetter
      for (const [sel, val] of Object.entries(fields)) {
        try {
          const safeSel = sel.replace(/\\/g, '\\\\').replace(/'/g, "\\'"), safeVal = String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const js = `(function(){var el=document.querySelector('${safeSel}');if(!el)return{ok:false};el.focus();var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;var ns=Object.getOwnPropertyDescriptor(proto.prototype,'value')?.set;if(ns)ns.call(el,'${safeVal}');else el.value='${safeVal}';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return{ok:true,value:el.value};})()`;
          const r = await ctx.bridgeCommand('execute_js', { code: js });
          results.push({ selector: sel, ok: r.ok && r.result?.ok !== false, value: val, via: 'nativeSetter' });
        } catch (e) { results.push({ selector: sel, ok: false, value: val, error: e.message, via: 'nativeSetter' }); }
      }
      // Method 2: click+type_human for failed fields
      for (const ff of results.filter(r => !r.ok)) {
        try { await ctx.bridgeCommand('click', { selector: ff.selector }); await new Promise(r => setTimeout(r, 200)); await ctx.bridgeCommand('key_combo', { keys: ['Control','a'] }); await new Promise(r => setTimeout(r, 100)); const tr = await ctx.bridgeCommand('type_human', { text: String(ff.value), selector: ff.selector, delay: 50 }); if (tr.ok) { ff.ok = true; ff.via = 'type_human'; } } catch (_) { /* best-effort */ }
      }
      // Method 3: bridge native fill for still-failed
      const still = results.filter(r => !r.ok);
      if (still.length > 0) { const rf = {}; for (const f of still) rf[f.selector] = f.value; try { const nr = await ctx.bridgeFillForm(rf); if (nr.ok) for (const f of still) { f.ok = true; f.via = 'bridge_native'; } } catch (_) { /* best-effort */ } }
      // Screenshot
      try { const ss = await ctx.bridgeCommand('screenshot', { quality: 70 }); if (ss.ok && ss.screenshot) ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage?.url || '' }); } catch (_) { /* best-effort */ }
      const allOk = results.every(r => r.ok);
      if (!allOk) { try { const ir = await ctx.bridgeCommand('get_interactive', {}); if (ir.ok && ir.elements) { const af = ir.elements.filter(el => ['input','select','textarea'].includes(el.tag) && !el.disabled).slice(0,15).map(el => ({ selector: el.selector || (el.id ? '#'+el.id : el.name ? `[name="${el.name}"]` : el.tag), type: el.type, placeholder: el.placeholder, label: el.ariaLabel || el.text })); return JSON.stringify({ ok: false, results, via: 'fill_form_3methods', hint: 'Alcuni campi non compilati. Ecco i campi REALI:', available_fields: af }); } } catch (_) { /* best-effort */ } }
      return JSON.stringify({ ok: allOk, results, via: 'fill_form_3methods' });
    } catch (_) { /* best-effort */ }
  }
  // Puppeteer fallback
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva e bridge non disponibile.' });
  try { await ctx.dismissModals(ap); } catch (_) { /* best-effort */ }
  let fields; try { fields = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields; } catch { return JSON.stringify({ error: 'Formato fields non valido.' }); }
  const results = [];
  for (const [sel, val] of Object.entries(fields)) {
    try {
      const fi = await ap.evaluate((s) => { const el=document.querySelector(s); if(!el) return null; return { tag:el.tagName.toLowerCase(), type:el.type||'', isSelect:el.tagName==='SELECT', isCustom:el.getAttribute('role')==='searchbox'||el.getAttribute('role')==='combobox'||el.getAttribute('contenteditable')==='true', hasAuto:el.getAttribute('aria-expanded')!==null }; }, sel);
      if (!fi) { results.push({ selector: sel, ok: false, error: 'Non trovato' }); continue; }
      if (fi.isSelect) { await ap.select(sel, val); }
      else if (fi.type==='checkbox'||fi.type==='radio') { if (val==='true'||val===true) await ap.click(sel); }
      else if (fi.isCustom||fi.hasAuto) { await ap.click(sel); await new Promise(r=>setTimeout(r,300)); await ap.keyboard.down('Control'); await ap.keyboard.press('a'); await ap.keyboard.up('Control'); await ap.keyboard.press('Backspace'); await ap.type(sel,val,{delay:80}); await new Promise(r=>setTimeout(r,1500)); const picked=await ap.evaluate(()=>{for(const o of document.querySelectorAll('[role="option"],li[data-value],[class*="option"] li')){if(o.offsetParent){o.click();return o.textContent.trim().substring(0,60);}} return null;}); if(!picked){await ap.keyboard.press('ArrowDown');await new Promise(r=>setTimeout(r,300));await ap.keyboard.press('Enter');} results.push({selector:sel,ok:true,value:val,method:'autocomplete'}); continue; }
      else { await ap.click(sel, {clickCount:3}); await ap.type(sel,val,{delay:30}); }
      results.push({ selector: sel, ok: true, value: val });
    } catch (e) {
      try { await ap.evaluate((s,v)=>{const el=document.querySelector(s);if(!el)return;const ns=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(ns)ns.call(el,v);else el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},sel,val); results.push({selector:sel,ok:true,value:val,method:'js_fallback'}); }
      catch (e2) { results.push({ selector: sel, ok: false, error: e.message }); }
    }
  }
  await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title);
  return JSON.stringify({ ok: true, filled: results.filter(r=>r.ok).length, total: results.length, results });
}

async function selectOption(args, ctx) {
  ctx.emitThinking(`Seleziono "${args.value}" in "${args.selector}"...`);
  if (ctx.isBridgeReady()) {
    await ctx.dismissModalsBridge();
    try { const r = await ctx.bridgeCommand('select_dropdown', { selector: args.selector, value: args.value, searchable: true }); if (r.ok) { try { const ss = await ctx.bridgeCommand('screenshot', { quality: 70 }); if (ss.ok) ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage?.url || '' }); } catch (_) { /* best-effort */ } return JSON.stringify({ ok: true, selected: r.selected || args.value, via: 'bridge_select' }); } } catch (_) { /* best-effort */ }
    // JS nativeSetter for <select>
    try {
      const safeSel = args.selector.replace(/\\/g,'\\\\').replace(/'/g,"\\'"), safeVal = String(args.value).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      const js = `(function(){var el=document.querySelector('${safeSel}');if(!el)return{ok:false};if(el.tagName==='SELECT'){var opts=Array.from(el.options);var m=opts.find(function(o){return o.value==='${safeVal}'||o.textContent.trim().toLowerCase().includes('${safeVal}'.toLowerCase());});if(m){el.value=m.value;el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true,selected:m.textContent.trim()};} return{ok:false,available:opts.slice(0,10).map(function(o){return o.textContent.trim();})};}el.click();return{ok:false,hint:'opened'};})()`;
      const r = await ctx.bridgeCommand('execute_js', { code: js });
      if (r.ok && r.result?.ok) return JSON.stringify({ ok: true, selected: r.result.selected, via: 'bridge_js_select' });
      if (r.result?.hint === 'opened') {
        await new Promise(r => setTimeout(r, 400));
        const clickJs = `(function(){var l='${safeVal}'.toLowerCase();var cs=document.querySelectorAll('[role="option"],[class*="option"],li,div[tabindex]');for(var i=0;i<cs.length;i++){if(cs[i].textContent.trim().toLowerCase().includes(l)&&cs[i].offsetParent!==null){cs[i].click();return{ok:true,selected:cs[i].textContent.trim()};}} return{ok:false};})()`;
        const cr = await ctx.bridgeCommand('execute_js', { code: clickJs });
        if (cr.ok && cr.result?.ok) return JSON.stringify({ ok: true, selected: cr.result.selected, via: 'bridge_custom_click' });
      }
      if (r.result?.available) return JSON.stringify({ ok: false, error: `Opzione "${args.value}" non trovata`, available_options: r.result.available });
    } catch (_) { /* best-effort */ }
  }
  // Puppeteer fallback
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try { await ctx.dismissModals(ap); } catch (_) { /* best-effort */ }
  try {
    let selected = await ap.evaluate((s,v)=>{const el=document.querySelector(s);if(!el)return null;const byV=[...el.options].find(o=>o.value===v);if(byV){el.value=byV.value;el.dispatchEvent(new Event('change',{bubbles:true}));return byV.text;}const byT=[...el.options].find(o=>o.text.toLowerCase().includes(v.toLowerCase()));if(byT){el.value=byT.value;el.dispatchEvent(new Event('change',{bubbles:true}));return byT.text;}return null;},args.selector,args.value);
    if (!selected) { await ap.click(args.selector); await new Promise(r=>setTimeout(r,500)); const oc=await ap.evaluate((v)=>{for(const el of document.querySelectorAll('li,div[role="option"],[class*="option"]')){if((el.textContent||'').trim().toLowerCase().includes(v.toLowerCase())&&el.offsetParent!==null){el.click();return el.textContent.trim();}} return null;},args.value); if(oc) selected=oc; }
    await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title);
    if (selected) return JSON.stringify({ ok: true, selected, selector: args.selector });
    return JSON.stringify({ ok: false, error: `Opzione "${args.value}" non trovata in "${args.selector}"` });
  } catch (e) { return JSON.stringify({ error: `Select failed: ${e.message}` }); }
}

module.exports = { click_element: clickElement, fill_form: fillForm, select_option: selectOption };
