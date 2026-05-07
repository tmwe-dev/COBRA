// modules/browser/pages.js — Page management, cookies, captcha detection
// Source: server.js lines 1953-2129

const { getOrCreateBrowser, getState, setState } = require('./browser');

async function getActivePage(url) {
  const browser = await getOrCreateBrowser();
  let page = getState('activePage');
  const cookieJar = getState('cookieJar');
  const { dismissCookieBanner } = require('./cookie-banner');

  if (page && url) {
    try {
      const curDomain = new URL(page.url()).hostname;
      const newDomain = new URL(url).hostname;
      if (curDomain === newDomain) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        try { await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }); } catch { /* best-effort */ }
        await dismissCookieBanner(page);
        return page;
      }
    } catch { /* best-effort */ }
    await _saveCookies();
    try { await page.close(); } catch { /* best-effort */ }
    page = null; setState('activePage', null);
  }

  if (!page) {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    setState('activePage', page);
  }

  if (url) {
    await _restoreCookies(url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    try { await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }); } catch { /* best-effort */ }
    await dismissCookieBanner(page);
  }
  return page;
}

async function _saveCookies() {
  const page = getState('activePage');
  const jar = getState('cookieJar');
  if (!page) return;
  try {
    const cookies = await page.cookies();
    if (cookies.length > 0) jar.set(new URL(page.url()).hostname, cookies);
  } catch { /* best-effort */ }
}

async function _restoreCookies(url) {
  const page = getState('activePage');
  const jar = getState('cookieJar');
  if (!page) return;
  try {
    const domain = new URL(url).hostname;
    for (const [stored, cookies] of jar.entries()) {
      if (domain === stored || domain.endsWith('.' + stored)) { await page.setCookie(...cookies); break; }
    }
  } catch { /* best-effort */ }
}

async function detectCaptcha(page) {
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      const html = document.documentElement.innerHTML.toLowerCase();
      const checks = [
        { sel: 'iframe[src*="recaptcha"]', type: 'reCAPTCHA' },
        { sel: 'iframe[src*="hcaptcha"]', type: 'hCaptcha' },
        { sel: '.cf-turnstile', type: 'Cloudflare Turnstile' },
        { sel: '#captcha', type: 'CAPTCHA generico' },
        { sel: '[class*="captcha"]', type: 'CAPTCHA generico' },
      ];
      for (const { sel, type } of checks) { if (document.querySelector(sel)) return type; }
      if (html.includes('verify you are human') || html.includes('verifica che sei umano')) return 'Verifica umana';
      return null;
    });
  } catch { return null; }
}

module.exports = { getActivePage, _saveCookies, _restoreCookies, detectCaptcha };
