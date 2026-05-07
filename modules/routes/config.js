// modules/routes/config.js — /api/config/keys, /api/config/email
// Source: server.js lines 8494-8552

function register(router, ctx) {
  // ── POST /api/config/keys ──
  router.post('/api/config/keys', (body, res) => {
    try {
      const cfg = JSON.parse(body);
      if (cfg.openai) ctx.aiKeys.openaiKey = cfg.openai;
      if (cfg.anthropic) ctx.aiKeys.anthropicKey = cfg.anthropic;
      if (cfg.gemini) ctx.aiKeys.geminiKey = cfg.gemini;
      if (cfg.groq) ctx.aiKeys.groqKey = cfg.groq;
      if (cfg.elevenlabs) ctx.aiKeys.elevenlabsKey = cfg.elevenlabs;
      if (cfg.openaiModel) ctx.aiKeys.openaiModel = cfg.openaiModel;
      if (cfg.anthropicModel) ctx.aiKeys.anthropicModel = cfg.anthropicModel;
      if (cfg.geminiModel) ctx.aiKeys.geminiModel = cfg.geminiModel;
      const active = Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key') && ctx.aiKeys[k]).map(k => k.replace('Key', ''));
      ctx.log(`[API Keys] Configurate: ${active.join(', ')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providers: active }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'JSON non valido' }));
    }
  });

  // ── GET /api/config/keys ──
  router.get('/api/config/keys', (body, res) => {
    const active = Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key') && ctx.aiKeys[k]).map(k => k.replace('Key', ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ providers: active, hasKeys: active.length > 0 }));
  });

  // ── POST /api/config/email ──
  router.post('/api/config/email', (body, res) => {
    try {
      const cfg = JSON.parse(body);
      ctx.session.emailConfig = { ...ctx.session.emailConfig, ...cfg };
      ctx.log('[Email Config] Updated: ' + Object.keys(cfg).join(', '));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, configured: Object.keys(ctx.session.emailConfig) }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'JSON non valido' }));
    }
  });

  // ── GET /api/config/email ──
  router.get('/api/config/email', (body, res) => {
    const safe = { ...ctx.session.emailConfig };
    if (safe.pass) safe.pass = '***';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
  });
}

module.exports = { register };
