// modules/security/ssrf.js — SSRF guard
// Source: server.js lines 1050-1071

function isSSRFSafe(urlString) {
  try {
    const u = new URL(urlString);
    const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return false;

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

module.exports = { isSSRFSafe };
