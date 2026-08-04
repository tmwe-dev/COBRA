// modules/memory/learning.js — Autoapprendimento: estrazione e richiamo di fatti durevoli
//
// Il resto della memoria conserva la CONVERSAZIONE (finestra scorrevole + riassunto).
// Qui si conservano i FATTI STABILI sull'utente e sulla sua attività, che devono
// sopravvivere alla singola sessione: nomi, ruoli, preferenze operative, codici,
// abitudini di lavoro.
//
// Vincoli di sicurezza:
//   - Si impara SOLO da ciò che l'utente scrive, mai dal contenuto web scaricato.
//     Altrimenti una pagina malevola potrebbe iscrivere istruzioni permanenti.
//   - Credenziali e segreti non vengono mai memorizzati.
//   - Ogni fatto è deduplicato e ha una confidenza che cresce con le conferme.

const path = require('path');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

const MAX_FACTS = 300;
const MIN_TURNS_BETWEEN_EXTRACTIONS = 4;

// Nulla che assomigli a un segreto entra nella memoria a lungo termine
const SECRET_PATTERNS = [
  /\b(sk|pk)-[A-Za-z0-9_-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\beyJ[A-Za-z0-9._-]{20,}/,                 // JWT
  /\bAIza[A-Za-z0-9_-]{20,}/,                 // chiave Google
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/i,          // token Slack
  /\bAKIA[0-9A-Z]{16}\b/,                     // chiave AWS
  // Ammette parole intermedie: "password è: x", "la mia password sarebbe x"
  /\b(password|passwd|pwd|segreto|secret|credenzial\w*|api[_ -]?key|token|codice\s+pin|pin)\b[^.\n]{0,20}?[:=]\s*\S+/i,
  /\b(password|passwd|pwd|segreto|secret)\b\s+(e|è|is|sarebbe|era)\s+\S+/i,
  /\b\d{13,19}\b/,                            // possibile numero di carta
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/,         // IBAN
];

function containsSecret(text) {
  return SECRET_PATTERNS.some(p => p.test(text || ''));
}

function normalizeText(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parole comuni che non distinguono un fatto da un altro
const FILLER = new Set([
  'come', 'della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'nello',
  'quando', 'dove', 'perche', 'anche', 'sono', 'essere', 'stato', 'stata',
  'viene', 'questo', 'questa', 'quello', 'quella', 'molto', 'sempre',
  'suo', 'sua', 'loro', 'nostro', 'nostra', 'presso', 'circa', 'oltre',
  'with', 'from', 'that', 'this', 'they', 'their', 'been', 'have',
]);

/** Insieme delle parole significative di un fatto. */
function significantWords(fact) {
  return new Set(
    normalizeText(fact).split(' ').filter(w => w.length > 3 && !FILLER.has(w))
  );
}

/** Chiave di deduplicazione: parole significative ordinate. */
function factKey(fact) {
  return [...significantWords(fact)].sort().slice(0, 8).join('-');
}

/** Somiglianza di Jaccard fra gli insiemi di parole significative. */
function similarity(a, b) {
  const sa = significantWords(a), sb = significantWords(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// Sopra questa soglia due formulazioni descrivono lo stesso fatto
const SIMILARITY_THRESHOLD = 0.7;

class LearningStore {
  constructor(dataDir) {
    this._file = path.join(dataDir, 'learned_facts.json');
    this.facts = readJsonSafeSync(this._file, []) || [];
    this._turnsSinceExtraction = 0;
    this._extracting = false;
  }

  save() { return writeJsonAtomicSync(this._file, this.facts); }

  /**
   * Inserisce un fatto, oppure rafforza quello equivalente già presente.
   * @returns {'nuovo'|'rafforzato'|'scartato'}
   */
  addFact(text, { category = 'generale', source = 'conversazione' } = {}) {
    const fact = String(text || '').trim();
    if (fact.length < 8 || fact.length > 400) return 'scartato';
    if (containsSecret(fact)) return 'scartato';

    const key = factKey(fact);
    if (!key) return 'scartato';

    // Prima la chiave esatta, poi la somiglianza: due formulazioni diverse
    // dello stesso fatto non devono creare due record.
    const existing = this.facts.find(f => f.key === key)
      || this.facts.find(f => similarity(f.text, fact) >= SIMILARITY_THRESHOLD);
    if (existing) {
      existing.confidence = Math.min(1, (existing.confidence || 0.5) + 0.15);
      existing.confirmations = (existing.confirmations || 1) + 1;
      existing.updatedAt = new Date().toISOString();
      // Se la nuova formulazione è più ricca, la si preferisce
      if (fact.length > existing.text.length) { existing.text = fact; existing.key = factKey(fact); }
      this.save();
      return 'rafforzato';
    }

    this.facts.push({
      key, text: fact, category, source,
      confidence: 0.6, confirmations: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Tetto: si eliminano i fatti meno confermati e più vecchi
    if (this.facts.length > MAX_FACTS) {
      this.facts.sort((a, b) =>
        (b.confidence - a.confidence) || (new Date(b.updatedAt) - new Date(a.updatedAt)));
      this.facts.length = MAX_FACTS;
    }
    this.save();
    return 'nuovo';
  }

  /** Rimuove un fatto per chiave o per testo esatto. */
  forget(needle) {
    const before = this.facts.length;
    const n = normalizeText(needle);
    this.facts = this.facts.filter(f => f.key !== needle && normalizeText(f.text) !== n);
    if (this.facts.length !== before) this.save();
    return before - this.facts.length;
  }

  /** Fatti più pertinenti al messaggio corrente, ordinati per rilevanza. */
  recall(query, limit = 6) {
    if (this.facts.length === 0) return [];
    const words = [...new Set(normalizeText(query).split(' '))].filter(w => w.length > 3);
    if (words.length === 0) {
      return [...this.facts]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, limit);
    }
    const scored = this.facts.map(f => {
      const hay = normalizeText(f.text + ' ' + f.category);
      let score = 0;
      for (const w of words) {
        if (new RegExp(`\\b${w}\\b`).test(hay)) score += 3;
        else if (hay.includes(w)) score += 1;
      }
      return { f, score: score * (0.5 + f.confidence) };
    }).filter(x => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(x => x.f);
  }

  /** Blocco testuale da inserire nel system prompt. */
  buildRecallBlock(query, limit = 6) {
    const hits = this.recall(query, limit);
    if (hits.length === 0) return '';
    const lines = hits.map(f => `- ${f.text}`).join('\n');
    return `## COSA SO GIA DELL'UTENTE\n${lines}\n(Se un dato risulta superato, aggiorna con save_memory invece di ripetere quello vecchio.)`;
  }

  getStats() {
    const byCategory = {};
    for (const f of this.facts) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    return {
      total: this.facts.length,
      byCategory,
      avgConfidence: this.facts.length
        ? Number((this.facts.reduce((s, f) => s + f.confidence, 0) / this.facts.length).toFixed(2))
        : 0,
    };
  }

  /**
   * Estrae fatti durevoli dai turni recenti usando un modello economico.
   * Non blocca la risposta: va invocata senza await dal chiamante.
   *
   * @param {Array<{role:string,content:string}>} turns storico conversazione
   * @param {object} aiKeys chiavi provider
   * @param {function} log
   */
  async extractFromConversation(turns, aiKeys, log = () => {}) {
    this._turnsSinceExtraction++;
    if (this._extracting) return { skipped: 'gia in corso' };
    if (this._turnsSinceExtraction < MIN_TURNS_BETWEEN_EXTRACTIONS) {
      return { skipped: 'troppo presto' };
    }
    // Si impara solo dai messaggi dell'utente: il contenuto web non deve
    // poter iscrivere nulla nella memoria permanente.
    const userTurns = (turns || []).filter(t => t.role === 'user').slice(-8);
    if (userTurns.length < 2) return { skipped: 'pochi messaggi' };

    const material = userTurns
      .map(t => String(t.content || '').substring(0, 400))
      .filter(t => !containsSecret(t))
      .join('\n---\n');
    if (material.length < 40) return { skipped: 'materiale insufficiente' };

    const istruzioni = [
      'Estrai i fatti STABILI e DUREVOLI sull\'utente o sulla sua attività dai messaggi seguenti.',
      'Includi: nome, ruolo, azienda, clienti e fornitori ricorrenti, preferenze operative,',
      'codici e riferimenti che useranno ancora, strumenti che usano, abitudini di lavoro.',
      'ESCLUDI: richieste una tantum, domande, contenuti di pagine web, credenziali, dati sensibili.',
      'Rispondi SOLO con un array JSON di oggetti {"fatto": "...", "categoria": "..."}.',
      'Categorie ammesse: identita, azienda, preferenza, contatto, processo, strumento.',
      'Se non c\'è nulla di durevole, rispondi [].',
      'Massimo 5 elementi. Ogni fatto deve stare in una frase.',
    ].join(' ');

    this._extracting = true;
    try {
      const raw = await this._callLite(istruzioni, material, aiKeys);
      if (!raw) return { skipped: 'nessuna risposta dal modello' };

      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return { skipped: 'risposta non in formato JSON' };

      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); }
      catch { return { skipped: 'JSON non valido' }; }
      if (!Array.isArray(parsed)) return { skipped: 'risposta non è un array' };

      let nuovi = 0, rafforzati = 0, scartati = 0;
      for (const item of parsed.slice(0, 5)) {
        const testo = typeof item === 'string' ? item : item?.fatto || item?.fact || '';
        const cat = (typeof item === 'object' && (item.categoria || item.category)) || 'generale';
        const esito = this.addFact(testo, { category: String(cat).substring(0, 30) });
        if (esito === 'nuovo') nuovi++;
        else if (esito === 'rafforzato') rafforzati++;
        else scartati++;
      }
      this._turnsSinceExtraction = 0;
      if (nuovi || rafforzati) {
        log(`[Apprendimento] ${nuovi} fatti nuovi, ${rafforzati} confermati, ${scartati} scartati (totale ${this.facts.length})`);
      }
      return { nuovi, rafforzati, scartati, totale: this.facts.length };
    } catch (e) {
      log(`[Apprendimento] estrazione fallita: ${e.message}`);
      return { skipped: e.message };
    } finally {
      this._extracting = false;
    }
  }

  /** Chiamata a un modello economico. Prova OpenAI, poi Gemini, poi Groq. */
  async _callLite(system, user, aiKeys = {}) {
    const timeout = 10000;
    if (aiKeys.openaiKey) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aiKeys.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiKeys.openaiModelLite || 'gpt-4o-mini',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: 400, temperature: 0,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (r.ok) { const d = await r.json(); return d.choices?.[0]?.message?.content || ''; }
    }
    if (aiKeys.geminiKey) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${aiKeys.geminiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: 400, temperature: 0 },
          }),
          signal: AbortSignal.timeout(timeout) });
      if (r.ok) { const d = await r.json(); return d.candidates?.[0]?.content?.parts?.[0]?.text || ''; }
    }
    if (aiKeys.groqKey) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aiKeys.groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: 400, temperature: 0,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (r.ok) { const d = await r.json(); return d.choices?.[0]?.message?.content || ''; }
    }
    return '';
  }
}

module.exports = { LearningStore, containsSecret, factKey, normalizeText, similarity };
