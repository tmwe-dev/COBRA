/**
 * lib/ai-providers/router.js
 * AI provider router and fallback cascade
 */

module.exports = function createRouter(deps) {
  const { log, COBRA_DEFAULTS, estimateTokens } = deps;

  async function callAI(systemPrompt, messages, tools, modelTier = null, aiKeys, SuperMario, emitThinking, callOpenAI, callAnthropic, callGemini) {
    const providers = [
      { name: 'openai', key: aiKeys.openaiKey, userModel: aiKeys.openaiModel, defaultModel: COBRA_DEFAULTS.OPENAI_MODEL },
      { name: 'anthropic', key: aiKeys.anthropicKey, userModel: aiKeys.anthropicModel, defaultModel: COBRA_DEFAULTS.ANTHROPIC_MODEL },
      { name: 'gemini', key: aiKeys.geminiKey, userModel: aiKeys.geminiModel, defaultModel: COBRA_DEFAULTS.GEMINI_MODEL },
      { name: 'groq', key: aiKeys.groqKey, userModel: aiKeys.groqModel, defaultModel: COBRA_DEFAULTS.GROQ_MODEL },
    ].filter(p => p.key).map(p => ({
      ...p,
      model: modelTier
        ? SuperMario.getModelForProvider(modelTier, p.name, p.userModel)
        : (p.userModel || p.defaultModel),
    }));

    if (providers.length === 0) {
      return { content: 'Nessuna API key configurata.', provider: 'none' };
    }

    let lastError = null;

    for (const p of providers) {
      try {
        log(`Trying ${p.name} (${p.model})...`);
        if (emitThinking) emitThinking(`Connessione a ${p.name}...`);
        let result;
        if (p.name === 'openai' || p.name === 'groq') result = await callOpenAI(p.name, p.key, p.model, systemPrompt, messages, tools);
        else if (p.name === 'anthropic') result = await callAnthropic(p.key, p.model, systemPrompt, messages, tools);
        else if (p.name === 'gemini') result = await callGemini(p.key, p.model, systemPrompt, messages, tools);
        const text = typeof result === 'object' ? result.text : result;
        const toolsUsed = typeof result === 'object' ? (result.toolsUsed || []) : [];
        if (text) { log(`${p.name} OK (${toolsUsed.length} tool calls)`); return { content: text, provider: p.name, model: p.model, toolsUsed }; }
        lastError = `${p.name}: risposta vuota`;
      } catch (e) {
        lastError = `${p.name}: ${e.message}`;
        log(`${p.name} failed: ${e.message}`);
      }
    }

    const fallbackKey = aiKeys.openaiKey || aiKeys.groqKey;
    const fallbackUrl = aiKeys.openaiKey ? 'https://api.openai.com/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
    const fallbackModel = aiKeys.openaiKey ? (aiKeys.openaiModel || COBRA_DEFAULTS.OPENAI_MODEL) : (aiKeys.groqModel || COBRA_DEFAULTS.GROQ_MODEL);

    if (fallbackKey) {
      try {
        if (emitThinking) emitThinking('Ultimo tentativo...');
        const resp = await fetch(fallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + fallbackKey },
          body: JSON.stringify({
            model: fallbackModel,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            max_tokens: 16000, temperature: 0.7
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const result = data.choices?.[0]?.message?.content || '';
          if (result) return { content: result, provider: 'inline-fallback', model: fallbackModel, toolsUsed: [] };
        }
      } catch (e) { lastError = 'Fallback: ' + e.message; }
    }

    return { content: `Tutti i provider hanno fallito. Ultimo errore: ${lastError}`, provider: 'none', toolsUsed: [] };
  }

  return { callAI };
};
