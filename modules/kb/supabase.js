// KB - Supabase Configuration
// Supabase config — caricato da variabili d'ambiente (mai hardcoded)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[Config] ⚠️  SUPABASE_URL e SUPABASE_ANON_KEY non impostate. Imposta via .env o variabili d\'ambiente.');
  console.warn('[Config]    export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"');
  console.warn('[Config]    export SUPABASE_ANON_KEY="your_anon_key_here"');
}

// Generic fetch helper
async function fetchKB(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
  if (options.prefer) headers['Prefer'] = options.prefer;

  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  return response;
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  fetchKB,
};
