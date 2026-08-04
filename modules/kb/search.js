// modules/kb/search.js — KB search + CRUD (merged persistence.js)

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabase');

// Parole troppo generiche per discriminare: non contribuiscono al punteggio
const STOPWORDS = new Set([
  'che', 'con', 'per', 'del', 'della', 'dei', 'delle', 'dal', 'dalla', 'nel', 'nella',
  'sul', 'sulla', 'una', 'uno', 'gli', 'the', 'and', 'for', 'you', 'sono', 'come',
  'cosa', 'quando', 'dove', 'quale', 'quali', 'mio', 'mia', 'suo', 'sua', 'più',
  'cerca', 'cercami', 'trova', 'dimmi', 'dammi', 'voglio', 'vorrei', 'puoi',
]);

// Normalizza accenti e punteggiatura per confronti robusti
function _norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cerca nella KB con reranking a due stadi.
 * Stadio 1: recupero ampio dei candidati attivi (con filtri opzionali dominio/tag).
 * Stadio 2: scoring per corrispondenza di parole, con peso maggiore a titolo e tag.
 *
 * Nota: il LIMIT SQL deve restare ampio. Applicarlo prima dello scoring
 * scarterebbe regole pertinenti solo perché hanno priorità bassa.
 */
async function searchKB(query, domain, tags) {
  try {
    let url = `${SUPABASE_URL}/rest/v1/cobra_kb_rules?select=*&active=eq.true&order=priority.desc&limit=500`;
    if (domain) url += `&domain=eq.${encodeURIComponent(domain)}`;
    if (tags && tags.length > 0) url += `&tags=ov.{${tags.map(t => encodeURIComponent(t)).join(',')}}`;
    const resp = await fetch(url, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];

    if (!query || query.trim().length <= 2) return rows.slice(0, 10);

    const words = [...new Set(_norm(query).split(' '))]
      .filter(w => w.length > 2 && !STOPWORDS.has(w));
    if (words.length === 0) return rows.slice(0, 10);

    const scored = rows.map(r => {
      const title = _norm(r.title);
      const tagText = _norm((r.tags || []).join(' '));
      const body = _norm(r.content);
      let score = 0;
      for (const w of words) {
        // Parola intera nel titolo: segnale più forte
        if (new RegExp(`\\b${w}\\b`).test(title)) score += 5;
        else if (title.includes(w)) score += 3;      // prefisso/plurale nel titolo
        if (tagText.includes(w)) score += 3;
        if (new RegExp(`\\b${w}\\b`).test(body)) score += 2;
        else if (body.includes(w)) score += 1;
      }
      // Bonus se la query compare quasi per intero nel titolo
      const matchedInTitle = words.filter(w => title.includes(w)).length;
      if (matchedInTitle >= Math.ceil(words.length * 0.6)) score += 4;
      return { ...r, _score: score };
    }).filter(r => r._score > 0);

    // La priorità resta come spareggio, non come filtro primario
    scored.sort((a, b) => b._score - a._score || (b.priority || 0) - (a.priority || 0));
    return scored.slice(0, 10);
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
