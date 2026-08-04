// modules/risk/classifiers.js — Classificazione del rischio di un URL
//
// Il confronto sui domini è fatto per etichette DNS, non per sottostringa:
// "wikipedia.org.evil.com" non deve risultare sicuro, e "mountebank.io" non
// deve risultare bancario solo perché contiene "bank".

const { maxRisk } = require('../config/constants');

// Domini di sola lettura: consentiti come dominio esatto o sottodominio
const URL_READ_ONLY_DOMAINS = [
  'wikipedia.org', 'duckduckgo.com', 'bing.com', 'brave.com',
  'google.com', 'iata.org', 'icao.int', 'imo.org',
];

// Domini sensibili: dominio esatto o sottodominio
const URL_SENSITIVE_DOMAINS = [
  'paypal.com', 'stripe.com', 'satispay.com', 'sumup.com',
  'intesasanpaolo.com', 'unicredit.it', 'bancoposta.it', 'nexi.it',
];

// Etichette DNS sensibili: valgono se sono una label intera del nome
// (es. "login.example.com" o "example.com" con label "login", ma non "nologin.x")
const SENSITIVE_LABELS = ['login', 'signin', 'auth', 'oauth', 'sso', 'admin', 'bank', 'banking', 'payment', 'payments', 'checkout', 'billing'];

const URL_MUTATING_PARAMS = [
  /[?&]delete(=|$)/i, /[?&]remove(=|$)/i, /[?&]confirm(=|$)/i, /[?&]approve(=|$)/i,
  /[?&]pay(=|$)/i, /[?&]submit(=|$)/i, /[?&]execute(=|$)/i,
  /[?&]action=(delete|remove|destroy|purge|reset|cancel|approve|pay|submit|send)/i,
  /[?&]token=/i,
  // Movimenti di denaro: il rischio sta nell'azione, non nel nome del dominio
  /[?&](amount|importo|somma|sum)=/i,
  /[?&](iban|beneficiario|beneficiary|recipient)=/i,
];
// Percorsi amministrativi: alzano il rischio ma non impongono da soli una conferma
const URL_ADMIN_PATHS = [
  /\/admin\//i, /\/wp-admin/i, /\/manage\//i, /\/delete\//i,
  /\/api\/.*\/(delete|remove|destroy)/i,
];

// Percorsi che spostano denaro o concludono un ordine: qui la conferma serve
// sempre, indipendentemente dal nome del dominio.
const URL_TRANSACTION_PATHS = [
  /\/checkout/i, /\/payment/i, /\/pagament/i,
  /\/transfer/i, /\/bonific/i, /\/withdraw/i, /\/preliev/i,
  /\/order\/confirm/i, /\/place-?order/i, /\/conferma-?ordine/i,
];
const URL_SUSPICIOUS_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:'];

/** Vero se `host` è esattamente `domain` o un suo sottodominio. */
function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/** Vero se una delle etichette DNS di `host` è esattamente `label`. */
function hostHasLabel(host, label) {
  return host.split('.').includes(label);
}

function classifyUrlRisk(rawUrl) {
  const reasons = [];
  let level = 'read';

  const lower = String(rawUrl || '').toLowerCase().trim();
  for (const scheme of URL_SUSPICIOUS_SCHEMES) {
    if (lower.startsWith(scheme)) return { level: 'destructive', reasons: [`Schema sospetto: ${scheme}`] };
  }

  let url;
  try { url = new URL(rawUrl); } catch { return { level: 'interact', reasons: ['URL non parsabile'] }; }

  const host = url.hostname.toLowerCase();
  const fullPath = url.pathname + url.search;

  // Credenziali nell'URL: tecnica classica di offuscamento del vero host
  if (url.username || url.password) {
    return { level: 'destructive', reasons: ['URL con credenziali incorporate'] };
  }

  const isKnownSafe = URL_READ_ONLY_DOMAINS.some(d => hostMatchesDomain(host, d));

  for (const d of URL_SENSITIVE_DOMAINS) {
    if (hostMatchesDomain(host, d)) { level = maxRisk(level, 'send_prepare'); reasons.push(`Dominio sensibile: ${d}`); }
  }
  for (const l of SENSITIVE_LABELS) {
    if (hostHasLabel(host, l)) { level = maxRisk(level, 'send_prepare'); reasons.push(`Sottodominio sensibile: ${l}`); }
  }
  for (const p of URL_MUTATING_PARAMS) {
    if (p.test(fullPath)) { level = maxRisk(level, 'destructive'); reasons.push(`Query mutativa: ${p.source}`); }
  }
  for (const p of URL_ADMIN_PATHS) {
    if (p.test(url.pathname)) { level = maxRisk(level, 'write_form'); reasons.push(`Path admin: ${p.source}`); }
  }
  for (const p of URL_TRANSACTION_PATHS) {
    if (p.test(url.pathname)) { level = maxRisk(level, 'send_prepare'); reasons.push(`Path transazionale: ${p.source}`); }
  }

  // La whitelist vale solo se nient'altro ha alzato il rischio: un dominio
  // fidato con /checkout o ?pay= resta trattato come rischioso.
  if (isKnownSafe && level === 'read') return { level: 'read', reasons: ['Whitelist read-only'] };
  return { level, reasons: reasons.length ? reasons : ['Default read'] };
}

module.exports = { classifyUrlRisk, hostMatchesDomain, hostHasLabel };
