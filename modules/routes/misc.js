// modules/routes/misc.js — /api/bridge-token, /api/page-preview, /api/ws-test, /api/test-monitor, /api/seed-kb, /api/tests/acceptance
// Source: server.js lines 7977-8879

const path = require('path');
const fs = require('fs');

// Estensioni riconosciute, con il tipo da dichiarare al browser
const TIPI_FILE = {
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8', xml: 'application/xml; charset=utf-8',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function register(router, ctx) {
  // ── Bridge Token ──
  router.get('/api/bridge-token', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: ctx.BRIDGE_SESSION_TOKEN }));
  });

  // ── Scarico dei file prodotti da COBRA ──
  // I file venivano scritti su disco ma non c'era modo di ottenerli:
  // "salvalo in un file scaricabile" produceva un file irraggiungibile.
  // Il router passa il percorso come terzo argomento
  router.get('/api/files/*', (b, res, pathname) => {
    const base = path.resolve(ctx.dataDir, 'files');
    let nome = '';
    try { nome = decodeURIComponent(String(pathname || '').replace(/^\/api\/files\//, '')); }
    catch { nome = ''; }

    const percorso = path.resolve(base, nome);
    // Il file deve stare dentro la cartella dei file, sempre
    if (!nome || (!percorso.startsWith(base + path.sep) && percorso !== base)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Percorso non consentito' }));
      return;
    }
    if (!fs.existsSync(percorso) || !fs.statSync(percorso).isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File non trovato' }));
      return;
    }
    const ext = nome.split('.').pop().toLowerCase();
    res.writeHead(200, {
      'Content-Type': TIPI_FILE[ext] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(nome).replace(/"/g, '')}"`,
      'Content-Length': fs.statSync(percorso).size,
    });
    fs.createReadStream(percorso).pipe(res);
  });

  // ── Elenco dei file prodotti ──
  router.get('/api/files', (b, res) => {
    const base = path.resolve(ctx.dataDir, 'files');
    let elenco = [];
    try {
      elenco = fs.readdirSync(base)
        .filter(f => !f.startsWith('.') && fs.statSync(path.join(base, f)).isFile())
        .map(f => {
          const st = fs.statSync(path.join(base, f));
          return { nome: f, byte: st.size, modificato: st.mtime.toISOString(), url: `/api/files/${encodeURIComponent(f)}` };
        })
        .sort((a, b2) => new Date(b2.modificato) - new Date(a.modificato));
    } catch { elenco = []; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file: elenco }));
  });

  // ── Monitor File ──
  router.post('/api/monitor/file', (body, res) => {
    try {
      ctx.broadcastFile(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ── Page Preview (sanitized) ──
  router.get('/api/page-preview', (b, res) => {
    if (ctx.session.lastPage && ctx.session.lastPage.html) {
      let html = ctx.session.lastPage.html;
      try {
        const baseUrl = new URL(ctx.session.lastPage.url);
        if (!/<base\s/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl.origin}/">`);
      } catch (_) { /* best-effort */ }
      html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '<!-- removed -->');
      html = html.replace(/<script[^>]*\/>/gi, '');
      html = html.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '');
      html = html.replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
      html = html.replace(/<form([^>]*)\s+action\s*=\s*"[^"]*"/gi, '<form$1 action=""');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src *;" });
      res.end(html);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#888"><p>Nessuna pagina caricata</p></body></html>');
    }
  });

  // ── WS Test (debug) ──
  router.get('/api/ws-test', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body style="font:16px monospace;padding:20px"><h2>WS Test</h2><div id="log"></div><script>const log=document.getElementById('log');function a(m,c){const d=document.createElement('div');d.style.color=c||'black';d.textContent=new Date().toLocaleTimeString()+' '+m;log.appendChild(d)}a('Connecting...');const ws=new WebSocket('ws://'+location.host);ws.onopen=()=>a('OPEN','green');ws.onclose=e=>a('CLOSE code:'+e.code,'red');ws.onerror=()=>a('ERROR','red');ws.onmessage=e=>a('MSG: '+e.data.substring(0,200),'blue')</script></body></html>`);
  });

  // ── Test Monitor (debug) ──
  router.get('/api/test-monitor', (b, res) => {
    ctx.wsBroadcast({ type: 'thinking', text: 'Test: navigo su esempio...' });
    ctx.wsBroadcast({ type: 'tool_start', tool: 'navigate' });
    setTimeout(() => {
      ctx.wsBroadcast({ type: 'site_visit', url: 'https://www.example.com', title: 'Example Domain', favicon: '', status: 'active' });
      ctx.wsBroadcast({ type: 'tool_done', tool: 'navigate', ok: true });
      ctx.wsBroadcast({ type: 'page_loaded', url: 'https://www.example.com', title: 'Example Domain' });
      ctx.wsBroadcast({ type: 'monitor_content', markdown: '# Example Domain\n\nTest del monitor.', url: 'https://www.example.com', title: 'Example Domain' });
    }, 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Test events sent', wsClients: ctx.getWsClientCount() }));
  });

  // ── Seed KB ──
  router.post('/api/seed-kb', async (body, res) => {
    try {
      const result = await ctx.seedKB();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ── Acceptance Tests ──
  router.get('/api/tests/acceptance', (b, res) => {
    const results = [];
    // URL whitelist test
    results.push({ id: 10, pass: ctx.classifyUrlRisk('https://www.google.com/search?q=test').level === 'read', expected: 'read' });
    // Admin URL
    const t11 = ctx.classifyUrlRisk('https://site.com/admin?delete=true');
    results.push({ id: 11, pass: ctx.RISK_LEVELS.indexOf(t11.level) >= ctx.RISK_LEVELS.indexOf('write_form'), expected: '>=write_form' });
    // Destructive button
    results.push({ id: 12, pass: ctx.classifyClickIntent('button.pay-btn', 'Paga ora').level === 'destructive', expected: 'destructive' });
    // Dangerous JS
    results.push({ id: 13, pass: ctx.detectDangerousJs('fetch("https://evil.com")').length > 0 });
    // mutate_dom_js confirmation
    results.push({ id: 14, pass: ctx.computeEffectiveRisk('mutate_dom_js', { code: 'x' }).requires_confirmation === true });
    // kb_delete
    const t20 = ctx.computeEffectiveRisk('kb_delete', { title: 'test' });
    results.push({ id: 20, pass: t20.requires_confirmation && t20.ttl === 60 });
    // Route scopes
    results.push({ id: 3, pass: ctx.SuperMario.routeIntent('Scrivi mail a marco@x con offerta').scopes?.includes('communicate') });
    results.push({ id: 18, pass: ctx.SuperMario.routeIntent('Manda whatsapp a Mario').scopes?.includes('communicate') });
    const passed = results.filter(r => r.pass).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ summary: { passed, total: results.length }, results }));
  });
}

module.exports = { register };
