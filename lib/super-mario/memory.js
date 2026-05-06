// ══════════════════════════════════════════════════════════════
// lib/super-mario/memory.js — Narrative memory & summaries
// ══════════════════════════════════════════════════════════════

module.exports = function createMemory(deps) {
  const { log } = deps;

  // ── 4. MEMORIA NARRATIVA ──
  const _summaryCache = new Map();

  function buildMemoryBlock(conversationHistory, lastToolResult) {
    const sections = [];
    const turns = conversationHistory || [];

    const summaryEntry = _summaryCache.get('current');
    if (summaryEntry && summaryEntry.summary) {
      sections.push(`## NARRATIVE_SUMMARY (turni 1-${summaryEntry.toIdx})\n${summaryEntry.summary}`);
    }

    const recentStart = Math.max(0, turns.length - 10);
    const recent = turns.slice(recentStart);
    if (recent.length > 0) {
      const recentText = recent.map((t, i) => {
        const role = t.role === 'user' ? 'UTENTE' : 'COBRA';
        const content = (t.content || '').substring(0, 500);
        return `[${recentStart + i + 1}] ${role}: ${content}`;
      }).join('\n');
      sections.push(`## RECENT_TURNS (ultimi ${recent.length})\n${recentText}`);
    }

    if (lastToolResult) {
      const result = typeof lastToolResult === 'string' ? lastToolResult : JSON.stringify(lastToolResult);
      sections.push(`## LAST_TOOL_RESULT\n${result.substring(0, 2000)}`);
    }

    return sections.length > 0 ? '# MEMORIA\n' + sections.join('\n\n') : '';
  }

  async function updateNarrativeSummary(conversationHistory, aiKeys) {
    const turns = conversationHistory || [];
    if (turns.length < 12) return;

    const existing = _summaryCache.get('current');
    const lastSummarized = existing ? existing.toIdx : 0;
    const newTurns = turns.length - 10;

    if (newTurns <= lastSummarized + 4) return;

    const toSummarize = turns.slice(0, newTurns);
    const summaryInput = toSummarize.map((t, i) => {
      const role = t.role === 'user' ? 'U' : 'A';
      return `${role}: ${(t.content || '').substring(0, 200)}`;
    }).join('\n');

    try {
      let summary = '';
      if (aiKeys.geminiKey) {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${aiKeys.geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Riassumi questa conversazione in 3-5 righe in italiano. Solo i fatti essenziali, le decisioni prese, e il contesto attuale. Nessun commento.\n\n${summaryInput}` }] }],
              generationConfig: { maxOutputTokens: 200 }
            }),
            signal: AbortSignal.timeout(8000)
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          summary = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
      } else if (aiKeys.openaiKey) {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiKeys.openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Riassumi la conversazione in 3-5 righe in italiano. Solo fatti essenziali.' },
              { role: 'user', content: summaryInput }
            ],
            max_tokens: 200
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (resp.ok) {
          const data = await resp.json();
          summary = data.choices?.[0]?.message?.content || '';
        }
      }

      if (summary) {
        const version = (existing?.version || 0) + 1;
        _summaryCache.set('current', {
          summary,
          fromIdx: 1,
          toIdx: newTurns,
          version,
          model: aiKeys.geminiKey ? 'gemini-flash-lite' : 'gpt-4o-mini',
          createdAt: new Date().toISOString()
        });
        log(`[SuperMario] Narrative summary v${version} generated (turni 1-${newTurns}, ${summary.length} chars)`);
      }
    } catch (e) {
      log(`[SuperMario] Summary generation failed: ${e.message}`);
    }
  }

  return {
    buildMemoryBlock,
    updateNarrativeSummary,
    clearSummaryCache: () => _summaryCache.clear(),
  };
};
