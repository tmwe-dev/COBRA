/**
 * lib/token-meter.js
 * Token consumption tracking and budget management
 * ~70 lines (functional object)
 */

const fs = require('fs');
const path = require('path');

function createTokenMeter(wsBroadcastFn) {
  const SESSION_BUDGET = 1000000;
  const _session = {
    startedAt: new Date().toISOString(),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    calls: 0,
    byProvider: {},
    byIntent: {},
    history: [],
  };

  function track({ provider, model, promptTokens, completionTokens, intent, systemPromptTokens, messageTokens, toolResultTokens }) {
    const total = (promptTokens || 0) + (completionTokens || 0);
    _session.totalPromptTokens += (promptTokens || 0);
    _session.totalCompletionTokens += (completionTokens || 0);
    _session.totalTokens += total;
    _session.calls++;

    if (!_session.byProvider[provider]) _session.byProvider[provider] = { tokens: 0, calls: 0 };
    _session.byProvider[provider].tokens += total;
    _session.byProvider[provider].calls++;

    const i = intent || 'unknown';
    if (!_session.byIntent[i]) _session.byIntent[i] = { tokens: 0, calls: 0 };
    _session.byIntent[i].tokens += total;
    _session.byIntent[i].calls++;

    _session.history.push({
      ts: new Date().toISOString(),
      provider, model, intent,
      prompt: promptTokens || 0,
      completion: completionTokens || 0,
      total,
      breakdown: {
        systemPrompt: systemPromptTokens || 0,
        messages: messageTokens || 0,
        toolResults: toolResultTokens || 0,
      },
    });

    if (wsBroadcastFn) wsBroadcastFn({ type: 'token_meter', ...getStatus() });
    return total;
  }

  function getLevel() {
    const pct = _session.totalTokens / SESSION_BUDGET;
    if (pct < 0.33) return 'green';
    if (pct < 0.66) return 'yellow';
    return 'red';
  }

  function getStatus() {
    return {
      ..._session,
      budget: SESSION_BUDGET,
      used_pct: Math.round((_session.totalTokens / SESSION_BUDGET) * 1000) / 10,
      remaining: SESSION_BUDGET - _session.totalTokens,
      level: getLevel(),
    };
  }

  function reset() {
    _session.startedAt = new Date().toISOString();
    _session.totalPromptTokens = 0;
    _session.totalCompletionTokens = 0;
    _session.totalTokens = 0;
    _session.calls = 0;
    _session.byProvider = {};
    _session.byIntent = {};
    _session.history = [];
    if (wsBroadcastFn) wsBroadcastFn({ type: 'token_meter', ...getStatus() });
  }

  return { track, getLevel, getStatus, reset };
}

module.exports = { createTokenMeter };
