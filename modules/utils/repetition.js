// modules/utils/repetition.js — Repetition & frustration detection
// Source: server.js lines 2926-2956

function detectRepetition(messages) {
  const userMsgs = messages
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .map(m => m.content.toLowerCase().trim());
  if (userMsgs.length < 2) return null;

  const last = userMsgs[userMsgs.length - 1];
  const lastWords = new Set(last.split(/\s+/).filter(w => w.length > 3));

  // Check last 4 user messages for similarity
  for (let i = userMsgs.length - 2; i >= Math.max(0, userMsgs.length - 5); i--) {
    const prevWords = new Set(userMsgs[i].split(/\s+/).filter(w => w.length > 3));
    const overlap = [...lastWords].filter(w => prevWords.has(w)).length;
    const sim = overlap / Math.max(lastWords.size, prevWords.size, 1);
    if (sim > 0.6) {
      return 'ATTENZIONE: L\'utente sta ripetendo una richiesta simile. La tua risposta precedente NON era soddisfacente. Rispondi in modo PIÙ CONCRETO e DIRETTO. Cambia approccio.';
    }
  }

  // Frustration patterns
  const frustrationPatterns = [
    /no,?\s*(intendo|volevo|dico)/i, /ti ho (già\s*)?detto/i,
    /come (ti )?ho (già )?detto/i, /ripeto/i, /non (hai |)(capito|capisci)/i,
    /ancora una volta/i, /di nuovo/i, /non funziona/i,
    /sembra stupido/i, /inutile/i,
  ];
  for (const p of frustrationPatterns) {
    if (p.test(last)) {
      return 'L\'utente è FRUSTRATO — cambia approccio completamente. Se stavi elenccando, SINTETIZZA. Se stavi chiedendo, AGISCI.';
    }
  }
  return null;
}

module.exports = { detectRepetition };
