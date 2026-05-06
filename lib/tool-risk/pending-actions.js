/**
 * lib/tool-risk/pending-actions.js
 * Pending actions manager, approval tokens, feedback tracking
 */

const crypto = require('crypto');

// ── Payload Hash ──
function computePayloadHash(toolName, toolArgs) {
  const canonical = canonicalize({ tool: toolName, args: toolArgs });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// ── Build Summary for user ──
function buildConfirmSummary(toolName, toolArgs, riskLevel) {
  switch (toolName) {
    case 'send_email': {
      const to = toolArgs.to || '?';
      const subj = toolArgs.subject || '(senza oggetto)';
      const body = String(toolArgs.body || '').slice(0, 200);
      return `📧 INVIO EMAIL\n→ ${to}\nOggetto: ${subj}\n\n${body}${body.length >= 200 ? '...' : ''}`;
    }
    case 'open_whatsapp': {
      const to = toolArgs.phone || toolArgs.to || '?';
      const text = String(toolArgs.text || '').slice(0, 200);
      return `💬 APRE WHATSAPP (NON INVIA)\n→ ${to}\n\n${text}`;
    }
    case 'open_linkedin': {
      const target = toolArgs.profile || toolArgs.url || toolArgs.recipient || '?';
      return `🔗 APRE LINKEDIN\n→ ${target}`;
    }
    case 'linkedin_send_message': {
      const url = toolArgs.url || '?';
      const msg = String(toolArgs.message || '').slice(0, 200);
      return `✉️ INVIO MESSAGGIO LINKEDIN\n→ ${url}\n\n${msg}${msg.length >= 200 ? '...' : ''}`;
    }
    case 'linkedin_connect': {
      const url = toolArgs.url || '?';
      const note = toolArgs.note ? `\nNota: ${String(toolArgs.note).slice(0, 150)}` : '';
      return `🤝 RICHIESTA COLLEGAMENTO LINKEDIN\n→ ${url}${note}`;
    }
    case 'whatsapp_send': {
      const phone = toolArgs.phone || '?';
      const text = String(toolArgs.text || '').slice(0, 200);
      return `📱 INVIO MESSAGGIO WHATSAPP\n→ ${phone}\n\n${text}${text.length >= 200 ? '...' : ''}`;
    }
    case 'kb_delete': return `🗑️ CANCELLA KB\nTitolo: ${toolArgs.title || toolArgs.id}\nIRREVERSIBILE`;
    case 'mutate_dom_js': return `⚠️ JS MUTATIVO\n\n${String(toolArgs.code || '').slice(0, 300)}`;
    case 'click_element': return `🖱️ CLICK su ${toolArgs.selector} (potenziale azione irreversibile)`;
    default: return `[${riskLevel.toUpperCase()}] ${toolName}\n${JSON.stringify(toolArgs, null, 2).slice(0, 500)}`;
  }
}

// ── Pending Actions Store ──
const _pendingActions = new Map();

function createPendingAction(sessionId, userId, toolName, toolArgs, payloadHash, riskLevel, summary, ttlSeconds) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + (ttlSeconds || 300) * 1000);
  const action = {
    id, session_id: sessionId, user_id: userId,
    tool_name: toolName, tool_args: toolArgs,
    payload_hash: payloadHash, risk_level: riskLevel,
    summary, status: 'pending',
    created_at: new Date(), expires_at: expiresAt,
    decided_at: null, decided_by: null,
  };
  _pendingActions.set(id, action);
  return action;
}

function approvePendingAction(id, userId) {
  const action = _pendingActions.get(id);
  if (!action || action.status !== 'pending') return { ok: false, reason: 'Non trovata o già decisa' };
  if (new Date() > action.expires_at) {
    action.status = 'expired';
    return { ok: false, reason: 'Scaduta' };
  }
  action.status = 'approved';
  action.decided_at = new Date();
  action.decided_by = userId;
  recordFeedback(action.tool_name, 'approved');
  const secret = process.env.APPROVAL_JWT_SECRET || 'cobra-dev-secret-change-me';
  const token = crypto.createHmac('sha256', secret)
    .update(`${id}:${action.payload_hash}:${action.expires_at.getTime()}`)
    .digest('hex');
  return { ok: true, approval_token: token, expires_at: action.expires_at };
}

function rejectPendingAction(id, userId, note) {
  const action = _pendingActions.get(id);
  if (!action || action.status !== 'pending') return { ok: false, reason: 'Non trovata o già decisa' };
  action.status = 'rejected';
  action.decided_at = new Date();
  action.decided_by = userId;
  action.decision_note = note;
  recordFeedback(action.tool_name, 'rejected');
  return { ok: true };
}

function verifyApprovalToken(token, payloadHash) {
  for (const [id, action] of _pendingActions) {
    if (action.status === 'approved' && new Date() < action.expires_at) {
      const secret = process.env.APPROVAL_JWT_SECRET || 'cobra-dev-secret-change-me';
      const expected = crypto.createHmac('sha256', secret)
        .update(`${id}:${action.payload_hash}:${action.expires_at.getTime()}`)
        .digest('hex');
      if (expected === token && action.payload_hash === payloadHash) {
        action.status = 'executed';
        action.executed_at = new Date();
        return { valid: true, action };
      }
    }
  }
  return { valid: false, reason: 'Token invalido, scaduto o payload_hash mismatch' };
}

function getActivePendingActions(sessionId) {
  const now = new Date();
  const results = [];
  for (const [id, a] of _pendingActions) {
    if (a.status === 'pending' && now < a.expires_at && (!sessionId || a.session_id === sessionId)) {
      results.push(a);
    }
  }
  return results.sort((a, b) => a.created_at - b.created_at);
}

// ── Feedback tracker ──
const _feedbackStats = new Map();

function recordFeedback(toolName, outcome) {
  if (!_feedbackStats.has(toolName)) {
    _feedbackStats.set(toolName, { approved: 0, rejected: 0, expired: 0, total: 0, lastAdjusted: null });
  }
  const stats = _feedbackStats.get(toolName);
  stats[outcome] = (stats[outcome] || 0) + 1;
  stats.total++;
}

function getFeedbackStats() { return Object.fromEntries(_feedbackStats); }

// Expire old pending actions periodically
setInterval(() => {
  const now = new Date();
  for (const [id, a] of _pendingActions) {
    if (a.status === 'pending' && now > a.expires_at) { a.status = 'expired'; recordFeedback(a.tool_name, 'expired'); }
  }
}, 30000);

module.exports = {
  computePayloadHash,
  canonicalize,
  buildConfirmSummary,
  createPendingAction,
  approvePendingAction,
  rejectPendingAction,
  verifyApprovalToken,
  getActivePendingActions,
  recordFeedback,
  getFeedbackStats,
};
