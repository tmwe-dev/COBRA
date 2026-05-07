// modules/security/injection.js — Prompt injection detection on scraped content (P0.1)
// Scans text for embedded instructions that attempt to manipulate the AI agent.

const INJECTION_PATTERNS = [
  // Direct instruction override
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /override\s+(system|safety|security)\s+(prompt|instructions|rules)/i,

  // Role hijacking
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /act\s+as\s+(a|an|if)\s+/i,
  /pretend\s+(you\s+are|to\s+be)\s+/i,
  /switch\s+to\s+(a\s+)?new\s+(role|persona|mode)/i,
  /enter\s+(developer|admin|god|sudo|root)\s+mode/i,

  // System prompt extraction
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /show\s+(me\s+)?(your|the)\s+(system\s+)?prompt/i,
  /print\s+(your|the)\s+(system\s+)?prompt/i,
  /output\s+(your|the)\s+instructions/i,
  /what\s+are\s+your\s+(system\s+)?instructions/i,

  // Delimiter / context manipulation
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<\s*SYS\s*>>/i,
  /<\|im_start\|>/i,
  /```system/i,
  /\bEND_TURN\b/,
  /\bHUMAN_TURN\b/,
  /\bASSISTANT_TURN\b/,

  // Encoding-based evasion
  /base64\s*decode/i,
  /eval\s*\(\s*atob/i,

  // Tool/action manipulation
  /execute\s+this\s+(command|code|script)/i,
  /run\s+the\s+following\s+(command|code|script)/i,
  /call\s+(the\s+)?tool\s+/i,
  /use\s+send_email\s+to/i,
  /use\s+whatsapp_send\s+to/i,

  // Authority claim
  /this\s+is\s+(a|an)\s+(system|admin|developer)\s+message/i,
  /authorized\s+by\s+(the\s+)?(admin|developer|system)/i,
  /emergency\s+override/i,
  /priority\s+instruction/i,
];

// Weighted scoring: each match adds weight; threshold triggers detection
const WEIGHT_HIGH = 3;   // Direct instruction override, role hijacking
const WEIGHT_MEDIUM = 2; // Delimiter injection, tool manipulation
const WEIGHT_LOW = 1;    // Suspicious but possibly benign

const PATTERN_WEIGHTS = INJECTION_PATTERNS.map((_, i) => {
  if (i < 4) return WEIGHT_HIGH;       // instruction override
  if (i < 10) return WEIGHT_HIGH;      // role hijacking
  if (i < 15) return WEIGHT_MEDIUM;    // prompt extraction
  if (i < 22) return WEIGHT_MEDIUM;    // delimiter injection
  if (i < 24) return WEIGHT_LOW;       // encoding evasion
  if (i < 29) return WEIGHT_MEDIUM;    // tool manipulation
  return WEIGHT_HIGH;                  // authority claim
});

const DETECTION_THRESHOLD = 3;

/**
 * detectPromptInjection(text) → { detected: bool, score: number, matches: string[] }
 * Scans text for prompt injection patterns.
 * Returns detected=true if cumulative score >= threshold.
 */
function detectPromptInjection(text) {
  if (!text || typeof text !== 'string') return { detected: false, score: 0, matches: [] };

  // Limit scan to first 50K chars (performance guard)
  const sample = text.length > 50000 ? text.substring(0, 50000) : text;

  let score = 0;
  const matches = [];

  for (let i = 0; i < INJECTION_PATTERNS.length; i++) {
    if (INJECTION_PATTERNS[i].test(sample)) {
      score += PATTERN_WEIGHTS[i];
      matches.push(INJECTION_PATTERNS[i].source.substring(0, 60));
      if (score >= DETECTION_THRESHOLD * 2) break; // Early exit on obvious attack
    }
  }

  return {
    detected: score >= DETECTION_THRESHOLD,
    score,
    matches,
  };
}

/**
 * sanitizeScrapedContent(text, url) → { text: string, injectionDetected: bool, warning?: string }
 * Wraps scraped content with injection scan. If detected, prepends warning and strips worst patterns.
 */
function sanitizeScrapedContent(text, url) {
  if (!text) return { text: '', injectionDetected: false };

  const result = detectPromptInjection(text);

  if (!result.detected) return { text, injectionDetected: false };

  // Strip the most dangerous patterns from the content
  let cleaned = text;
  for (const pattern of INJECTION_PATTERNS.slice(0, 10)) {
    cleaned = cleaned.replace(new RegExp(pattern.source, 'gi'), '[FILTERED]');
  }
  // Strip delimiter injections
  for (const pattern of INJECTION_PATTERNS.slice(15, 22)) {
    cleaned = cleaned.replace(new RegExp(pattern.source, 'gi'), '[FILTERED]');
  }

  const warning = `⚠️ INJECTION WARNING: Contenuto da ${url || 'unknown'} contiene ${result.matches.length} pattern sospetti (score=${result.score}). Pattern filtrati.`;

  return {
    text: `[COBRA SECURITY: Injection patterns detected and filtered from this content]\n\n${cleaned}`,
    injectionDetected: true,
    warning,
    score: result.score,
    matches: result.matches,
  };
}

module.exports = { detectPromptInjection, sanitizeScrapedContent };
