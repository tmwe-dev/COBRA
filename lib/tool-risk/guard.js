/**
 * lib/tool-risk/guard.js
 * Main guard function for tool call authorization
 */

const { computeEffectiveRisk } = require('./risk-calculator');
const { computePayloadHash, buildConfirmSummary, createPendingAction, verifyApprovalToken } = require('./pending-actions');

function guardToolCall(toolName, toolArgs, sessionId, approvalToken) {
  const risk = computeEffectiveRisk(toolName, toolArgs);

  if (!risk.requires_confirmation) {
    return { kind: 'allow', effective_risk: risk.level, reasons: risk.reasons };
  }

  const payloadHash = computePayloadHash(toolName, toolArgs);

  if (approvalToken) {
    const verdict = verifyApprovalToken(approvalToken, payloadHash);
    if (verdict.valid) {
      return { kind: 'allow', effective_risk: risk.level, reasons: [...risk.reasons, 'approved'] };
    }
  }

  const summary = buildConfirmSummary(toolName, toolArgs, risk.level);
  const pending = createPendingAction(sessionId || 'default', 'operator', toolName, toolArgs, payloadHash, risk.level, summary, risk.ttl);

  return {
    kind: 'block_for_confirmation',
    pending_action_id: pending.id,
    effective_risk: risk.level,
    summary,
    expires_at: pending.expires_at,
    reasons: risk.reasons,
  };
}

module.exports = {
  guardToolCall,
};
