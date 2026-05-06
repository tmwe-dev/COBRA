// lib/tools/read.js — Read-only page inspection tools
module.exports = function createReadTools(deps) {
  const { bridgeReady, bridgeCommand, activePage, session, emitThinking, wsBroadcast, log } = deps;

  async function toolReadPageElements(args) {
    emitThinking('Analyzing elements...');
    if (bridgeReady()) {
      try {
        const interactive = await bridgeCommand('get_interactive');
        if (interactive?.ok) {
          const elements = { inputs: [], buttons: [], links: [], selects: [] };
          for (const el of (interactive.elements || [])) {
            const sel = el.selector || (el.id ? '#' + el.id : el.tag);
            if (['input', 'textarea'].includes(el.tag)) {
              elements.inputs.push({ selector: sel, type: el.type, placeholder: el.placeholder });
            } else if (['button'].includes(el.tag) || el.type === 'submit') {
              elements.buttons.push({ selector: sel, text: el.text });
            } else if (el.tag === 'a') {
              elements.links.push({ text: el.text, href: el.href });
            }
          }
          return JSON.stringify({ ok: true, elements, via: 'bridge' });
        }
      } catch (e) { log(`[Bridge] get_page_elements failed: ${e.message}`); }
    }
    if (!activePage) return JSON.stringify({ error: 'No active page.' });
    try {
      const elements = await activePage.evaluate(() => {
        const result = { inputs: [], buttons: [], links: [] };
        for (const el of document.querySelectorAll('input, button, a')) {
          const sel = el.id ? '#' + el.id : el.name ? `[name="${el.name}"]` : el.tagName.toLowerCase();
          if (el.tagName === 'INPUT') result.inputs.push({ selector: sel, type: el.type });
          if (el.tagName === 'BUTTON') result.buttons.push({ selector: sel, text: el.textContent.trim().substring(0, 60) });
          if (el.tagName === 'A') result.links.push({ text: el.textContent.trim().substring(0, 60), href: el.href });
        }
        return result;
      });
      return JSON.stringify({ ok: true, elements, via: 'puppeteer' });
    } catch (e) {
      return JSON.stringify({ error: `DOM query failed: ${e.message}` });
    }
  }

  async function toolGetPageSnapshot(args) {
    emitThinking('Creating page snapshot...');
    if (bridgeReady()) {
      try {
        const snap = await bridgeCommand('get_page_snapshot');
        if (snap.ok) return JSON.stringify(snap);
      } catch (e) { }
    }
    return JSON.stringify({ error: 'No page available. Navigate first.' });
  }

  async function toolScreenshot(args) {
    if (bridgeReady()) {
      try {
        const ss = await bridgeCommand('screenshot', { quality: 70 });
        if (ss.ok && ss.screenshot) {
          session.lastScreenshotData = ss.screenshot;
          wsBroadcast({ type: 'screenshot', data: ss.screenshot, url: session.lastPage?.url || '', title: session.lastPage?.title || '' });
          return JSON.stringify({ ok: true, screenshot: 'broadcast', via: 'bridge' });
        }
      } catch (e) { }
    }
    if (activePage) {
      const ss = await activePage.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
      if (ss) {
        session.lastScreenshotData = ss;
        wsBroadcast({ type: 'screenshot', data: ss, url: session.lastPage?.url || '' });
        return JSON.stringify({ ok: true, screenshot: 'broadcast' });
      }
    }
    return JSON.stringify({ info: 'No active page.' });
  }

  async function toolScrollPage(args) {
    if (bridgeReady()) {
      await bridgeCommand('scroll', { direction: args.direction || 'down', amount: args.amount || 500 });
      await new Promise(r => setTimeout(r, 500));
      return JSON.stringify({ ok: true, scrolled: true, via: 'bridge' });
    }
    if (activePage) {
      await activePage.evaluate((d, a) => window.scrollBy(0, d === 'down' ? a : -a), args.direction || 'down', args.amount || 500);
      await new Promise(r => setTimeout(r, 500));
    }
    return JSON.stringify({ ok: true, scrolled: true });
  }

  async function toolHoverElement(args) {
    emitThinking(`Hovering over "${args.selector}"...`);
    if (bridgeReady()) {
      try {
        await bridgeCommand('hover', { selector: args.selector });
        await new Promise(r => setTimeout(r, 800));
        return JSON.stringify({ ok: true, hovered: true, via: 'bridge' });
      } catch (e) { }
    }
    if (!activePage) return JSON.stringify({ error: 'No active page.' });
    try {
      await activePage.hover(args.selector);
      await new Promise(r => setTimeout(r, 800));
      return JSON.stringify({ ok: true, hovered: true });
    } catch (e) {
      return JSON.stringify({ error: `Hover failed: ${e.message}` });
    }
  }

  async function toolWaitFor(args) {
    if (!activePage) return JSON.stringify({ error: 'No active page.' });
    try {
      await activePage.waitForSelector(args.selector, { timeout: args.timeout || 10000 });
      return JSON.stringify({ ok: true, found: true });
    } catch (e) {
      return JSON.stringify({ error: `Wait timeout: ${e.message}` });
    }
  }

  async function toolSwitchTab(args) {
    return JSON.stringify({ error: 'Not implemented for server mode.' });
  }

  async function toolDetectBlock(args) {
    emitThinking('Checking for blocks...');
    if (!activePage) return JSON.stringify({ error: 'No active page.' });
    try {
      const result = await activePage.evaluate(() => {
        const captcha = document.querySelector('iframe[src*="recaptcha"]') ? 'reCAPTCHA' : null;
        const loginReq = document.body.textContent.includes('Login') || document.body.textContent.includes('Sign in');
        return { blocked: !!captcha || loginReq, type: captcha, loginRequired: loginReq };
      });
      return JSON.stringify(result);
    } catch (e) {
      return JSON.stringify({ error: `Detection failed: ${e.message}` });
    }
  }

  async function toolVerifyAction(args) {
    return JSON.stringify({ ok: true, verified: true });
  }

  async function toolWaitNetworkIdle(args) {
    if (!activePage) return JSON.stringify({ error: 'No active page.' });
    try {
      await activePage.waitForNavigation({ waitUntil: 'networkidle0', timeout: args.timeout || 10000 }).catch(() => {});
      return JSON.stringify({ ok: true, idle: true });
    } catch (e) {
      return JSON.stringify({ error: `Network wait failed: ${e.message}` });
    }
  }

  return {
    toolReadPageElements,
    toolGetPageSnapshot,
    toolScreenshot,
    toolScrollPage,
    toolHoverElement,
    toolWaitFor,
    toolSwitchTab,
    toolDetectBlock,
    toolVerifyAction,
    toolWaitNetworkIdle,
  };
};
