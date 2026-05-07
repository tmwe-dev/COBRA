// modules/routes/index.js — Lightweight router dispatcher + CORS + auth + static files
// Source: server.js lines 7940-9093

const path = require('path');
const fs = require('fs');
const { MAX_BODY_SIZE } = require('../config/constants');

// Simple router: stores route handlers by method+path
function createRouter() {
  const routes = { GET: [], POST: [], DELETE: [] };

  function addRoute(method, pattern, handler) {
    routes[method].push({ pattern, handler });
  }

  function match(method, url) {
    const list = routes[method] || [];
    // Exact match first
    for (const r of list) {
      if (r.pattern === url) return r.handler;
    }
    // Wildcard match (e.g., /api/pending-actions/*/approve)
    for (const r of list) {
      if (r.pattern.includes('*')) {
        const re = new RegExp('^' + r.pattern.replace(/\*/g, '[^/]+') + '$');
        if (re.test(url)) return r.handler;
      }
    }
    // startsWith match (e.g., /api/page-preview)
    for (const r of list) {
      if (r.pattern.endsWith('*') && url.startsWith(r.pattern.slice(0, -1))) return r.handler;
    }
    return null;
  }

  return {
    get: (p, h) => addRoute('GET', p, h),
    post: (p, h) => addRoute('POST', p, h),
    delete: (p, h) => addRoute('DELETE', p, h),
    match,
  };
}

function setupRoutes(ctx) {
  const router = createRouter();

  // Register all route modules
  require('./chat').register(router, ctx);
  require('./tts').register(router, ctx);
  require('./config').register(router, ctx);
  require('./pending').register(router, ctx);
  require('./monitoring').register(router, ctx);
  require('./misc').register(router, ctx);

  return function handleRequest(req, res) {
    // CORS
    const reqOrigin = req.headers.origin || '';
    const allowedOrigin = ctx.ALLOWED_ORIGINS.find(o => reqOrigin.startsWith(o)) || ctx.ALLOWED_ORIGINS[0];
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cobra-Token');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Auth check on /api/
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/') && !ctx.isAuthenticatedRequest(req)) {
      ctx.log(`[Security] Unauthorized: ${req.method} ${pathname}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Provide X-Cobra-Token header.' }));
      return;
    }

    // Route matching
    const handler = router.match(req.method, pathname);
    if (handler) {
      // POST: collect body
      if (req.method === 'POST') {
        let body = '', size = 0;
        req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY_SIZE) { req.destroy(); return; } body += chunk; });
        req.on('end', () => handler(body, res, pathname));
      } else {
        handler('', res, pathname);
      }
      return;
    }

    // Static files (path traversal protected)
    const publicDir = path.resolve(ctx.baseDir, 'public');
    const decodedPath = decodeURIComponent(pathname);
    if (req.url.includes('..') || decodedPath.includes('..') || req.url.includes('%2e%2e') || req.url.includes('%2E%2E')) {
      ctx.log(`[Security] Path traversal blocked: ${req.url}`);
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const safePath = path.resolve(publicDir, '.' + decodedPath);
    if (!safePath.startsWith(publicDir + path.sep) && safePath !== publicDir) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const filePath = safePath === publicDir ? path.join(publicDir, 'index.html') : safePath;
    const ext = path.extname(filePath);
    const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'text/plain',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Security-Policy': "default-src 'self' ws://localhost:3000 blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; media-src * blob: data:; connect-src *; font-src * data:;",
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
  };
}

module.exports = { setupRoutes, createRouter };
