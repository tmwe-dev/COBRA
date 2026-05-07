// modules/ai/anthropic.js — Anthropic Claude API provider
// Source: server.js lines 7301-7379

async function callAnthropic(key, model, systemPrompt, messages, tools, ctx) {
  const { executeTool, digestToolResult, wsBroadcast, session, CobraSupervisor, TokenMeter, estimateTokens, COBRA_DEFAULTS } = ctx;
  const anthropicTools = tools ? tools.map(t => ({
    name: t.function.name, description: t.function.description, input_schema: t.function.parameters
  })) : undefined;

  const apiMessages = [...messages];
  let round = 0;
  const maxRounds = tools ? COBRA_DEFAULTS.MAX_TOOL_ROUNDS : 1;
  let totalToolCalls = 0;
  const _toolsUsed = [];

  while (round < maxRounds) {
    if (session.chatAborted) return { text: 'Operazione interrotta dall\'utente.', toolsUsed: _toolsUsed };
    round++;
    const body = { model, max_tokens: 16000, system: systemPrompt, messages: apiMessages, temperature: 0.5 };
    if (anthropicTools) { body.tools = anthropicTools; body.tool_choice = { type: 'auto' }; }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();

    if (data.usage && TokenMeter) {
      TokenMeter.track({ provider: 'anthropic', model, promptTokens: data.usage.input_tokens || 0, completionTokens: data.usage.output_tokens || 0, intent: session.lastIntent, systemPromptTokens: estimateTokens(systemPrompt) });
    }

    const toolUseBlocks = data.content?.filter(b => b.type === 'tool_use') || [];
    const textBlocks = data.content?.filter(b => b.type === 'text') || [];

    if (toolUseBlocks.length > 0 && data.stop_reason === 'tool_use') {
      apiMessages.push({ role: 'assistant', content: data.content });
      const toolResults = [];
      for (const tu of toolUseBlocks) {
        totalToolCalls++;
        if (totalToolCalls > COBRA_DEFAULTS.MAX_TOTAL_TOOL_CALLS) return { text: 'Limite operazioni raggiunto.', toolsUsed: _toolsUsed };
        wsBroadcast({ type: 'tool_start', tool: tu.name });
        const rawResult = await executeTool(tu.name, tu.input || {});
        const ok = !rawResult.includes('"error"');
        const result = digestToolResult(tu.name, rawResult);
        wsBroadcast({ type: 'tool_done', tool: tu.name, ok });
        _toolsUsed.push({ name: tu.name, args: tu.input || {}, ok });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
        if (!ok) CobraSupervisor._failedToolCount++; else CobraSupervisor._failedToolCount = 0;
        if (rawResult.includes('"force_stop"') || rawResult.includes('"circular_loop"')) {
          const summary = _toolsUsed.filter(t => t.ok).map(t => t.name).join(', ') || 'nessuno';
          return { text: `Interrotto per evitare loop. Tool usati: ${summary}.`, toolsUsed: _toolsUsed };
        }
        if (CobraSupervisor._failedToolCount >= 5) return { text: 'Troppi errori consecutivi.', toolsUsed: _toolsUsed };
      }
      apiMessages.push({ role: 'user', content: toolResults });
      continue;
    }
    return { text: textBlocks.map(b => b.text).join('\n') || '', toolsUsed: _toolsUsed };
  }
  return { text: '', toolsUsed: _toolsUsed };
}

module.exports = { callAnthropic };
