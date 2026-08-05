// modules/config/index.js — ENV + defaults + paths
// Source: server.js lines 1-34, 1074-1105

const path = require('path');
const fs = require('fs');

// ── .env loader (zero dependencies) ──
try {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) {
        const k = t.substring(0, eq).trim();
        if (!process.env[k]) process.env[k] = t.substring(eq + 1).trim();
      }
    }
    console.log('[Config] .env loaded');
  }
} catch (e) { console.warn('[Config] .env load failed:', e.message); }

const PORT = process.env.PORT || 3000;
const APP_VERSION = 'COBRA v10.2';

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
  DEFAULT_LANGUAGE: 'it',
  MAX_TOTAL_TOOL_CALLS: 40,
  MAX_TIMEOUT_MS: 600000,
  MAX_RECURSION_DEPTH: 25,
  MAX_TOOL_ROUNDS: 18,
});

const COBRA_USER_DATA = process.env.COBRA_PROFILE_DIR ||
  path.join(require('os').homedir(), '.cobra-browser-profile');

module.exports = { PORT, APP_VERSION, COBRA_DEFAULTS, COBRA_USER_DATA };
