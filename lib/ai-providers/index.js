/**
 * lib/ai-providers/index.js
 * AI providers factory and re-exports
 */

const createOpenAIProvider = require('./openai');
const createAnthropicProvider = require('./anthropic');
const createGeminiProvider = require('./gemini');
const createRouter = require('./router');

module.exports = function createAIProviders(deps) {
  const { callOpenAI } = createOpenAIProvider(deps);
  const { callAnthropic } = createAnthropicProvider(deps);
  const { callGemini } = createGeminiProvider(deps);
  const { callAI } = createRouter(deps);

  return {
    callOpenAI,
    callAnthropic,
    callGemini,
    callAI: (systemPrompt, messages, tools, modelTier, aiKeys, SuperMario, emitThinking) =>
      callAI(systemPrompt, messages, tools, modelTier, aiKeys, SuperMario, emitThinking, callOpenAI, callAnthropic, callGemini),
  };
};
