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
 * loadAPIKeys — Carica chiavi API dall'ambiente o dal file locale.
 *
 * ══════════════════════════════════════════════════════════════════════
 * PERCHE' NON SI LEGGONO PIU' DA SUPABASE
 *
 * Fino al 7 agosto la prima strategia era una fetch a `config_ai` con la
 * chiave ANON. Quella chiave sta nel .env, nel codice della webapp e nel
 * browser di chiunque apra la pagina: chi ce l'aveva poteva leggere in chiaro
 * le chiavi di OpenAI, Anthropic, Gemini, Groq ed ElevenLabs. Cinque chiavi a
 * consumo, su un tavolo aperto.
 *
 * La cosa che ha deciso la questione e' che NESSUNO le usava. `loadAPIKeys()`
 * viene chiamata in server-slim.js:581 come `await loadAPIKeys();` — il
 * risultato non viene assegnato a niente — e l'oggetto `aiKeys` che il server
 * adopera davvero e' un altro, riempito da process.env alle righe 141-145.
 * Le chiavi arrivavano da Supabase, entravano in questo oggetto, e restavano
 * li' a non servire a nulla.
 *
 * Erano esposte in cambio di zero. Tolta la fetch, la fonte diventa una sola:
 * il .env sulla macchina di Luca. La policy di `config_ai` per anon e' stata
 * rimossa il 7 agosto (migrazione config_ai_le_chiavi_non_escono_piu_con_la_anon):
 * anche riaggiungendo questa fetch, adesso risponderebbe "permission denied".
 * ══════════════════════════════════════════════════════════════════════
 */
async function loadAPIKeys(log) {
  // STRATEGY 1: l'ambiente. E' la stessa fonte che usa server-slim.js, cosi'
  // chi legge questo modulo e chi legge il server vedono le stesse chiavi.
  const daAmbiente = {
    openaiKey: process.env.OPENAI_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY, groqKey: process.env.GROQ_API_KEY,
    elevenlabsKey: process.env.ELEVENLABS_API_KEY,
    openaiModel: process.env.OPENAI_MODEL, anthropicModel: process.env.ANTHROPIC_MODEL,
    geminiModel: process.env.GEMINI_MODEL,
  };
  const prese = Object.entries(daAmbiente).filter(([, v]) => v);
  for (const [k, v] of prese) aiKeys[k] = v;
  if (prese.some(([k]) => k.endsWith('Key'))) {
    if (log) log(`Chiavi API dall'ambiente: ${prese.filter(([k]) => k.endsWith('Key')).map(([k]) => k.replace('Key', '')).join(', ')}`);
    return aiKeys;
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
