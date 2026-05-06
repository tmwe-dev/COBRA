/**
 * lib/security.js
 * API Token, Auth, Sanitization, SSRF Guard
 * ~60 lines
 */

const crypto = require('crypto');

const COBRA_API_TOKEN = crypto.randomBytes(32).toString('hex');
const BRIDGE_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB limit

function getAllowedOrigins(port) {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

function isAuthenticatedRequest(req, port) {
  const token = req.headers['x-cobra-token'] || new URL(req.url, 'http://localhost').searchParams.get('token');
  if (token) {
    return token === COBRA_API_TOKEN;
  }
  const origin = req.headers.origin || '';
  const allowedOrigins = getAllowedOrigins(port);
  if (allowedOrigins.some(o => origin.startsWith(o))) return true;
  if (origin.startsWith('chrome-extension://')) {
    const remoteIp = req.socket.remoteAddress || '';
    const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    const extId = origin.replace('chrome-extension://', '').replace(/\//g, '');
    const allowedExtId = process.env.COBRA_EXTENSION_ID || '';
    if (isLoopback && (allowedExtId === '' || extId === allowedExtId)) return true;
    if (isLoopback && allowedExtId && extId !== allowedExtId) return false;
  }
  const remoteIp = req.socket.remoteAddress || '';
  if (!origin && (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1')) return true;
  return false;
}

function sanitizeForLog(str) {
  if (typeof str !== 'string') {
    try { str = JSON.stringify(str); } catch { return '[unserializable]'; }
  }
  return str
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/\b(eyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+)\b/g, '[JWT]')
    .replace(/\b(sk-[A-Za-z0-9]{20,})\b/g, '[API_KEY]')
    .replace(/\b(AIza[A-Za-z0-9_\-]{30,})\b/g, '[GAPI_KEY]')
    .replace(/\b(xoxb-[A-Za-z0-9\-]+)\b/g, '[SLACK_TOKEN]')
    .replace(/(password|passwd|pwd|secret|token|apikey|api_key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b[0-9a-f]{32,64}\b/gi, (m) => m.length >= 40 ? '[HASH/TOKEN]' : m);
}

function readBodyWithLimit(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Payload too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function isSSRFSafe(urlString) {
  try {
    const u = new URL(urlString);
    const hostname = u.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return false;
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      if (parts[0] === 10) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 169 && parts[1] === 254) return false;
      if (parts[0] === 0) return false;
    }
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return false;
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    return true;
  } catch { return false; }
}

module.exports = {
  COBRA_API_TOKEN, BRIDGE_SESSION_TOKEN, MAX_BODY_SIZE,
  getAllowedOrigins, isAuthenticatedRequest,
  sanitizeForLog, readBodyWithLimit, isSSRFSafe,
};
