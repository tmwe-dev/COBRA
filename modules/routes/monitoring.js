// modules/routes/monitoring.js — /api/response-log/*, /api/monitoring/*, /api/status, /api/logs, /api/token-meter, etc.
// Source: server.js lines 8442-8968

const path = require('path');
const fs = require('fs');

function register(router, ctx) {
  // ── Response Log ──
  router.get('/api/response-log', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.ResponseRecorder.getLog())); });
  router.get('/api/response-log/stats', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.ResponseRecorder.getStats())); });
  router.get('/api/response-log/export/json', (b, res) => {
    const data = JSON.stringify(ctx.ResponseRecorder.exportJSON(), null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="cobra-responses-${new Date().toISOString().split('T')[0]}.json"` });
    res.end(data);
  });
  router.get('/api/response-log/export/csv', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="cobra-responses-${new Date().toISOString().split('T')[0]}.csv"` });
    res.end(ctx.ResponseRecorder.exportCSV());
  });
  router.get('/api/response-log/export/txt', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="cobra-conversazioni-${new Date().toISOString().split('T')[0]}.txt"` });
    res.end(ctx.ResponseRecorder.exportConversation());
  });
  router.get('/api/response-log/problems', (b, res) => {
    const problems = ctx.ResponseRecorder.getLog({ hasFlags: ['raw_url_list', 'excessive_bullets', 'robot_opener', 'heavy_markdown', 'ai_self_reference', 'raw_urls_shown', 'possible_copypaste'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: problems.length, entries: problems }));
  });
  router.delete('/api/response-log', (b, res) => {
    ctx.ResponseRecorder._log = [];
    try { fs.writeFileSync(ctx.ResponseRecorder._filePath, ''); } catch (e) { ctx.log(`[Recorder] reset error: ${e.message}`); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Log cancellato' }));
  });

  // ── Token Meter ──
  router.get('/api/token-meter', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.TokenMeter.getStatus())); });
  router.delete('/api/token-meter', (b, res) => { ctx.TokenMeter.reset(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });

  // ── Monitoring Stats ──
  router.get('/api/monitoring/stats', (b, res) => {
    const stats = { total: 0, approved: 0, rejected: 0, expired: 0, executed: 0, pending: 0, byTool: {}, byRisk: {}, blockedPatterns: {} };
    const now = new Date();
    for (const [id, a] of ctx._pendingActions) {
      stats.total++;
      let status = a.status;
      if (status === 'pending' && now > a.expires_at) status = 'expired';
      stats[status] = (stats[status] || 0) + 1;
      stats.byTool[a.tool_name] = stats.byTool[a.tool_name] || { total: 0, approved: 0, rejected: 0, expired: 0 };
      stats.byTool[a.tool_name].total++;
      stats.byTool[a.tool_name][status] = (stats.byTool[a.tool_name][status] || 0) + 1;
      stats.byRisk[a.risk_level] = (stats.byRisk[a.risk_level] || 0) + 1;
    }
    const decided = stats.approved + stats.rejected + stats.expired + stats.executed;
    stats.rates = { approval: decided > 0 ? Math.round(stats.approved / decided * 100) : 0, rejection: decided > 0 ? Math.round(stats.rejected / decided * 100) : 0, expiry: decided > 0 ? Math.round(stats.expired / decided * 100) : 0, execution: decided > 0 ? Math.round(stats.executed / decided * 100) : 0 };
    stats.topTools = Object.entries(stats.byTool).sort((a, b) => b[1].total - a[1].total).slice(0, 10).map(([name, data]) => ({ name, ...data }));
    const invLog = ctx.SuperMario.getInvocationLog();
    stats.invocations = { total: invLog.length, avgLatency: invLog.length > 0 ? Math.round(invLog.reduce((s, l) => s + (l.latency_ms || 0), 0) / invLog.length) : 0, preflightWarnings: invLog.filter(l => l.preflight_warnings?.length > 0).length, postflightWarnings: invLog.filter(l => l.postflight_warnings?.length > 0).length, toolsUsedTotal: invLog.reduce((s, l) => s + (l.tools_used?.length || 0), 0) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  });

  // ── Audit Log ──
  router.get('/api/monitoring/audit-log', (b, res) => {
    const allActions = [];
    for (const [id, a] of ctx._pendingActions) {
      allActions.push({ id, tool: a.tool_name, risk: a.risk_level, status: a.status, summary: (a.summary || '').substring(0, 200), created: a.created_at, decided: a.decided_at, decided_by: a.decided_by, expires: a.expires_at });
    }
    const invLog = ctx.SuperMario.getInvocationLog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending_actions: allActions.sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 100), invocations: invLog.slice(-50) }));
  });

  // ── Memoria appresa (fatti durevoli sull'utente) ──
  router.get('/api/learning/facts', (b, res) => {
    const store = ctx.learningStore;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!store) { res.end(JSON.stringify({ facts: [], stats: { total: 0 } })); return; }
    res.end(JSON.stringify({
      facts: [...store.facts].sort((a, b) => b.confidence - a.confidence),
      stats: store.getStats(),
    }));
  });

  router.post('/api/learning/forget', (body, res) => {
    const store = ctx.learningStore;
    let removed = 0, errore = null;
    try {
      const { fact, all } = JSON.parse(body || '{}');
      if (!store) errore = 'memoria non disponibile';
      else if (all === true) { removed = store.facts.length; store.facts = []; store.save(); }
      else if (fact) removed = store.forget(fact);
      else errore = 'serve "fact" oppure "all": true';
    } catch (e) { errore = e.message; }
    res.writeHead(errore ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errore ? { error: errore } : { ok: true, removed }));
  });

  // Verifica che il registro di audit non sia stato alterato
  router.get('/api/monitoring/audit-integrity', (b, res) => {
    let result;
    try { result = ctx.verifyAuditChain(); }
    catch (e) { result = { valid: false, reason: `verifica fallita: ${e.message}` }; }
    res.writeHead(result.valid ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  // ── Prompt Audit ──
  router.get('/api/monitoring/prompts', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const promptLog = path.join(ctx.dataDir, 'supermario_prompts.jsonl');
      if (fs.existsSync(promptLog)) {
        const lines = fs.readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean);
        const entries = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        res.end(JSON.stringify({ total: lines.length, entries }));
      } else { res.end(JSON.stringify({ total: 0, entries: [] })); }
    } catch (e) { res.end(JSON.stringify({ total: 0, entries: [], error: e.message })); }
  });

  // ── Feedback ──
  router.get('/api/monitoring/feedback', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.getFeedbackStats())); });

  // ── Human Driver Stats ──
  router.get('/api/human-driver/stats', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.HumanDriver.getStats())); });

  // Research Status — rimosso (ResearchStrategy eliminato nella semplificazione)

  // ── Status ──
  router.get('/api/status', (b, res) => {
    const conv = ctx.conversationEngine.getActiveConversation();
    const chatMem = conv ? ctx.conversationEngine.chatMemories.get(conv.id) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      keys: Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key')).map(k => k.replace('Key', '')),
      clients: ctx.getWsClientCount(),
      lastPage: ctx.session.lastPage ? { url: ctx.session.lastPage.url, title: ctx.session.lastPage.title } : null,
      supervisor: ctx.CobraSupervisor.getStatus(),
      persona: { version: 'v11-slim', layers: [] },
      conversation: conv ? { id: conv.id, title: conv.title, messageCount: conv.messages.length, hasSummary: !!conv.summary } : null,
      memory: chatMem ? chatMem.getStats() : { liveWindowCount: 0 },
      toolRegistry: { count: ctx.COBRA_TOOLS.length, tools: ctx.COBRA_TOOLS.map(t => t.function.name) },
      toolHistory: ctx.toolHistory.slice(-10),
      bridge: { connected: ctx.isBridgeReady(), capabilities: ctx.getBridgeCapabilities() },
    }));
  });

  // ── Logs ──
  router.get('/api/logs', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ logs: ctx.serverLogs.slice(-50) })); });

  // ── Conversations ──
  router.get('/api/conversations', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ conversations: ctx.conversationEngine.listConversations() })); });
  router.post('/api/conversations/new', (b, res) => {
    const conv = ctx.conversationEngine.createConversation('Nuova Chat');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, conversation: conv }));
  });

  // ── Memory Clear ──
  router.post('/api/memory/clear', (b, res) => {
    const conv = ctx.conversationEngine.getActiveConversation();
    if (conv) { const m = ctx.conversationEngine.chatMemories.get(conv.id); if (m) m.clear(); }
    ctx.session.lastPage = null;
    ctx.toolHistory.length = 0;
    ctx.session.kbSnippets = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  // Persona — rimosso (CobraPersona eliminato nella semplificazione)

  // ── Version ──
  router.get('/api/version', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: ctx.APP_VERSION, build: ctx.APP_BUILD })); });

  // ── Bridge Status ──
  router.get('/api/bridge-status', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: ctx.isBridgeReady(), capabilities: ctx.getBridgeCapabilities() })); });
}

module.exports = { register };
