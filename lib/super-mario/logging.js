// ══════════════════════════════════════════════════════════════
// lib/super-mario/logging.js — Invocation & tool execution logging
// ══════════════════════════════════════════════════════════════

module.exports = function createLogging(deps) {
  const { log, fs, path } = deps;

  // ── INVOCATION LOG ──
  const _invocationLog = [];

  function logInvocation(trace) {
    _invocationLog.push({
      ...trace,
      created_at: new Date().toISOString(),
    });
    while (_invocationLog.length > 100) _invocationLog.shift();

    try {
      const logDir = path.join(__dirname, 'data');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'supermario_audit.jsonl');
      const line = JSON.stringify({
        type: 'invocation',
        trace_id: trace.trace_id,
        scope: trace.scope,
        intent: trace.intent,
        scopes: trace.scopes,
        model: trace.model,
        prompt_tokens: trace.prompt_tokens,
        completion_tokens: trace.completion_tokens,
        latency_ms: trace.latency_ms,
        prompt_hash: trace.prompt_hash,
        tool_count: trace.tool_count,
        tools_used: trace.tools_used,
        preflight_warnings: trace.preflight_warnings,
        postflight_warnings: trace.postflight_warnings,
        created_at: trace.created_at,
      }) + '\n';
      fs.appendFileSync(logFile, line);
    } catch (e) { /* silent */ }
  }

  function logToolExecution(toolName, toolArgs, result, riskLevel, guardKind, latencyMs) {
    try {
      const logDir = path.join(__dirname, 'data');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'supermario_audit.jsonl');
      const line = JSON.stringify({
        type: 'tool_execution',
        tool: toolName,
        risk_level: riskLevel,
        guard_result: guardKind,
        args_preview: JSON.stringify(toolArgs).substring(0, 200),
        result_preview: (typeof result === 'string' ? result : JSON.stringify(result)).substring(0, 200),
        latency_ms: latencyMs,
        created_at: new Date().toISOString(),
      }) + '\n';
      fs.appendFileSync(logFile, line);
    } catch (e) { /* silent */ }
  }

  // ── COMPLETE ──
  function complete(assemblyResult, response, model, promptTokens, completionTokens, toolsUsed) {
    const { postflightAudit } = require('./audit')(deps);
    const postflight = postflightAudit(response, assemblyResult.selectedToolNames);
    if (postflight.warnings.length > 0) {
      log(`[SuperMario] Post-flight warnings: ${postflight.warnings.join(', ')}`);
    }

    logInvocation({
      trace_id: assemblyResult.trace_id,
      scope: assemblyResult.scope,
      intent: assemblyResult.intent,
      scopes: assemblyResult.scope.split(','),
      model,
      prompt_tokens: promptTokens || 0,
      completion_tokens: completionTokens || 0,
      latency_ms: Date.now() - assemblyResult.startTime,
      prompt_hash: assemblyResult.preflight.promptHash,
      tool_count: assemblyResult.tools.length,
      tools_used: toolsUsed || [],
      preflight_warnings: assemblyResult.preflight.warnings,
      postflight_warnings: postflight.warnings,
    });

    return postflight;
  }

  return {
    logInvocation,
    logToolExecution,
    complete,
    getInvocationLog: () => _invocationLog,
  };
};
