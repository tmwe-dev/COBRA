// ══════════════════════════════════════════════════════════════
// lib/super-mario/route-intent.js — Intent routing & classification
// ══════════════════════════════════════════════════════════════

module.exports = function createRouteIntent(deps) {
  const { log, detectLanguage } = deps;

  let _lastMarioIntent = 'chat';
  let _lastMarioScopes = ['chat'];

  // ── INTENT ROUTER ──
  function routeIntent(message) {
    const msg = (message || '').toLowerCase().trim();

    const continuations = ['procedi', 'vai', 'fallo', 'si', 'ok', 'sì', 'continua',
      'esatto', 'perfetto', 'certo', 'ovvio', 'provaci', 'dai', 'forza', 'fai', 'avanti', 'bene'];
    if (msg.length < 20 && continuations.some(c => msg === c || msg.startsWith(c + ' '))) {
      return { intent: _lastMarioIntent, scopes: _lastMarioScopes, continued: true };
    }

    if (msg.length < 15) {
      const greetings = ['ciao', 'hey', 'hi', 'hello', 'buongiorno', 'buonasera', 'salve', 'come stai', 'grazie', 'chi sei', 'aiuto'];
      if (greetings.some(g => msg === g || msg.startsWith(g + ' '))) {
        return setIntent('chat', ['chat']);
      }
    }

    const scopes = new Set();
    let intent = 'task';

    if (/apri|vai su|naviga|navigate|sito|pagina|url|leggi|prenota|book|reserv|compila|registra|iscri|accedi|login|voli|volo|hotel|albergo|bigliett|treno|traghett|noleggi|affitt|acquist|compr|ordina|visita|confronta.*prezz|economico|low.?cost/.test(msg)) scopes.add('browse');
    if (!scopes.has('browse') && /cerca|search|google|trova|ricerca|notizie|news|rassegna|giornali/.test(msg)) scopes.add('search');
    if (scopes.has('browse') && /cerca|search|google|ricerca|notizie|news/.test(msg)) scopes.add('search');
    if (scopes.has('browse') || scopes.has('search')) scopes.add('interact');
    if (/estrai|extract|crawl|scrape|analizza|dati|tabella|csv|confronta|paragona/.test(msg)) scopes.add('data');
    if (/salva|ricorda|memoria|kb|job|task|procedura/.test(msg)) scopes.add('admin');
    if (/file|cartella|documento|lista file|salva file/.test(msg)) scopes.add('file');
    if (/email|mail|whatsapp|linkedin|invia|manda|scrivi a/.test(msg)) scopes.add('communicate');
    if (/https?:\/\//.test(msg) || /www\./.test(msg)) scopes.add('browse');

    if (scopes.size === 0) {
      if (msg.endsWith('?') && msg.length < 40) return setIntent('chat', ['chat']);
      scopes.add('search');
      scopes.add('browse');
    }

    let operationLevel = 'read';
    const opPatterns = [
      { level: 'destructive', re: /\b(cancella|elimina|delete|rimuovi|paga|acquista|conferma definitivamente|distruggi|wipe|reset)\b/i },
      { level: 'send', re: /\b(invia|manda|send|spedisci|inoltra)\b/i },
      { level: 'write', re: /\b(salva|memorizza|aggiorna|modifica|update|cambia|compila|riempi|fill|prenota|book|reserv|iscri|registra)\b/i },
      { level: 'prepare', re: /\b(scrivi|componi|redigi|prepara|crea|genera|draft|bozza|traduci|riformula|riassumi)\b/i },
      { level: 'read', re: /\b(cerca|leggi|trova|mostrami|dimmi|spiega|analizza|guarda|verifica|controlla|esplora|elenca|quali|quanti|cosa c'è)\b/i },
    ];
    for (const op of opPatterns) {
      if (op.re.test(msg)) { operationLevel = op.level; break; }
    }

    if (/\b(partner|cliente|prospect|lead|outreach|preventivo|offerta|commerciale|wca|forwarder|spedizioniere)\b/i.test(msg)) scopes.add('sales');
    if (/\btmwe\b/i.test(msg) || /\btransport management\b/i.test(msg)) scopes.add('tmwe');
    if (/\bfindair\b/i.test(msg) || /\bpiattaforma booking\b/i.test(msg)) scopes.add('findair');
    if (/\b(ricorda|ricordati|memorizza|non dimenticare|appunta|dimentica)\b/i.test(msg)) scopes.add('memory');
    if (/\b(spedizione|express|cargo|air freight|courier|dhl|fedex|ups|awb|tracking|dogana)\b/i.test(msg)) scopes.add('logistics');

    return setIntent(intent, [...scopes], operationLevel);
  }

  function setIntent(intent, scopes, operationLevel) {
    _lastMarioIntent = intent;
    _lastMarioScopes = scopes;
    return { intent, scopes, continued: false, operationLevel: operationLevel || 'read' };
  }

  // ── 5b. LLM FALLBACK for ambiguous intents ──
  async function clarifyIntentWithLLM(message, regexResult, aiKeys) {
    if (!regexResult || regexResult.scopes?.length < 3) return regexResult;
    if (regexResult.operationLevel && regexResult.operationLevel !== 'read') return regexResult;

    const prompt = `Classifica questo messaggio in UNA di queste categorie:
- chat (saluto, domanda generica)
- search (cerca informazioni)
- browse (naviga su sito)
- interact (compila form, clicca)
- communicate (email, whatsapp, linkedin)
- sales (outreach partner, preventivo)
- data (estrai, analizza dati)
- admin (salva KB, memoria, job)
- memory (ricorda, dimentica)
- logistics (spedizioni, cargo, tracking)

E il livello operativo:
- read / prepare / write / send / destructive

Messaggio: "${message.substring(0, 200)}"

Rispondi SOLO con JSON: {"scope":"...", "level":"..."}`;

    try {
      let result = null;
      if (aiKeys?.geminiKey) {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${aiKeys.geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 50 }
            }),
            signal: AbortSignal.timeout(3000)
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const match = text.match(/\{[^}]+\}/);
          if (match) result = JSON.parse(match[0]);
        }
      }
      if (result && result.scope) {
        log(`[IntentRouter] LLM clarified: scope=${result.scope} level=${result.level} (was: ${regexResult.scopes?.join(',')})`);
        return {
          ...regexResult,
          intent: result.scope === 'chat' ? 'chat' : 'task',
          scopes: [result.scope, ...regexResult.scopes.filter(s => s !== result.scope)],
          operationLevel: result.level || regexResult.operationLevel,
          llm_clarified: true,
        };
      }
    } catch (e) {
      log(`[IntentRouter] LLM fallback failed: ${e.message}`);
    }
    return regexResult;
  }

  return {
    routeIntent,
    clarifyIntentWithLLM,
    setIntent,
  };
};
