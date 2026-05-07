// modules/kb/search.js — KB search + CRUD (merged persistence.js)

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabase');

async function searchKB(query, domain, tags) {
  try {
    let url = `${SUPABASE_URL}/rest/v1/cobra_kb_rules?select=*&active=eq.true&order=priority.desc&limit=20`;
    if (domain) url += `&domain=eq.${encodeURIComponent(domain)}`;
    if (tags && tags.length > 0) url += `&tags=ov.{${tags.map(t => encodeURIComponent(t)).join(',')}}`;
    const resp = await fetch(url, { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } });
    if (!resp.ok) return [];
    const rows = await resp.json();
    if (query && query.trim().length > 2) {
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const scored = rows.map(r => {
        const text = `${r.title} ${r.content} ${(r.tags || []).join(' ')}`.toLowerCase();
        return { ...r, _score: words.filter(w => text.includes(w)).length };
      }).filter(r => r._score > 0);
      scored.sort((a, b) => b._score - a._score || b.priority - a.priority);
      return scored.slice(0, 10);
    }
    return rows;
  } catch { return []; }
}

async function saveToKB(domain, type, name, content, tags) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/cobra_kb_rules`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ domain, rule_type: type, title: name, content, tags: tags ? tags.split(',').map(t => t.trim()) : [], active: true, priority: 5, created_at: new Date().toISOString() })
    });
    return resp.ok;
  } catch { return false; }
}

async function updateKB(title, content, category, domain, tags) {
  return saveToKB(domain || 'global', category, title, content, tags);
}

async function deleteKB(title) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/cobra_kb_rules?title=eq.${encodeURIComponent(title)}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ active: false })
    });
    return resp.ok;
  } catch { return false; }
}

module.exports = { searchKB, saveToKB, updateKB, deleteKB };
