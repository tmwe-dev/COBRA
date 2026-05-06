// modules/utils/language.js — Language detection
// Source: server.js lines 565-574

function detectLanguage(message) {
  const msg = (message || '').toLowerCase();
  const enWords = /\b(the|and|for|with|this|that|from|your|have|will|please|could|would|should|about|what|which|where|when|how|thank)\b/g;
  const itWords = /\b(il|lo|la|le|gli|del|nel|per|con|che|sono|hai|puoi|cosa|come|dove|quando|questo|questa|questi|anche|ancora|dopo|prima|grazie)\b/g;
  const enCount = (msg.match(enWords) || []).length;
  const itCount = (msg.match(itWords) || []).length;
  if (enCount > 2 && itCount === 0) return 'en';
  if (enCount > itCount * 2 && enCount > 3) return 'en';
  return 'it';
}

module.exports = { detectLanguage };
