// modules/tools/executor.js — executeTool() dispatcher + pre/post guards
// Source: server.js lines 4939-7204

const { COBRA_DEFAULTS } = require('../config');
const { isDomainWhitelisted } = require('../config/whitelist');
const { auditToolCall, auditSecurityEvent } = require('../security/audit-log');

const INTERACT_TOOLS = ['click_element', 'fill_form', 'type_human', 'select_option', 'press_key',
  'key_combo', 'select_dropdown', 'set_datepicker', 'drag_drop', 'upload_file', 'clipboard_write',
  'mutate_dom_js', 'hover_element'];

function validateToolArgs(name, args) {
  if (name === 'navigate' || name === 'scrape_url') {
    let url = args.url || '';
    if (!url.startsWith('http')) url = 'https://' + url;
    args.url = url;
  }
  if (['execute_js', 'inspect_dom_js', 'mutate_dom_js'].includes(name) && args.code?.length > COBRA_DEFAULTS.MAX_JS_CODE_LENGTH) {
    throw new Error(`Code troppo lungo (${args.code.length} > ${COBRA_DEFAULTS.MAX_JS_CODE_LENGTH})`);
  }
  if (name === 'click_element' && args.selector?.length > COBRA_DEFAULTS.MAX_SELECTOR_LENGTH) {
    throw new Error('Selector troppo lungo');
  }
  if (name === 'google_search' && args.query?.length > COBRA_DEFAULTS.MAX_SEARCH_QUERY_LENGTH) {
    args.query = args.query.substring(0, COBRA_DEFAULTS.MAX_SEARCH_QUERY_LENGTH);
  }
  return args;
}

// Handler registry — populated by registerHandlers()
const _handlers = {};

function registerHandlers(handlerMap) {
  for (const [toolName, fn] of Object.entries(handlerMap)) _handlers[toolName] = fn;
}

async function executeTool(name, args, ctx) {
  // Validate args
  try { args = validateToolArgs(name, args); } catch (e) { return JSON.stringify({ error: e.message }); }

  // SuperMario hard guards
  const marioValidation = ctx.SuperMario.validateToolCall(name, args);
  if (!marioValidation.valid) {
    const blockWarnings = marioValidation.warnings.filter(w => w.startsWith('dangerous_js_pattern') || w.startsWith('send_missing_recipient'));
    if (blockWarnings.length > 0) {
      ctx.log(`[SuperMario] BLOCKED tool ${name}: ${blockWarnings.join(', ')}`);
      return JSON.stringify({ error: `Tool bloccato: ${blockWarnings.join(', ')}`, blocked: true });
    }
    if (marioValidation.warnings.length > 0) ctx.log(`[SuperMario] Tool ${name} warnings: ${marioValidation.warnings.join(', ')}`);
  }

  // Whitelist guard — block DOM interaction on non-whitelisted domains
  if (INTERACT_TOOLS.includes(name)) {
    const currentUrl = ctx.session.lastPage?.url;
    if (!isDomainWhitelisted(currentUrl)) {
      ctx.log(`[Whitelist] BLOCKED ${name} on ${currentUrl}`);
      return JSON.stringify({ error: `Tool ${name} bloccato: dominio non in whitelist. COBRA opera in sola lettura su questo sito.`, blocked: true, reason: 'domain_not_whitelisted' });
    }
  }

  // Track usage
  const desc = `${name}(${JSON.stringify(args).substring(0, 80)})`;
  ctx.toolHistory.push(desc);
  if (ctx.toolHistory.length > COBRA_DEFAULTS.ACTION_LOG_MAX_SIZE) ctx.toolHistory.shift();

  // Supervisor tracking
  const loopWarning = ctx.CobraSupervisor.recordToolCall(name, args);
  if (loopWarning) {
    return JSON.stringify({ error: loopWarning.message || `Loop circolare: ${name}`, warning: loopWarning.warning || 'circular_loop', force_stop: loopWarning.warning === 'force_stop' });
  }

  // Security guard
  const guard = ctx.guardToolCall(name, args, 'default', ctx.session.currentApprovalToken);
  if (guard.kind === 'reject') {
    ctx.log(`[Security] REJECTED ${name}: ${guard.reason}`);
    ctx.wsBroadcast({ type: 'tool_rejected', tool: name, reason: guard.reason });
    auditSecurityEvent('tool_rejected', { tool: name, reason: guard.reason }, ctx.session?.id);
    return JSON.stringify({ error: `Azione rifiutata: ${guard.reason}`, rejected: true });
  }
  if (guard.kind === 'block_for_confirmation') {
    ctx.log(`[Security] BLOCKED ${name} (risk=${guard.effective_risk})`);
    ctx.wsBroadcast({ type: 'pending_action', id: guard.pending_action_id, tool: name, risk: guard.effective_risk, summary: guard.summary, expires_at: guard.expires_at.toISOString(), reasons: guard.reasons });
    return JSON.stringify({ status: 'pending_confirmation', pending_action_id: guard.pending_action_id, risk_level: guard.effective_risk, message: `Azione intercettata. In attesa di conferma. ID: ${guard.pending_action_id}`, instructions_for_ai: 'NON rigenerare la chiamata. Spiega all\'utente e attendi conferma.' });
  }
  if (guard.effective_risk !== 'read' && guard.effective_risk !== 'inspect') {
    ctx.log(`[Security] ALLOW ${name} (risk=${guard.effective_risk}) ${guard.reasons.join(' | ')}`);
  }

  const _toolExecStart = Date.now();
  let _toolResult;
  try {
    const handler = _handlers[name];
    if (!handler) return JSON.stringify({ error: `Tool "${name}" non implementato` });
    _toolResult = await handler(args, ctx);
    return _toolResult;
  } catch (e) {
    _toolResult = JSON.stringify({ error: `${name}: ${e.message}` });
    return _toolResult;
  } finally {
    const _toolLatency = Date.now() - _toolExecStart;
    try { ctx.SuperMario.logToolExecution(name, args, (_toolResult || '').substring(0, 500), guard.effective_risk, guard.kind, _toolLatency); } catch (_) { /* best-effort */ }
    // P0.2: Persistent audit log
    auditToolCall(name, args, guard.effective_risk, guard.kind, _toolResult, ctx.session?.id);
  }
}

module.exports = { executeTool, registerHandlers, validateToolArgs };
