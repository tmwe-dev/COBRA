// modules/security/output-sanitizer.js — Sanitize AI-generated output before sending (P0.3)
// Validates content before it's sent via email, WhatsApp, LinkedIn, etc.

const { sanitizeForLog } = require('./sanitize');

// Patterns that should never appear in outbound messages
const BLOCKED_PATTERNS = [
  // Credential leaks
  /\b(sk-[a-zA-Z0-9]{20,})\b/,                    // OpenAI keys
  /\b(anthropic-[a-zA-Z0-9]{20,})\b/,              // Anthropic keys
  /\b(AIza[a-zA-Z0-9_-]{35})\b/,                   // Google API keys
  /\b(ghp_[a-zA-Z0-9]{36})\b/,                     // GitHub tokens
  /\b(Bearer\s+[a-zA-Z0-9._~+/=-]{20,})\b/,        // Bearer tokens
  /\b([a-zA-Z0-9+/]{40,}={0,2})\b/,                // Long base64 (potential secrets)

  // System prompt leaks
  /COBRA_CORE/i,
  /system\s*prompt\s*:/i,
  /\[SYSTEM\]/,
  /SuperMario\.routeIntent/,
  /COBRA_DEFAULTS\./,

  // Internal infrastructure
  /localhost:\d{4}/,
  /127\.0\.0\.1/,
  /192\.168\.\d+\.\d+/,
  /10\.\d+\.\d+\.\d+/,
  /supabase\.co.*key/i,
];

// Content length limits per channel
const MAX_LENGTHS = {
  email: 50000,
  whatsapp: 4096,
  linkedin: 3000,
  default: 10000,
};

/**
 * sanitizeOutboundMessage(text, channel) → { text, blocked, warnings }
 * Scans and cleans AI-generated text before sending via communication channels.
 */
function sanitizeOutboundMessage(text, channel = 'default') {
  if (!text || typeof text !== 'string') return { text: '', blocked: false, warnings: [] };

  const warnings = [];
  let cleaned = text;
  let blocked = false;

  // 1. Check for blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cleaned)) {
      const match = cleaned.match(pattern);
      warnings.push(`Blocked pattern found: ${pattern.source.substring(0, 40)}`);
      // Redact the match
      cleaned = cleaned.replace(new RegExp(pattern.source, 'g'), '[REDACTED]');
    }
  }

  // 2. Strip potential HTML/script injection in non-email channels
  if (channel !== 'email') {
    cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleaned = cleaned.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
    cleaned = cleaned.replace(/on\w+="[^"]*"/gi, ''); // onclick, onload, etc.
  }

  // 3. For email HTML, sanitize dangerous tags but keep formatting
  if (channel === 'email') {
    cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleaned = cleaned.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
    cleaned = cleaned.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '');
    cleaned = cleaned.replace(/<embed[^>]*>/gi, '');
    cleaned = cleaned.replace(/javascript:/gi, '');
  }

  // 4. Enforce length limits
  const maxLen = MAX_LENGTHS[channel] || MAX_LENGTHS.default;
  if (cleaned.length > maxLen) {
    cleaned = cleaned.substring(0, maxLen);
    warnings.push(`Truncated to ${maxLen} chars (${channel} limit)`);
  }

  // 5. Block if too many redactions (likely a data leak attempt)
  const redactCount = (cleaned.match(/\[REDACTED\]/g) || []).length;
  if (redactCount > 3) {
    blocked = true;
    warnings.push(`Blocked: ${redactCount} redactions detected — possible data leak`);
  }

  return { text: cleaned, blocked, warnings };
}

module.exports = { sanitizeOutboundMessage };
