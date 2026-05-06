// ══════════════════════════════════════════════════════════════
// lib/super-mario/resolve-agent.js — Agent type resolution
// ══════════════════════════════════════════════════════════════

module.exports = function createResolveAgent(deps) {
  // ── RESOLVE AGENT ──
  function resolveAgent(scopes) {
    if (scopes.includes('navigate') || scopes.includes('interact') || scopes.includes('browse')) return 'navigator';
    if (scopes.includes('search')) return 'searcher';
    if (scopes.includes('communicate') || scopes.includes('email') || scopes.includes('whatsapp') || scopes.includes('linkedin')) return 'communicator';
    if (scopes.includes('admin') || scopes.includes('memory')) return 'admin';
    if (scopes.includes('data') || scopes.includes('extract')) return 'scout';
    return 'full';
  }

  return {
    resolveAgent,
  };
};
