// modules/risk/js-detector.js — Dangerous JS pattern detection
// Source: server.js lines 238-244

const ALWAYS_BLOCKED_JS = [
  /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\beval\s*\(/, /\bFunction\s*\(/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/,
  /\bdocument\.cookie\b/, /\bnavigator\.clipboard\b/, /\bwindow\.location\s*=/,
  /\.submit\s*\(/, /\.click\s*\(/, /\.innerHTML\s*=/, /\.outerHTML\s*=/,
  /\bdocument\.write\b/, /\bimport\s*\(/, /\bnew\s+Worker\b/, /\bpostMessage\b/,
];

function detectDangerousJs(code) {
  const found = [];
  for (const p of ALWAYS_BLOCKED_JS) {
    if (p.test(code)) found.push(p.source);
  }
  return found;
}

module.exports = { ALWAYS_BLOCKED_JS, detectDangerousJs };
