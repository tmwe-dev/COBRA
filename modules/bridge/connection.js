// Bridge - WebSocket Connection Management
let _bridgeSocket = null;
let _bridgeReady = false;
let _pendingBridgeRequests = new Map();
let _bridgeRequestId = 0;

function isBridgeReady() {
  return _bridgeReady && _bridgeSocket && _bridgeSocket.readyState === 1; // WebSocket.OPEN
}

async function bridgeCommand(command, args = {}) {
  if (!isBridgeReady()) {
    throw new Error('Bridge not ready');
  }
  return new Promise((resolve, reject) => {
    const id = ++_bridgeRequestId;
    const timeout = setTimeout(() => {
      _pendingBridgeRequests.delete(id);
      reject(new Error(`Bridge command timeout: ${command}`));
    }, 15000);

    _pendingBridgeRequests.set(id, { resolve, reject, timeout });
    // Protocollo atteso dall'estensione (cobra-extension/background.js): bridge_command
    _bridgeSocket.send(JSON.stringify({ type: 'bridge_command', id, command, args }));
  });
}

function setBridgeSocket(socket) {
  _bridgeSocket = socket;
  _bridgeReady = true;
}

function setBridgeReady(ready) {
  _bridgeReady = ready;
}

function getPendingBridgeRequests() {
  return _pendingBridgeRequests;
}

// ── Bridge Navigation (merged from navigate.js) ──
async function bridgeNavigate(url, wsBroadcast, log) {
  const navResult = await bridgeCommand('navigate', { url });
  if (!navResult.ok) return navResult;

  await new Promise(r => setTimeout(r, 2000));

  // Auto-dismiss cookie con retry
  let cookieResult = await bridgeCommand('dismiss_cookies');
  if (cookieResult?.action === 'no_banner') {
    await new Promise(r => setTimeout(r, 2000));
    cookieResult = await bridgeCommand('dismiss_cookies');
  }
  if (cookieResult?.action && cookieResult.action !== 'no_banner') {
    if (log) log(`[Cookie] Bridge dismiss: ${cookieResult.action} "${cookieResult.button || ''}"`);
    await new Promise(r => setTimeout(r, 500));
  }

  // Auto-dismiss overlay/splash
  const overlayResult = await bridgeCommand('dismiss_overlay');
  if (overlayResult?.action && overlayResult.action !== 'no_overlay') {
    if (log) log(`[Overlay] Bridge dismiss: ${overlayResult.action} "${overlayResult.button || ''}"`);
    await new Promise(r => setTimeout(r, 1000));
    const overlay2 = await bridgeCommand('dismiss_overlay');
    if (overlay2?.action && overlay2.action !== 'no_overlay') {
      if (log) log(`[Overlay] Bridge dismiss (2nd): ${overlay2.action} "${overlay2.button || ''}"`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Screenshot
  const ssResult = await bridgeCommand('screenshot', { quality: 70 });
  if (ssResult.ok && ssResult.screenshot && wsBroadcast) {
    wsBroadcast({ type: 'screenshot', data: ssResult.screenshot, url, title: '' });
  }

  const contentResult = await bridgeCommand('get_page_content');
  return { ok: true, url, screenshot: ssResult?.screenshot, content: contentResult };
}

module.exports = {
  isBridgeReady,
  bridgeCommand,
  bridgeNavigate,
  setBridgeSocket,
  setBridgeReady,
  getPendingBridgeRequests,
};
