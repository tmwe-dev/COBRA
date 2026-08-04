// modules/ai/openai.js — OpenAI / Groq API provider
// Source: server.js lines 7213-7298

const OPENAI_BASE = 'https://api.openai.com/v1/chat/completions';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

async function callOpenAI(provider, key, model, systemPrompt, messages, tools, ctx) {
  const { executeTool, digestToolResult, wsBroadcast, session, CobraSupervisor, TokenMeter, estimateTokens, COBRA_DEFAULTS } = ctx;
  const baseUrl = provider === 'groq' ? GROQ_BASE : OPENAI_BASE;
  const apiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
  let round = 0;
  const maxRounds = tools ? COBRA_DEFAULTS.MAX_TOOL_ROUNDS : 1;
  let totalToolCalls = 0;
  const _toolsUsed = [];

  while (round < maxRounds) {
    if (session.chatAborted) return { text: 'Operazione interrotta dall\'utente.', toolsUsed: _toolsUsed };
    round++;
    const body = { model, messages: apiMessages, max_tokens: 16000, temperature: 0.5 };
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();

    if (data.usage && TokenMeter) {
      TokenMeter.track({ provider: 'openai', model, promptTokens: data.usage.prompt_tokens || 0, completionTokens: data.usage.completion_tokens || 0, intent: session.lastIntent, systemPromptTokens: estimateTokens(apiMessages[0]?.content || '') });
    }

    const choice = data.choices?.[0];
    if (!choice) return { text: '', toolsUsed: _toolsUsed };

    if (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length > 0) {
      apiMessages.push(choice.message);
      for (const tc of choice.message.tool_calls) {
        totalToolCalls++;
        if (totalToolCalls > COBRA_DEFAULTS.MAX_TOTAL_TOOL_CALLS) return { text: 'Limite operazioni raggiunto.', toolsUsed: _toolsUsed };
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* malformed JSON from AI */ }
        wsBroadcast({ type: 'tool_start', tool: tc.function.name });
        const rawResult = await executeTool(tc.function.name, args);
        const ok = !rawResult.includes('"error"');
        const result = digestToolResult(tc.function.name, rawResult);
        wsBroadcast({ type: 'tool_done', tool: tc.function.name, ok });
        _toolsUsed.push({ name: tc.function.name, args, ok });
        if (!ok) CobraSupervisor._failedToolCount++; else CobraSupervisor._failedToolCount = 0;
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        if (rawResult.includes('"force_stop"') || rawResult.includes('"circular_loop"')) {
          const summary = _toolsUsed.filter(t => t.ok).map(t => t.name).join(', ') || 'nessuno';
          return { text: `Interrotto per evitare loop. Tool usati: ${summary}.`, toolsUsed: _toolsUsed };
        }
        if (CobraSupervisor._failedToolCount >= 5) return { text: 'Troppi errori consecutivi.', toolsUsed: _toolsUsed };
      }
      continue;
    }
    return { text: choice.message?.content || '', toolsUsed: _toolsUsed, usage: data.usage };
  }
  return { text: 'Operazione completata.', toolsUsed: _toolsUsed };
}

module.exports = { callOpenAI };
