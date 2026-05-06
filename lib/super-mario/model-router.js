// ══════════════════════════════════════════════════════════════
// lib/super-mario/model-router.js — Model tier selection & routing
// ══════════════════════════════════════════════════════════════

module.exports = function createModelRouter(deps) {
  // ── 12. MODEL ROUTER ──
  const MODEL_TIERS = {
    lite: {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-sonnet-4-20250514',
      gemini: 'gemini-2.0-flash-lite',
      groq: 'llama-3.1-8b-instant',
    },
    standard: {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-sonnet-4-20250514',
      gemini: 'gemini-2.0-flash',
      groq: 'llama-3.3-70b-versatile',
    },
    power: {
      openai: 'gpt-4o',
      anthropic: 'claude-sonnet-4-20250514',
      gemini: 'gemini-2.5-pro-preview-05-06',
      groq: 'llama-3.3-70b-versatile',
    },
  };

  function selectModel(scopes, taskPlan, userMessage) {
    const msg = (userMessage || '').toLowerCase();

    if (scopes.length === 1 && scopes[0] === 'chat') {
      return { tier: 'lite', reason: 'chat puro' };
    }

    if (msg.length < 15) {
      return { tier: 'lite', reason: 'messaggio breve' };
    }

    if (taskPlan && taskPlan.steps.length >= 3) {
      return { tier: 'power', reason: `piano ${taskPlan.steps.length} step` };
    }

    const complexPatterns = /\b(confronta|paragona|analizza|analisi|strategia|valuta|pro e contro|differenz|report|documento|riassunto dettagliato|business plan|proposta)\b/;
    if (complexPatterns.test(msg)) {
      return { tier: 'power', reason: 'ragionamento complesso' };
    }

    if (scopes.length >= 3) {
      return { tier: 'power', reason: `${scopes.length} scope attivi` };
    }

    if (scopes.includes('communicate') && msg.length > 100) {
      return { tier: 'standard', reason: 'comunicazione elaborata' };
    }

    return { tier: 'standard', reason: 'default operativo' };
  }

  function getModelForProvider(tier, providerName, userConfiguredModel) {
    if (userConfiguredModel) return userConfiguredModel;
    const tierModels = MODEL_TIERS[tier] || MODEL_TIERS.standard;
    return tierModels[providerName] || null;
  }

  return {
    selectModel,
    getModelForProvider,
    MODEL_TIERS,
  };
};
