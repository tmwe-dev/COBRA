// modules/risk/click-intent.js — Click intent classification
// Source: server.js lines 221-235

const DESTRUCTIVE_BUTTON_PATTERNS = [
  /\b(paga|pay|checkout|pagamento)\b/i,
  /\b(conferma acquisto|confirm purchase|conferma pagamento|confirm payment)\b/i,
  /\b(elimina|delete|remove permanently)\b/i,
  /\b(acquista ora|buy now|purchase now|completa ordine|place order)\b/i,
];

function classifyClickIntent(selector, visibleText) {
  const haystack = `${selector} ${visibleText || ''}`.toLowerCase();
  if (/button\[type=["']?submit/i.test(selector) || /input\[type=["']?submit/i.test(selector)) {
    return { level: 'destructive', reason: 'Submit button' };
  }
  for (const p of DESTRUCTIVE_BUTTON_PATTERNS) {
    if (p.test(haystack)) return { level: 'destructive', reason: `Bottone irreversibile: ${p.source}` };
  }
  return { level: 'interact' };
}

module.exports = { DESTRUCTIVE_BUTTON_PATTERNS, classifyClickIntent };
