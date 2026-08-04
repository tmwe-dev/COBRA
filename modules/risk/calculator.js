// modules/risk/calculator.js — Risk computation (merged: click-intent, js-detector)
// Source: server.js lines 221-308

const crypto = require('crypto');
const { maxRisk, RISK_REQUIRES_CONFIRMATION, RISK_DEFAULT_TTL } = require('../config/constants');
const { getToolRiskSpec } = require('./taxonomy');
const { classifyUrlRisk } = require('./classifiers');

// ── Click intent (was click-intent.js) ──
const DESTRUCTIVE_BUTTON_PATTERNS = [
  /\b(paga|pay|checkout|pagamento)\b/i,
  /\b(conferma acquisto|confirm purchase|conferma pagamento|confirm payment)\b/i,
  /\b(elimina|delete|remove permanently)\b/i,
  /\b(acquista ora|buy now|purchase now|completa ordine|place order)\b/i,
];

function classifyClickIntent(selector, visibleText) {
  const haystack = `${selector} ${visibleText || ''}`.toLowerCase();
  if (/button\[type=["']?submit/i.test(selector) || /input\[type=["']?submit/i.test(selector)) {
    return { level: 'destructive', reason: 'Submit button' };
  }
  for (const p of DESTRUCTIVE_BUTTON_PATTERNS) {
    if (p.test(haystack)) return { level: 'destructive', reason: `Bottone irreversibile: ${p.source}` };
  }
  return { level: 'interact' };
}

// ── JS detector (was js-detector.js) ──
const ALWAYS_BLOCKED_JS = [
  /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\beval\s*\(/, /\bFunction\s*\(/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/,
  /\bdocument\.cookie\b/, /\bnavigator\.clipboard\b/, /\bwindow\.location\s*=/,
  /\.submit\s*\(/, /\.click\s*\(/, /\.innerHTML\s*=/, /\.outerHTML\s*=/,
  /\bdocument\.write\b/, /\bimport\s*\(/, /\bnew\s+Worker\b/, /\bpostMessage\b/,
];

function detectDangerousJs(code) {
  const found = [];
  for (const p of ALWAYS_BLOCKED_JS) { if (p.test(code)) found.push(p.source); }
  return found;
}

// ── Effective risk ──
function computeEffectiveRisk(toolName, toolArgs) {
  const spec = getToolRiskSpec(toolName);
  let level = spec.level;
  const reasons = [`tool=${toolName} base=${spec.level}`];

  if (['navigate', 'read_page', 'scrape_url'].includes(toolName)) {
    const url = toolArgs.url || toolArgs.target;
    if (typeof url === 'string') {
      const urlRisk = classifyUrlRisk(url);
      level = maxRisk(level, urlRisk.level);
      reasons.push(`url_risk=${urlRisk.level} (${urlRisk.reasons.join('; ')})`);
    }
  }
  if (toolName === 'click_element') {
    const clickRisk = classifyClickIntent(String(toolArgs.selector || ''), toolArgs.text || toolArgs.visible_text);
    level = maxRisk(level, clickRisk.level);
    if (clickRisk.reason) reasons.push(`click_intent=${clickRisk.level} (${clickRisk.reason})`);
  }
  if (toolName === 'press_key') {
    const key = String(toolArgs.key || '').toLowerCase();
    if (key === 'enter' || key === 'return') {
      level = maxRisk(level, 'destructive');
      reasons.push('Enter su form = potenziale submit');
    }
  }
  if (['mutate_dom_js', 'inspect_dom_js', 'execute_js'].includes(toolName)) {
    const dangerous = detectDangerousJs(String(toolArgs.code || ''));
    if (dangerous.length > 0) { level = 'destructive'; reasons.push(`JS pericolosi: ${dangerous.join(', ')}`); }
  }

  const levelRequiresConfirm = RISK_REQUIRES_CONFIRMATION[level];

  // Il rischio è "escalato" se l'analisi (URL, intento del click, JS) lo ha
  // portato sopra il livello base del tool.
  const escalated = level !== spec.level;

  // Semantica di spec.confirm:
  //   true      → conferma sempre richiesta
  //   false     → il tool di per sé non la richiede, MA se il rischio è escalato
  //               la conferma torna obbligatoria. Senza questa clausola un
  //               navigate verso una pagina di pagamento, o un click su "Paga ora",
  //               verrebbero eseguiti senza chiedere nulla.
  //   undefined → decide il livello di rischio
  let requiresConfirm;
  if (spec.confirm === true) requiresConfirm = true;
  else if (spec.confirm === false) requiresConfirm = escalated && levelRequiresConfirm;
  else requiresConfirm = levelRequiresConfirm;

  if (spec.confirm === false && requiresConfirm) {
    reasons.push(`conferma riattivata: rischio escalato ${spec.level} → ${level}`);
  }

  const ttl = spec.ttl || RISK_DEFAULT_TTL[level];
  return { level, requires_confirmation: requiresConfirm, ttl, reasons };
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function computePayloadHash(toolName, toolArgs) {
  return crypto.createHash('sha256')
    .update(canonicalize({ tool: toolName, args: toolArgs }))
    .digest('hex');
}

module.exports = { computeEffectiveRisk, computePayloadHash, classifyClickIntent, detectDangerousJs };
