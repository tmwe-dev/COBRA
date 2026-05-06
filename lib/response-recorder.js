/**
 * lib/response-recorder.js
 * Recording and analysis of all AI interactions
 * ~170 lines
 */

const fs = require('fs');
const path = require('path');

function createResponseRecorder() {
  const _log = [];
  const _maxEntries = 500;
  const _filePath = path.join(__dirname, '..', 'data', 'response-log.jsonl');

  function record(entry) {
    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    _log.push(record);
    if (_log.length > _maxEntries) _log.shift();
    try {
      fs.appendFileSync(_filePath, JSON.stringify(record) + '\n');
    } catch (e) { /* silent */ }
    return record.id;
  }

  function recordChat({ userMessage, intent, systemPromptLength, provider, model, response, toolsUsed, durationMs, kbEntries, repetitionDetected }) {
    return record({
      type: 'chat',
      user_message: userMessage,
      intent,
      system_prompt_tokens: Math.ceil((systemPromptLength || 0) / 4),
      provider,
      model,
      response_text: response,
      response_length: (response || '').length,
      tools_used: toolsUsed || [],
      duration_ms: durationMs,
      kb_entries_loaded: kbEntries || 0,
      repetition_detected: repetitionDetected || false,
      quality_flags: analyzeQuality(response),
    });
  }

  function recordTTS({ text, voiceId, model, durationMs, charCount, success }) {
    return record({
      type: 'tts',
      text_sent: text,
      text_length: charCount || (text || '').length,
      voice_id: voiceId,
      model,
      duration_ms: durationMs,
      success,
    });
  }

  function analyzeQuality(text) {
    if (!text) return ['empty_response'];
    const flags = [];
    const t = text.toLowerCase();
    if (/\d+\.\s*(http|www\.|https)/i.test(text)) flags.push('raw_url_list');
    if ((text.match(/^[\s]*[-•]\s/gm) || []).length >= 4) flags.push('excessive_bullets');
    if (/ecco (i risultati|cosa ho trovato|quello che)/i.test(t)) flags.push('robot_opener');
    if (/#{2,}\s/g.test(text)) flags.push('heavy_markdown');
    if (/come (modello|intelligenza artificiale|IA|assistente virtuale)/i.test(t)) flags.push('ai_self_reference');
    if (/(http|www\.)\S{30,}/g.test(text)) flags.push('raw_urls_shown');
    if (text.length > 100000) flags.push('too_long');
    if (text.length < 20) flags.push('too_short');
    const sentences = text.split(/[.!?]\s/);
    if (sentences.some(s => s.length > 300)) flags.push('possible_copypaste');
    if (flags.length === 0) flags.push('ok');
    return flags;
  }

  function getLog(filter) {
    if (!filter) return _log;
    return _log.filter(entry => {
      if (filter.type && entry.type !== filter.type) return false;
      if (filter.hasFlags) {
        const flags = entry.quality_flags || [];
        if (!filter.hasFlags.some(f => flags.includes(f))) return false;
      }
      if (filter.since) {
        if (new Date(entry.timestamp) < new Date(filter.since)) return false;
      }
      return true;
    });
  }

  function getStats() {
    const chats = _log.filter(e => e.type === 'chat');
    const tts = _log.filter(e => e.type === 'tts');
    const allFlags = chats.flatMap(c => c.quality_flags || []);
    const flagCounts = {};
    for (const f of allFlags) flagCounts[f] = (flagCounts[f] || 0) + 1;
    return {
      total_entries: _log.length,
      chats: chats.length,
      tts_requests: tts.length,
      avg_response_length: chats.length ? Math.round(chats.reduce((s, c) => s + (c.response_length || 0), 0) / chats.length) : 0,
      avg_duration_ms: chats.length ? Math.round(chats.reduce((s, c) => s + (c.duration_ms || 0), 0) / chats.length) : 0,
      quality_flags: flagCounts,
      providers_used: [...new Set(chats.map(c => c.provider).filter(Boolean))],
      problematic_responses: chats.filter(c => (c.quality_flags || []).some(f => f !== 'ok')).length,
    };
  }

  function loadFromFile() {
    try {
      if (!fs.existsSync(_filePath)) return;
      const lines = fs.readFileSync(_filePath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-_maxEntries)) {
        try { _log.push(JSON.parse(line)); } catch (e) { }
      }
      console.log(`[ResponseRecorder] Loaded ${_log.length} entries from file`);
    } catch (e) { }
  }

  function exportJSON() {
    return {
      exported_at: new Date().toISOString(),
      stats: getStats(),
      entries: _log,
    };
  }

  function exportCSV() {
    const headers = ['timestamp','type','user_message','intent','provider','model','response_length','duration_ms','tools_used','quality_flags','response_text','tts_text'];
    const rows = _log.map(e => [
      e.timestamp,
      e.type,
      `"${(e.user_message || '').replace(/"/g, '""')}"`,
      e.intent || '',
      e.provider || '',
      e.model || '',
      e.response_length || e.text_length || '',
      e.duration_ms || '',
      `"${(e.tools_used || []).join(', ')}"`,
      `"${(e.quality_flags || []).join(', ')}"`,
      `"${(e.response_text || '').replace(/"/g, '""')}"`,
      `"${(e.text_sent || '').replace(/"/g, '""')}"`,
    ].join(','));
    return [headers.join(','), ...rows].join('\n');
  }

  function exportConversation() {
    let out = `# COBRA — Log Conversazioni\n`;
    out += `# Esportato: ${new Date().toLocaleString('it-IT')}\n`;
    out += `# Totale: ${_log.length} interazioni\n`;
    out += '─'.repeat(60) + '\n\n';

    for (const e of _log) {
      const time = e.timestamp ? new Date(e.timestamp).toLocaleString('it-IT') : '?';
      if (e.type === 'chat') {
        out += `╔══ [${time}] ══════════════════════════════════\n`;
        out += `║ UTENTE: ${e.user_message || '(vuoto)'}\n`;
        out += `║ Intent: ${e.intent || '?'} | Provider: ${e.provider || '?'} | Model: ${e.model || '?'}\n`;
        if (e.tools_used && e.tools_used.length > 0) {
          out += `║ Tool usati: ${e.tools_used.join(', ')}\n`;
        }
        out += `║ Durata: ${e.duration_ms || '?'}ms | Qualità: ${(e.quality_flags || []).join(', ')}\n`;
        out += `╠──────────────────────────────────────────────\n`;
        out += `║ COBRA:\n`;
        const lines = (e.response_text || '(nessuna risposta)').split('\n');
        for (const line of lines) {
          out += `║   ${line}\n`;
        }
        out += `╚══════════════════════════════════════════════\n\n`;
      } else if (e.type === 'tts') {
        out += `  🔊 [${time}] TTS (${e.success ? 'OK' : 'ERRORE'}) — ${e.text_length || 0} chars, ${e.duration_ms || '?'}ms\n`;
        out += `     Testo: "${e.text_sent || ''}"\n\n`;
      }
    }
    return out;
  }

  return {
    record, recordChat, recordTTS, analyzeQuality,
    getLog, getStats, loadFromFile,
    exportJSON, exportCSV, exportConversation,
  };
}

module.exports = { createResponseRecorder };
