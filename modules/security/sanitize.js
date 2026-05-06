// modules/security/sanitize.js — Log sanitization
// Source: server.js lines 1021-1033

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
    .replace(/\b[0-9a-f]{32,64}\b/gi, m => m.length >= 40 ? '[HASH/TOKEN]' : m);
}

module.exports = { sanitizeForLog };
