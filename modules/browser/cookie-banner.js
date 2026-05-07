// modules/browser/cookie-banner.js — Cookie consent banner dismiss
// Source: server.js lines 1995-2068

async function dismissCookieBanner(page) {
  if (!page) return;
  try {
    const result = await page.evaluate(() => {
      const rejectSel = [
        'button[id*="reject"]','button[id*="deny"]','button[id*="decline"]',
        'button[class*="reject"]','button[class*="deny"]','button[class*="decline"]',
        '[data-testid*="reject"]','button.fc-cta-do-not-consent',
        '.cmp-reject-all','.cmp-deny','#onetrust-reject-all-handler',
      ];
      const rejectTxt = [
        'rifiuta tutto','rifiuta tutti','rifiuta','reject all','reject','deny all','deny',
        'decline all','decline','solo necessari','strictly necessary only',
        'nur notwendige','alle ablehnen','tout refuser','refuser',
      ];
      const acceptSel = [
        'button[id*="accept"]','button[id*="agree"]','button[id*="consent"]',
        'button[class*="accept"]','button[class*="agree"]',
        '#onetrust-accept-btn-handler','.cmp-accept-all',
        'button.fc-cta-consent','.uc-banner__accept-button',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      ];
      const acceptTxt = [
        'accetta tutto','accetta tutti','accetta','accept all','accept','agree',
        'i agree','got it','ok','allow all','allow','consent',
        'alle akzeptieren','tout accepter','accetto','ho capito','va bene','continua',
      ];
      function tryClick(sels, txts) {
        for (const s of sels) {
          for (const el of document.querySelectorAll(s)) {
            if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') {
              try { el.click(); return el.textContent.trim().substring(0, 40); } catch { /* best-effort */ }
            }
          }
        }
        for (const el of document.querySelectorAll('button, a[role="button"], [role="button"], a.btn')) {
          const t = (el.textContent || '').trim().toLowerCase();
          if (t.length > 60) continue;
          if (txts.some(x => t === x || t.includes(x))) {
            if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') {
              try { el.click(); return t.substring(0, 40); } catch { /* best-effort */ }
            }
          }
        }
        return null;
      }
      let c = tryClick(rejectSel, rejectTxt);
      if (c) return { action: 'rejected', button: c };
      c = tryClick(acceptSel, acceptTxt);
      if (c) return { action: 'accepted', button: c };
      return null;
    });
    if (result) {
      await new Promise(r => setTimeout(r, 500));
    }
  } catch { /* best-effort */ }
}

module.exports = { dismissCookieBanner };
