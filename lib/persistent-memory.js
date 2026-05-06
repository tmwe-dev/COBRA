// lib/persistent-memory.js — Persistent AI Memory (Supabase-backed)
module.exports = function createPersistentMemory(deps) {
  const { log, SUPABASE_URL, SUPABASE_ANON_KEY } = deps;
  const fetch = global.fetch;

  return {
    async save(content, type = 'fact', level = 2, tags = []) {
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/ai_memory`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content, memory_type: type, level, tags,
            importance: level >= 3 ? 5 : level >= 2 ? 3 : 1,
            confidence: 0.8, source: 'cobra_web_app',
            created_at: new Date().toISOString()
          })
        });
        if (resp.ok) log(`[Memory] Saved L${level}: ${content.substring(0, 60)}...`);
        return resp.ok;
      } catch (e) {
        log(`[Memory] Save failed: ${e.message}`);
        return false;
      }
    },

    async loadForContext(query) {
      try {
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/ai_memory?select=*&order=importance.desc,level.desc&limit=15`,
          { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
        );
        if (!resp.ok) return '';
        const rows = await resp.json();
        if (!rows || rows.length === 0) return '';

        const q = (query || '').toLowerCase();
        const qWords = q.split(/\s+/).filter(w => w.length > 2);
        const relevant = qWords.length > 0
          ? rows.filter(r => qWords.some(w => (r.content || '').toLowerCase().includes(w)))
          : rows.slice(0, 8);

        if (relevant.length === 0) return '';

        const levelNames = { 3: 'PERMANENTE', 2: 'OPERATIVA', 1: 'SESSIONE' };
        let ctx = '\n# MEMORIA COBRA\n';
        const byLevel = { 3: [], 2: [], 1: [] };
        for (const m of relevant) {
          const lvl = m.level || 2;
          if (!byLevel[lvl]) byLevel[lvl] = [];
          byLevel[lvl].push(m);
        }
        for (const lvl of [3, 2, 1]) {
          if (!byLevel[lvl] || byLevel[lvl].length === 0) continue;
          ctx += `[L${lvl} ${levelNames[lvl] || ''}]\n`;
          for (const m of byLevel[lvl]) {
            ctx += `• ${m.content}\n`;
          }
        }
        return ctx;
      } catch (e) {
        log(`[Memory] Load failed: ${e.message}`);
        return '';
      }
    },

    async saveToolAction(toolName, args, result) {
      const autoSaveRules = {
        google_search: (a) => `Cercato online: "${a.query}"`,
        navigate: (a) => `Visitato: ${a.url}`,
        send_email: (a) => `Email inviata a ${a.to}`,
        save_to_kb: (a) => `Salvato in KB: "${a.name}"`,
        create_file: (a) => `File creato: ${a.filename}`,
      };
      const formatter = autoSaveRules[toolName];
      if (!formatter) return;
      const content = formatter(args);
      if (content) {
        await this.save(content, 'tool_action', 1, ['auto', toolName]);
      }
    }
  };
};
