// modules/risk/pending-actions.js — Pending action store + guard + confirm summary
// Source: server.js lines 311-514 (merged confirm-summary.js)

const crypto = require('crypto');
const { computeEffectiveRisk, computePayloadHash } = require('./calculator');

const _pendingActions = new Map();
const _feedbackStats = new Map();

// ── Confirm summary (was confirm-summary.js) ──
function buildConfirmSummary(toolName, toolArgs, riskLevel) {
  const slice = (s, n = 200) => { s = String(s || ''); return s.slice(0, n) + (s.length > n ? '...' : ''); };
  switch (toolName) {
    case 'send_email': return `📧 INVIO EMAIL\n→ ${toolArgs.to || '?'}\nOggetto: ${toolArgs.subject || '(senza oggetto)'}\n\n${slice(toolArgs.body)}`;
    case 'open_whatsapp': return `💬 APRE WHATSAPP\n→ ${toolArgs.phone || toolArgs.to || '?'}\n\n${slice(toolArgs.text)}`;
    case 'whatsapp_send': return `📱 MSG WHATSAPP\n→ ${toolArgs.phone || '?'}\n\n${slice(toolArgs.text)}`;
    case 'open_linkedin': return `🔗 APRE LINKEDIN\n→ ${toolArgs.profile || toolArgs.url || '?'}`;
    case 'linkedin_send_message': return `✉️ MSG LINKEDIN\n→ ${toolArgs.url || '?'}\n\n${slice(toolArgs.message)}`;
    case 'linkedin_connect': return `🤝 COLLEGAMENTO LINKEDIN\n→ ${toolArgs.url || '?'}${toolArgs.note ? '\nNota: ' + slice(toolArgs.note, 150) : ''}`;
    case 'kb_delete': return `🗑️ CANCELLA KB\nTitolo: ${toolArgs.title || toolArgs.id}\nIRREVERSIBILE`;
    case 'mutate_dom_js': return `⚠️ JS MUTATIVO\n\n${slice(toolArgs.code, 300)}`;
    case 'click_element': return `🖱️ CLICK su ${toolArgs.selector} (potenziale azione irreversibile)`;
    default: return `[${riskLevel.toUpperCase()}] ${toolName}\n${JSON.stringify(toolArgs, null, 2).slice(0, 500)}`;
  }
}

function recordFeedback(toolName, outcome) {
  if (!_feedbackStats.has(toolName)) _feedbackStats.set(toolName, { approved: 0, rejected: 0, expired: 0, total: 0 });
  const s = _feedbackStats.get(toolName);
  s[outcome] = (s[outcome] || 0) + 1;
  s.total++;
}

function createPendingAction(sessionId, userId, toolName, toolArgs, payloadHash, riskLevel, summary, ttlSeconds) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + (ttlSeconds || 300) * 1000);
  const action = { id, session_id: sessionId, user_id: userId, tool_name: toolName, tool_args: toolArgs,
    payload_hash: payloadHash, risk_level: riskLevel, summary, status: 'pending',
    created_at: new Date(), expires_at: expiresAt, decided_at: null, decided_by: null };
  _pendingActions.set(id, action);
  return action;
}

function approvePendingAction(id, userId) {
  const a = _pendingActions.get(id);
  if (!a || a.status !== 'pending') return { ok: false, reason: 'Non trovata o già decisa' };
  if (new Date() > a.expires_at) { a.status = 'expired'; return { ok: false, reason: 'Scaduta' }; }
  a.status = 'approved'; a.decided_at = new Date(); a.decided_by = userId;
  recordFeedback(a.tool_name, 'approved');
  const secret = process.env.APPROVAL_JWT_SECRET || 'cobra-dev-secret-change-me';
  const token = crypto.createHmac('sha256', secret).update(`${id}:${a.payload_hash}:${a.expires_at.getTime()}`).digest('hex');
  return { ok: true, approval_token: token, expires_at: a.expires_at };
}

function rejectPendingAction(id, userId, note) {
  const a = _pendingActions.get(id);
  if (!a || a.status !== 'pending') return { ok: false, reason: 'Non trovata o già decisa' };
  a.status = 'rejected'; a.decided_at = new Date(); a.decided_by = userId; a.decision_note = note;
  recordFeedback(a.tool_name, 'rejected');
  return { ok: true };
}

function verifyApprovalToken(token, payloadHash) {
  const secret = process.env.APPROVAL_JWT_SECRET || 'cobra-dev-secret-change-me';
  for (const [id, a] of _pendingActions) {
    if (a.status !== 'approved' || new Date() >= a.expires_at) continue;
    const expected = crypto.createHmac('sha256', secret).update(`${id}:${a.payload_hash}:${a.expires_at.getTime()}`).digest('hex');
    if (expected === token && a.payload_hash === payloadHash) { a.status = 'executed'; a.executed_at = new Date(); return { valid: true, action: a }; }
  }
  return { valid: false, reason: 'Token invalido/scaduto/mismatch' };
}

function getActivePendingActions(sessionId) {
  const now = new Date();
  return [..._pendingActions.values()]
    .filter(a => a.status === 'pending' && now < a.expires_at && (!sessionId || a.session_id === sessionId))
    .sort((a, b) => a.created_at - b.created_at);
}

function getFeedbackStats() { return Object.fromEntries(_feedbackStats); }

function guardToolCall(toolName, toolArgs, sessionId, approvalToken, log) {
  const risk = computeEffectiveRisk(toolName, toolArgs);
  if (!risk.requires_confirmation) return { kind: 'allow', effective_risk: risk.level, reasons: risk.reasons };
  const payloadHash = computePayloadHash(toolName, toolArgs);
  if (approvalToken) {
    const v = verifyApprovalToken(approvalToken, payloadHash);
    if (v.valid) return { kind: 'allow', effective_risk: risk.level, reasons: [...risk.reasons, 'approved'] };
    if (log) log(`[Security] Approval mismatch for ${toolName} — new pending`);
  }
  const summary = buildConfirmSummary(toolName, toolArgs, risk.level);
  const pending = createPendingAction(sessionId || 'default', 'operator', toolName, toolArgs, payloadHash, risk.level, summary, risk.ttl);
  return { kind: 'block_for_confirmation', pending_action_id: pending.id, effective_risk: risk.level, summary, expires_at: pending.expires_at, reasons: risk.reasons };
}

setInterval(() => {
  const now = new Date();
  for (const [, a] of _pendingActions) {
    if (a.status === 'pending' && now > a.expires_at) { a.status = 'expired'; recordFeedback(a.tool_name, 'expired'); }
  }
}, 30000);

module.exports = { createPendingAction, approvePendingAction, rejectPendingAction,
  verifyApprovalToken, getActivePendingActions, getFeedbackStats, guardToolCall, _pendingActions };
