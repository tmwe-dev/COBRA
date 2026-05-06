// lib/ws-handler.js — WebSocket connection handler
// Extracted from server.js lines 7594-7693

module.exports = function createWsHandler(deps) {
  const { WebSocketLib, log, wsBroadcast, wsClients, session,
    BRIDGE_SESSION_TOKEN, COBRA_API_TOKEN,
    _bridgeState, executeTool, handleExtResult,
    _handleDelegateFromExtension } = deps;

  function setupWebSocket(httpServer) {
    const wss = new WebSocketLib.Server({ server: httpServer });
    wss.on('connection', (ws) => {
      wsClients.add(ws);
      ws.isAlive = true;
      ws._authenticated = false;
      ws._isWebApp = false;
      console.log(`[WS] ${wsClients.size} client(s) connected`);
      try { ws.send(JSON.stringify({ type: 'ws_connected', ts: Date.now(), clients: wsClients.size })); } catch (e) { log(`[WS] welcome error: ${e.message}`); }
      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === 'webapp_hello') { ws._isWebApp = true; return; }

          const WEBAPP_ALLOWED = ['ext_result', 'human_takeover_resume', 'navigate'];
          const isBridgeMsg = !ws._isWebApp && !WEBAPP_ALLOWED.includes(msg.type);
          if (isBridgeMsg && !ws._authenticated && msg.type !== 'bridge_connect') {
            log(`[Security] WS message "${msg.type}" REJECTED — not authenticated`);
            ws.send(JSON.stringify({ type: 'auth_required', rejected: msg.type }));
            return;
          }

          // Webapp messages
          if (msg.type === 'navigate' && msg.url) executeTool('navigate', { url: msg.url }).catch(() => {});
          if (msg.type === 'ext_result' && msg.requestId) handleExtResult(msg);
          if (msg.type === 'human_takeover_resume') {
            log('[HumanTakeover] Operator resumed via WebSocket button');
            session.humanTakeover = false;
            if (session.humanTakeoverResolve) { session.humanTakeoverResolve(); session.humanTakeoverResolve = null; }
          }

          // Bridge protocol
          if (msg.type === 'bridge_connect') {
            const validToken = msg.token === BRIDGE_SESSION_TOKEN || msg.token === COBRA_API_TOKEN;
            if (!validToken) {
              log(`[Security] Bridge connection REJECTED — invalid token`);
              ws.send(JSON.stringify({ type: 'bridge_auth_failed', reason: 'Invalid token' }));
              return;
            }
            if (_bridgeState.client && _bridgeState.client.readyState === WebSocketLib.OPEN && _bridgeState.client !== ws) {
              log('[Security] Existing bridge replaced');
              _bridgeState.client.send(JSON.stringify({ type: 'bridge_replaced' }));
            }
            ws._authenticated = true;
            _bridgeState.client = ws;
            _bridgeState.capabilities = msg.capabilities || [];
            log(`[Bridge] Chrome extension connected: ${msg.userAgent?.substring(0, 50) || 'unknown'}`);
            ws.send(JSON.stringify({ type: 'bridge_auth_ok', ts: Date.now() }));
            wsBroadcast({ type: 'ai_reasoning', text: '🔌 Estensione Chrome COBRA Bridge connessa', icon: '✅' });
            wsBroadcast({ type: 'bridge_status', connected: true, capabilities: _bridgeState.capabilities });
          }

          if (msg.type === 'bridge_result' && msg.id && ws._authenticated) {
            const cb = _bridgeState.pending.get(msg.id);
            if (cb) { _bridgeState.pending.delete(msg.id); cb(msg.result); }
          }
          if (msg.type === 'delegate_to_app' && msg.id && msg.task && ws._authenticated) {
            _handleDelegateFromExtension(ws, msg).catch(e => {
              log(`[Bridge] Delegate error: ${e.message}`);
              try { ws.send(JSON.stringify({ type: 'delegate_result', id: msg.id, result: { ok: false, error: e.message } })); } catch (e2) { }
            });
          }
        } catch (e) { log(`[WS] message parse error: ${e.message}`); }
      });

      ws.on('close', () => {
        wsClients.delete(ws);
        if (ws === _bridgeState.client) {
          _bridgeState.client = null;
          log('[Bridge] Chrome extension disconnected');
          wsBroadcast({ type: 'bridge_status', connected: false });
        }
        console.log(`[WS] client disconnected, ${wsClients.size} remaining`);
      });
      ws.on('error', () => { wsClients.delete(ws); });
    });

    // Heartbeat every 30s
    setInterval(() => {
      for (const ws of wsClients) {
        if (!ws.isAlive) { ws.terminate(); wsClients.delete(ws); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { wsClients.delete(ws); }
      }
    }, 30000);

    return wss;
  }

  return { setupWebSocket };
};
