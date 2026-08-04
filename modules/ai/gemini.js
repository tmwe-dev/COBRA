// modules/ai/gemini.js — Google Gemini API provider
// Source: server.js lines 7382-7452

async function callGemini(key, model, systemPrompt, messages, tools, ctx) {
  const { executeTool, digestToolResult, wsBroadcast, session, CobraSupervisor, TokenMeter, estimateTokens, COBRA_DEFAULTS } = ctx;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }]
  }));
  const geminiTools = tools ? [{ functionDeclarations: tools.map(t => ({
    name: t.function.name, description: t.function.description, parameters: t.function.parameters
  })) }] : undefined;

  let round = 0;
  let totalToolCalls = 0;
  const _toolsUsed = [];

  while (round < (tools ? COBRA_DEFAULTS.MAX_TOOL_ROUNDS : 1)) {
    if (session.chatAborted) return { text: 'Operazione interrotta dall\'utente.', toolsUsed: _toolsUsed };
    round++;
    const body = { system_instruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { maxOutputTokens: 16000, temperature: 0.5 } };
    if (geminiTools) body.tools = geminiTools;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();

    if (data.usageMetadata && TokenMeter) {
      TokenMeter.track({ provider: 'gemini', model, promptTokens: data.usageMetadata.promptTokenCount || 0, completionTokens: data.usageMetadata.candidatesTokenCount || 0, intent: session.lastIntent });
    } else if (TokenMeter) {
      const estP = contents.reduce((s, c) => s + (c.parts || []).reduce((s2, p) => s2 + estimateTokens(p.text || ''), 0), 0);
      const estC = estimateTokens((data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
      TokenMeter.track({ provider: 'gemini', model, promptTokens: estP, completionTokens: estC, intent: session.lastIntent });
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const funcCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);

    if (funcCalls.length > 0) {
      contents.push({ role: 'model', parts });
      const responseParts = [];
      for (const fc of funcCalls) {
        totalToolCalls++;
        if (totalToolCalls > COBRA_DEFAULTS.MAX_TOTAL_TOOL_CALLS) return { text: 'Limite operazioni raggiunto.', toolsUsed: _toolsUsed };
        wsBroadcast({ type: 'tool_start', tool: fc.functionCall.name });
        const rawResult = await executeTool(fc.functionCall.name, fc.functionCall.args || {});
        const ok = !rawResult.includes('"error"');
        const result = digestToolResult(fc.functionCall.name, rawResult);
        wsBroadcast({ type: 'tool_done', tool: fc.functionCall.name, ok });
        _toolsUsed.push({ name: fc.functionCall.name, args: fc.functionCall.args || {}, ok });
        if (!ok) CobraSupervisor._failedToolCount++; else CobraSupervisor._failedToolCount = 0;
        let parsed = {}; try { parsed = JSON.parse(result); } catch { parsed = { result }; }
        responseParts.push({ functionResponse: { name: fc.functionCall.name, response: parsed } });
        if (rawResult.includes('"force_stop"') || rawResult.includes('"circular_loop"')) {
          const summary = _toolsUsed.filter(t => t.ok).map(t => t.name).join(', ') || 'nessuno';
          return { text: `Interrotto per evitare loop. Tool usati: ${summary}.`, toolsUsed: _toolsUsed };
        }
        if (CobraSupervisor._failedToolCount >= 5) return { text: 'Troppi errori consecutivi.', toolsUsed: _toolsUsed };
      }
      contents.push({ role: 'user', parts: responseParts });
      continue;
    }
    const _usage = data.usageMetadata ? { prompt_tokens: data.usageMetadata.promptTokenCount, completion_tokens: data.usageMetadata.candidatesTokenCount } : undefined;
    return { text: textParts.map(p => p.text).join('\n') || '', toolsUsed: _toolsUsed, usage: _usage };
  }
  return { text: '', toolsUsed: _toolsUsed };
}

module.exports = { callGemini };
