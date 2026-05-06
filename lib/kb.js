// lib/kb.js — Knowledge Base (Supabase)
module.exports = function createKB(deps) {
  const { log, SUPABASE_URL, SUPABASE_ANON_KEY, aiKeys, session, COBRA_DEFAULTS } = deps;
  const path = require('path');
  const fs = require('fs');
  const fetch = global.fetch;

  async function loadAPIKeys() {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/config_ai?select=provider,modello,api_key&attivo=eq.true`,
        { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
          signal: AbortSignal.timeout(5000) }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const rows = await resp.json();
      const keyMap = { openai: 'openaiKey', anthropic: 'anthropicKey', gemini: 'geminiKey', groq: 'groqKey', elevenlabs: 'elevenlabsKey' };
      for (const row of rows) {
        if (keyMap[row.provider] && row.api_key) aiKeys[keyMap[row.provider]] = row.api_key;
      }
      log(`[KB] Loaded ${rows.length} API keys from Supabase`);
    } catch (e) {
      log('[KB] Supabase failed, trying local keys.json: ' + e.message);
      try {
        const keysPath = path.join(__dirname, '..', 'keys.json');
        if (fs.existsSync(keysPath)) {
          const rows = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
          for (const row of rows) {
            if (row.provider === 'openai' && row.api_key) aiKeys.openaiKey = row.api_key;
          }
        }
      } catch (e2) { log('[KB] No local keys found: ' + e2.message); }
    }
  }

  async function loadOperatorConfig() {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/cobra_operator?select=key,value`,
        { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
          signal: AbortSignal.timeout(5000) }
      );
      if (resp.ok) {
        const rows = await resp.json();
        for (const row of rows) session.operatorConfig[row.key] = row.value;
        log('[KB] Operator config loaded');
      }
    } catch (e) {
      log('[KB] Operator config load failed: ' + e.message);
    }
  }

  async function searchKB(query, domain, tags) {
    try {
      let url = `${SUPABASE_URL}/rest/v1/cobra_kb_rules?select=*&active=eq.true&order=priority.desc&limit=20`;
      if (domain) url += `&domain=eq.${encodeURIComponent(domain)}`;
      if (tags && tags.length > 0) {
        url += `&tags=ov.{${tags.map(t => encodeURIComponent(t)).join(',')}}`;
      }
      const resp = await fetch(url, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
      });
      if (!resp.ok) return [];
      const rows = await resp.json();
      if (query && query.trim().length > 2) {
        const q = query.toLowerCase();
        const words = q.split(/\s+/).filter(w => w.length > 2);
        const scored = rows.map(r => {
          const text = `${r.title} ${r.content}`.toLowerCase();
          const hits = words.filter(w => text.includes(w)).length;
          return { ...r, _score: hits };
        }).filter(r => r._score > 0);
        scored.sort((a, b) => b._score - a._score || b.priority - a.priority);
        return scored.slice(0, 10);
      }
      return rows;
    } catch { return []; }
  }

  async function loadPersonaFromKB(contextTags = []) {
    try {
      const allTags = ['always', ...(contextTags || [])];
      const entries = await searchKB(null, 'persona', allTags);
      const seen = new Set();
      const unique = entries.filter(e => {
        if (seen.has(e.title)) return false;
        seen.add(e.title);
        return true;
      });
      unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
      return unique;
    } catch { return []; }
  }

  async function saveToKB(domain, type, name, content, tags) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/cobra_kb_rules`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          domain, rule_type: type, title: name, content,
          tags: tags ? tags.split(',').map(t => t.trim()) : [],
          active: true, priority: 5, created_at: new Date().toISOString()
        })
      });
      return resp.ok;
    } catch { return false; }
  }

  async function updateKB(title, content, category, domain, tags) {
    return saveToKB(domain || 'global', category, title, content, tags);
  }

  async function deleteKB(title) {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/cobra_kb_rules?title=eq.${encodeURIComponent(title)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ active: false })
        }
      );
      return resp.ok;
    } catch { return false; }
  }

  return { loadAPIKeys, loadOperatorConfig, searchKB, loadPersonaFromKB, saveToKB, updateKB, deleteKB };
};
