// modules/browser/browser.js — Puppeteer browser lifecycle + shared state
// Source: server.js lines 1908-1946

let _browser = null;
let _activePage = null;
let _popupPages = [];
const _cookieJar = new Map();

const _state = { activePage: null };

function getState(key) {
  if (key === 'activePage') return _activePage;
  if (key === 'popupPages') return _popupPages;
  if (key === 'cookieJar') return _cookieJar;
  if (key === 'browser') return _browser;
  return undefined;
}

function setState(key, val) {
  if (key === 'activePage') _activePage = val;
}

async function getOrCreateBrowser() {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch { throw new Error('puppeteer non installato'); }
  if (_browser && _browser.isConnected()) return _browser;
  const headlessMode = process.env.COBRA_HEADLESS !== 'false' ? 'new' : false;
  const path = require('path');
  const os = require('os');
  const COBRA_USER_DATA = process.env.COBRA_PROFILE_DIR || path.join(os.homedir(), '.cobra-browser-profile');
  _browser = await puppeteer.launch({
    headless: headlessMode,
    userDataDir: COBRA_USER_DATA,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
           '--disable-blink-features=AutomationControlled',
           ...(headlessMode === false ? ['--window-size=1280,900'] : [])],
    ...(headlessMode === false ? { defaultViewport: { width: 1280, height: 900 } } : {}),
  });
  _browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const newPage = await target.page();
        if (newPage && newPage !== _activePage) _popupPages.push(newPage);
      } catch { /* best-effort */ }
    }
  });
  return _browser;
}

module.exports = { getOrCreateBrowser, getState, setState };
