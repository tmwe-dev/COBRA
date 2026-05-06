// ══════════════════════════════════════════════════════════════
// lib/bridge.js — Chrome Extension Bridge Communication
// Extracted from server.js lines 7410-7593
// ══════════════════════════════════════════════════════════════

module.exports = function createBridge(deps) {
  const { log, wsBroadcast, session, WebSocketLib } = deps;

  let _bridgeClient = null;
  let _bridgePending = new Map();

  async function bridgeCommand(command, args = {}) {
    if (!_bridgeClient || _bridgeClient.readyState !== WebSocketLib.OPEN) {
      return { ok: false, error: 'Bridge non connesso. Installa l\'estensione COBRA Bridge.' };
    }

    const _bridgeCmdLabels = {
      navigate: 'navigare su ' + (args.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
      click: 'cliccare su ' + (args.selector || '').substring(0, 40),
      fill_form: 'compilare form',
      screenshot: 'catturare screenshot',
      get_page_content: 'leggere contenuto pagina',
      get_page_elements: 'analizzare elementi pagina',
      scroll: 'scrollare pagina',
      hover: 'hover su elemento',
      type_human: 'digitare testo',
      dismiss_cookies: 'chiudere popup cookie',
      dismiss_overlay: 'chiudere overlay/splash',
      detect_block: 'verificare blocchi',
      select_dropdown: 'selezionare opzione',
      set_datepicker: 'impostare data',
      read_table: 'leggere tabella',
    };
    const cmdLabel = _bridgeCmdLabels[command] || command;
    if (!['screenshot', 'dismiss_cookies', 'dismiss_overlay', 'get_url', 'get_page_content', 'get_page_elements', 'get_page_snapshot'].includes(command)) {
      wsBroadcast({ type: 'bridge_activity', direction: 'to_extension', command, label: cmdLabel });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    return new Promise((resolve) => {
      let resolved = false;
      const timeoutMs = ['get_interactive', 'get_page_content', 'get_page_snapshot', 'type_human'].includes(command) ? 25000 : 15000;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          _bridgePending.delete(id);
          resolve({ ok: false, error: `Bridge timeout (${timeoutMs/1000}s)` });
        }
      }, timeoutMs);
      _bridgePending.set(id, (result) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (!['screenshot', 'dismiss_cookies', 'dismiss_overlay', 'get_url', 'get_page_content', 'get_page_elements', 'get_page_snapshot'].includes(command)) {
            wsBroadcast({ type: 'bridge_activity', direction: 'extension_done', command, label: cmdLabel, ok: result?.ok !== false });
          }
          resolve(result);
        }
      });
      _bridgeClient.send(JSON.stringify({ type: 'bridge_command', id, command, args }));
    });
  }

  function isBridgeReady() {
    return _bridgeClient && _bridgeClient.readyState === WebSocketLib.OPEN;
  }

  async function bridgeNavigate(url) {
    const navResult = await bridgeCommand('navigate', { url });
    if (!navResult.ok) return navResult;

    await new Promise(r => setTimeout(r, 2000));

    let cookieResult = await bridgeCommand('dismiss_cookies');
    if (cookieResult?.action === 'no_banner') {
      await new Promise(r => setTimeout(r, 2000));
      cookieResult = await bridgeCommand('dismiss_cookies');
    }
    if (cookieResult?.action && cookieResult.action !== 'no_banner') {
      log(`[Cookie] Bridge dismiss: ${cookieResult.action}`);
      await new Promise(r => setTimeout(r, 500));
    }

    const overlayResult = await bridgeCommand('dismiss_overlay');
    if (overlayResult?.action && overlayResult.action !== 'no_overlay') {
      log(`[Overlay] Bridge dismiss: ${overlayResult.action}`);
      await new Promise(r => setTimeout(r, 1000));
      const overlay2 = await bridgeCommand('dismiss_overlay');
      if (overlay2?.action && overlay2.action !== 'no_overlay') {
        log(`[Overlay] Bridge dismiss (2nd): ${overlay2.action}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const ssResult = await bridgeCommand('screenshot', { quality: 70 });
    if (ssResult.ok && ssResult.screenshot) {
      session.lastScreenshotData = ssResult.screenshot;
      session.lastBroadcastUrl = url;
      wsBroadcast({ type: 'screenshot', data: ssResult.screenshot, url, title: '' });
    }

    const contentResult = await bridgeCommand('get_page_content');
    return { ok: true, url, screenshot: ssResult?.screenshot, content: contentResult };
  }

  async function bridgeClick(selector) {
    const result = await bridgeCommand('click', { selector });
    await new Promise(r => setTimeout(r, 2500));
    const ssResult = await bridgeCommand('screenshot', { quality: 70 });
    if (ssResult.ok && ssResult.screenshot) {
      wsBroadcast({ type: 'screenshot', data: ssResult.screenshot, url: session.lastPage?.url || '', title: session.lastPage?.title || '' });
    }
    const urlResult = await bridgeCommand('get_url');
    return { ...result, newUrl: urlResult?.url, newTitle: urlResult?.title };
  }

  async function bridgeFillForm(fields) {
    const result = await bridgeCommand('fill_form', { fields });
    await new Promise(r => setTimeout(r, 500));
    const ssResult = await bridgeCommand('screenshot', { quality: 70 });
    if (ssResult.ok && ssResult.screenshot) {
      wsBroadcast({ type: 'screenshot', data: ssResult.screenshot, url: session.lastPage?.url || '', title: session.lastPage?.title || '' });
    }
    return result;
  }

  async function bridgeTypeHuman(text, selector, delay = 80) {
    return await bridgeCommand('type_human', { text, selector, delay });
  }

  async function bridgeDetectBlock() {
    return await bridgeCommand('detect_block');
  }

  async function bridgeRequestHuman(reason) {
    return await bridgeCommand('request_human', { reason });
  }

  function setBridgeClient(client) {
    _bridgeClient = client;
  }

  function getBridgePending() {
    return _bridgePending;
  }

  return {
    bridgeCommand,
    isBridgeReady,
    bridgeNavigate,
    bridgeClick,
    bridgeFillForm,
    bridgeTypeHuman,
    bridgeDetectBlock,
    bridgeRequestHuman,
    setBridgeClient,
    getBridgePending,
  };
};
