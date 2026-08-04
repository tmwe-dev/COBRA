// modules/ws/server.js — WebSocket server, bridge protocol, broadcast
// Source: server.js lines 7810-7935

const WebSocketLib = require('ws');

let wss = null;
const wsClients = new Set();
let _bridgeClient = null;
let _bridgeCapabilities = [];
const _bridgePending = new Map();

function setupWebSocket(httpServer, ctx) {
  wss = new WebSocketLib.Server({ server: httpServer });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.isAlive = true;
    ws._authenticated = false;
    ws._isWebApp = false;
    console.log(`[WS] ${wsClients.size} client(s) connected`);
    try { ws.send(JSON.stringify({ type: 'ws_connected', ts: Date.now(), clients: wsClients.size })); }
    catch (e) { ctx.log(`[WS] welcome error: ${e.message}`); }

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // WebApp client identification
        if (msg.type === 'webapp_hello') { ws._isWebApp = true; return; }

        // Battito dell'estensione: tiene sveglio il service worker, nessuna azione
        if (msg.type === 'keepalive') {
          ws.isAlive = true;
          try { ws.send(JSON.stringify({ type: 'keepalive_ack', ts: Date.now() })); } catch { /* best-effort */ }
          return;
        }

        // Auth gate — webapp messages pass without bridge auth
        const WEBAPP_ALLOWED = ['ext_result', 'human_takeover_resume', 'navigate'];
        const isBridgeMsg = !ws._isWebApp && !WEBAPP_ALLOWED.includes(msg.type);
        if (isBridgeMsg && !ws._authenticated && msg.type !== 'bridge_connect') {
          ctx.log(`[Security] WS message "${msg.type}" REJECTED — not authenticated`);
          ws.send(JSON.stringify({ type: 'auth_required', rejected: msg.type }));
          return;
        }

        // Webapp messages
        if (msg.type === 'navigate' && msg.url) ctx.executeTool('navigate', { url: msg.url }).catch(() => {});
        if (msg.type === 'ext_result' && msg.requestId) ctx.handleExtResult(msg);
        if (msg.type === 'human_takeover_resume') {
          ctx.log('[HumanTakeover] Operator resumed via WebSocket button');
          ctx.session.humanTakeover = false;
          if (ctx.session.humanTakeoverResolve) { ctx.session.humanTakeoverResolve(); ctx.session.humanTakeoverResolve = null; }
        }

        // Bridge extension protocol
        if (msg.type === 'bridge_connect') {
          const validToken = msg.token === ctx.BRIDGE_SESSION_TOKEN || msg.token === ctx.COBRA_API_TOKEN;
          if (!validToken) {
            ctx.log(`[Security] Bridge connection REJECTED — invalid token`);
            ws.send(JSON.stringify({ type: 'bridge_auth_failed', reason: 'Invalid token' }));
            return;
          }
          if (_bridgeClient && _bridgeClient.readyState === WebSocketLib.OPEN && _bridgeClient !== ws) {
            ctx.log('[Security] Existing bridge replaced');
            _bridgeClient.send(JSON.stringify({ type: 'bridge_replaced' }));
          }
          ws._authenticated = true;
          _bridgeClient = ws;
          _bridgeCapabilities = msg.capabilities || [];
          ctx.log(`[Bridge] Chrome extension connected: ${(msg.userAgent || '').substring(0, 50)}`);
          ws.send(JSON.stringify({ type: 'bridge_auth_ok', ts: Date.now() }));
          wsBroadcast({ type: 'ai_reasoning', text: '🔌 Estensione Chrome COBRA Bridge connessa', icon: '✅' });
          wsBroadcast({ type: 'bridge_status', connected: true, capabilities: _bridgeCapabilities });
        }

        // Bridge authenticated messages
        if (msg.type === 'bridge_result' && msg.id && ws._authenticated) {
          const cb = _bridgePending.get(msg.id);
          if (cb) { _bridgePending.delete(msg.id); cb(msg.result); }
        }
        if (msg.type === 'delegate_to_app' && msg.id && msg.task && ws._authenticated) {
          ctx.handleDelegateFromExtension(ws, msg).catch(e => {
            ctx.log(`[Bridge] Delegate error: ${e.message}`);
            try { ws.send(JSON.stringify({ type: 'delegate_result', id: msg.id, result: { ok: false, error: e.message } })); } catch (_) { /* best-effort */ }
          });
        }
      } catch (e) { ctx.log(`[WS] message parse error: ${e.message}`); }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      if (ws === _bridgeClient) {
        _bridgeClient = null;
        ctx.log('[Bridge] Chrome extension disconnected');
        wsBroadcast({ type: 'bridge_status', connected: false });
      }
      console.log(`[WS] client disconnected, ${wsClients.size} remaining`);
    });
    ws.on('error', () => { wsClients.delete(ws); });
  });

  // Heartbeat every 15s (più aggressivo per detect disconnessioni rapide)
  setInterval(() => {
    for (const ws of wsClients) {
      if (!ws.isAlive) {
        wsClients.delete(ws);
        if (ws === _bridgeClient) {
          _bridgeClient = null;
          ctx.log('[Bridge] Heartbeat timeout — bridge disconnected');
          wsBroadcast({ type: 'bridge_status', connected: false, reason: 'heartbeat_timeout' });
        }
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { wsClients.delete(ws); }
    }
  }, 15000);

  // Battito applicativo ogni 20 secondi.
  // L'estensione è un service worker Manifest V3: Chrome lo sospende dopo circa
  // 30 secondi di inattività, e alla sospensione il bridge cade. I ping del
  // protocollo WebSocket non risvegliano il worker perché non arrivano al
  // codice JavaScript; un messaggio applicativo sì. Con 20s si resta sotto la
  // soglia con margine e la connessione non si interrompe più.
  setInterval(() => {
    wsBroadcast({ type: 'server_heartbeat', ts: Date.now(), bridge: isBridgeReady(), clients: wsClients.size });
  }, 20000);

  return wss;
}

function wsBroadcast(data) {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocketLib.OPEN) {
      try { ws.send(msg); } catch { wsClients.delete(ws); }
    }
  }
}

function broadcastFile(opts) {
  wsBroadcast({ type: 'monitor_file', ...opts });
}

function isBridgeReady() { return !!_bridgeClient && _bridgeClient.readyState === WebSocketLib.OPEN; }
function getBridgeClient() { return _bridgeClient; }
function getBridgeCapabilities() { return _bridgeCapabilities; }
function getBridgePending() { return _bridgePending; }
function getWsClients() { return wsClients; }

module.exports = {
  setupWebSocket, wsBroadcast, broadcastFile,
  isBridgeReady, getBridgeClient, getBridgeCapabilities, getBridgePending, getWsClients,
};
