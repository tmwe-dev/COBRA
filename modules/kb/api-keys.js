// KB - API Keys and Operator Config Loading
const path = require('path');
const fs = require('fs');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabase');

// Global AI Keys object
const aiKeys = {
  openaiKey: '',
  openaiModel: 'gpt-4',
  anthropicKey: '',
  anthropicModel: 'claude-3-5-sonnet-20241022',
  geminiKey: '',
  geminiModel: 'gemini-2.0-flash',
  groqKey: '',
  groqModel: 'mixtral-8x7b-32768',
  elevenlabsKey: '',
  elevenlabsVoiceId: '',
  elevenlabsModel: '',
};

/**
 * loadAPIKeys — Carica chiavi API da Supabase o file locale
 */
async function loadAPIKeys(log) {
  // STRATEGY 1: Try Supabase remote
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/config_ai?select=provider,modello,api_key&attivo=eq.true`,
      { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rows = await resp.json();
    const keyMap = { openai: 'openaiKey', anthropic: 'anthropicKey', gemini: 'geminiKey', groq: 'groqKey', elevenlabs: 'elevenlabsKey' };
    const modelMap = { openai: 'openaiModel', anthropic: 'anthropicModel', gemini: 'geminiModel', groq: 'groqModel', elevenlabs: 'elevenlabsModel' };
    for (const row of rows) {
      if (keyMap[row.provider] && row.api_key) aiKeys[keyMap[row.provider]] = row.api_key;
      if (modelMap[row.provider] && row.modello) aiKeys[modelMap[row.provider]] = row.modello;
    }
    if (log) log(`Loaded ${rows.length} API keys from Supabase: ${Object.keys(aiKeys).filter(k => k.endsWith('Key')).map(k => k.replace('Key', '')).join(', ')}`);
    return aiKeys;
  } catch (e) {
    if (log) log('Supabase unreachable: ' + e.message + ' — loading from local config...');
  }

  // STRATEGY 2: Local config file (keys.json)
  try {
    const keysPath = path.join(__dirname, 'keys.json');
    if (fs.existsSync(keysPath)) {
      const rows = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
      const keyMap = { openai: 'openaiKey', anthropic: 'anthropicKey', gemini: 'geminiKey', groq: 'groqKey', elevenlabs: 'elevenlabsKey' };
      const modelMap = { openai: 'openaiModel', anthropic: 'anthropicModel', gemini: 'geminiModel', groq: 'groqModel', elevenlabs: 'elevenlabsModel' };
      for (const row of rows) {
        if (keyMap[row.provider] && row.api_key) aiKeys[keyMap[row.provider]] = row.api_key;
        if (modelMap[row.provider] && row.modello) aiKeys[modelMap[row.provider]] = row.modello;
      }
      if (log) log(`Loaded API keys from keys.json: ${Object.keys(aiKeys).filter(k => k.endsWith('Key')).map(k => k.replace('Key', '')).join(', ')}`);
      return aiKeys;
    }
  } catch (e) {
    if (log) log('Local keys.json load failed: ' + e.message);
  }

  if (log) log('WARNING: No API keys loaded. Configure via /api/config/keys or create keys.json');
  return aiKeys;
}

/**
 * loadOperatorConfig — Carica profilo operatore da Supabase (cobra_operator) o locale
 */
async function loadOperatorConfig(operatorConfig = {}, log) {
  // Strategy 1: Supabase
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/cobra_operator?select=key,value,category`,
      { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        signal: AbortSignal.timeout(5000) }
    );
    if (resp.ok) {
      const rows = await resp.json();
      for (const row of rows) operatorConfig[row.key] = row.value;
    } else throw new Error(`HTTP ${resp.status}`);
  } catch (e) {
    if (log) log('Supabase operator config unreachable: ' + e.message + ' — loading from local...');
    // Strategy 2: Local fallback
    try {
      const opPath = path.join(__dirname, 'operator.json');
      if (fs.existsSync(opPath)) {
        const loaded = JSON.parse(fs.readFileSync(opPath, 'utf8'));
        Object.assign(operatorConfig, loaded);
      }
    } catch (e) { if (log) log(`[KB] local fallback error: ${e.message}`); }
  }

  const keys = Object.keys(operatorConfig);
  if (keys.length > 0 && log) {
    log(`Operator config loaded: ${keys.join(', ')}`);
  }
  return operatorConfig;
}

module.exports = {
  aiKeys,
  loadAPIKeys,
  loadOperatorConfig,
};
