// modules/browser/modals.js — Dismiss modals, popups, overlays, ads
// Source: server.js lines 2131-2284

async function dismissModals(page) {
  if (!page) return { dismissed: 0 };
  try {
    const dismissed = await page.evaluate(() => {
      let count = 0;
      // 1. Close buttons
      const closeSel = [
        '[aria-label="Close"]','[aria-label="Chiudi"]','[aria-label="Dismiss"]',
        'button.close','button.modal-close','.modal .close','[data-dismiss="modal"]',
        '.popup-close','.overlay-close','.btn-close',
        'button[class*="close"]','button[class*="dismiss"]',
        '[role="dialog"] button[aria-label]',
        '[data-testid="genius-banner-close"]','.bui-modal__close',
      ];
      for (const sel of closeSel) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') { try { el.click(); count++; } catch { /* best-effort */ } }
        }
      }
      // 2. Dismiss text buttons
      const dismissTxt = ['chiudi','close','no grazie','no thanks','skip','salta','dismiss','not now','non ora','later','più tardi','got it','ho capito','ok','continue','continua','non mi interessa','decline','rifiuta'];
      for (const el of document.querySelectorAll('button, a[role="button"], [role="button"], span[role="button"]')) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (t.length > 80) continue;
        if (dismissTxt.some(d => t === d || t.includes(d)) && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) {
          try { el.click(); count++; } catch { /* best-effort */ }
        }
      }
      // 3. Remove overlay backdrops
      for (const sel of ['.modal-backdrop','[class*="overlay"][style*="fixed"]','[class*="modal-mask"]','[class*="popup-overlay"]']) {
        for (const el of document.querySelectorAll(sel)) {
          if (getComputedStyle(el).position === 'fixed' && parseFloat(getComputedStyle(el).opacity || 1) < 1) { try { el.remove(); count++; } catch { /* best-effort */ } }
        }
      }
      // 4. Remove ad iframes/banners
      const adSel = ['iframe[src*="doubleclick"]','iframe[src*="googlesyndication"]','iframe[src*="googleads"]','[class*="adsbygoogle"]','ins.adsbygoogle','[id*="google_ads"]','div[id^="div-gpt-ad"]','[class*="ad-banner"]','[class*="advertisement"]','[data-ad]','[class*="sponsored"]'];
      for (const sel of adSel) { for (const el of document.querySelectorAll(sel)) { try { el.remove(); count++; } catch { /* best-effort */ } } }
      // 5. Remove fixed promo bars
      for (const el of document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]')) {
        const r = el.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.5 && r.height < 200) { try { el.remove(); count++; } catch { /* best-effort */ } }
      }
      // 6. Restore scroll
      if (document.body.style.overflow === 'hidden' || document.body.classList.contains('modal-open')) {
        document.body.style.overflow = ''; document.body.classList.remove('modal-open','no-scroll','noscroll');
        document.documentElement.style.overflow = '';
      }
      return count;
    });
    try { await page.keyboard.press('Escape'); } catch { /* best-effort */ }
    await new Promise(r => setTimeout(r, 500));
    // Second pass
    const dismissed2 = await page.evaluate(() => {
      let count = 0;
      for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="modal"]:not(.modal-backdrop)')) {
        if (el.offsetParent !== null && getComputedStyle(el).display !== 'none') {
          const btn = el.querySelector('button[class*="close"], [aria-label="Close"], [aria-label="Chiudi"]');
          if (btn) { try { btn.click(); count++; } catch { /* best-effort */ } }
        }
      }
      return count;
    });
    return { dismissed: (dismissed || 0) + (dismissed2 || 0) };
  } catch (e) { return { dismissed: 0, error: e.message }; }
}

async function dismissModalsBridge(bridgeCommand, isBridgeReady) {
  if (!isBridgeReady()) return { dismissed: 0 };
  try {
    const result = await bridgeCommand('execute_js', { code: `(function(){var count=0;var cookieSel=['#onetrust-accept-btn-handler','.fc-cta-consent','#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll','button.cookie-accept','.cc-accept','.cc-allow','button[id*="accept"]'];for(var i=0;i<cookieSel.length;i++){var el=document.querySelector(cookieSel[i]);if(el&&el.offsetParent!==null){try{el.click();count++;}catch(e){}}}var closeSel=['[aria-label="Close"]','[aria-label="Chiudi"]','button.close','.modal .close','[data-dismiss="modal"]','.popup-close','.btn-close'];for(var i=0;i<closeSel.length;i++){var els=document.querySelectorAll(closeSel[i]);for(var j=0;j<els.length;j++){if(els[j].offsetParent!==null){try{els[j].click();count++;}catch(e){}}}}var dismissTxt=['chiudi','close','no grazie','skip','dismiss','not now','got it','ok','continue','accetta','accept all','accept'];var btns=document.querySelectorAll('button, a[role="button"], [role="button"]');for(var i=0;i<btns.length;i++){var t=btns[i].textContent.trim().toLowerCase();if(t.length>60)continue;for(var j=0;j<dismissTxt.length;j++){if(t===dismissTxt[j]||t.indexOf(dismissTxt[j])!==-1){if(btns[i].offsetParent!==null){try{btns[i].click();count++;}catch(e){}}break;}}}var overlays=document.querySelectorAll('.modal-backdrop,[class*="overlay"][style*="fixed"]');for(var i=0;i<overlays.length;i++){if(getComputedStyle(overlays[i]).position==='fixed'){try{overlays[i].remove();count++;}catch(e){}}}var adSel=['iframe[src*="doubleclick"]','iframe[src*="googlesyndication"]','[class*="adsbygoogle"]','ins.adsbygoogle','div[id^="div-gpt-ad"]','[class*="ad-banner"]','[class*="advertisement"]'];for(var i=0;i<adSel.length;i++){var els=document.querySelectorAll(adSel[i]);for(var j=0;j<els.length;j++){try{els[j].remove();count++;}catch(e){}}}if(document.body.style.overflow==='hidden'){document.body.style.overflow='';document.body.classList.remove('modal-open','no-scroll');}document.documentElement.style.overflow='';return{ok:true,dismissed:count};})()` });
    return result.result || { dismissed: 0 };
  } catch (e) { return { dismissed: 0 }; }
}

module.exports = { dismissModals, dismissModalsBridge };
