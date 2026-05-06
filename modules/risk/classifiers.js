// modules/risk/classifiers.js — URL & click intent classification
// Source: server.js lines 188-219, 221-290

const { maxRisk } = require('../config/constants');

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

module.exports = { classifyUrlRisk };
