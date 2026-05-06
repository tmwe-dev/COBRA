// ══════════════════════════════════════════════════════════════
// lib/super-mario/decompose.js — Task decomposition & planning
// ══════════════════════════════════════════════════════════════

module.exports = function createDecompose(deps) {
  const { log, crypto } = deps;

  // ── 11. TASK PLANNER ──
  const _planTemplates = new Map();

  function decompose(message, scopes) {
    const msg = (message || '').toLowerCase();

    if (msg.length < 30) return null;
    if (scopes.length <= 1 && !/\b(e poi|dopo|quindi|infine|poi)\b/.test(msg)) return null;

    const sequentialMarkers = (msg.match(/\b(e poi|dopo|quindi|infine|poi|successivamente|una volta|quando hai|prima|per prima cosa)\b/g) || []).length;
    const multipleVerbs = (msg.match(/\b(cerca|trova|apri|leggi|confronta|analizza|estrai|invia|manda|salva|compila|clicca|prenota|scrivi|crea|fai)\b/g) || []);
    const uniqueVerbs = [...new Set(multipleVerbs)].length;
    const quantifiers = /\b(\d+\s+\w+|tutti i|ogni|per ciascuno|ciascun|ognuno)\b/.test(msg);
    const dependencies = /\b(usa il risultato|in base a|con quello|con i dati|dal risultato|usando|basandoti)\b/.test(msg);

    const complexityScore = sequentialMarkers * 2 + (uniqueVerbs > 2 ? uniqueVerbs : 0) + (quantifiers ? 2 : 0) + (dependencies ? 2 : 0);

    if (complexityScore < 3) return null;

    const steps = [];
    const segments = splitIntoSegments(msg);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segScopes = detectSegmentScopes(seg);
      steps.push({
        step: i + 1,
        action: seg.trim(),
        scopes: segScopes,
        dependsOn: i > 0 ? [i] : [],
        status: 'pending',
        result: null,
      });
    }

    if (steps.length <= 1) return null;

    const templateKey = steps.map(s => s.scopes.sort().join('+')).join('→');
    const existing = _planTemplates.get(templateKey);

    const plan = {
      id: crypto.randomUUID().substring(0, 8),
      steps,
      templateKey,
      isFromTemplate: !!existing,
      complexityScore,
      created: new Date().toISOString(),
    };

    log(`[SuperMario] TaskPlan decomposed: ${steps.length} steps, complexity=${complexityScore}, template=${existing ? 'reused' : 'new'}`);
    return plan;
  }

  function splitIntoSegments(msg) {
    const parts = msg.split(/\s*(?:,\s*(?:e\s+)?poi\s+|,\s*dopo(?:\s+di\s+che)?\s+|,\s*quindi\s+|,\s*infine\s+|\.\s+poi\s+|\.\s+dopo\s+|\.\s+quindi\s+|\.\s+infine\s+|;\s*)/i);

    if (parts.length > 1) {
      return parts.filter(p => p.trim().length > 5);
    }

    const verbPattern = /\b(cerca|trova|apri|leggi|confronta|analizza|estrai|invia|manda|salva|compila|clicca|prenota|scrivi|crea)\b/gi;
    let matches = [...msg.matchAll(verbPattern)];

    if (matches.length > 1) {
      const segments = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = i < matches.length - 1 ? matches[i + 1].index : msg.length;
        const seg = msg.substring(start, end).replace(/\s*(e|,)\s*$/, '').trim();
        if (seg.length > 5) segments.push(seg);
      }
      return segments;
    }

    return [msg];
  }

  function detectSegmentScopes(segment) {
    const s = segment.toLowerCase();
    const scopes = [];
    if (/cerca|search|google|trova|ricerca|notizie/.test(s)) scopes.push('search');
    if (/apri|vai su|naviga|sito|pagina|leggi/.test(s)) scopes.push('browse');
    if (/compila|clicca|form|inserisci|prenota|registra/.test(s)) scopes.push('interact');
    if (/estrai|crawl|scrape|analizza|dati|tabella/.test(s)) scopes.push('data');
    if (/salva|ricorda|memoria|kb|job/.test(s)) scopes.push('admin');
    if (/file|cartella|documento/.test(s)) scopes.push('file');
    if (/email|mail|whatsapp|linkedin|invia|manda/.test(s)) scopes.push('communicate');
    if (/confronta|paragona|differenz/.test(s)) scopes.push('search', 'data');
    return scopes.length > 0 ? [...new Set(scopes)] : ['search'];
  }

  function buildPlanPrompt(plan) {
    const stepDescs = plan.steps.map(s => {
      const deps = s.dependsOn.length > 0 ? ` (usa output step ${s.dependsOn.join(',')})` : '';
      const status = s.status !== 'pending' ? ` [${s.status}]` : '';
      return `  ${s.step}. ${s.action}${deps}${status}`;
    }).join('\n');

    return `# PIANO DI ESECUZIONE (${plan.steps.length} step)
Questa richiesta è stata scomposta in step sequenziali. Esegui ogni step nell'ordine, usando il risultato dello step precedente come input per il successivo.

${stepDescs}

REGOLE PIANO:
- Esegui gli step in ordine. Non saltare step.
- Dopo ogni tool call, valuta se il risultato è sufficiente per procedere allo step successivo.
- Se uno step fallisce, riporta l'errore e chiedi all'utente come procedere.
- Al termine di tutti gli step, fornisci un riassunto consolidato dei risultati.
- Se puoi parallelizzare step indipendenti (dependsOn vuoto), fallo.`;
  }

  function savePlanTemplate(plan) {
    const existing = _planTemplates.get(plan.templateKey);
    _planTemplates.set(plan.templateKey, {
      steps: plan.steps.map(s => ({ scopes: s.scopes, action: s.action })),
      usageCount: (existing?.usageCount || 0) + 1,
      lastUsed: new Date().toISOString(),
    });
    if (_planTemplates.size > 50) {
      const oldest = [..._planTemplates.entries()].sort((a, b) =>
        new Date(a[1].lastUsed) - new Date(b[1].lastUsed)
      )[0];
      if (oldest) _planTemplates.delete(oldest[0]);
    }
  }

  return {
    decompose,
    buildPlanPrompt,
    savePlanTemplate,
  };
};
