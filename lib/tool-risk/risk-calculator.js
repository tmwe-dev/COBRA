/**
 * lib/tool-risk/risk-calculator.js
 * Effective risk computation based on tool type and arguments
 */

const { getToolRiskSpec, RISK_REQUIRES_CONFIRMATION, RISK_DEFAULT_TTL, maxRisk } = require('./taxonomy');
const { classifyUrlRisk, classifyClickIntent, detectDangerousJs } = require('./classifiers');

function computeEffectiveRisk(toolName, toolArgs) {
  const spec = getToolRiskSpec(toolName);
  let level = spec.level;
  const reasons = [`tool=${toolName} base=${spec.level}`];

  if (toolName === 'navigate' || toolName === 'read_page' || toolName === 'scrape_url') {
    const url = toolArgs.url || toolArgs.target;
    if (typeof url === 'string') {
      const urlRisk = classifyUrlRisk(url);
      level = maxRisk(level, urlRisk.level);
      reasons.push(`url_risk=${urlRisk.level} (${urlRisk.reasons.join('; ')})`);
    }
  }

  if (toolName === 'click_element') {
    const sel = toolArgs.selector || '';
    const vis = toolArgs.text || toolArgs.visible_text;
    const clickRisk = classifyClickIntent(String(sel), vis);
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

  if (toolName === 'mutate_dom_js' || toolName === 'inspect_dom_js' || toolName === 'execute_js') {
    const code = String(toolArgs.code || '');
    const dangerous = detectDangerousJs(code);
    if (dangerous.length > 0) {
      level = 'destructive';
      reasons.push(`JS pericolosi: ${dangerous.join(', ')}`);
    }
  }

  const levelRequiresConfirm = RISK_REQUIRES_CONFIRMATION[level];
  const requiresConfirm = (spec.confirm === false) ? false : (spec.confirm === true) ? true : levelRequiresConfirm;
  const ttl = spec.ttl || RISK_DEFAULT_TTL[level];
  return { level, requires_confirmation: requiresConfirm, ttl, reasons };
}

module.exports = {
  computeEffectiveRisk,
};
