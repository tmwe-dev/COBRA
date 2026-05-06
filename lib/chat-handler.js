// lib/chat-handler.js — Main chat pipeline (SuperMario orchestration)
// Extracted from server.js lines 7807-8083
// Factory function: receives deps, returns { handleChat(message, voiceMode) }

const { extractBookingParams, mergeFlightFollowup, getMissingFlightFields, buildFlightUrl } = require('./booking-parser');

module.exports = function createChatHandler(deps) {
  const { log, emitThinking, emitReasoning, wsBroadcast, session, toolHistory,
    CobraSupervisor, conversationEngine, SuperMario, COBRA_TOOLS, aiKeys,
    searchKB, callAI, isBridgeReady, TokenMeter, ResponseRecorder,
    CobraPersonaLearner, detectRepetition,
    getActivePendingActions, approvePendingAction, executeTool } = deps;

  async function handleChat(message, voiceMode) {
    session.chatAborted = false;

    // Check human takeover resume
    if (session.humanTakeover && /\b(continu|riprendi|vai|ok|fatto|go|resume|done|prosegui)\b/i.test(message)) {
      log('[HumanTakeover] Operator resumed via chat message');
      session.humanTakeover = false;
      if (session.humanTakeoverResolve) { session.humanTakeoverResolve(); session.humanTakeoverResolve = null; }
      wsBroadcast({ type: 'human_takeover_ended', ts: Date.now() });
      wsBroadcast({ type: 'ai_response', text: 'Perfetto, riprendo il controllo. Analizzo lo stato attuale della pagina...' });
      return { ok: true, message: 'Controllo restituito a COBRA. Riprendo da dove ero rimasto.' };
    }

    // ══════════════════════════════════════════════════════════════
    // PENDING BOOKING: intercetta follow-up prima di SuperMario
    // ══════════════════════════════════════════════════════════════
    if (session.pendingBooking) {
      log(`[PendingBooking] Active: type=${session.pendingBooking.type}, checking follow-up`);

      // Check for cancellation
      if (/\b(annulla|cancella|lascia|stop|cancel|forget|dimentica|non importa)\b/i.test(message)) {
        log('[PendingBooking] Cancelled by user');
        session.pendingBooking = null;
        session.currentIntent = null;
        wsBroadcast({ type: 'ai_response', text: 'Ok, prenotazione annullata.' });
        CobraSupervisor.startRequest(null, message);
        CobraSupervisor.completeRequest();
        return { ok: true, cancelled: 'booking' };
      }

      if (session.pendingBooking.type === 'flight') {
        const merged = mergeFlightFollowup(session.pendingBooking.params, message);
        const missing = getMissingFlightFields(merged);

        log(`[PendingBooking] Merged: ${JSON.stringify(merged)}, still missing: [${missing.join(', ')}]`);

        if (missing.length > 0) {
          session.pendingBooking = { type: 'flight', params: merged, missing };
          wsBroadcast({ type: 'ai_response', text: `Mi mancano ancora: **${missing.join(', ')}**.` });
          return { ok: true, blocked: 'missing_data', pending: true };
        }

        // All data complete — clear pending, set intent, navigate
        session.pendingBooking = null;
        session.currentIntent = 'flight_booking';
        const url = buildFlightUrl(merged);
        log(`[PendingBooking] COMPLETE → navigating to ${url}`);
        emitReasoning(`Dati completi: ${merged.origin}→${merged.destination} ${merged.departureDate} ${merged.cabin} ${merged.tripType} ${merged.passengers}pax`, '✈️');

        // Add conversation context
        const conv = conversationEngine.getOrCreateActive('Chat');
        conversationEngine.addMessage(conv.id, 'user', message);

        // Navigate directly
        CobraSupervisor.startRequest(null, message);
        try {
          const navResult = await executeTool('navigate', { url });
          log(`[PendingBooking] Navigate result: ${(navResult || '').substring(0, 200)}`);
        } catch (e) {
          log(`[PendingBooking] Navigate error: ${e.message}`);
        }

        // Now run AI loop with strong hints
        const systemHint = `TASK VOLO GIÀ ROUTATO. Sei su Google Flights con parametri: ${JSON.stringify(merged)}. ` +
          `NON navigare su google.com. NON usare Google Search. ` +
          `Compila i campi se necessario, poi cerca i voli disponibili.`;

        const chatMem = conversationEngine.chatMemories.get(conv.id);
        const msgs = chatMem ? chatMem.getAPIMessages() : [{ role: 'user', content: message }];
        const marioResult = await SuperMario.assemble({
          intent: 'task', scopes: ['browse', 'interact', 'navigate'],
          operationLevel: 'write', userMessage: `Cerca volo ${merged.origin}-${merged.destination} ${merged.cabin} ${merged.departureDate}`,
          conversationHistory: msgs, lastToolResult: null, voiceMode, allTools: COBRA_TOOLS,
        });
        let systemPrompt = marioResult.systemPrompt + '\n\n' + systemHint;
        const useTools = marioResult.tools.length > 0 ? marioResult.tools : undefined;
        const result = await callAI(systemPrompt, msgs, useTools, 'standard');

        conversationEngine.addMessage(conv.id, 'assistant', result.content);
        CobraSupervisor.completeRequest(result.content);
        session.currentIntent = null; // reset after completion

        return { content: result.content, provider: result.provider, intent: 'flight_booking' };
      }
    }

    // Check pending action confirmation
    const _confirmPattern = /^(s[iì]|ok|invia|conferma|vai|procedi|fallo|send|yes|do it|go ahead)[\s.!]*$/i;
    const activePending = getActivePendingActions('default');
    if (activePending.length > 0 && _confirmPattern.test(message.trim())) {
      const pending = activePending[activePending.length - 1];
      const result = approvePendingAction(pending.id, 'operator');
      if (result.ok) {
        session.currentApprovalToken = result.approval_token;
        log(`[Security] Pending action ${pending.id} AUTO-APPROVED via chat confirmation ("${message.trim()}")`);
        wsBroadcast({ type: 'pending_action_approved', id: pending.id, approval_token: result.approval_token });
        wsBroadcast({ type: 'ai_reasoning', text: `✅ Azione confermata: ${pending.summary}`, icon: '🔓' });
      }
    }

    // 1. Supervisor start
    CobraSupervisor.startRequest(null, message);

    // 2. Get or create active conversation
    const conv = conversationEngine.getOrCreateActive('Chat');
    conversationEngine.addMessage(conv.id, 'user', message);
    const chatMem = conversationEngine.chatMemories.get(conv.id);

    // 3. Route intent via Super Mario
    let routing = SuperMario.routeIntent(message);
    const realScopes = (routing.scopes || []).filter(s => s !== 'interact');
    if (realScopes.length >= 3 && !realScopes.includes('browse')) {
      try {
        const clarified = await SuperMario.clarifyIntentWithLLM(message, routing, aiKeys);
        if (clarified && clarified.llm_clarified) {
          if (routing.scopes.includes('browse') && !clarified.scopes.includes('browse')) {
            clarified.scopes.push('browse');
          }
          log(`[SuperMario] LLM disambiguated: ${routing.scopes.join(',')} → ${clarified.scopes.join(',')}`);
          routing = clarified;
        }
      } catch (llmErr) {
        log(`[SuperMario] LLM clarify failed (non-blocking): ${llmErr.message}`);
      }
    }

    const intent = routing.intent;
    const opLevel = routing.operationLevel || 'read';
    session.currentOperationLevel = opLevel;
    log(`Chat: "${message.substring(0, 50)}" → ${intent} scopes=[${routing.scopes.join(',')}] opLevel=${opLevel}${routing.continued ? ' (continued)' : ''}`);
    wsBroadcast({ type: 'clear_activity' });
    emitReasoning(`L'utente chiede: "${message.length > 80 ? message.substring(0, 80) + '...' : message}"`, '💬');

    // PRE-ROUTING: blocca task di azione con dati incompleti + salva pendingBooking
    if (!routing.continued && (opLevel === 'write' || opLevel === 'prepare') && routing.scopes.includes('browse')) {
      // Try to extract structured booking params
      const bookingParams = extractBookingParams(message);

      if (bookingParams && bookingParams.type === 'flight') {
        const missing = getMissingFlightFields(bookingParams);
        if (missing.length > 0) {
          // Save pending booking state for follow-up merge
          session.pendingBooking = { type: 'flight', params: bookingParams, missing };
          const route = bookingParams.originRaw && bookingParams.destinationRaw
            ? `${bookingParams.originRaw}→${bookingParams.destinationRaw}` : bookingParams.destinationRaw || '?';
          const cabin = bookingParams.cabin !== 'economy' ? ` in ${bookingParams.cabin}` : '';
          log(`[PreRouting] PENDING BOOKING saved: ${route}${cabin}, missing=[${missing.join(',')}]`);
          emitReasoning(`Dati volo parziali (${route}${cabin}) — chiedo: ${missing.join(', ')}`, '⛔');
          wsBroadcast({ type: 'ai_response', text: `Per cercare il volo ${route}${cabin} mi servono: **${missing.join(', ')}**.` });
          CobraSupervisor.completeRequest();
          return { ok: true, blocked: 'missing_data', pendingBooking: true };
        }
        // All data present from first message — proceed directly
      } else {
        // Generic booking check (non-flight)
        const msg = message.toLowerCase();
        const HAS_DATE = /\b(\d{1,2}[\/.\\-]\d{1,2}|\d{1,2}\s*(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)|domani|dopodomani|oggi|stasera|stanotte|prossim|luned|marted|mercoled|gioved|venerd|sabato|domenica|today|tomorrow|tonight|next\s+\w+day|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}[\/-]\d{2}[\/-]\d{2})\b/i;
        const NEEDS_DATE = /\b(prenota|book|reserv|bigliett|prenotazione|appuntamento|hotel|albergo|treno|traghett|noleggi|affit|viaggio|soggiorno|check.?in)\b/i;
        if (NEEDS_DATE.test(msg) && !HAS_DATE.test(msg)) {
          log(`[PreRouting] BLOCKED: task di azione senza data — opLevel=${opLevel}, asking user`);
          emitReasoning('Dati incompleti — chiedo informazioni mancanti', '⛔');
          wsBroadcast({ type: 'ai_response', text: 'Per procedere mi servono alcune informazioni: **quando** (data/periodo)? Serve anche sapere il numero di persone e se ci sono preferenze specifiche.' });
          CobraSupervisor.completeRequest();
          return { ok: true, blocked: 'missing_data' };
        }
      }
    }

    // 4. Decompose multi-step tasks
    const taskPlan = SuperMario.decompose(message, routing.scopes);
    if (taskPlan) {
      emitReasoning(`Piano multi-step: ${taskPlan.steps.length} step individuati`, '📋');
      log(`[SuperMario] TaskPlan: ${taskPlan.steps.map(s => s.action.substring(0, 40)).join(' → ')}`);
      for (const step of taskPlan.steps) {
        for (const s of step.scopes) {
          if (!routing.scopes.includes(s)) routing.scopes.push(s);
        }
      }
    }

    // BRIDGE WAIT
    const BROWSER_SCOPES = ['browse', 'interact', 'search', 'navigate'];
    const needsBrowser = routing.scopes.some(s => BROWSER_SCOPES.includes(s));
    if (needsBrowser && !isBridgeReady()) {
      emitReasoning('Attendo connessione estensione Chrome...', '🔌');
      emitThinking('Connessione al browser in corso...');
      const _bridgeWaitStart = Date.now();
      const BRIDGE_TIMEOUT_MS = 15000;
      while (!isBridgeReady() && (Date.now() - _bridgeWaitStart) < BRIDGE_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 250));
      }
      if (isBridgeReady()) {
        log(`[Bridge] Estensione connessa dopo ${Date.now() - _bridgeWaitStart}ms`);
        emitReasoning(`Estensione Chrome connessa (${Math.round((Date.now() - _bridgeWaitStart)/1000)}s)`, '✅');
      } else {
        log('[Bridge] TIMEOUT: estensione non connessa dopo 15s');
        wsBroadcast({ type: 'ai_response', text: '⚠️ L\'estensione Chrome COBRA non è connessa. Assicurati che:\n1. L\'estensione sia installata e attiva\n2. Hai una pagina web aperta\n3. Il bridge WebSocket sia connesso (icona estensione verde)\n\nRiprova dopo aver verificato.' });
        CobraSupervisor.completeRequest();
        return { ok: true, blocked: 'bridge_timeout' };
      }
    }

    if (intent === 'task') emitReasoning(`Scope attivati: [${routing.scopes.join(', ')}]`, '🔧');
    emitThinking(intent === 'task' ? 'Analizzo la richiesta...' : 'Elaboro...');
    const _chatStartTime = Date.now();

    // 5. Search KB
    try { session.kbSnippets = await searchKB(message); } catch { session.kbSnippets = []; }

    // 6. Assemble via Super Mario
    const lastToolResult = session.lastPage
      ? { url: session.lastPage.url, title: session.lastPage.title, snippet: (session.lastPage.markdown || '').substring(0, 500) }
      : (toolHistory.length > 0 ? toolHistory[toolHistory.length - 1] : null);
    const conversationHistory = chatMem ? chatMem.getAPIMessages() : [];
    const marioResult = await SuperMario.assemble({
      intent, scopes: routing.scopes, operationLevel: routing.operationLevel || 'read',
      userMessage: message, conversationHistory, lastToolResult, voiceMode, allTools: COBRA_TOOLS,
    });

    let systemPrompt = marioResult.systemPrompt;
    const useTools = marioResult.tools.length > 0 ? marioResult.tools : undefined;
    log(`[SuperMario] Assembled: ${marioResult.tools.length} tools, prompt=${systemPrompt.length} chars, preflight=${marioResult.preflight.ok ? 'OK' : 'WARN'}`);

    // SuperMario Pipeline Badge
    const marioAudit = {
      timestamp: new Date().toISOString(),
      message: message.substring(0, 200),
      routing: { intent, scopes: routing.scopes, operationLevel: routing.operationLevel || 'read', continued: routing.continued || false, llm_clarified: routing.llm_clarified || false },
      assembly: { toolCount: marioResult.tools.length, toolNames: marioResult.tools.map(t => t.function?.name || t.name).slice(0, 20), promptLength: systemPrompt.length, promptTokensEstimate: Math.ceil(systemPrompt.length / 4), preflightOk: marioResult.preflight.ok, preflightWarnings: marioResult.preflight.warnings || [], hasTaskPlan: !!taskPlan, taskPlanSteps: taskPlan ? taskPlan.steps.length : 0 },
      kbLoaded: session.kbSnippets.length,
    };
    wsBroadcast({ type: 'supermario_pipeline', intent, scopes: routing.scopes, operationLevel: routing.operationLevel || 'read', toolCount: marioResult.tools.length, promptTokens: marioAudit.assembly.promptTokensEstimate, preflightOk: marioResult.preflight.ok, preflightWarnings: marioResult.preflight.warnings || [], kbEntries: session.kbSnippets.length, llmClarified: routing.llm_clarified || false });

    // Save prompt audit
    try {
      const fs = require('fs'), path = require('path');
      const auditDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(path.join(auditDir, 'supermario_prompts.jsonl'), JSON.stringify(marioAudit) + '\n');
    } catch (_) { /* non-blocking */ }

    if (taskPlan) systemPrompt += '\n\n' + SuperMario.buildPlanPrompt(taskPlan);

    // 7. Get messages + repetition detection
    const msgs = chatMem ? chatMem.getAPIMessages() : [{ role: 'user', content: message }];
    const repetitionWarning = detectRepetition(msgs);
    if (repetitionWarning) { systemPrompt += '\n\n' + repetitionWarning; log('Repetition detected — injected warning'); }

    // 8. Select model + Call AI
    const modelSelection = SuperMario.selectModel(marioResult.scopes, taskPlan, message);
    log(`[SuperMario] Model tier: ${modelSelection.tier} (${modelSelection.reason})`);
    emitReasoning(`Modello: ${modelSelection.tier} — ${modelSelection.reason}`, '🧠');
    const result = await callAI(systemPrompt, msgs, useTools, modelSelection.tier);

    // 9. Store response
    conversationEngine.addMessage(conv.id, 'assistant', result.content);
    SuperMario.updateNarrativeSummary(conversationHistory, aiKeys).catch(e => log('[SuperMario] Summary update error: ' + e.message));
    if (taskPlan) SuperMario.savePlanTemplate(taskPlan);

    // 10. Post-flight audit
    const postflight = SuperMario.complete(marioResult, result, result.model || '', result.promptTokens || 0, result.completionTokens || 0, result.toolsUsed || []);
    if (postflight.warnings.length > 0) log(`[SuperMario] Post-flight issues: ${postflight.warnings.join(', ')}`);

    if (result.provider !== 'none') CobraSupervisor.completeRequest(result.content);
    else CobraSupervisor.failRequest(result.content);

    // 11. Record response
    ResponseRecorder.recordChat({
      userMessage: message, intent, systemPromptLength: systemPrompt.length,
      provider: result.provider, model: result.model || '', response: result.content,
      toolsUsed: result.toolsUsed || [], durationMs: Date.now() - _chatStartTime,
      kbEntries: (session.kbSnippets || []).length, repetitionDetected: !!repetitionWarning,
      marioScope: marioResult.scope, marioTraceId: marioResult.trace_id,
      taskPlanSteps: taskPlan ? taskPlan.steps.length : 0,
    });

    const meterStatus = TokenMeter.getStatus();
    wsBroadcast({ type: 'thinking', text: '' });
    wsBroadcast({ type: 'page_loaded', url: '', title: '' });

    // Autoapprendimento
    CobraPersonaLearner.onOperatorMessage(message).catch(err => log('[PersonaLearner] onOperatorMessage failed: ' + err.message));

    return { content: result.content, provider: result.provider, intent, tokens: meterStatus.totalTokens, tokenLevel: meterStatus.level };
  }

  return { handleChat };
};
