// ══════════════════════════════════════════════════════════════
// lib/context-budget.js — Token budget & Context Assembly
// Extracted from server.js lines 2756-2851
// ══════════════════════════════════════════════════════════════

// Repetition Detection — detect when user repeats a request or is frustrated
function detectRepetition(messages) {
  const userMsgs = messages
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .map(m => m.content.toLowerCase().trim());
  if (userMsgs.length < 2) return null;

  const last = userMsgs[userMsgs.length - 1];
  const lastWords = new Set(last.split(/\s+/).filter(w => w.length > 3));
  for (let i = userMsgs.length - 2; i >= Math.max(0, userMsgs.length - 5); i--) {
    const prevWords = new Set(userMsgs[i].split(/\s+/).filter(w => w.length > 3));
    const overlap = [...lastWords].filter(w => prevWords.has(w)).length;
    const sim = overlap / Math.max(lastWords.size, prevWords.size, 1);
    if (sim > 0.6) {
      return 'ATTENZIONE: L\'utente sta ripetendo una richiesta simile. Rispondi in modo PIÙ CONCRETO e DIRETTO. Se prima hai chiesto chiarimenti, ORA agisci con la migliore interpretazione. NON ripetere la stessa struttura di risposta.';
    }
  }
  const frustrationPatterns = [
    /no,?\s*(intendo|volevo|dico)/i, /ti ho (già\s*)?detto/i,
    /come (ti )?ho (già )?detto/i, /ripeto/i, /non (hai |)(capito|capisci)/i,
    /ancora una volta/i, /di nuovo/i, /fa cagare/i, /merda/i, /non funziona/i,
    /sembra stupido/i, /inutile/i, /cazzo/i,
  ];
  for (const p of frustrationPatterns) {
    if (p.test(last)) {
      return 'L\'utente è FRUSTRATO — la risposta precedente non ha centrato il punto. Rispondi in modo diretto, concreto, senza chiedere chiarimenti. Cambia approccio completamente.';
    }
  }
  return null;
}

// Token Budget & Context Assembly
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * digestToolResult — Pre-processa i risultati dei tool prima di passarli al modello.
 * Tronca contenuti lunghi e aggiunge istruzioni per il modello di NON rigurgitare.
 */
function digestToolResult(toolName, rawResult) {
  const MAX_CHARS = 150000;
  let result = rawResult;

  if (result.length > MAX_CHARS) {
    result = result.substring(0, MAX_CHARS) + '\n\n[...contenuto troncato. Hai letto abbastanza per rispondere.]';
  }

  result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
  result = result.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  result = result.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  result = result.replace(/<header[\s\S]*?<\/header>/gi, '');
  result = result.replace(/<[^>]+>/g, ' ');
  result = result.replace(/\s{3,}/g, '\n');

  const digestInstruction = `[ISTRUZIONE: Questo è il risultato del tool "${toolName}". LEGGILO, CAPISCILO, poi rispondi all'utente con PAROLE TUE. NON copiare questo testo. NON elencarlo. RACCONTALO come un collega.]\n`;

  return digestInstruction + result;
}

function assembleContextWithBudget(blocks, budgetTokens) {
  const sorted = [...blocks].sort((a, b) => b.priority - a.priority);
  const included = [], truncated = [], dropped = [];
  let remaining = budgetTokens;
  const parts = [];

  for (const block of sorted) {
    if (!block.content || !block.content.trim()) continue;
    const blockTokens = estimateTokens(block.content);
    if (blockTokens <= remaining) {
      parts.push(block.content);
      remaining -= blockTokens;
      included.push(block.key);
    } else if (remaining >= (block.minTokens || 200)) {
      const charBudget = remaining * 4;
      const cut = block.content.slice(0, charBudget);
      const lastNl = cut.lastIndexOf('\n');
      const cleanCut = lastNl > charBudget * 0.5 ? cut.slice(0, lastNl) : cut;
      parts.push(cleanCut + '\n[...contesto troncato]');
      remaining -= estimateTokens(cleanCut);
      truncated.push(block.key);
    } else {
      dropped.push(block.key);
    }
  }
  return { text: parts.join('\n\n'), stats: { included, truncated, dropped, totalTokens: budgetTokens - remaining } };
}

module.exports = {
  detectRepetition,
  estimateTokens,
  digestToolResult,
  assembleContextWithBudget,
};
