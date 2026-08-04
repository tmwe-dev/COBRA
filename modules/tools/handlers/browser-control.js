// modules/tools/handlers/browser-control.js — screenshot, scroll, hover, drag, upload, switch_tab, wait_for, press_key
// Source: server.js lines 6043-6688

const path = require('path');
const fs = require('fs');

async function screenshot(args, ctx) {
  if (ctx.isBridgeReady()) { try { await ctx.dismissModalsBridge(); } catch (_) { /* best-effort */ } }
  else { const ap = ctx.getState('activePage'); if (ap) { try { await ctx.dismissModals(ap); } catch (_) { /* best-effort */ } } }
  if (ctx.isBridgeReady()) {
    try {
      const ss = await ctx.bridgeCommand('screenshot', { quality: 70 });
      if (ss.ok && ss.screenshot) {
        ctx.session.lastScreenshotData = ss.screenshot;
        ctx.session.lastBroadcastUrl = ctx.session.lastPage?.url || '';
        ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage?.url || '', title: ctx.session.lastPage?.title || '' });
        return JSON.stringify({ ok: true, screenshot: 'inviato al monitor', via: 'bridge' });
      }
      // Il motivo del fallimento va registrato, altrimenti l'anteprima sparisce
      // dal monitor senza che nessuno sappia perché
      ctx.log(`[Screenshot] Estensione: ${ss?.error || 'nessuna immagine restituita'}`);
    } catch (e) {
      ctx.log(`[Screenshot] Comando bridge fallito: ${e.message}`);
    }
  }
  const ap = ctx.getState('activePage');
  if (ap) { const ss = await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title); return JSON.stringify({ ok: true, screenshot: ss ? 'broadcast al monitor' : 'fallito' }); }
  return JSON.stringify({ info: 'Nessuna pagina attiva. Usa navigate prima.' });
}

async function scrollPage(args, ctx) {
  if (ctx.isBridgeReady()) {
    // L'esito del comando va controllato: dichiarare successo senza verificarlo
    // nascondeva i fallimenti dell'estensione e l'AI proseguiva convinta di
    // aver scrollato una pagina che non si era mossa.
    const esito = await ctx.bridgeCommand('scroll', { direction: args.direction || 'down', amount: args.amount || 500 });
    if (esito && esito.ok === false) {
      ctx.log(`[Scroll] Estensione: ${esito.error || 'errore non specificato'}`);
      return JSON.stringify({ error: `Scroll non riuscito: ${esito.error || 'errore nell\'estensione'}` });
    }
    await new Promise(r => setTimeout(r, 500));
    const ss = await ctx.bridgeCommand('screenshot', { quality: 70 }).catch(() => ({}));
    if (ss.ok && ss.screenshot) ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage?.url || '' });
    return JSON.stringify({ ok: true, scrolled: esito?.scrolled || args.direction || 'down', amount: esito?.amount || args.amount || 500, via: 'bridge' });
  }
  const ap = ctx.getState('activePage');
  if (ap) {
    const dir = args.direction || 'down', amt = args.amount || 500;
    await ap.evaluate((d, a) => window.scrollBy(0, d === 'down' ? a : -a), dir, amt);
    await new Promise(r => setTimeout(r, 500));
    await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title);
  }
  return JSON.stringify({ ok: true, scrolled: args.direction || 'down', amount: args.amount || 500 });
}

async function hoverElement(args, ctx) {
  ctx.emitThinking(`Hover su "${args.selector}"...`);
  if (ctx.isBridgeReady()) {
    try { await ctx.bridgeCommand('hover', { selector: args.selector }); await new Promise(r => setTimeout(r, 800)); const ss = await ctx.bridgeCommand('screenshot', { quality: 70 }); if (ss.ok && ss.screenshot) ctx.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: ctx.session.lastPage?.url || '' }); return JSON.stringify({ ok: true, hovered: args.selector, via: 'bridge' }); } catch (_) { /* best-effort */ }
  }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try { await ctx.dismissModals(ap); } catch (_) { /* best-effort */ }
  const sel = args.selector || '';
  try {
    if (sel.startsWith('text:')) {
      const ht = sel.substring(5).trim().toLowerCase();
      const found = await ap.evaluate((txt) => { for (const el of [...document.querySelectorAll('a,button,[role="button"],label,span,li,div,nav *')]) { if ((el.textContent||'').trim().toLowerCase().includes(txt) && el.offsetParent!==null) { const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; } } return null; }, ht);
      if (!found) return JSON.stringify({ ok: false, error: `"${sel}" non trovato` });
      await ap.mouse.move(found.x, found.y);
    } else { await ap.hover(sel); }
    await new Promise(r => setTimeout(r, 800));
    await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title);
    return JSON.stringify({ ok: true, hovered: sel });
  } catch (e) { return JSON.stringify({ error: `Hover failed: ${e.message}` }); }
}

