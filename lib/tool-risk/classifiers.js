/**
 * lib/tool-risk/classifiers.js
 * URL and click intent classifiers, dangerous JS detector
 */

const { maxRisk } = require('./taxonomy');

// ── URL Risk Classifier ──
const URL_READ_ONLY_DOMAINS = ['wikipedia.org','duckduckgo.com','google.com/search','bing.com','brave.com','maps.google.com','translate.google.com','iata.org','icao.int','imo.org'];
const URL_SENSITIVE_DOMAINS = ['paypal.com','stripe.com','bank','login.','auth.','oauth.','admin.'];
const URL_MUTATING_PARAMS = [/[?&]delete(=|$)/i,/[?&]remove(=|$)/i,/[?&]confirm(=|$)/i,/[?&]approve(=|$)/i,/[?&]pay(=|$)/i,/[?&]submit(=|$)/i,/[?&]execute(=|$)/i,/[?&]action=(delete|remove|destroy|purge|reset|cancel|approve|pay|submit|send)/i,/[?&]token=/i];
const URL_ADMIN_PATHS = [/\/admin\//i,/\/wp-admin/i,/\/manage\//i,/\/delete\//i,/\/checkout/i,/\/payment/i,/\/api\/.*\/(delete|remove|destroy)/i];
const URL_SUSPICIOUS_SCHEMES = ['javascript:','data:','file:','vbscript:'];

function classifyUrlRisk(rawUrl) {
  const reasons = [];
  let level = 'read';
  for (const scheme of URL_SUSPICIOUS_SCHEMES) {
    if (rawUrl.toLowerCase().startsWith(scheme)) return { level:'destructive', reasons:[`Schema sospetto: ${scheme}`] };
  }
  let url;
  try { url = new URL(rawUrl); } catch { return { level:'interact', reasons:['URL non parsabile'] }; }
  const host = url.hostname.toLowerCase();
  const fullPath = url.pathname + url.search;
  let isKnownSafe = false;
  for (const safe of URL_READ_ONLY_DOMAINS) {
    if (host.includes(safe) || rawUrl.includes(safe)) { isKnownSafe = true; break; }
  }
  for (const s of URL_SENSITIVE_DOMAINS) {
    if (host.includes(s)) { level = maxRisk(level, 'send_prepare'); reasons.push(`Dominio sensibile: ${s}`); }
  }
  for (const p of URL_MUTATING_PARAMS) {
    if (p.test(fullPath)) { level = maxRisk(level, 'destructive'); reasons.push(`Query mutativa: ${p.source}`); }
  }
  for (const p of URL_ADMIN_PATHS) {
    if (p.test(url.pathname)) { level = maxRisk(level, 'write_form'); reasons.push(`Path admin: ${p.source}`); }
  }
  if (isKnownSafe && level === 'read') return { level:'read', reasons:['Whitelist read-only'] };
  return { level, reasons: reasons.length ? reasons : ['Default read'] };
}

// ── Click Intent Classifier ──
const DESTRUCTIVE_BUTTON_PATTERNS = [/\b(paga|pay|checkout|pagamento)\b/i,/\b(conferma acquisto|confirm purchase|conferma pagamento|confirm payment)\b/i,/\b(elimina|delete|remove permanently)\b/i,/\b(acquista ora|buy now|purchase now|completa ordine|place order)\b/i];

function classifyClickIntent(selector, visibleText) {
  const haystack = `${selector} ${visibleText || ''}`.toLowerCase();
  if (/button\[type=["']?submit/i.test(selector) || /input\[type=["']?submit/i.test(selector)) {
    return { level:'destructive', reason:'Submit button' };
  }
  for (const p of DESTRUCTIVE_BUTTON_PATTERNS) {
    if (p.test(haystack)) return { level:'destructive', reason:`Bottone irreversibile: ${p.source}` };
  }
  return { level:'interact' };
}

// ── Dangerous JS Pattern Detector ──
const ALWAYS_BLOCKED_JS = [/\bfetch\s*\(/,/\bXMLHttpRequest\b/,/\beval\s*\(/,/\bFunction\s*\(/,/\blocalStorage\b/,/\bsessionStorage\b/,/\bindexedDB\b/,/\bdocument\.cookie\b/,/\bnavigator\.clipboard\b/,/\bwindow\.location\s*=/,/\.submit\s*\(/,/\.click\s*\(/,/\.innerHTML\s*=/,/\.outerHTML\s*=/,/\bdocument\.write\b/,/\bimport\s*\(/,/\bnew\s+Worker\b/,/\bpostMessage\b/];

function detectDangerousJs(code) {
  const found = [];
  for (const p of ALWAYS_BLOCKED_JS) { if (p.test(code)) found.push(p.source); }
  return found;
}

module.exports = {
  URL_READ_ONLY_DOMAINS,
  URL_SENSITIVE_DOMAINS,
  URL_MUTATING_PARAMS,
  URL_ADMIN_PATHS,
  URL_SUSPICIOUS_SCHEMES,
  classifyUrlRisk,
  DESTRUCTIVE_BUTTON_PATTERNS,
  classifyClickIntent,
  ALWAYS_BLOCKED_JS,
  detectDangerousJs,
};
