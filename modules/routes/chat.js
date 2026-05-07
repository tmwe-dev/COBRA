// modules/routes/chat.js — /api/chat, /api/chat/abort, /api/chat/clear
// Source: server.js lines 7984-8307 (SuperMario pipeline)

function register(router, ctx) {
  // ── /api/chat — main chat endpoint ──
  router.post('/api/chat', async (body, res) => {
    try {
      const { message, voiceMode } = JSON.parse(body);
      if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'No message' })); return; }
      ctx.session.chatAborted = false;
      console.log('[TURN]', { sessionId: ctx.session.id, msg: message.substring(0, 60) });

      // Human takeover resume check
      if (ctx.session.humanTakeover && /\b(continu|riprendi|vai|ok|fatto|go|resume|done|prosegui)\b/i.test(message)) {
        ctx.log('[HumanTakeover] Operator resumed via chat message');
        ctx.session.humanTakeover = false;
        if (ctx.session.humanTakeoverResolve) { ctx.session.humanTakeoverResolve(); ctx.session.humanTakeoverResolve = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Controllo restituito a COBRA.' }));
        ctx.wsBroadcast({ type: 'human_takeover_ended', ts: Date.now() });
        ctx.wsBroadcast({ type: 'ai_response', text: 'Perfetto, riprendo il controllo. Analizzo lo stato attuale della pagina...' });
        return;
      }

      // Auto-approve pending actions on confirmation
      const _confirmPattern = /^(s[iì]|ok|invia|conferma|vai|procedi|fallo|send|yes|do it|go ahead)[\s.!]*$/i;
      const activePending = ctx.getActivePendingActions('default');
      if (activePending.length > 0 && _confirmPattern.test(message.trim())) {
        const pending = activePending[activePending.length - 1];
        const result = ctx.approvePendingAction(pending.id, 'operator');
        if (result.ok) {
          ctx.session.currentApprovalToken = result.approval_token;
          ctx.log(`[Security] Pending action ${pending.id} AUTO-APPROVED via chat`);
          ctx.wsBroadcast({ type: 'pending_action_approved', id: pending.id, approval_token: result.approval_token });
          ctx.wsBroadcast({ type: 'ai_reasoning', text: `✅ Azione confermata: ${pending.summary}`, icon: '🔓' });
        }
      }

      // 1. Supervisor start
      ctx.CobraSupervisor.startRequest(null, message);

      // 2-3. Conversation + ChatMemory
      const conv = ctx.conversationEngine.getOrCreateActive('Chat');
      ctx.conversationEngine.addMessage(conv.id, 'user', message);
      const chatMem = ctx.conversationEngine.chatMemories.get(conv.id);

      // 4. SuperMario pipeline — route intent
      let routing = ctx.SuperMario.routeIntent(message);
      const realScopes = (routing.scopes || []).filter(s => s !== 'interact');
      if (realScopes.length >= 3 && !realScopes.includes('browse')) {
        try {
          const clarified = await ctx.SuperMario.clarifyIntentWithLLM(message, routing, ctx.aiKeys);
          if (clarified?.llm_clarified) {
            if (routing.scopes.includes('browse') && !clarified.scopes.includes('browse')) clarified.scopes.push('browse');
            ctx.log(`[SuperMario] LLM disambiguated: ${routing.scopes.join(',')} → ${clarified.scopes.join(',')}`);
            routing = clarified;
          }
        } catch (e) { ctx.log(`[SuperMario] LLM clarify failed: ${e.message}`); }
      }
      const intent = routing.intent;
      const opLevel = routing.operationLevel || 'read';
      ctx.session.currentOperationLevel = opLevel;
      ctx.log(`Chat: "${message.substring(0, 50)}" → ${intent} scopes=[${routing.scopes.join(',')}] opLevel=${opLevel}`);
      ctx.wsBroadcast({ type: 'clear_activity' });
      ctx.emitReasoning(`L'utente chiede: "${message.length > 80 ? message.substring(0, 80) + '...' : message}"`, '💬');

      // Pre-routing: whitelist + booking downgrade
      if (!routing.continued && (opLevel === 'write' || opLevel === 'prepare') && routing.scopes.includes('browse')) {
        if (/\b(prenota|book|reserv|bigliett|prenotazione|hotel|albergo|treno|traghett|noleggi|affit|volo|voli|flight|check.?in)\b/i.test(message.toLowerCase())) {
          routing.operationLevel = 'read';
          routing.scopes = routing.scopes.filter(s => s !== 'interact');
          ctx.emitReasoning('Richiesta booking → modalità lettura', '📖');
        }
        const currentUrl = ctx.session.lastPage?.url;
        if (currentUrl && !ctx.isDomainWhitelisted(currentUrl)) {
          routing.operationLevel = 'read';
          routing.scopes = routing.scopes.filter(s => s !== 'interact');
        }
      }

      // 4b. Decompose multi-step
      const taskPlan = ctx.SuperMario.decompose(message, routing.scopes);
      if (taskPlan) {
        ctx.emitReasoning(`Piano multi-step: ${taskPlan.steps.length} step`, '📋');
        for (const step of taskPlan.steps) { for (const s of step.scopes) { if (!routing.scopes.includes(s)) routing.scopes.push(s); } }
      }

      // Bridge wait
      const BROWSER_SCOPES = ['browse', 'interact', 'search', 'navigate'];
      if (routing.scopes.some(s => BROWSER_SCOPES.includes(s)) && !ctx.isBridgeReady()) {
        ctx.emitThinking('Connessione al browser in corso...');
        const start = Date.now();
        while (!ctx.isBridgeReady() && (Date.now() - start) < 15000) await new Promise(r => setTimeout(r, 250));
        if (!ctx.isBridgeReady()) {
          ctx.wsBroadcast({ type: 'ai_response', text: '⚠️ Estensione Chrome non connessa. Verifica installazione e riprova.' });
          ctx.CobraSupervisor.completeRequest();
          return;
        }
      }

      if (intent === 'task') ctx.emitReasoning(`Scope: [${routing.scopes.join(', ')}]`, '🔧');
      ctx.emitThinking(intent === 'task' ? 'Analizzo la richiesta...' : 'Elaboro...');

      // 5. KB search
      try { ctx.session.kbSnippets = await ctx.searchKB(message); } catch { ctx.session.kbSnippets = []; }

      // 6. SuperMario assemble
      const lastToolResult = ctx.session.lastPage
        ? { url: ctx.session.lastPage.url, title: ctx.session.lastPage.title, snippet: (ctx.session.lastPage.markdown || '').substring(0, 500) }
        : (ctx.toolHistory.length > 0 ? ctx.toolHistory[ctx.toolHistory.length - 1] : null);
      const conversationHistory = chatMem ? chatMem.getAPIMessages() : [];
      const marioResult = await ctx.SuperMario.assemble({ intent, scopes: routing.scopes, operationLevel: routing.operationLevel || 'read', userMessage: message, conversationHistory, lastToolResult, voiceMode, allTools: ctx.COBRA_TOOLS });
      let systemPrompt = marioResult.systemPrompt;
      const useTools = marioResult.tools.length > 0 ? marioResult.tools : undefined;
      ctx.log(`[SuperMario] Assembled: ${marioResult.tools.length} tools, prompt=${systemPrompt.length} chars`);

      // Prompt audit
      ctx.auditPrompt(message, routing, marioResult, taskPlan, ctx.session.kbSnippets);
      if (taskPlan) systemPrompt += '\n\n' + ctx.SuperMario.buildPlanPrompt(taskPlan);

      // 7. Messages + repetition
      const msgs = chatMem ? chatMem.getAPIMessages() : [{ role: 'user', content: message }];
      const repetitionWarning = ctx.detectRepetition(msgs);
      if (repetitionWarning) { systemPrompt += '\n\n' + repetitionWarning; ctx.log('Repetition detected'); }

      // 8. AI call
      const modelSelection = ctx.SuperMario.selectModel(marioResult.scopes, taskPlan, message);
      ctx.emitReasoning(`Modello: ${modelSelection.tier}`, '🧠');
      const _chatStart = Date.now();
      const result = await ctx.callAI(systemPrompt, msgs, useTools, modelSelection.tier);

      // 9. Store + post-processing
      ctx.conversationEngine.addMessage(conv.id, 'assistant', result.content);
      ctx.SuperMario.updateNarrativeSummary(conversationHistory, ctx.aiKeys).catch(() => {});
      if (taskPlan) ctx.SuperMario.savePlanTemplate(taskPlan);

      // 10. Post-flight
      const postflight = ctx.SuperMario.complete(marioResult, result, result.model || '', result.promptTokens || 0, result.completionTokens || 0, result.toolsUsed || []);
      if (postflight.warnings.length > 0) ctx.log(`[SuperMario] Post-flight: ${postflight.warnings.join(', ')}`);
      if (result.provider !== 'none') ctx.CobraSupervisor.completeRequest(result.content);
      else ctx.CobraSupervisor.failRequest(result.content);

      // 11. Record
      ctx.ResponseRecorder.recordChat({ userMessage: message, intent, systemPromptLength: systemPrompt.length, provider: result.provider, model: result.model || '', response: result.content, toolsUsed: result.toolsUsed || [], durationMs: Date.now() - _chatStart, kbEntries: (ctx.session.kbSnippets || []).length, repetitionDetected: !!repetitionWarning, marioScope: marioResult.scope, marioTraceId: marioResult.trace_id, taskPlanSteps: taskPlan ? taskPlan.steps.length : 0 });

      const meterStatus = ctx.TokenMeter.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: result.content, provider: result.provider, intent, tokens: meterStatus.totalTokens, tokenLevel: meterStatus.level }));
      ctx.wsBroadcast({ type: 'thinking', text: '' });
      ctx.wsBroadcast({ type: 'page_loaded', url: '', title: '' });
    } catch (e) {
      ctx.log('Chat error: ' + e.message);
      ctx.CobraSupervisor.failRequest(e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: 'Errore server: ' + e.message, provider: 'none' }));
      ctx.wsBroadcast({ type: 'thinking', text: '' });
      ctx.wsBroadcast({ type: 'page_loaded', url: '', title: '' });
    }
  });

  // ── /api/chat/abort ──
  router.post('/api/chat/abort', (body, res) => {
    ctx.session.chatAborted = true;
    ctx.CobraSupervisor.abort();
    ctx.wsBroadcast({ type: 'chat_aborted' });
    ctx.log('[Chat] Abort requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  // ── /api/chat/clear ──
  router.post('/api/chat/clear', (body, res) => {
    try {
      const oldConv = ctx.conversationEngine.getActiveConversation();
      if (oldConv) { const m = ctx.conversationEngine.chatMemories.get(oldConv.id); if (m) m.clear(); }
      const newConv = ctx.conversationEngine.createConversation('Nuova Chat');
      ctx.conversationEngine.activeConversationId = newConv.id;
      ctx.session.lastPage = null;
      ctx.toolHistory.length = 0;
      ctx.session.kbSnippets = [];
    } catch (e) { ctx.log(`[Chat] Clear error: ${e.message}`); }
    if (ctx.SuperMario.clearSummaryCache) ctx.SuperMario.clearSummaryCache();
    ctx.log('[Chat] Conversation cleared');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

module.exports = { register };
