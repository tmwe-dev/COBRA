// lib/http-routes.js — HTTP API route handlers
// Extracted from server.js lines 7724-8871

const fs = require('fs');
const path = require('path');

module.exports = function createHttpHandler(deps) {
  const { log, wsBroadcast, session, toolHistory, aiKeys, PORT,
    APP_VERSION, APP_BUILD, ALLOWED_ORIGINS, COBRA_DEFAULTS, COBRA_TOOLS,
    isAuthenticatedRequest, MAX_BODY_SIZE, broadcastFile, BRIDGE_SESSION_TOKEN,
    CobraSupervisor, conversationEngine, SuperMario, TokenMeter, ResponseRecorder,
    CobraPersona, CobraPersonaLearner, HumanDriver, ResearchStrategy,
    getActivePendingActions, approvePendingAction, rejectPendingAction,
    getFeedbackStats, _pendingActions, isBridgeReady, _bridgeCapabilities,
    computeEffectiveRisk, classifyUrlRisk, classifyClickIntent, classifyIntent,
    handleChat, searchKB, serverLogs, wsClients, SUPABASE_URL, SUPABASE_ANON_KEY,
    loadAPIKeys, loadOperatorConfig, KB_ENTRIES } = deps;

  const publicDir = path.resolve(path.join(__dirname, '..'), 'public');

  async function handleRequest(req, res) {
    // CORS
    const reqOrigin = req.headers.origin || '';
    const allowedOrigin = ALLOWED_ORIGINS.find(o => reqOrigin.startsWith(o)) || ALLOWED_ORIGINS[0];
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cobra-Token');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const pathname = new URL(req.url, 'http://localhost').pathname;

    // Auth check
    if (pathname.startsWith('/api/') && !isAuthenticatedRequest(req)) {
      log(`[Security] Unauthorized API request blocked: ${req.method} ${pathname}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Provide X-Cobra-Token header.' }));
      return;
    }

    // API: Monitor File
    if (req.method === 'POST' && req.url === '/api/monitor/file') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        try { broadcastFile(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
        catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // API: Bridge Token
    if (req.method === 'GET' && req.url === '/api/bridge-token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: BRIDGE_SESSION_TOKEN }));
      return;
    }

    // API: Chat
    if (req.method === 'POST' && req.url === '/api/chat') {
      let body = '', _bodySize = 0;
      req.on('data', chunk => { _bodySize += chunk.length; if (_bodySize > MAX_BODY_SIZE) { req.destroy(); return; } body += chunk; });
      req.on('end', async () => {
        try {
          const { message, voiceMode } = JSON.parse(body);
          if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'No message' })); return; }
          const result = await handleChat(message, voiceMode);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          log('Chat error: ' + e.message);
          CobraSupervisor.failRequest(e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: 'Errore server: ' + e.message, provider: 'none' }));
          wsBroadcast({ type: 'thinking', text: '' });
          wsBroadcast({ type: 'page_loaded', url: '', title: '' });
        }
      });
      return;
    }

    // API: Abort
    if (req.method === 'POST' && req.url === '/api/chat/abort') {
      session.chatAborted = true; CobraSupervisor.abort(); wsBroadcast({ type: 'chat_aborted' });
      log('[Chat] Abort requested by user');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
    }

    // API: Chat Clear
    if (req.method === 'POST' && req.url === '/api/chat/clear') {
      try {
        const oldConv = conversationEngine.getActiveConversation();
        if (oldConv) { const oldMem = conversationEngine.chatMemories.get(oldConv.id); if (oldMem) oldMem.clear(); }
        const newConv = conversationEngine.createConversation('Nuova Chat');
        conversationEngine.activeConversationId = newConv.id;
        session.lastPage = null; toolHistory.length = 0; session.kbSnippets = [];
      } catch (e) { log(`[Chat] Clear error: ${e.message}`); }
      if (SuperMario && SuperMario.clearSummaryCache) SuperMario.clearSummaryCache();
      log('[Chat] Conversation cleared');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
    }

    // API: TTS
    if (req.method === 'POST' && req.url === '/api/tts') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { text } = JSON.parse(body);
          if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'No text' })); return; }
          if (!aiKeys.elevenlabsKey) { res.writeHead(400); res.end(JSON.stringify({ error: 'ElevenLabs API key non configurata' })); return; }
          const _ttsStart = Date.now();
          const voiceId = aiKeys.elevenlabsVoiceId || COBRA_DEFAULTS.ELEVENLABS_VOICE_ID;
          const modelId = aiKeys.elevenlabsModel || COBRA_DEFAULTS.ELEVENLABS_MODEL;
          const ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
            method: 'POST', headers: { 'xi-api-key': aiKeys.elevenlabsKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text.substring(0, 5000), model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }, language_code: 'it' }),
          });
          if (!ttsResp.ok) { const err = await ttsResp.text().catch(() => ''); res.writeHead(ttsResp.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `ElevenLabs HTTP ${ttsResp.status}` })); return; }
          const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
          ResponseRecorder.recordTTS({ text, voiceId, model: modelId, durationMs: Date.now() - _ttsStart, charCount: text.length, success: true });
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.length }); res.end(audioBuffer);
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // API: TTS Voices
    if (req.url === '/api/tts/voices') {
      try {
        if (!aiKeys.elevenlabsKey) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ voices: [], error: 'No ElevenLabs key' })); return; }
        const vResp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': aiKeys.elevenlabsKey } });
        if (!vResp.ok) throw new Error(`HTTP ${vResp.status}`);
        const data = await vResp.json();
        const voices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, language: v.labels?.language, gender: v.labels?.gender }));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ voices, current: aiKeys.elevenlabsVoiceId }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // API: Response Log
    if (req.url === '/api/response-log') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ResponseRecorder.getLog())); return; }
    if (req.url === '/api/response-log/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ResponseRecorder.getStats())); return; }
    if (req.url === '/api/response-log/export/json') {
      const data = JSON.stringify(ResponseRecorder.exportJSON(), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="cobra-responses-${new Date().toISOString().split('T')[0]}.json"` }); res.end(data); return;
    }
    if (req.url === '/api/response-log/export/csv') {
      const csv = ResponseRecorder.exportCSV();
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="cobra-responses-${new Date().toISOString().split('T')[0]}.csv"` }); res.end(csv); return;
    }
    if (req.url === '/api/response-log/export/txt') {
      const txt = ResponseRecorder.exportConversation();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="cobra-conversazioni-${new Date().toISOString().split('T')[0]}.txt"` }); res.end(txt); return;
    }
    if (req.url === '/api/response-log/problems') {
      const problems = ResponseRecorder.getLog({ hasFlags: ['raw_url_list', 'excessive_bullets', 'robot_opener', 'heavy_markdown', 'ai_self_reference', 'raw_urls_shown', 'possible_copypaste'] });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ count: problems.length, entries: problems })); return;
    }
    if (req.method === 'DELETE' && req.url === '/api/response-log') {
      ResponseRecorder._log = [];
      try { fs.writeFileSync(ResponseRecorder._filePath, ''); } catch (e) { log(`[Recorder] reset error: ${e.message}`); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: 'Log cancellato' })); return;
    }

    // API: Config Keys
    if (req.method === 'POST' && req.url === '/api/config/keys') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const cfg = JSON.parse(body);
          if (cfg.openai) aiKeys.openaiKey = cfg.openai; if (cfg.anthropic) aiKeys.anthropicKey = cfg.anthropic;
          if (cfg.gemini) aiKeys.geminiKey = cfg.gemini; if (cfg.groq) aiKeys.groqKey = cfg.groq;
          if (cfg.elevenlabs) aiKeys.elevenlabsKey = cfg.elevenlabs;
          if (cfg.openaiModel) aiKeys.openaiModel = cfg.openaiModel; if (cfg.anthropicModel) aiKeys.anthropicModel = cfg.anthropicModel;
          if (cfg.geminiModel) aiKeys.geminiModel = cfg.geminiModel;
          const active = Object.keys(aiKeys).filter(k => k.endsWith('Key') && aiKeys[k]).map(k => k.replace('Key', ''));
          log(`[API Keys] Configurate: ${active.join(', ')}`);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, providers: active }));
        } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'JSON non valido' })); }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/config/keys') {
      const active = Object.keys(aiKeys).filter(k => k.endsWith('Key') && aiKeys[k]).map(k => k.replace('Key', ''));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ providers: active, hasKeys: active.length > 0 })); return;
    }

    // API: Config Email
    if (req.method === 'POST' && req.url === '/api/config/email') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const cfg = JSON.parse(body); session.emailConfig = { ...session.emailConfig, ...cfg };
          log('[Email Config] Updated: ' + Object.keys(cfg).join(', '));
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'JSON non valido' })); }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/config/email') {
      const safe = { ...session.emailConfig }; if (safe.pass) safe.pass = '***';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(safe)); return;
    }

    // API: Pending Actions
    if (req.url === '/api/pending-actions' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ pending_actions: getActivePendingActions() })); return;
    }
    if (req.url?.startsWith('/api/pending-actions/') && req.url.endsWith('/approve') && req.method === 'POST') {
      const id = req.url.split('/')[3]; const result = approvePendingAction(id, 'operator');
      if (result.ok) { session.currentApprovalToken = result.approval_token; wsBroadcast({ type: 'pending_action_approved', id, approval_token: result.approval_token }); log(`[Security] Pending action ${id} APPROVED`); }
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
    }
    if (req.url?.startsWith('/api/pending-actions/') && req.url.endsWith('/reject') && req.method === 'POST') {
      const id = req.url.split('/')[3]; const result = rejectPendingAction(id, 'operator');
      if (result.ok) { wsBroadcast({ type: 'pending_action_rejected', id }); log(`[Security] Pending action ${id} REJECTED`); }
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
    }

    // API: Token Meter
    if (req.url === '/api/token-meter') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(TokenMeter.getStatus())); return; }
    if (req.method === 'DELETE' && req.url === '/api/token-meter') { TokenMeter.reset(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }

    // API: Page Preview (sanitized)
    if (req.url.startsWith('/api/page-preview')) {
      if (session.lastPage && session.lastPage.html) {
        let html = session.lastPage.html;
        try { const base = new URL(session.lastPage.url).origin; if (!/<base\s/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}/">`); } catch (e) { }
        html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '<!-- script removed -->').replace(/<script[^>]*\/>/gi, '');
        html = html.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '').replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
        html = html.replace(/<form([^>]*)\s+action\s*=\s*"[^"]*"/gi, '<form$1 action=""');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src *;" }); res.end(html);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#888"><p>Nessuna pagina caricata</p></body></html>');
      }
      return;
    }

    // API: Version
    if (req.url === '/api/version') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: APP_VERSION, build: APP_BUILD })); return; }

    // API: Bridge Status
    if (req.url === '/api/bridge-status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: isBridgeReady(), capabilities: _bridgeCapabilities })); return; }

    // API: Monitoring Stats
    if (req.url === '/api/monitoring/feedback') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getFeedbackStats())); return; }
    if (req.url === '/api/monitoring/prompts') {
      try {
        const promptLog = path.join(__dirname, '..', 'data', 'supermario_prompts.jsonl');
        if (fs.existsSync(promptLog)) {
          const lines = fs.readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean);
          const entries = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ total: lines.length, entries }));
        } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ total: 0, entries: [] })); }
      } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ total: 0, entries: [], error: e.message })); }
      return;
    }
    if (req.url === '/api/monitoring/stats') {
      const stats = { total: 0, approved: 0, rejected: 0, expired: 0, executed: 0, pending: 0, byTool: {}, byRisk: {} };
      const now = new Date();
      for (const [id, a] of _pendingActions) {
        stats.total++; let status = a.status; if (status === 'pending' && now > a.expires_at) status = 'expired';
        stats[status] = (stats[status] || 0) + 1;
        stats.byTool[a.tool_name] = stats.byTool[a.tool_name] || { total: 0, approved: 0, rejected: 0, expired: 0 };
        stats.byTool[a.tool_name].total++; stats.byTool[a.tool_name][status] = (stats.byTool[a.tool_name][status] || 0) + 1;
        stats.byRisk[a.risk_level] = (stats.byRisk[a.risk_level] || 0) + 1;
      }
      const decided = stats.approved + stats.rejected + stats.expired + stats.executed;
      stats.rates = { approval: decided > 0 ? Math.round(stats.approved / decided * 100) : 0, rejection: decided > 0 ? Math.round(stats.rejected / decided * 100) : 0, expiry: decided > 0 ? Math.round(stats.expired / decided * 100) : 0, execution: decided > 0 ? Math.round(stats.executed / decided * 100) : 0 };
      stats.topTools = Object.entries(stats.byTool).sort((a, b) => b[1].total - a[1].total).slice(0, 10).map(([name, data]) => ({ name, ...data }));
      const invLog = SuperMario.getInvocationLog();
      stats.invocations = { total: invLog.length, avgLatency: invLog.length > 0 ? Math.round(invLog.reduce((s, l) => s + (l.latency_ms || 0), 0) / invLog.length) : 0, preflightWarnings: invLog.filter(l => l.preflight_warnings?.length > 0).length, postflightWarnings: invLog.filter(l => l.postflight_warnings?.length > 0).length, toolsUsedTotal: invLog.reduce((s, l) => s + (l.tools_used?.length || 0), 0) };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(stats)); return;
    }
    if (req.url === '/api/monitoring/audit-log') {
      const allActions = [];
      for (const [id, a] of _pendingActions) { allActions.push({ id, tool: a.tool_name, risk: a.risk_level, status: a.status, summary: (a.summary || '').substring(0, 200), created: a.created_at, decided: a.decided_at, decided_by: a.decided_by, expires: a.expires_at }); }
      const invLog = SuperMario.getInvocationLog();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ pending_actions: allActions.sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 100), invocations: invLog.slice(-50) })); return;
    }

    // API: HumanDriver + Research
    if (req.url === '/api/human-driver/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(HumanDriver.getStats())); return; }
    if (req.url === '/api/research/status') {
      const eval_ = ResearchStrategy.evaluate(); const cont = ResearchStrategy.shouldContinue();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ evaluation: eval_, shouldContinue: cont, sources: ResearchStrategy._sources.slice(-20) })); return;
    }

    // API: Status
    if (req.url === '/api/status') {
      const conv = conversationEngine.getActiveConversation();
      const chatMem = conv ? conversationEngine.chatMemories.get(conv.id) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        keys: Object.keys(aiKeys).filter(k => k.endsWith('Key')).map(k => k.replace('Key', '')),
        clients: wsClients.size,
        lastPage: session.lastPage ? { url: session.lastPage.url, title: session.lastPage.title } : null,
        supervisor: CobraSupervisor.getStatus(),
        persona: { version: CobraPersona.getVersion(), layers: Object.keys(CobraPersona.getAllLayers()) },
        conversation: conv ? { id: conv.id, title: conv.title, messageCount: conv.messages.length, hasSummary: !!conv.summary } : null,
        memory: chatMem ? chatMem.getStats() : { liveWindowCount: 0 },
        toolRegistry: { count: COBRA_TOOLS.length, tools: COBRA_TOOLS.map(t => t.function.name) },
        toolHistory: toolHistory.slice(-10),
        bridge: { connected: isBridgeReady(), capabilities: _bridgeCapabilities },
      }));
      return;
    }

    // API: Logs
    if (req.url === '/api/logs') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ logs: serverLogs.slice(-50) })); return; }

    // API: Conversations
    if (req.url === '/api/conversations') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ conversations: conversationEngine.listConversations() })); return; }
    if (req.method === 'POST' && req.url === '/api/conversations/new') {
      const conv = conversationEngine.createConversation('Nuova Chat');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, conversation: conv })); return;
    }

    // API: Memory Clear
    if (req.method === 'POST' && req.url === '/api/memory/clear') {
      const conv = conversationEngine.getActiveConversation();
      if (conv) { const chatMem = conversationEngine.chatMemories.get(conv.id); if (chatMem) chatMem.clear(); }
      session.lastPage = null; toolHistory.length = 0; session.kbSnippets = [];
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
    }

    // API: Persona
    if (req.url === '/api/persona') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: CobraPersona.getVersion(), layers: CobraPersona.getAllLayers() })); return; }

    // Static files
    const rawUrl = req.url;
    const urlPath = new URL(rawUrl, 'http://localhost').pathname;
    const decodedPath = decodeURIComponent(urlPath);
    if (rawUrl.includes('..') || decodedPath.includes('..') || rawUrl.includes('%2e%2e') || rawUrl.includes('%2E%2E')) {
      log(`[Security] Path traversal blocked: ${rawUrl}`); res.writeHead(403); res.end('Forbidden'); return;
    }
    const safePath = path.resolve(publicDir, '.' + decodedPath);
    if (!safePath.startsWith(publicDir + path.sep) && safePath !== publicDir) {
      log(`[Security] Path traversal blocked (resolve): ${rawUrl}`); res.writeHead(403); res.end('Forbidden'); return;
    }
    let filePath = safePath === publicDir ? path.join(publicDir, 'index.html') : safePath;
    const ext = path.extname(filePath);
    const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'text/plain',
        'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0',
        'Content-Security-Policy': "default-src 'self' ws://localhost:3000 blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; media-src * blob: data:; connect-src *; font-src * data:;",
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
  }

  return { handleRequest };
};
