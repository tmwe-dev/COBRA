// modules/security/auth.js — API tokens + request authentication
// Source: server.js lines 987-1018

const crypto = require('crypto');

const COBRA_API_TOKEN = crypto.randomBytes(32).toString('hex');
const BRIDGE_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

function makeAllowedOrigins(port) {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

function isAuthenticatedRequest(req, allowedOrigins) {
  const token = req.headers['x-cobra-token'] ||
    new URL(req.url, 'http://localhost').searchParams.get('token');
  if (token) return token === COBRA_API_TOKEN;

  const origin = req.headers.origin || '';
  if (allowedOrigins.some(o => origin.startsWith(o))) return true;

  // Chrome extension from loopback
  if (origin.startsWith('chrome-extension://')) {
    const remoteIp = req.socket.remoteAddress || '';
    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp);
    const extId = origin.replace('chrome-extension://', '').replace(/\//g, '');
    const allowedExtId = process.env.COBRA_EXTENSION_ID || '';
    if (isLoopback && (!allowedExtId || extId === allowedExtId)) return true;
    return false;
  }

  // No-origin loopback (curl, same server)
  const remoteIp = req.socket.remoteAddress || '';
  if (!origin && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp)) return true;
  return false;
}

module.exports = {
  COBRA_API_TOKEN, BRIDGE_SESSION_TOKEN,
  makeAllowedOrigins, isAuthenticatedRequest,
};
