// modules/security/audit-log.js — Persistent, append-only audit log (P0.2)
// Writes JSONL to disk. Immutable: no delete/update API.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = process.env.COBRA_AUDIT_DIR || path.join(__dirname, '..', '..', 'data', 'audit');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // soglia di rotazione: 50 MB

// Ensure directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* best-effort */ }

// ── Catena di hash ──────────────────────────────────────────────
// Ogni riga include l'hash della precedente. Modificare o rimuovere una riga
// a posteriori rompe la catena e diventa rilevabile con verifyAuditChain().
const GENESIS = '0'.repeat(64);
let _prevHash = GENESIS;

function _hashRecord(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/** Recupera l'ultimo hash dal file, così la catena continua dopo un riavvio. */
function _loadLastHash() {
  try {
    if (!fs.existsSync(LOG_FILE)) return GENESIS;
    const size = fs.statSync(LOG_FILE).size;
    if (size === 0) return GENESIS;
    // Legge solo la coda del file: evita di caricare in memoria decine di MB
    const readLen = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(readLen);
    const fd = fs.openSync(LOG_FILE, 'r');
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.hash) return rec.hash;
      } catch { /* riga parziale o corrotta: si prova la precedente */ }
    }
  } catch { /* best-effort */ }
  return GENESIS;
}
_prevHash = _loadLastHash();

// ── Scrittura asincrona con buffer ──────────────────────────────
// appendFileSync bloccava il thread ad ogni tool call. Le righe vengono
// accodate in memoria e scritte in blocco, preservando l'ordine.
let _queue = [];
let _flushTimer = null;
let _flushing = false;

function _rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_FILE_SIZE) {
      fs.renameSync(LOG_FILE, LOG_FILE.replace('.jsonl', `-${Date.now()}.jsonl`));
    }
  } catch { /* il file non esiste ancora */ }
}

function flushAuditSync() {
  if (_queue.length === 0) return;
  const chunk = _queue.join('');
  _queue = [];
  try {
    _rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, chunk, 'utf8');
  } catch (e) {
    console.error(`[AuditLog] SCRITTURA FALLITA: ${e.message}`);
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (_flushing) return;
    _flushing = true;
    const chunk = _queue.join('');
    _queue = [];
    if (!chunk) { _flushing = false; return; }
    try { _rotateIfNeeded(); } catch { /* best-effort */ }
    fs.appendFile(LOG_FILE, chunk, 'utf8', (err) => {
      _flushing = false;
      if (err) console.error(`[AuditLog] SCRITTURA FALLITA: ${err.message}`);
      if (_queue.length > 0) _scheduleFlush();
    });
  }, 200);
  if (_flushTimer.unref) _flushTimer.unref();
}

/**
 * Accoda un record di audit. Ogni record porta l'hash del precedente,
 * formando una catena verificabile.
 */
function appendAuditEntry(entry) {
  try {
    const base = {
      ts: new Date().toISOString(),
      event: entry.event || 'unknown',
      actor: entry.actor || 'system',
      tool: entry.tool || null,
      args_summary: entry.args_summary || null,
      risk: entry.risk || null,
      result: entry.result || null,
      session_id: entry.session_id || null,
      meta: entry.meta || null,
      prev: _prevHash,
    };
    const hash = _hashRecord(base);
    _prevHash = hash;
    _queue.push(JSON.stringify({ ...base, hash }) + '\n');
    // Oltre una certa soglia si scrive subito, per non accumulare troppo
    if (_queue.length >= 200) flushAuditSync();
    else _scheduleFlush();
  } catch (e) {
    console.error(`[AuditLog] SCRITTURA FALLITA: ${e.message}`, JSON.stringify(entry).substring(0, 200));
  }
}

// Nessuna voce deve andare persa se il processo termina con voci ancora in coda.
// Si scrive in modo sincrono sull'uscita, qualunque sia la causa.
process.on('exit', () => { try { flushAuditSync(); } catch { /* ultima spiaggia */ } });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { flushAuditSync(); } catch { /* ultima spiaggia */ } });
}

/**
 * Ricalcola la catena e segnala la prima riga alterata o mancante.
 * @returns {{valid: boolean, entries: number, brokenAt: number|null, reason: string|null}}
 */
function verifyAuditChain(filePath = LOG_FILE) {
  flushAuditSync();
  if (!fs.existsSync(filePath)) return { valid: true, entries: 0, brokenAt: null, reason: null };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); }
    catch { return { valid: false, entries: i, brokenAt: i + 1, reason: 'riga non leggibile' }; }
    // Le righe scritte prima dell'introduzione della catena non hanno hash
    if (!rec.hash) { prev = GENESIS; continue; }
    if (rec.prev !== prev) {
      return { valid: false, entries: i, brokenAt: i + 1, reason: 'catena interrotta: riga rimossa o riordinata' };
    }
    const { hash, ...body } = rec;
    if (_hashRecord(body) !== hash) {
      return { valid: false, entries: i, brokenAt: i + 1, reason: 'contenuto della riga alterato' };
    }
    prev = hash;
  }
  return { valid: true, entries: lines.length, brokenAt: null, reason: null };
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
  // Le scritture sono bufferizzate: una lettura deve vedere anche ciò che è
  // ancora in coda, altrimenti restituirebbe un quadro incompleto.
  flushAuditSync();
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (event) entries = entries.filter(e => e.event === event || e.event?.startsWith(event));
    return entries.slice(-limit);
  } catch { return []; }
}

module.exports = {
  appendAuditEntry, auditToolCall, auditSecurityEvent, auditAICall, readAuditLog,
  verifyAuditChain, flushAuditSync, LOG_FILE,
};
