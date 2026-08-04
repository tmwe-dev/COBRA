// modules/risk/pending-actions.js — Pending action store + guard + confirm summary
// Source: server.js lines 311-514 (merged confirm-summary.js)

const crypto = require('crypto');
const { computeEffectiveRisk, computePayloadHash } = require('./calculator');
const _approvalSecret = process.env.APPROVAL_JWT_SECRET || crypto.randomBytes(32).toString('hex');

const _pendingActions = new Map();
const _feedbackStats = new Map();
// Indice inverso approval_token -> id, per la verifica in tempo costante
const _tokenIndex = new Map();
// Le azioni decise restano consultabili per un'ora, poi vengono rimosse
const DECIDED_RETENTION_MS = 3600000;
const MAX_RETAINED_ACTIONS = 2000;

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
  const token = crypto.createHmac('sha256', _approvalSecret)
    .update(`${id}:${a.payload_hash}:${a.expires_at.getTime()}`).digest('hex');
  _tokenIndex.set(token, id);
  return { ok: true, approval_token: token, expires_at: a.expires_at };
}

function rejectPendingAction(id, userId, note) {
  const a = _pendingActions.get(id);
  if (!a || a.status !== 'pending') return { ok: false, reason: 'Non trovata o già decisa' };
  a.status = 'rejected'; a.decided_at = new Date(); a.decided_by = userId; a.decision_note = note;
  recordFeedback(a.tool_name, 'rejected');
  return { ok: true };
}

/** Confronto a tempo costante fra token. */
function _tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyApprovalToken(token, payloadHash) {
  // Indice inverso token -> id: verifica O(1) invece di scorrere tutte le azioni
  const id = _tokenIndex.get(token);
  if (!id) return { valid: false, reason: 'Token invalido/scaduto/mismatch' };
  const a = _pendingActions.get(id);
  if (!a || a.status !== 'approved' || new Date() >= a.expires_at) {
    _tokenIndex.delete(token);
    return { valid: false, reason: 'Token invalido/scaduto/mismatch' };
  }
  const expected = crypto.createHmac('sha256', _approvalSecret)
    .update(`${id}:${a.payload_hash}:${a.expires_at.getTime()}`).digest('hex');
  if (!_tokensMatch(expected, token) || a.payload_hash !== payloadHash) {
    return { valid: false, reason: 'Token invalido/scaduto/mismatch' };
  }
  // Un token vale per una sola esecuzione
  a.status = 'executed';
  a.executed_at = new Date();
  _tokenIndex.delete(token);
  return { valid: true, action: a };
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

/**
 * Manutenzione periodica: marca le azioni scadute e rimuove quelle già decise
 * da oltre un'ora. Senza questa rimozione la Map cresce indefinitamente.
 */
function sweepPendingActions(now = new Date()) {
  let expired = 0, removed = 0;
  for (const [id, a] of _pendingActions) {
    if (a.status === 'pending' && now > a.expires_at) {
      a.status = 'expired';
      recordFeedback(a.tool_name, 'expired');
      expired++;
    }
    const decidedAt = a.decided_at || a.executed_at || a.expires_at;
    const isClosed = a.status !== 'pending';
    if (isClosed && decidedAt && (now - new Date(decidedAt)) > DECIDED_RETENTION_MS) {
      _pendingActions.delete(id);
      removed++;
    }
  }
  // Tetto assoluto: se il volume è alto si eliminano prima le più vecchie chiuse
  if (_pendingActions.size > MAX_RETAINED_ACTIONS) {
    const closed = [..._pendingActions.entries()]
      .filter(([, a]) => a.status !== 'pending')
      .sort((x, y) => new Date(x[1].created_at) - new Date(y[1].created_at));
    for (const [id] of closed.slice(0, _pendingActions.size - MAX_RETAINED_ACTIONS)) {
      _pendingActions.delete(id);
      removed++;
    }
  }
  // Ripulisce l'indice dai token che non puntano più a un'azione approvata
  for (const [tok, id] of _tokenIndex) {
    const a = _pendingActions.get(id);
    if (!a || a.status !== 'approved' || now >= a.expires_at) _tokenIndex.delete(tok);
  }
  return { expired, removed, retained: _pendingActions.size, tokens: _tokenIndex.size };
}

const _sweepTimer = setInterval(() => sweepPendingActions(), 30000);
if (_sweepTimer.unref) _sweepTimer.unref(); // non tiene vivo il processo nei test

module.exports = { createPendingAction, approvePendingAction, rejectPendingAction,
  verifyApprovalToken, getActivePendingActions, getFeedbackStats, guardToolCall,
  sweepPendingActions, _pendingActions, _tokenIndex };
