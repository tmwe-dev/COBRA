// modules/security/audit-log.js — Persistent, append-only audit log (P0.2)
// Writes JSONL to disk. Immutable: no delete/update API.

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.COBRA_AUDIT_DIR || path.join(__dirname, '..', '..', 'data', 'audit');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB rotation threshold

// Ensure directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* best-effort */ }

/**
 * appendAuditEntry(entry) — Append a single audit record.
 * Fields: timestamp, event, actor, tool, args_summary, risk, result_summary, session_id, metadata
 */
function appendAuditEntry(entry) {
  try {
    const record = {
      ts: new Date().toISOString(),
      event: entry.event || 'unknown',
      actor: entry.actor || 'system',
      tool: entry.tool || null,
      args_summary: entry.args_summary || null,
      risk: entry.risk || null,
      result: entry.result || null,
      session_id: entry.session_id || null,
      meta: entry.meta || null,
    };
    const line = JSON.stringify(record) + '\n';

    // Rotate if file exceeds threshold
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_FILE_SIZE) {
        const rotated = LOG_FILE.replace('.jsonl', `-${Date.now()}.jsonl`);
        fs.renameSync(LOG_FILE, rotated);
      }
    } catch { /* file doesn't exist yet, fine */ }

    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    // Last-resort: console (never lose audit events silently)
    console.error(`[AuditLog] WRITE FAILED: ${e.message}`, JSON.stringify(entry).substring(0, 200));
  }
}

/**
 * auditToolCall(name, args, risk, kind, result, sessionId) — Convenience for tool execution audit.
 */
function auditToolCall(name, args, risk, kind, result, sessionId) {
  appendAuditEntry({
    event: 'tool_call',
    actor: 'cobra',
    tool: name,
    args_summary: JSON.stringify(args).substring(0, 300),
    risk,
    result: (typeof result === 'string' ? result : JSON.stringify(result || '')).substring(0, 300),
    session_id: sessionId,
    meta: { kind },
  });
}

/**
 * auditSecurityEvent(event, details, sessionId) — Log security-relevant events.
 */
function auditSecurityEvent(event, details, sessionId) {
  appendAuditEntry({
    event: `security:${event}`,
    actor: 'system',
    session_id: sessionId,
    meta: details,
  });
}

/**
 * auditAICall(provider, model, promptTokens, completionTokens, sessionId) — Log AI provider calls.
 */
function auditAICall(provider, model, promptTokens, completionTokens, sessionId) {
  appendAuditEntry({
    event: 'ai_call',
    actor: 'cobra',
    session_id: sessionId,
    meta: { provider, model, promptTokens, completionTokens, totalTokens: (promptTokens || 0) + (completionTokens || 0) },
  });
}

/**
 * readAuditLog(options) — Read audit entries (for monitoring routes).
 */
function readAuditLog(options = {}) {
  const { limit = 100, event = null } = options;
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (event) entries = entries.filter(e => e.event === event || e.event?.startsWith(event));
    return entries.slice(-limit);
  } catch { return []; }
}

module.exports = { appendAuditEntry, auditToolCall, auditSecurityEvent, auditAICall, readAuditLog };
