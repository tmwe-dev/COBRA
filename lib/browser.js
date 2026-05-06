// lib/browser.js — Browser automation wrapper (Puppeteer)
module.exports = function createBrowser(deps) {
  const { log, puppeteer, wsBroadcast } = deps;
  let _browser = null;
  let _activePage = null;
  let _cookieJar = new Map();

  async function getOrCreateBrowser() {
    if (!puppeteer) throw new Error('puppeteer not installed');
    if (_browser && _browser.isConnected()) return _browser;
    const headlessMode = process.env.COBRA_HEADLESS !== 'false' ? 'new' : false;
    _browser = await puppeteer.launch({
      headless: headlessMode,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    log(`[Browser] Started in ${headlessMode === false ? 'VISIBLE' : 'headless'} mode`);
    return _browser;
  }

  async function getActivePage(url) {
    const browser = await getOrCreateBrowser();
    if (_activePage && url) {
      try {
        const currentDomain = new URL(_activePage.url()).hostname;
        const newDomain = new URL(url).hostname;
        if (currentDomain === newDomain) {
          await _activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          return _activePage;
        }
      } catch {}
    }

    if (!_activePage) {
      _activePage = await browser.newPage();
      await _activePage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
      await _activePage.setViewport({ width: 1280, height: 800 });
    }

    if (url) {
      await _activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    return _activePage;
  }

  async function takeActiveScreenshot(url, title) {
    if (!_activePage) return null;
    try {
      const ss = await _activePage.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
      if (ss) {
        wsBroadcast({ type: 'screenshot', data: ss, url: url || '', title: title || '' });
      }
      return ss;
    } catch (e) {
      log(`[Browser] Screenshot failed: ${e.message}`);
      return null;
    }
  }

  async function smartScrape(url, options = {}) {
    const { timeout = 12000 } = options;
    const page = await getOrCreateBrowser().then(b => b.newPage());
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      const result = await page.evaluate(() => {
        const markdown = document.body.innerText;
        const metadata = {
          title: document.title,
          url: document.location.href,
          description: document.querySelector('meta[name="description"]')?.content || '',
        };
        const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim(), href: a.href })).slice(0, 50);
        return { markdown, metadata, links, stats: { chars: markdown.length, words: markdown.split(/\s+/).length } };
      });
      let screenshot = null;
      try {
        screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
      } catch {}
      result.screenshot = screenshot;
      return result;
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { getOrCreateBrowser, getActivePage, takeActiveScreenshot, smartScrape };
};
