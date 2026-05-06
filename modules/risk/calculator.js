// modules/risk/calculator.js — Effective risk computation + payload hash
// Source: server.js lines 247-308

const crypto = require('crypto');
const { maxRisk, RISK_REQUIRES_CONFIRMATION, RISK_DEFAULT_TTL } = require('../config/constants');
const { getToolRiskSpec } = require('./taxonomy');
const { classifyUrlRisk } = require('./classifiers');
const { classifyClickIntent } = require('./click-intent');
const { detectDangerousJs } = require('./js-detector');

function computeEffectiveRisk(toolName, toolArgs) {
  const spec = getToolRiskSpec(toolName);
  let level = spec.level;
  const reasons = [`tool=${toolName} base=${spec.level}`];

  // URL boost
  if (['navigate', 'read_page', 'scrape_url'].includes(toolName)) {
    const url = toolArgs.url || toolArgs.target;
    if (typeof url === 'string') {
      const urlRisk = classifyUrlRisk(url);
      level = maxRisk(level, urlRisk.level);
      reasons.push(`url_risk=${urlRisk.level} (${urlRisk.reasons.join('; ')})`);
    }
  }

  // Click intent boost
  if (toolName === 'click_element') {
    const sel = toolArgs.selector || '';
    const vis = toolArgs.text || toolArgs.visible_text;
    const clickRisk = classifyClickIntent(String(sel), vis);
    level = maxRisk(level, clickRisk.level);
    if (clickRisk.reason) reasons.push(`click_intent=${clickRisk.level} (${clickRisk.reason})`);
  }

  // Enter = potential submit
  if (toolName === 'press_key') {
    const key = String(toolArgs.key || '').toLowerCase();
    if (key === 'enter' || key === 'return') {
      level = maxRisk(level, 'destructive');
      reasons.push('Enter su form = potenziale submit');
    }
  }

  // JS pattern check
  if (['mutate_dom_js', 'inspect_dom_js', 'execute_js'].includes(toolName)) {
    const dangerous = detectDangerousJs(String(toolArgs.code || ''));
    if (dangerous.length > 0) {
      level = 'destructive';
      reasons.push(`JS pericolosi: ${dangerous.join(', ')}`);
    }
  }

  const levelRequiresConfirm = RISK_REQUIRES_CONFIRMATION[level];
  const requiresConfirm = spec.confirm === false ? false : spec.confirm === true ? true : levelRequiresConfirm;
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

module.exports = { computeEffectiveRisk, computePayloadHash };