async function dragDrop(args, ctx) {
  ctx.emitThinking(`Drag da "${args.source}" a "${args.target}"...`);
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try {
    const srcBox = await ap.evaluate(s => { const el=document.querySelector(s); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }, args.source);
    const tgtBox = await ap.evaluate(s => { const el=document.querySelector(s); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }, args.target);
    if (!srcBox) return JSON.stringify({ error: `Source "${args.source}" non trovato` });
    if (!tgtBox) return JSON.stringify({ error: `Target "${args.target}" non trovato` });
    await ap.mouse.move(srcBox.x, srcBox.y); await ap.mouse.down();
    for (let i = 1; i <= 10; i++) { await ap.mouse.move(srcBox.x + (tgtBox.x - srcBox.x) * (i / 10), srcBox.y + (tgtBox.y - srcBox.y) * (i / 10)); await new Promise(r => setTimeout(r, 30)); }
    await ap.mouse.up(); await new Promise(r => setTimeout(r, 500));
    await ap.evaluate((s,t) => { const src=document.querySelector(s),tgt=document.querySelector(t); if(src&&tgt){const dt=new DataTransfer();src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));tgt.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));src.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));} }, args.source, args.target);
    await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title);
    return JSON.stringify({ ok: true, from: args.source, to: args.target });
  } catch (e) { return JSON.stringify({ error: `Drag failed: ${e.message}` }); }
}

async function uploadFile(args, ctx) {
  ctx.emitThinking(`Upload file su "${args.selector}"...`);
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try {
    let filePath = args.file_path;
    const localPath = path.join(__dirname, '..', '..', '..', 'data', 'local_files', filePath);
    if (fs.existsSync(localPath)) filePath = localPath;
    if (!fs.existsSync(filePath)) return JSON.stringify({ error: `File non trovato: ${args.file_path}` });
    const fileInput = await ap.$(args.selector);
    if (!fileInput) return JSON.stringify({ error: `Input file "${args.selector}" non trovato` });
    await fileInput.uploadFile(filePath);
    await new Promise(r => setTimeout(r, 1000));
    await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title);
    return JSON.stringify({ ok: true, uploaded: path.basename(filePath), selector: args.selector });
  } catch (e) { return JSON.stringify({ error: `Upload failed: ${e.message}` }); }
}

async function switchTab(args, ctx) {
  const idx = args.index || 0;
  const ap = ctx.getState('activePage');
  let popups = ctx.getState('popupPages') || [];
  try {
    if (idx === 0) {
      if (ap) { await ap.bringToFront(); await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title); return JSON.stringify({ ok: true, switched: 'main', url: ap.url() }); }
      return JSON.stringify({ error: 'Nessuna pagina principale attiva' });
    }
    popups = popups.filter(p => !p.isClosed());
    const pi = idx - 1;
    if (pi >= popups.length) return JSON.stringify({ error: `Popup ${idx} non esiste`, available: popups.map((p, i) => ({ index: i + 1, url: p.url() })) });
    const popup = popups[pi];
    await popup.bringToFront();
    const oldActive = ap;
    ctx.setState('activePage', popup);
    popups.splice(pi, 1);
    if (oldActive) popups.unshift(oldActive);
    const pUrl = popup.url(), pTitle = await popup.title();
    ctx.session.lastPage = { ...ctx.session.lastPage, url: pUrl, title: pTitle };
    await ctx.takeActiveScreenshot(pUrl, pTitle);
    ctx.wsBroadcast({ type: 'page_loaded', url: pUrl, title: pTitle });
    return JSON.stringify({ ok: true, switched: `popup_${idx}`, url: pUrl, title: pTitle });
  } catch (e) { return JSON.stringify({ error: `Switch tab failed: ${e.message}` }); }
}

async function waitFor(args, ctx) {
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  const timeout = args.timeout || 5000;
  try {
    if (args.selector) { ctx.emitThinking(`Attendo "${args.selector}"...`); await ap.waitForSelector(args.selector, { visible: true, timeout }); }
    else { await new Promise(r => setTimeout(r, timeout)); }
    await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title);
    return JSON.stringify(args.selector ? { ok: true, found: args.selector } : { ok: true, waited: timeout + 'ms' });
  } catch (e) { await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title); return JSON.stringify({ ok: false, error: `Timeout: "${args.selector}" non apparso in ${timeout}ms` }); }
}

async function pressKey(args, ctx) {
  if (ctx.isBridgeReady()) { try { const r = await ctx.bridgeCommand('press_key', { key: args.key, repeat: args.repeat || 1 }); if (r.ok) return JSON.stringify({ ok: true, key: args.key, via: 'bridge' }); } catch (_) { /* best-effort */ } }
  const ap = ctx.getState('activePage');
  if (!ap) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
  try { if (args.selector) await ap.focus(args.selector); await ap.keyboard.press(args.key); await new Promise(r => setTimeout(r, 300)); await ctx.takeActiveScreenshot(ctx.session.lastPage?.url, ctx.session.lastPage?.title); return JSON.stringify({ ok: true, key: args.key, target: args.selector || 'active element' }); }
  catch (e) { return JSON.stringify({ error: `Key press failed: ${e.message}` }); }
}

module.exports = { screenshot, scroll_page: scrollPage, hover_element: hoverElement, drag_drop: dragDrop, upload_file: uploadFile, switch_tab: switchTab, wait_for: waitFor, press_key: pressKey };
