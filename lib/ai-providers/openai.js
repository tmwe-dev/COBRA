/**
 * lib/ai-providers/openai.js
 * OpenAI and Groq API integration
 */

module.exports = function createOpenAIProvider(deps) {
  const { log, wsBroadcast, session, TokenMeter, CobraSupervisor, COBRA_DEFAULTS, estimateTokens, sanitizeForLog, executeTool, digestToolResult } = deps;

  async function callOpenAI(provider, key, model, systemPrompt, messages, tools) {
    const baseUrl = provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';

    const apiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    let round = 0;
    const maxRounds = tools ? COBRA_DEFAULTS.MAX_TOOL_ROUNDS : 1;
    let totalToolCalls = 0;
    const _toolsUsed = [];

    while (round < maxRounds) {
      if (session.chatAborted) { return { text: 'Operazione interrotta dall\'utente.', toolsUsed: _toolsUsed }; }
      round++;
      const body = { model, messages: apiMessages, max_tokens: 16000, temperature: 0.5 };
      if (tools) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.usage) {
        TokenMeter.track({
          provider: 'openai', model,
          promptTokens: data.usage.prompt_tokens || 0,
          completionTokens: data.usage.completion_tokens || 0,
          intent: session.lastIntent,
          systemPromptTokens: estimateTokens(apiMessages[0]?.content || ''),
        });
      } else {
        const estPrompt = apiMessages.reduce((s, m) => s + estimateTokens(m.content || JSON.stringify(m)), 0);
        const estCompletion = estimateTokens(data.choices?.[0]?.message?.content || '');
        TokenMeter.track({ provider: 'openai', model, promptTokens: estPrompt, completionTokens: estCompletion, intent: session.lastIntent });
      }
      const choice = data.choices?.[0];
      if (!choice) return '';

      if (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length > 0) {
        apiMessages.push(choice.message);
        for (const tc of choice.message.tool_calls) {
          totalToolCalls++;
          if (totalToolCalls > COBRA_DEFAULTS.MAX_TOTAL_TOOL_CALLS) {
            log('[AI] Tool budget exceeded');
            return { text: 'Ho raggiunto il limite massimo di operazioni.', toolsUsed: _toolsUsed };
          }
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (e) { log(`[Tool] JSON parse error for ${tc.function.name}`); }
          log(`[Tool] ${tc.function.name} ${sanitizeForLog(JSON.stringify(args).substring(0, 80))}`);
          wsBroadcast({ type: 'tool_start', tool: tc.function.name });
          const rawResult = await executeTool(tc.function.name, args);
          const ok = !rawResult.includes('"error"');
          const result = digestToolResult(tc.function.name, rawResult);
          wsBroadcast({ type: 'tool_done', tool: tc.function.name, ok });
          _toolsUsed.push({ name: tc.function.name, args, ok });
          if (!ok) { CobraSupervisor._failedToolCount++; } else { CobraSupervisor._failedToolCount = 0; }
          apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          if (rawResult.includes('"force_stop"') || rawResult.includes('"circular_loop"')) {
            log('[AI] Force stop triggered by supervisor');
            const summary = _toolsUsed.filter(t => t.ok).map(t => t.name).join(', ') || 'nessun tool riuscito';
            return { text: `Ho interrotto per evitare un loop. Tool usati: ${summary}.`, toolsUsed: _toolsUsed };
          }
          if (CobraSupervisor._failedToolCount >= 5) {
            log('[AI] 5+ consecutive tool failures');
            return { text: 'Troppi errori consecutivi.', toolsUsed: _toolsUsed };
          }
        }
        continue;
      }
      return { text: choice.message?.content || '', toolsUsed: _toolsUsed };
    }
    return { text: 'Operazione completata.', toolsUsed: _toolsUsed };
  }

  return { callOpenAI };
};
