// modules/security/auth.js — API tokens + request authentication
// Source: server.js lines 987-1018

const crypto = require('crypto');

const COBRA_API_TOKEN = crypto.randomBytes(32).toString('hex');
const BRIDGE_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

function makeAllowedOrigins(port) {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

const LOOPBACK_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** Confronto a tempo costante: evita di rivelare il token byte per byte. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Verifica un header Origin.
 *
 * L'elenco consentito può contenere origin completi ("http://localhost:3000")
 * oppure prefissi con porta aperta ("http://localhost:"). In entrambi i casi il
 * confronto avviene su hostname e porta dopo il parsing, mai su sottostringa:
 * "http://localhost:3000.evil.com" non è un URL valido e viene respinto, e
 * "http://localhost.evil.com" ha hostname diverso da "localhost".
 */
function isAllowedOrigin(origin, allowedOrigins = []) {
  if (!origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;

  for (const entry of allowedOrigins) {
    if (entry === origin) return true;              // corrispondenza esatta
    if (entry.endsWith(':')) {                      // prefisso con porta libera
      let base;
      try { base = new URL(entry + '0'); } catch { continue; }
      if (base.protocol === u.protocol && base.hostname === u.hostname && u.port) return true;
    } else {
      let base;
      try { base = new URL(entry); } catch { continue; }
      if (base.protocol === u.protocol && base.hostname === u.hostname && base.port === u.port) return true;
    }
  }
  // Rete di sicurezza: solo host di loopback riconosciuti
  return LOOPBACK_HOSTNAMES.has(u.hostname) && allowedOrigins.length === 0;
}

function isAuthenticatedRequest(req, allowedOrigins) {
  // Il token si accetta SOLO dall'header. In query string finirebbe nei log del
  // server, nella cronologia del browser e nell'header Referer.
  const token = req.headers['x-cobra-token'];
  if (token) return safeEqual(String(token), COBRA_API_TOKEN);

  const origin = req.headers.origin || '';
  if (isAllowedOrigin(origin, allowedOrigins)) return true;

  // Estensione Chrome, solo da loopback
  if (origin.startsWith('chrome-extension://')) {
    const remoteIp = req.socket.remoteAddress || '';
    const isLoopback = LOOPBACK_IPS.includes(remoteIp);
    const extId = origin.replace('chrome-extension://', '').replace(/\//g, '');
    const allowedExtId = process.env.COBRA_EXTENSION_ID || '';
    if (isLoopback && (!allowedExtId || extId === allowedExtId)) return true;
    return false;
  }

  // Nessun origin da loopback (curl, chiamate interne del server)
  const remoteIp = req.socket.remoteAddress || '';
  if (!origin && LOOPBACK_IPS.includes(remoteIp)) return true;
  return false;
}

module.exports = {
  COBRA_API_TOKEN, BRIDGE_SESSION_TOKEN,
  makeAllowedOrigins, isAuthenticatedRequest, safeEqual, isAllowedOrigin,
};
