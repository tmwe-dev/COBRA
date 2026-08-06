// modules/routes/chat.js — /api/chat, /api/chat/abort, /api/chat/clear

const { Collega } = require('../collega/collega');
const { descriviCriterio } = require('../collega/incarico');
const { analizzaRisposta, rispostaOnesta, analizzaResa } = require('../security/fabrication-guard');

function register(router, ctx) {
  // ── /api/chat — main chat endpoint ──
  router.post('/api/chat', async (body, res) => {
    // Rete di sicurezza: qualunque sia il percorso di uscita, il client riceve
    // sempre una risposta entro il limite. Una richiesta appesa è indistinguibile
    // da un blocco totale dal punto di vista dell'utente.
    // Un confronto fra piu fonti con report finale richiede minuti, non secondi.
    // Questo non e un limite al lavoro ma una rete contro i blocchi totali.
    const MAX_TURN_MS = 900000;
    let _risposto = false;
    const _invia = (status, payload) => {
      if (_risposto) return;
      _risposto = true;
      clearTimeout(_watchdog);
      try {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch (e) { ctx.log(`[Chat] invio risposta fallito: ${e.message}`); }
    };
    const _watchdog = setTimeout(() => {
      ctx.log(`[Chat] TIMEOUT DI TURNO (${MAX_TURN_MS}ms) — risposta di emergenza`);
      try { ctx.CobraSupervisor.failRequest('timeout di turno'); } catch { /* best-effort */ }
      ctx.wsBroadcast({ type: 'thinking', text: '' });
      _invia(504, { content: 'La richiesta ha superato il tempo massimo ed è stata interrotta. Riprova, magari con una richiesta più circoscritta.', provider: 'timeout' });
    }, MAX_TURN_MS);
    if (_watchdog.unref) _watchdog.unref();

    try {
      const { message, voiceMode } = JSON.parse(body);
      if (!message) { _invia(400, { error: 'Nessun messaggio' }); return; }
      ctx.session.chatAborted = false;
      console.log('[TURN]', { sessionId: ctx.session.id, msg: message.substring(0, 60) });

      // Human takeover resume check
      if (ctx.session.humanTakeover && /\b(continu|riprendi|vai|ok|fatto|go|resume|done|prosegui)\b/i.test(message)) {
        ctx.log('[HumanTakeover] Operator resumed via chat message');
        ctx.session.humanTakeover = false;
        if (ctx.session.humanTakeoverResolve) { ctx.session.humanTakeoverResolve(); ctx.session.humanTakeoverResolve = null; }
        _invia(200, { ok: true, message: 'Controllo restituito a COBRA.' });
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
      ctx.session.pagineDelTurno = [];
      // La cache delle pagine vale per un turno solo: al turno dopo i prezzi
      // e le disponibilità possono essere cambiati, e servire dati vecchi
      // spacciandoli per letti adesso sarebbe peggio che rileggerli.
      ctx.session._cachePagine = new Map();
      // Stessa cosa per le ricerche: dentro un turno la stessa query dà gli
      // stessi risultati, e ripeterla è il modo in cui si finisce in loop.
      ctx.session._cacheRicerche = new Map();
      // I file prodotti nel turno servono al Collega per verificare il criterio
      // "file atteso": senza questa traccia, un report creato risulterebbe assente.
      ctx.session.fileDelTurno = [];
      ctx.session.righeUltimoFile = null;
      ctx._navDomainCount = {};

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
          // Va SEMPRE inviata una risposta HTTP: senza, il client resta appeso
          // fino al proprio timeout e l'utente non vede alcun errore.
          const avviso = 'Estensione Chrome non connessa: non posso usare il browser. Verifica che sia installata e attiva, poi riprova.';
          ctx.log('[Chat] Bridge non disponibile dopo 15s — richiesta conclusa con avviso');
          ctx.wsBroadcast({ type: 'ai_response', text: '⚠️ ' + avviso });
          ctx.wsBroadcast({ type: 'thinking', text: '' });
          ctx.CobraSupervisor.completeRequest();
          _invia(200, { content: avviso, provider: 'none', intent, bridgeMissing: true });
          return;
        }
      }

      if (intent === 'task') ctx.emitReasoning(`Scope: [${routing.scopes.join(', ')}]`, '🔧');
      ctx.emitThinking(intent === 'task' ? 'Analizzo la richiesta...' : 'Elaboro...');

      // ── 4b. IL COLLEGA ──
      //
      // Prima il messaggio andava dritto all'Esecutore e "fatto" era un
      // giudizio che il modello dava su se stesso. Adesso c'e' un primo
      // passaggio: qualcuno legge la richiesta, decide se serve davvero
      // lavorare, e se serve scrive cosa vorra' dire "completo" — in criteri
      // che verifica il codice, non lui.
      //
      // Se il Collega non e' disponibile o inciampa, si prosegue com'era:
      // questa parte puo' migliorare il lavoro, non deve poterlo impedire.
      let incaricoCorrente = null;
      let collega = null;
      let collegaPassaOltre = false;
      if (ctx.CollegaAttivo !== false) {
        try {
          collega = new Collega(
            async (sys, messaggi) => {
              // Il Collega e' il giudizio del sistema: capire il bisogno sotto
              // la frase, scegliere i criteri, proporre alternative quando la
              // richiesta esatta non esiste. Sono compiti da modello forte.
              // Con il modello piccolo usciva un assistente che eseguiva alla
              // lettera e non proponeva niente — la "poca intelligenza" non era
              // mancanza di regole, era mancanza di capacita'.
              const r = await ctx.callAI(sys, messaggi, undefined, { ...ctx, modelTier: 'power' });
              // Un fornitore caduto restituisce comunque una stringa
              // ("Errore AI: ..."): senza questo controllo quel testo veniva
              // consegnato all'utente come se fosse la risposta di un collega.
              if (!r || r.provider === 'error' || r.provider === 'none' || r.provider === 'budget_exceeded') {
                throw new Error(r?.content || 'nessuna risposta dal modello');
              }
              return r.content || '';
            },
            ctx.log
          );
          let memoria = ctx.learningStore ? (ctx.learningStore.buildRecallBlock(message) || '') : '';

          // Se al giro scorso il Collega ha chiesto qualcosa, il lavoro che
          // aveva preparato è ancora sul tavolo. Senza questo richiamo, un
          // "vai" o un "25.000" tornerebbero a un Collega smemorato, che
          // ricomincerebbe da capo — ed è esattamente il motivo per cui prima
          // non conveniva mai chiedere.
          const inSospeso = ctx.session.incaricoInSospeso;
          if (inSospeso && (Date.now() - inSospeso.quando) < 30 * 60 * 1000) {
            memoria += `\n\n# IL LAVORO CHE HAI GIÀ PREPARATO E NON È ANCORA PARTITO\n`
              + `Su richiesta di Luca: "${inSospeso.richiesta}"\n`
              + `Obiettivo che avevi scritto: ${inSospeso.obiettivo}\n`
              + `Gli avevi chiesto: ${inSospeso.domanda}\n`
              + `Se questo messaggio è la sua risposta — anche solo "vai", "ok", "procedi" o una cifra — `
              + `NON richiedere niente e NON ricominciare: rispondi con modo "incarico", `
              + `riprendendo quell'obiettivo con dentro quello che ti ha appena detto.`;
          } else if (inSospeso) {
            ctx.session.incaricoInSospeso = null;   // troppo vecchio: non è più quel discorso
          }

          const ascolto = await collega.ascolta(message, { memoria, storico: chatMem ? chatMem.getAPIMessages().slice(-6) : [] });

          if (ascolto.modo === 'passa_oltre') {
            // Il Collega non è riuscito a strutturare la risposta: il lavoro
            // prosegue per la via diretta invece di sparire in una chiacchiera.
            // Ma alla fine parla comunque LUI: senza questa voce, il risultato
            // arrivava crudo dall'officina — ed era la freddezza che l'utente
            // sentiva senza saperla nominare.
            collegaPassaOltre = true;
            ctx.log('[Collega] Passo oltre: la richiesta va all\'Esecutore senza incarico');
          } else if (ascolto.modo === 'proposta' && ascolto.risposta) {
            // Ha capito il lavoro, l'ha preparato, e prima di bruciare dieci
            // minuti chiede la cosa che cambia il risultato. Il lavoro resta
            // in sospeso: non si sveglia l'Esecutore, non si perde niente.
            ctx.session.incaricoInSospeso = {
              quando: Date.now(),
              richiesta: String(message || '').slice(0, 500),
              obiettivo: ascolto.incarico ? ascolto.incarico.obiettivo : '(non specificato)',
              domanda: ascolto.risposta.slice(0, 500),
            };
            ctx.log(`[Collega] Proposta in attesa di risposta: "${ctx.session.incaricoInSospeso.obiettivo}"`);
            if (chatMem) chatMem.addMessage('assistant', ascolto.risposta);
            ctx.conversationEngine.addMessage(conv.id, 'assistant', ascolto.risposta);
            ctx.CobraSupervisor.completeRequest(ascolto.risposta);
            _invia(200, { content: ascolto.risposta, provider: 'collega', intent, lingua: ascolto.lingua || 'it', inAttesa: true });
            ctx.wsBroadcast({ type: 'thinking', text: '' });
            return;
          } else if (ascolto.modo === 'conversazione' && ascolto.risposta) {
            // Il Collega se la cava da solo: non si sveglia l'Esecutore.
            // E' anche la ragione per cui due agenti non raddoppiano i costi.
            ctx.log('[Collega] Rispondo senza coinvolgere l\'Esecutore');
            if (chatMem) chatMem.addMessage('assistant', ascolto.risposta);
            ctx.conversationEngine.addMessage(conv.id, 'assistant', ascolto.risposta);
            ctx.CobraSupervisor.completeRequest(ascolto.risposta);
            _invia(200, { content: ascolto.risposta, provider: 'collega', intent, lingua: ascolto.lingua || 'it' });
            ctx.wsBroadcast({ type: 'thinking', text: '' });
            return;
          }

          if (ascolto.modo === 'incarico' && ascolto.incarico) {
            ctx.session.incaricoInSospeso = null;   // il lavoro parte: non è più in attesa
            incaricoCorrente = ascolto.incarico;
            ctx.log(`[Collega] Incarico: "${incaricoCorrente.obiettivo}" — ${incaricoCorrente.criteri.length} criteri`
              + (ascolto.senzaVerifica ? ' (NON verificabile)' : ''));
            ctx.wsBroadcast({
              type: 'incarico',
              obiettivo: incaricoCorrente.obiettivo,
              criteri: incaricoCorrente.criteri.map(c => descriviCriterio(c)),
              verificabile: !ascolto.senzaVerifica,
            });
            if (ascolto.risposta) ctx.emitReasoning(ascolto.risposta, '💬');
            ctx.session.linguaCorrente = ascolto.lingua || 'it';

            // ── L'incarico decide anche gli strumenti ──
            //
            // Non si può pretendere una fonte da chi non ha un browser.
            //
            // Successo davvero: "organizzami una vacanza a Bora Bora ... alla
            // fine preparami un file Excel" è stata classificata scopes=[file]
            // perché la parola "file" ha vinto sul resto. All'Esecutore sono
            // arrivati dieci strumenti, nessuno capace di navigare. Ha lavorato
            // a vuoto, e il criterio "ogni valore viene da una pagina aperta"
            // gli chiedeva l'impossibile: zero pagine aperte, due giri di
            // insistenza sprecati, e un file col solo intestazione.
            //
            // Se i criteri chiedono fonti, gli strumenti per procurarsele
            // devono esserci. Questo lo impone il codice, non il modello.
            // La regola non può dipendere da quali criteri il Collega ha
            // scelto: la prima volta ha messo "origine_verificabile" e la
            // seconda no, sulla STESSA richiesta, e nel secondo caso
            // l'Esecutore è rimasto di nuovo senza browser.
            //
            // Un incarico nasce solo quando c'è del lavoro da fare, e il
            // lavoro quasi sempre comincia guardando qualcosa. Gli strumenti
            // di ricerca ci sono sempre, tranne quando l'obiettivo parla
            // apertamente solo di file già presenti sul computer. Averli non
            // obbliga a usarli; non averli rende impossibile riuscire.
            //
            // L'eccezione "solo file locali" guarda le PAROLE dell'obiettivo,
            // e le parole sbagliano: "Preparare un documento con le tariffe
            // dei corrieri" contiene "documento" e nessuna delle parole di
            // ricerca, quindi passerebbe per un lavoro da fare senza browser —
            // mentre le tariffe stanno su internet. Se poi il Collega ha messo
            // origine_verificabile, all'Esecutore si chiede una fonte e gli si
            // suggerisce di aprire le pagine con navigate(), che non ha.
            //
            // I criteri battono le parole: se si pretende una fonte, il
            // browser serve, punto. È lo stesso principio scritto qui sopra.
            const pretendeFonti = (incaricoCorrente.criteri || [])
              .some(c => c.tipo === 'origine_verificabile');
            const soloFileLocali = !pretendeFonti
              && /\b(file|cartella|documento|foglio)\b/i.test(incaricoCorrente.obiettivo)
              && !/\b(cerca|trova|voli|hotel|prezz|aziend|fornitor|escursion|confront|verific|leggi (su|il sito))/i.test(incaricoCorrente.obiettivo);
            if (!soloFileLocali) {
              const mancanti = ['search', 'browse'].filter(s => !routing.scopes.includes(s));
              if (mancanti.length) {
                routing.scopes.push(...mancanti);
                ctx.log(`[Collega] L'incarico richiede di cercare ma mancavano gli strumenti: `
                  + `aggiunti gli ambiti [${mancanti.join(', ')}] (erano [${routing.scopes.filter(s => !mancanti.includes(s)).join(', ')}])`);
                ctx.emitReasoning('Mi servono gli strumenti di ricerca per questo incarico', '🔎');
              }
            }

            // ── Chi deve consegnare un file deve avere di che scriverlo ──
            //
            // Verificato dal vivo il 6 agosto, richiesta Tokyo. Il Collega
            // aveva messo il criterio { file_atteso: "html" }, ma all'Esecutore
            // sono arrivati 19 strumenti fra cui NESSUNO capace di scrivere un
            // file: crea_report e create_file stanno negli ambiti "data" e
            // "file", che non erano attivi.
            //
            // Il seguito, riga per riga nel log: due insistenze e un cambio di
            // strada, tutti con la stessa frase — "manca il file .html
            // richiesto" — ripetuta a un modello che non aveva modo di
            // produrlo. Tre giri di lavoro spesi a chiedere l'impossibile.
            //
            // Come per la ricerca: il criterio decide gli strumenti. Se si
            // promette un documento, gli strumenti per scriverlo ci sono.
            const vuoleUnFile = (incaricoCorrente.criteri || []).some(c => c.tipo === 'file_atteso');
            if (vuoleUnFile && !routing.scopes.includes('file')) {
              routing.scopes.push('file');
              ctx.log('[Collega] L\'incarico promette un file ma mancavano gli strumenti per scriverlo: '
                + 'aggiunto l\'ambito [file]');
              ctx.emitReasoning('Mi serve di che scrivere il documento', '📝');
            }
          }
        } catch (e) {
          ctx.log(`[Collega] Passaggio saltato (${e.message}): procedo com'era`);
          incaricoCorrente = null;
        }
      }

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

      // Richiamo dei fatti appresi nelle sessioni precedenti, pertinenti a questo messaggio
      if (ctx.learningStore) {
        try {
          const recall = ctx.learningStore.buildRecallBlock(message);
          if (recall) {
            systemPrompt += '\n\n' + recall;
            ctx.log(`[Apprendimento] richiamati fatti pertinenti (${ctx.learningStore.facts.length} in archivio)`);
          }
        } catch (e) { ctx.log(`[Apprendimento] richiamo fallito: ${e.message}`); }
      }

      // L'incarico entra nel prompt dell'Esecutore: obiettivo, criteri, vincoli
      // e cosa NON fare. E' il contratto fra i due, e dice apertamente che a
      // verificare i criteri sara' il codice.
      if (incaricoCorrente) systemPrompt += '\n\n' + incaricoCorrente.perIlPrompt();
      // Quello che l'esperienza ha gia' insegnato sulle fonti entra nel
      // prompt: non si riscopre a spese del tempo di Luca.
      if (ctx.registroFonti) {
        const blocco = ctx.registroFonti.perIlPrompt();
        if (blocco) systemPrompt += '\n\n' + blocco;
      }

      // Prompt audit
      ctx.auditPrompt(message, routing, marioResult, taskPlan, ctx.session.kbSnippets);
      if (taskPlan) systemPrompt += '\n\n' + ctx.SuperMario.buildPlanPrompt(taskPlan);

      // 7. Messages + repetition
      const msgs = chatMem ? chatMem.getAPIMessages() : [{ role: 'user', content: message }];
      const repetitionWarning = ctx.detectRepetition(msgs);
      if (repetitionWarning) { systemPrompt += '\n\n' + repetitionWarning; ctx.log('Repetition detected'); }

      // 8. AI call
      const modelSelection = ctx.SuperMario.selectModel(marioResult.scopes, taskPlan, message, ctx.session);

      // ── Il modello lo decide il LAVORO, non la lunghezza del messaggio ──
      //
      // Verificato dal vivo il 6 agosto: alla domanda del Collega, Luca ha
      // risposto "25.000 in tutto, 4 doppie, date fisse. Vai." — un messaggio
      // corto, senza parole come "report" o "confronta". Il modello è stato
      // scelto su QUEL testo: tier standard, cioè gpt-4o-mini. Poi al piccolo
      // è stato chiesto di coprire due soggetti, verificare le fonti e
      // produrre un report impaginato. Ha girato in tondo — stessa ricerca
      // quattro volte — e il Supervisore ha dovuto fermarlo due volte.
      //
      // L'incarico dice quanto è difficile il lavoro molto meglio della frase
      // che l'ha innescato: un "Vai." di quattro lettere può valere mezz'ora
      // di ricerche. Stessa logica con cui, poco sopra, gli strumenti vengono
      // aggiunti in base ai criteri e non in base alle parole usate.
      if (incaricoCorrente && modelSelection.tier !== 'power') {
        const criteri = incaricoCorrente.criteri || [];
        const impegnativo = criteri.length >= 3
          || criteri.some(c => ['origine_verificabile', 'file_atteso', 'soggetti_coperti'].includes(c.tipo));
        if (impegnativo) {
          ctx.log(`[Modello] Il messaggio sembrava semplice (${modelSelection.tier}), ma l'incarico chiede `
            + `${criteri.length} criteri: passo al modello forte`);
          modelSelection.tier = 'power';
          modelSelection.reason = `incarico con ${criteri.length} criteri`;
        }
      }

      ctx.emitReasoning(`Modello: ${modelSelection.tier}`, '🧠');
      const _chatStart = Date.now();
      let result = await ctx.callAI(systemPrompt, msgs, useTools, { ...ctx, modelTier: modelSelection.tier });

      // ── 8a. IL COLLEGA GIUDICA ──
      //
      // Il verdetto non lo da' chi ha fatto il lavoro. I criteri li confronta
      // il codice col risultato, e se manca qualcosa l'Esecutore torna indietro
      // sapendo ESATTAMENTE cosa: prima l'insistenza era una spinta cieca
      // ("prova un'altra strada") data a chi non sapeva cosa mancasse.
      let valutazioneFinale = null;
      let insistenzeEsaurite = false;
      if (collega && incaricoCorrente) {
        let insistenze = 0;
        let mancanzePrecedenti = null;   // per capire se un tentativo ha spostato qualcosa
        let stradeCambiate = 0;
        for (;;) {
          const esito = {
            testo: result.content || '',
            righe: (ctx.session.righeUltimoFile || null),
            file: ctx.session.fileDelTurno || [],
            pagine: ctx.session.pagineDelTurno || [],
          };
          const giudizio = collega.giudica(incaricoCorrente, esito, ctx.session, insistenze,
            mancanzePrecedenti, stradeCambiate);
          valutazioneFinale = giudizio.valutazione;

          if (giudizio.decisione === 'consegna') {
            insistenzeEsaurite = !!giudizio.esaurite;
            if (valutazioneFinale) {
              ctx.log(`[Collega] Verdetto: ${valutazioneFinale.soddisfatti}/${valutazioneFinale.totale} criteri`
                + (valutazioneFinale.soddisfatto ? '' : ` — mancano: ${valutazioneFinale.mancanze.join('; ')}`));

              // ── Due giudici non possono dare verdetti opposti ──
              //
              // Il motore dei passi e i criteri dell'incarico sono nati in
              // momenti diversi e non si conoscono. E' successo davvero: il
              // pannello mostrava "1/3 · interrotto" con il passo 1 in rosso,
              // mentre i criteri erano soddisfatti 3 su 3 e la risposta
              // conteneva i tre voli giusti, verificati a mano.
              //
              // L'utente vedeva il giudizio pessimista accanto a un lavoro
              // riuscito, e non aveva modo di sapere quale dei due credere.
              //
              // I criteri sono la definizione di "fatto" concordata prima di
              // cominciare: quella comanda. I passi restano un modo di
              // organizzare il lavoro, non un secondo verdetto.
              const proc = ctx.session.processo;
              if (proc && valutazioneFinale.soddisfatto && (proc.interrotto() || !proc.concluso())) {
                ctx.log('[Collega] Il motore dei passi dice interrotto ma i criteri sono soddisfatti: '
                  + 'comanda l\'incarico, allineo quello che vedi');
                ctx.wsBroadcast({
                  type: 'processo',
                  ...proc.riepilogo(),
                  concluso: true,
                  interrotto: false,
                  esitoCriteri: `${valutazioneFinale.soddisfatti}/${valutazioneFinale.totale} criteri soddisfatti`,
                  nota: 'Alcuni passi non sono stati chiusi uno per uno, ma il risultato rispetta '
                    + 'tutto quello che era stato chiesto.',
                });
              }
            }
            break;
          }

          // ── La strada non porta: se ne cerca un'altra ──
          //
          // Prima qui c'era solo "insisti": stessa richiesta, tono più duro.
          // Quando la cosa chiesta non era ottenibile — prezzi che il sito
          // mostra solo dopo il login, un hotel che a quelle date non esiste —
          // insistere produceva due giri identici e una consegna monca.
          if (giudizio.decisione === 'cambia_strada') {
            stradeCambiate++;
            ctx.log(`[Collega] Cambio strada (${stradeCambiate}): ${valutazioneFinale.mancanze.join('; ')}`);
            const altra = await collega.ripensa(incaricoCorrente, valutazioneFinale, esito);
            if (!altra) { insistenzeEsaurite = true; break; }
            ctx.log(`[Collega] Nuova strada: ${altra.obiettivo}`);
            if (altra.avviso) ctx.emitReasoning(altra.avviso, '🧭');
            ctx.wsBroadcast({
              type: 'cambio_strada',
              obiettivo: altra.obiettivo,
              avviso: altra.avviso,
              mancavano: valutazioneFinale.mancanze,
            });
            mancanzePrecedenti = valutazioneFinale.mancanze.slice();
            try {
              const ripresa = await ctx.callAI(
                systemPrompt + '\n\n# CAMBIO DI STRADA DECISO DAL COLLEGA\n' + altra.istruzione,
                [...msgs, { role: 'assistant', content: result.content },
                 { role: 'user', content: altra.istruzione }],
                useTools, { ...ctx, modelTier: modelSelection.tier }
              );
              if (!ripresa?.content) { insistenzeEsaurite = true; break; }
              result = { ...ripresa, toolsUsed: [...(result.toolsUsed || []), ...(ripresa.toolsUsed || [])] };
            } catch (e) {
              ctx.log(`[Collega] Anche l'altra strada è fallita: ${e.message}`);
              insistenzeEsaurite = true;
              break;
            }
            continue;
          }

          insistenze++;
          mancanzePrecedenti = valutazioneFinale.mancanze.slice();
          ctx.log(`[Collega] Insisto (${insistenze}/2): ${valutazioneFinale.mancanze.join('; ')}`);
          ctx.emitReasoning(`Non è completo: ${valutazioneFinale.mancanze[0]}`, '🔁');
          ctx.wsBroadcast({
            type: 'verdetto',
            soddisfatti: valutazioneFinale.soddisfatti,
            totale: valutazioneFinale.totale,
            mancanze: valutazioneFinale.mancanze,
            insistenza: insistenze,
          });
          try {
            const ripresa = await ctx.callAI(
              systemPrompt + '\n\n# NOTA DEL COLLEGA\n' + giudizio.istruzione,
              [...msgs, { role: 'assistant', content: result.content },
               { role: 'user', content: giudizio.istruzione }],
              useTools, { ...ctx, modelTier: modelSelection.tier }
            );
            if (!ripresa?.content) { insistenzeEsaurite = true; break; }
            result = {
              ...ripresa,
              toolsUsed: [...(result.toolsUsed || []), ...(ripresa.toolsUsed || [])],
            };
          } catch (e) {
            ctx.log(`[Collega] Ripresa fallita: ${e.message}`);
            insistenzeEsaurite = true;
            break;
          }
        }
      }

      // 8b. Guardia anti-invenzione.
      // Un prezzo inventato è peggio di un "non lo so": chi legge non ha modo
      // di distinguerlo da uno vero. Se la risposta contiene dati concreti ma
      // nessuna fonte è stata consultata, si sostituisce con una dichiarazione
      // onesta invece di lasciar passare il dato falso.
      const verifica = analizzaRisposta(result.content, {
        intent,
        toolsUsed: result.toolsUsed || [],
        kbSnippets: ctx.session.kbSnippets || [],
        hasPageContent: !!ctx.session.lastPage?.markdown,
      });
      if (verifica.sospetta) {
        ctx.log(`[AntiInvenzione] ${verifica.gravita}: ${verifica.motivi.join('; ')}`);
        ctx.wsBroadcast({ type: 'ai_reasoning', text: `Risposta trattenuta: ${verifica.motivi.join('; ')}`, icon: '🛑' });
        if (verifica.gravita === 'invenzione') {
          result.content = rispostaOnesta(verifica.gravita, verifica.motivi);
          result.fabricationBlocked = true;
        }
      }

      // 8c. Insistenza. Se si è arreso dopo pochi tentativi, non si consegna la
      // resa all'utente: gli si fa notare e gli si dà una seconda occasione,
      // com'è normale per chi ha preso un incarico e deve portarlo a termine.
      const resa = analizzaResa(result.content, { toolsUsed: result.toolsUsed || [] });
      if (resa.resa && !result.fabricationBlocked) {
        ctx.log(`[Insistenza] ${resa.suggerimento}`);
        ctx.emitReasoning('Non mi accontento: provo un\'altra strada.', '🔁');
        try {
          const secondoTentativo = await ctx.callAI(
            systemPrompt + '\n\n# NOTA DEL SUPERVISORE\n'
              + `Ti sei fermato dopo ${resa.tentativi} tentativi dicendo di non farcela. `
              + 'Non è sufficiente: prova una strada diversa da quella che ha fallito — un altro sito, '
              + 'un URL diretto ai risultati, uno screenshot seguito da una rilettura. '
              + 'Se anche così non ottieni il dato, spiega ESATTAMENTE cosa hai provato e cosa ha impedito di ottenerlo.',
            [...msgs, { role: 'assistant', content: result.content },
             { role: 'user', content: 'Non ti fermare qui: prova un\'altra strada e poi dimmi cosa hai trovato.' }],
            useTools, { ...ctx, modelTier: modelSelection.tier }
          );
          if (secondoTentativo?.content && (secondoTentativo.toolsUsed || []).length > 0) {
            ctx.log(`[Insistenza] Secondo tentativo: ${secondoTentativo.toolsUsed.length} strumenti usati`);
            result.content = secondoTentativo.content;
            result.toolsUsed = [...(result.toolsUsed || []), ...(secondoTentativo.toolsUsed || [])];
            result.secondoTentativo = true;
          }
        } catch (e) { ctx.log(`[Insistenza] Secondo tentativo fallito: ${e.message}`); }
      }

      // 9. Store + post-processing
      ctx.conversationEngine.addMessage(conv.id, 'assistant', result.content);
      ctx.SuperMario.updateNarrativeSummary(conversationHistory, ctx.aiKeys).catch(() => {});
      // Apprendimento in sottofondo: non deve ritardare la risposta all'utente
      if (ctx.learningStore) {
        const storico = [...conversationHistory, { role: 'user', content: message }];
        ctx.learningStore.extractFromConversation(storico, ctx.aiKeys, ctx.log).catch(() => {});
      }
      if (taskPlan) ctx.SuperMario.savePlanTemplate(taskPlan);

      // 10. Post-flight
      const postflight = ctx.SuperMario.complete(marioResult, result, result.model || '', result.promptTokens || 0, result.completionTokens || 0, result.toolsUsed || []);
      if (postflight.warnings.length > 0) ctx.log(`[SuperMario] Post-flight: ${postflight.warnings.join(', ')}`);
      if (result.provider !== 'none') ctx.CobraSupervisor.completeRequest(result.content);
      else ctx.CobraSupervisor.failRequest(result.content);

      // 11. Record
      ctx.ResponseRecorder.recordChat({ userMessage: message, intent, systemPromptLength: systemPrompt.length, provider: result.provider, model: result.model || '', response: result.content, toolsUsed: result.toolsUsed || [], durationMs: Date.now() - _chatStart, kbEntries: (ctx.session.kbSnippets || []).length, repetitionDetected: !!repetitionWarning, marioScope: marioResult.scope, marioTraceId: marioResult.trace_id, taskPlanSteps: taskPlan ? taskPlan.steps.length : 0 });

      // Le pagine consultate diventano collegamenti: da lì l'utente prosegue
      // per conto suo, per esempio per completare una prenotazione.
      const consultate = ctx.session.pagineDelTurno || [];
      if (consultate.length > 0) {
        ctx.wsBroadcast({ type: 'pagine_consultate', pagine: consultate.slice(0, 12) });
      }

      // ── 11b. IL COLLEGA RACCONTA ──
      // Non e' un riassunto di cortesia: e' il momento in cui quello che e'
      // successo torna in parole, con il verdetto gia' deciso alle spalle.
      let linguaRisposta = ctx.session.linguaCorrente || 'it';
      if (collega && (incaricoCorrente || collegaPassaOltre)) {
        try {
          const commento = await collega.commenta(incaricoCorrente, valutazioneFinale, {
            testo: result.content || '',
            file: ctx.session.fileDelTurno || [],
            pagine: ctx.session.pagineDelTurno || [],
          }, { memoria: '', esaurite: insistenzeEsaurite });
          if (commento.risposta) {
            result.content = commento.proposta
              ? `${commento.risposta}\n\n${commento.proposta}`
              : commento.risposta;
            linguaRisposta = commento.lingua || linguaRisposta;
          }
        } catch (e) {
          ctx.log(`[Collega] Commento non riuscito (${e.message}): consegno il risultato grezzo`);
        }
      }

      const meterStatus = ctx.TokenMeter.getStatus();
      _invia(200, {
        content: result.content, provider: result.provider, intent,
        tokens: meterStatus.totalTokens, tokenLevel: meterStatus.level,
        lingua: linguaRisposta,
        verdetto: valutazioneFinale
          ? { soddisfatti: valutazioneFinale.soddisfatti, totale: valutazioneFinale.totale, mancanze: valutazioneFinale.mancanze }
          : null,
      });
      ctx.wsBroadcast({ type: 'thinking', text: '' });
      ctx.wsBroadcast({ type: 'page_loaded', url: '', title: '' });
    } catch (e) {
      ctx.log('Chat error: ' + e.message);
      ctx.CobraSupervisor.failRequest(e.message);
      _invia(500, { content: 'Errore server: ' + e.message, provider: 'none' });
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
