// lib/constants.js — Shared constants and utility functions

const COBRA_DEFAULTS = Object.freeze({
  OPENAI_MODEL: 'gpt-4o-mini',
  ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
  GEMINI_MODEL: 'gemini-2.0-flash',
  GROQ_MODEL: 'llama-3.3-70b-versatile',
  ELEVENLABS_MODEL: 'eleven_multilingual_v2',
  ELEVENLABS_VOICE_ID: 'uScy1bXtKz8vPzfdFsFw',
  SCRIPT_EXECUTION_TIMEOUT: 15000,
  TAB_LOAD_TIMEOUT: 30000,
  FETCH_TIMEOUT: 30000,
  MAX_CHAT_HISTORY: 10000,
  MAX_SELECTOR_LENGTH: 500,
  MAX_JS_CODE_LENGTH: 10000,
  MAX_SEARCH_QUERY_LENGTH: 1000,
  ACTION_LOG_MAX_SIZE: 50,
  DEFAULT_RATE_LIMIT_MODE: 'balanced',
  DEFAULT_LANGUAGE: 'it',
  DEFAULT_VOICE_SPEED: '1.0',
  SELECTOR_STATS_FLUSH_INTERVAL: 60000,
  SELECTOR_STATS_TTL_DAYS: 30,
  SELECTOR_STATS_MAX_PER_DOMAIN: 200,
  DEFAULT_TRUST_LEVEL: 2,
  CONFIRMATION_TOKEN_TTL: 120000,
  JOB_MAX_RETRIES: 3,
  MAX_STRATEGY_ATTEMPTS: 3,
  MAX_TOTAL_TOOL_CALLS: 25,
  MAX_TIMEOUT_MS: 600000,
  MAX_RECURSION_DEPTH: 25,
  MAX_TOOL_ROUNDS: 10,
});

function detectRepetition(messages) {
  const userMsgs = messages
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .map(m => m.content.toLowerCase().trim());
  if (userMsgs.length < 2) return null;
  const last = userMsgs[userMsgs.length - 1];
  const lastWords = new Set(last.split(/\s+/).filter(w => w.length > 3));
  for (let i = userMsgs.length - 2; i >= Math.max(0, userMsgs.length - 5); i--) {
    const prevWords = new Set(userMsgs[i].split(/\s+/).filter(w => w.length > 3));
    const overlap = [...lastWords].filter(w => prevWords.has(w)).length;
    const sim = overlap / Math.max(lastWords.size, prevWords.size, 1);
    if (sim > 0.6) {
      return 'ATTENZIONE: L\'utente sta ripetendo una richiesta simile. La tua risposta precedente NON era soddisfacente. Rispondi in modo PIÙ CONCRETO e DIRETTO. Se prima hai chiesto chiarimenti, ORA agisci con la migliore interpretazione. NON ripetere la stessa struttura di risposta. Cambia approccio.';
    }
  }
  const frustrationPatterns = [
    /no,?\s*(intendo|volevo|dico)/i, /ti ho (già\s*)?detto/i,
    /come (ti )?ho (già )?detto/i, /ripeto/i, /non (hai |)(capito|capisci)/i,
    /ancora una volta/i, /di nuovo/i, /fa cagare/i, /merda/i, /non funziona/i,
    /sembra stupido/i, /inutile/i, /cazzo/i,
  ];
  for (const p of frustrationPatterns) {
    if (p.test(last)) {
      return 'L\'utente è FRUSTRATO — la risposta precedente non ha centrato il punto. Rispondi in modo diretto, concreto, senza chiedere chiarimenti. Cambia approccio completamente.';
    }
  }
  return null;
}

function createEmitSiteVisit(wsBroadcast) {
  return function emitSiteVisit(url, title, status) {
    let favicon = '';
    try { favicon = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`; } catch (e) { }
    wsBroadcast({ type: 'site_visit', url, title: title || url, favicon, status: status || 'active' });
  };
}

module.exports = { COBRA_DEFAULTS, detectRepetition, createEmitSiteVisit };
