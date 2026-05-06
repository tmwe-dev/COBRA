// ══════════════════════════════════════════════════════════════
// lib/super-mario/audit.js — Pre/post-flight audits
// ══════════════════════════════════════════════════════════════

module.exports = function createAudit(deps) {
  const { log, crypto, TOOL_RISK } = deps;

  // ── 8. PRE-FLIGHT AUDIT ──
  function preflightAudit(prompt, scope, toolCount) {
    const warnings = [];

    if (!prompt.includes('RUOLO:') && !prompt.includes('ruolo')) warnings.push('missing_identity');
    if (!scope) warnings.push('missing_scope');
    if (scope !== 'chat' && toolCount === 0) warnings.push('no_tools_for_task_intent');
    const estimatedTokens = Math.ceil(prompt.length / 4);
    if (estimatedTokens > 120000) warnings.push(`token_budget_exceeded:${estimatedTokens}`);
    const injectionPatterns = [
      /ignore previous/i, /you are now/i, /disregard all/i, /new instructions/i,
      /forget (your|all|every)/i, /override (your|the|all)/i,
      /system prompt/i, /reveal (your|the) (prompt|instructions|rules|system)/i,
      /act as (a |an )?(?:admin|root|developer|god|unrestricted)/i,
      /jailbreak/i, /DAN mode/i, /developer mode/i,
      /\bsudo\b/i, /admin mode/i, /bypass (the |all )?(?:filter|restriction|safety|rule)/i,
      /pretend (you are|to be|you're)/i, /roleplay as/i,
      /translate the (following|above) (system|hidden)/i,
      /repeat (the |your )?(system|above|hidden|secret)/i,
      /base64|atob|btoa|decode this/i,
      /\bROT13\b/i,
      /you must comply/i, /this is an? (emergency|urgent|critical)/i,
      /anthropic|openai|claude|gpt.*(said|told|authorized|approved)/i,
      /\bpwned\b/i,
    ];
    for (const p of injectionPatterns) {
      if (p.test(prompt)) warnings.push(`injection_detected:${p.source}`);
    }

    return {
      ok: !warnings.some(w => w.startsWith('token_budget') || w.startsWith('injection')),
      warnings,
      estimatedTokens,
      promptHash: crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16),
    };
  }

  // ── 9. POST-FLIGHT AUDIT ──
  function postflightAudit(response, selectedToolNames) {
    const warnings = [];

    if (!response) { warnings.push('empty_response'); return { ok: false, warnings }; }

    if (response.tool_calls) {
      for (const tc of response.tool_calls) {
        const name = tc.function?.name || tc.name;
        if (name && !selectedToolNames.includes(name) && !TOOL_RISK[name]) {
          warnings.push(`hallucinated_tool:${name}`);
        }
      }
    }

    return { ok: warnings.length === 0, warnings };
  }

  return {
    preflightAudit,
    postflightAudit,
  };
};
