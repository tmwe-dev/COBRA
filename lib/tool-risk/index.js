/**
 * lib/tool-risk/index.js
 * Re-exports all tool-risk modules
 */

const {
  RISK_LEVELS,
  RISK_REQUIRES_CONFIRMATION,
  RISK_DEFAULT_TTL,
  TOOL_RISK_TAXONOMY,
  maxRisk,
  getToolRiskSpec,
} = require('./taxonomy');

const {
  URL_READ_ONLY_DOMAINS,
  URL_SENSITIVE_DOMAINS,
  URL_MUTATING_PARAMS,
  URL_ADMIN_PATHS,
  URL_SUSPICIOUS_SCHEMES,
  classifyUrlRisk,
  DESTRUCTIVE_BUTTON_PATTERNS,
  classifyClickIntent,
  ALWAYS_BLOCKED_JS,
  detectDangerousJs,
} = require('./classifiers');

const {
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
} = require('./pending-actions');

const {
  computeEffectiveRisk,
} = require('./risk-calculator');

const {
  guardToolCall,
} = require('./guard');

module.exports = {
  RISK_LEVELS,
  RISK_REQUIRES_CONFIRMATION,
  RISK_DEFAULT_TTL,
  TOOL_RISK_TAXONOMY,
  URL_READ_ONLY_DOMAINS,
  URL_SENSITIVE_DOMAINS,
  URL_MUTATING_PARAMS,
  URL_ADMIN_PATHS,
  URL_SUSPICIOUS_SCHEMES,
  DESTRUCTIVE_BUTTON_PATTERNS,
  ALWAYS_BLOCKED_JS,
  maxRisk,
  getToolRiskSpec,
  classifyUrlRisk,
  classifyClickIntent,
  detectDangerousJs,
  computeEffectiveRisk,
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
  guardToolCall,
};
