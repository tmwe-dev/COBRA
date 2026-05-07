// modules/ai/router.js — AI Provider Router with cascade fallback
// Source: server.js lines 7454-7530

const { callOpenAI } = require('./openai');
const { callAnthropic } = require('./anthropic');
const { callGemini } = require('./gemini');
const { COBRA_DEFAULTS } = require('../config');
const { auditAICall } = require('../security/audit-log');

/**
 * callAI — Main AI router. 3-strategy cascade: provider chain → inline fallback
 * Provider chain: OpenAI → Anthropic → Gemini → Groq
 */
async function callAI(systemPrompt, messages, tools, ctx) {
  const { aiKeys, session, executeTool, digestToolResult, wsBroadcast, CobraSupervisor, TokenMeter, estimateTokens, emitThinking, SuperMario, modelTier } = ctx;
  const log = ctx.log || console.log;
  const sanitizeForLog = ctx.sanitizeForLog || (s => s);

  const providers = [
    { name: 'openai', key: aiKeys.openaiKey, userModel: aiKeys.openaiModel, defaultModel: COBRA_DEFAULTS.OPENAI_MODEL },
    { name: 'anthropic', key: aiKeys.anthropicKey, userModel: aiKeys.anthropicModel, defaultModel: COBRA_DEFAULTS.ANTHROPIC_MODEL },
    { name: 'gemini', key: aiKeys.geminiKey, userModel: aiKeys.geminiModel, defaultModel: COBRA_DEFAULTS.GEMINI_MODEL },
    { name: 'groq', key: aiKeys.groqKey, userModel: aiKeys.groqModel, defaultModel: COBRA_DEFAULTS.GROQ_MODEL },
  ].filter(p => p.key).map(p => ({
    ...p,
    model: modelTier && SuperMario
      ? SuperMario.getModelForProvider(modelTier, p.name, p.userModel)
      : (p.userModel || p.defaultModel),
  }));

  if (providers.length === 0) return { content: 'Nessuna API key configurata.', provider: 'none' };

  // P0.4: Budget cap enforcement — block if exceeded
  if (TokenMeter) {
    const budget = TokenMeter.checkBudget();
    if (!budget.allowed) {
      log(`[TokenMeter] AI call BLOCKED: budget exceeded (${budget.consumed}/${budget.cap})`);
      return { content: `Budget token esaurito (${budget.consumed}/${budget.cap}). Impossibile effettuare nuove chiamate AI.`, provider: 'budget_exceeded', toolsUsed: [] };
    }
  }

  let lastError = null;
  const providerCtx = { executeTool, digestToolResult, wsBroadcast, session, CobraSupervisor, TokenMeter, estimateTokens, COBRA_DEFAULTS };

  for (const p of providers) {
    try {
      log(`Trying ${p.name} (${p.model})...`);
      if (emitThinking) emitThinking(`Connessione a ${p.name}...`);
      let result;
      if (p.name === 'openai' || p.name === 'groq') result = await callOpenAI(p.name, p.key, p.model, systemPrompt, messages, tools, providerCtx);
      else if (p.name === 'anthropic') result = await callAnthropic(p.key, p.model, systemPrompt, messages, tools, providerCtx);
      else if (p.name === 'gemini') result = await callGemini(p.key, p.model, systemPrompt, messages, tools, providerCtx);
      const text = typeof result === 'object' ? result.text : result;
      const toolsUsed = typeof result === 'object' ? (result.toolsUsed || []) : [];
      if (text) {
        log(`${p.name} OK (${toolsUsed.length} tool calls)`);
        // P0.2: Audit AI call
        const usage = typeof result === 'object' ? result.usage : null;
        auditAICall(p.name, p.model, usage?.prompt_tokens || 0, usage?.completion_tokens || 0, session?.id);
        return { content: text, provider: p.name, model: p.model, toolsUsed };
      }
      lastError = `${p.name}: risposta vuota`;
    } catch (e) {
      lastError = `${p.name}: ${e.message}`;
      log(`${p.name} failed: ${e.message}`);
    }
  }

  // Inline fallback (no tools, last resort)
  const fbKey = aiKeys.openaiKey || aiKeys.groqKey;
  if (fbKey) {
    try {
      const fbUrl = aiKeys.openaiKey ? 'https://api.openai.com/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
      const fbModel = aiKeys.openaiKey ? (aiKeys.openaiModel || COBRA_DEFAULTS.OPENAI_MODEL) : (aiKeys.groqModel || COBRA_DEFAULTS.GROQ_MODEL);
      const res = await fetch(fbUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fbKey}` },
        body: JSON.stringify({ model: fbModel, messages: [{ role: 'system', content: systemPrompt }, ...messages], max_tokens: 4000 })
      });
      if (res.ok) {
        const d = await res.json();
        const text = d.choices?.[0]?.message?.content || '';
        if (text) return { content: text, provider: 'fallback', model: fbModel, toolsUsed: [] };
      }
    } catch { /* fallback provider failed, continue to error response */ }
  }

  return { content: `Errore AI: ${lastError}`, provider: 'error', toolsUsed: [] };
}

module.exports = { callAI };
