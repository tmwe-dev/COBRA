// modules/routes/chat.js — /api/chat, /api/chat/abort, /api/chat/clear

const { Collega } = require('../collega/collega');
const { Cantiere } = require('../collega/cantiere');
const { ArchivioCantieri } = require('../collega/cantiere-archivio');
const { ordineDiLavoro, inChiaro, domandaPerLaConoscenza } = require('../collega/comando');
const { tiraLezioni } = require('../memory/tira-lezioni');
const { descriviCriterio } = require('../collega/incarico');
const { analizzaRisposta, rispostaOnesta, analizzaResa } = require('../security/fabrication-guard');
// L'unica porta per dire "fatto": vale per il turno di chat come per un job.
const { decidi: decidiCompletamento } = require('../collega/completamento');
// Il Supervisore: guarda il lavoro su disco e dice se va ripreso. Codice, non AI.
const supervisore = require('../collega/ripresa');

// Quello che è già sul tavolo, da mettere davanti al modello a ogni ripresa.
//
// È il pezzo che fa la differenza fra insistere e ricominciare: senza, la
// nota del Collega dice "manca questo" a qualcuno che non ricorda più cosa
// aveva già fatto, e che quindi rifà tutto da capo. Con otto soggetti da
// raccogliere, rifare da capo significa non arrivare mai in fondo.
const fs = require('fs');
const path = require('path');

function _bloccoCantiere(ctx) {
  const c = ctx.session && ctx.session.cantiere;
  if (!c) return '';
  const blocco = c.perIlPrompt();
  return blocco ? '\n\n' + blocco : '';
}

// ── La contabilita' della ricerca, davanti agli occhi ──
//
// Trentuno ricerche di voli in cinque giorni, e nessuna che sapesse cosa
// avevano trovato le trenta precedenti. Il modello ripeteva le stesse domande
// perche' non aveva modo di sapere di averle gia' fatte: quando il contesto si
// riempie, la prima cosa che esce e' proprio la contabilita'.
//
// Qui non si chiede al modello di ricordare. Si scrive: cosa hai gia' chiesto,
// quali domini non hanno mai reso, cosa manca ancora, e la ricerca che
// chiuderebbe una di quelle lacune.
//
// Sta accanto al Cantiere e non altrove perche' sono la stessa cosa vista da
// due lati: il Cantiere dice cosa HAI, questo dice cosa MANCA e dove cercarlo.
function _bloccoRicerca(ctx) {
  const i = ctx.session && ctx.session.indagine;
  const c = ctx.session && ctx.session.cantiere;
  if (!i || !c) return '';
  try {
    const blocco = i.perIlPrompt(c, ctx.session._soggettiAttesi || [],
      (c.campiAttesi || []), ctx.session._contestoRicerca || '');
    return blocco ? '\n\n' + blocco : '';
  } catch (_) { return ''; }
}

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
      // Il cantiere NON si butta a fine turno: un lavoro da otto soggetti non
      // sta in un turno, e ributtarlo ogni volta significa non finirlo mai.
      // Si riapre quello lasciato a metà, se si sta ancora parlando della
      // stessa cosa; altrimenti lo si chiude e se ne apre uno nuovo.
      if (!ctx._archivioCantieri) ctx._archivioCantieri = new ArchivioCantieri(ctx.dataDir);
      ctx._ordineDiLavoro = null;   // nasce dall'incarico, se ci sarà un incarico
      ctx.session._letturePerLezioni = [];
      ctx.session._ostacoliPerLezioni = [];
      ctx._navDomainCount = {};

      // 2-3. Conversation + ChatMemory
      const conv = ctx.conversationEngine.getOrCreateActive('Chat');
      ctx.conversationEngine.addMessage(conv.id, 'user', message);
      const chatMem = ctx.conversationEngine.chatMemories.get(conv.id);

      // 3-bis. IL SUPERVISORE — c'e' un lavoro rimasto a meta'?
      //
      // Adesso il lavoro sopravvive al turno. Ma sopravvivere non basta:
      // finora la ripresa dipendeva da Luca, che doveva riscrivere la
      // richiesta — e riscrivendola otteneva un incarico nuovo, un piano
      // nuovo, e un modello che ricominciava. Il lavoro c'era su disco e non
      // lo guardava nessuno.
      //
      // Questo controllo e' deterministico: nessun modello viene interpellato.
      // Un supervisore che chiedesse a un'AI se il lavoro e' finito avrebbe lo
      // stesso difetto che stiamo curando — direbbe di si'.
      //
      // Va PRIMA del Collega, perche' se il lavoro va ripreso non c'e' niente
      // da reinterpretare: l'obiettivo e i criteri sono gia' stabiliti, e
      // rifarli da zero e' esattamente il danno.
      let _ripresa = null;
      try {
        const _aperto = ctx._archivioCantieri.riapriLavoro(null);
        if (_aperto.cantiere || _aperto.processo) {
          const s = supervisore.guarda(_aperto, message);
          if (s.riprendere) {
            _ripresa = s;
            ctx.session.cantiere = _aperto.cantiere || ctx.session.cantiere;
            ctx.session.processo = _aperto.processo || ctx.session.processo;
            ctx.log(`[Supervisore] Riprendo il lavoro aperto — ${s.perche}`);
            ctx.emitReasoning(`Riprendo il lavoro di prima invece di ricominciare: ${s.verdetto.perche}`, '↩️');
          } else if (_aperto.obiettivo) {
            ctx.log(`[Supervisore] Lavoro aperto lasciato dov'e': ${s.perche}`);
          }
        }
      } catch (e) {
        // Se la ripresa non riesce si lavora come prima: perdere la ripresa
        // costa un giro, farla male costa il lavoro.
        ctx.log(`[Supervisore] Ripresa saltata (${e.message}): procedo normalmente`);
      }

      // ── "parla in inglese" non e' un incarico: e' cambiare interlocutore ──
      //
      // Prima serviva aprire un menu. Una cosa che serve piu' volte al giorno
      // — Brandon parla inglese, Jose spagnolo — costava tre clic.
      //
      // Sta QUI, prima del routing, perche' non e' un lavoro da fare: e' una
      // preferenza. Mandarla all'Esecutore significherebbe fargli cercare
      // qualcosa su internet.
      try {
        const { riconosci, conferma } = require('../config/scelta-agente');
        const cambio = riconosci(message);
        if (cambio && cambio.agente.id !== ctx._agenteScelto) {
          ctx._agenteScelto = cambio.agente.id;
          try {
            fs.writeFileSync(path.join(ctx.dataDir, 'agente_scelto.json'),
              JSON.stringify({ id: cambio.agente.id, nome: cambio.agente.nome,
                quando: new Date().toISOString(), come: cambio.come }, null, 2));
          } catch (_) { /* la scelta vale comunque per questa sessione */ }
          ctx.log(`[Agente] "${cambio.frase}" → adesso parla ${cambio.agente.nome} (${cambio.come})`);
          ctx.wsBroadcast({ type: 'agente_cambiato', agente: cambio.agente });
          _invia(200, { response: conferma(cambio.agente), agente: cambio.agente,
            intent: 'chat', toolsUsed: [] });
          return;
        }
      } catch (e) { ctx.log(`[Agente] riconoscimento saltato: ${e.message}`); }

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
        // ── Cercare non è prenotare ──
        //
        // Questa regola nasce giusta: impedire che una richiesta di viaggio
        // finisca per premere "Conferma prenotazione". Ma guardava il DOMINIO
        // invece dell'INTENZIONE: bastava la parola "volo" o "hotel" per
        // togliere di mano gli strumenti di interazione.
        //
        // Verificato a schermo il 6 agosto. Richiesta: "compila il modulo di
        // ricerca su Google Voli, da Milano a Tokyo". Nel log:
        //   [SuperMario] Sola lettura: esclusi fill_form, type_human
        // COBRA ha aperto Google Voli, non ha potuto scrivere una parola nei
        // campi, e ha chiuso con 1 criterio su 6. Non per incapacità: gli era
        // stato tolto lo strumento.
        //
        // Su qualunque ricerca di viaggio — che è metà del lavoro di Luca —
        // il modulo di ricerca era inaccessibile per costruzione.
        //
        // Quindi si guarda cosa vuole fare, non di cosa parla: prenotare,
        // acquistare, confermare, pagare. Il resto — cercare, confrontare,
        // compilare un modulo di RICERCA — è lettura, e va lasciato lavorare.
        // Le azioni davvero irreversibili restano protette dove devono
        // stare: la classificazione del rischio e la conferma esplicita.
        // Due trappole, trovate entrambe dal test:
        //   - i prefissi vogliono \w* in coda, non \b: "acquist\b" non trova
        //     "acquista", perché dopo "acquist" la parola continua. Lasciava
        //     passare proprio il caso da fermare.
        //   - ma \w* troppo largo pesca parole innocenti: "pag\w*" fermava
        //     "paganesimo". Per il verbo pagare servono le forme vere.
        const vuolePrenotare = /\b(prenot\w*|acquist\w*|compr[ao]\w*|pag(?:a|are|ato|ata|herò|hero|hi|hiamo)|pagament\w*|conferma l'?ordine|book now|purchase|checkout|check.?out|emett\w*|biglietteria)\b/i;
        if (vuolePrenotare.test(message.toLowerCase())) {
          routing.operationLevel = 'read';
          routing.scopes = routing.scopes.filter(s => s !== 'interact');
          ctx.emitReasoning('Qui si parla di prenotare: mi fermo alla lettura', '📖');
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

      // ── Il diario: si apre qui, si chiude in fondo ──
      //
      // Una missione e' un LAVORO, non un turno. "Ciao" non e' una missione:
      // se si registrasse ogni scambio si tornerebbe al response_log, che ha
      // tutto ed e' illeggibile.
      //
      // Il diario esiste perche' Luca ha chiesto tre volte "si ricorda quando
      // ha sbagliato?" e la risposta era no. Le quattro memorie che c'erano
      // tenevano fatti sparsi, non lavori — e le "lezioni" erano cinque righe
      // identiche che dicevano la stessa cosa con un numero diverso.
      let _missione = null;
      try {
        const { Missioni } = require('../memory/missioni');
        if (!ctx._missioni) ctx._missioni = new Missioni(ctx.dataDir);
      } catch (_) { /* il diario e' una comodita', non una condizione */ }
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

            // ── La checklist: quello che la richiesta chiedeva e i criteri no ──
            //
            // Il Collega i criteri li scrive a occhio, e a occhio si perdono
            // pezzi. Il caso tipico: "tutte le compagnie Cina → PHX, SAN e LAS
            // con aeroporti, frequenze e aircraft" diventa "cerca voli,
            // confronta, fai il report" — tre passi che si possono dichiarare
            // fatti senza che nessuno sappia dire se manca LAS.
            //
            // Qui si CONTANO le cose nominate nella richiesta e si aggiungono
            // i criteri che mancavano. Non sostituisce il Collega: lui capisce
            // l'intenzione, che il codice non sa fare; contare gli elenchi in
            // una frase invece il codice lo fa meglio, perche' non si distrae
            // e non decide che tre citta' su quattro bastano.
            //
            // Il caso peggiore che intercetta non e' il criterio assente: e'
            // quello INCOMPLETO — tre soggetti su quattro passano la verifica,
            // e il lavoro sembra controllato.
            try {
              const { requisitiMancanti, checklistInChiaro } = require('../collega/requisiti');
              const r = requisitiMancanti(
                incaricoCorrente.obiettivo + ' ' + message, incaricoCorrente.criteri || []);
              if (r.mancanti.length) {
                const criteriNuovi = [...(incaricoCorrente.criteri || [])];
                for (const m of r.mancanti) {
                  const i = criteriNuovi.findIndex(c => c.tipo === m.tipo);
                  const { perche, ...criterio } = m;
                  if (i >= 0) criteriNuovi[i] = criterio; else criteriNuovi.push(criterio);
                  ctx.log(`[Checklist] + ${m.tipo}: ${perche}`);
                }
                incaricoCorrente.criteri = criteriNuovi;
                ctx.emitReasoning(
                  `La richiesta chiedeva ${r.checklist.length} cose contabili: ne aggiungo ${r.mancanti.length} ai criteri`,
                  '☑️');
              }
              const lista = checklistInChiaro(incaricoCorrente.obiettivo + ' ' + message, []);
              if (lista) { ctx.session._checklist = lista; ctx.log('[Checklist]\n' + lista); }
            } catch (e) {
              ctx.log(`[Checklist] saltata (${e.message}): si procede coi criteri del Collega`);
            }

            // ── Si apre il cantiere, con le misure prese dall'incarico ──
            //
            // I criteri dicono già quanti soggetti servono e quali campi:
            // elementi_minimi dà il numero, campi_obbligatori le colonne,
            // soggetti_coperti i nomi da trattare per forza. Da lì il cantiere
            // sa cosa aspettarsi e può dire, giro dopo giro, cosa manca.
            {
              const cr = incaricoCorrente.criteri || [];
              const quanti = cr.find(c => c.tipo === 'elementi_minimi')?.quanti || 0;
              const campi = cr.find(c => c.tipo === 'campi_obbligatori')?.campi || [];
              const soggetti = cr.find(c => c.tipo === 'soggetti_coperti')?.soggetti || [];
              if (quanti > 1 || campi.length > 0 || soggetti.length > 1) {
                const lavoro = ctx._archivioCantieri.riapriLavoro(incaricoCorrente.obiettivo);
                const ripreso = lavoro.cantiere;
                if (ripreso) {
                  ctx.session.cantiere = ripreso;
                  // Il piano torna con lui: senza, il modello lo rifa' da capo
                  // e i passi gia' chiusi tornano in attesa.
                  if (lavoro.processo) {
                    ctx.session.processo = lavoro.processo;
                    const fatti = lavoro.processo.passi.filter(x => x.stato === 'completato').length;
                    ctx.log(`[Processo] Riaperto il piano: ${fatti}/${lavoro.processo.passi.length} passi gia' chiusi`);
                    ctx.emitReasoning(`Riprendo il piano: ${fatti} passi su ${lavoro.processo.passi.length} erano gia' fatti`, '📋');
                  }
                  ctx.log(`[Cantiere] Riaperto quello di prima: ${ripreso.elenco().length} voci già in mano`);
                  ctx.emitReasoning(`Riprendo da dove eravamo: ${ripreso.elenco().length} voci già raccolte`, '🧱');
                } else {
                  ctx.session.cantiere = new Cantiere({
                    campiAttesi: campi,
                    quanteVoci: Math.max(quanti, soggetti.length),
                  });
                  ctx.session.cantiere.obiettivo = incaricoCorrente.obiettivo;
                  ctx.session.cantiere.aperto = Date.now();
                  for (const nome of soggetti) ctx.session.cantiere.annota(nome, {}, '');
                }
                ctx.log(`[Cantiere] Aperto: ${Math.max(quanti, soggetti.length) || '?'} voci, `
                  + `campi [${campi.join(', ') || 'liberi'}]`);
                ctx.emitReasoning('Apro il cantiere: poso ogni cosa che trovo, appena la trovo', '🧱');
              }
            }
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

            // ── UN COMANDANTE SOLO: l'incarico ──
            //
            // Prima decidevano in sette, e i primi tre lo facevano PRIMA di
            // sapere cosa servisse: routeIntent guardava le parole del
            // messaggio, selectModel la sua lunghezza. Poi il turno rattoppava
            // in sei punti diversi.
            //
            // Adesso il Collega capisce e scrive l'incarico; da lì discendono
            // ambiti, strumenti e modello, per deduzione, in un posto solo.
            const ordine = ordineDiLavoro(incaricoCorrente);
            routing.scopes = ordine.ambiti;
            routing.operationLevel = 'read';
            ctx._ordineDiLavoro = ordine;
            ctx.log(`[Comando] ${inChiaro(ordine)} Modello: ${ordine.tier}.`);
            ctx.emitReasoning(inChiaro(ordine), '🎯');

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

      // 5. KB search — si chiede all'INCARICO, non al messaggio
      //
      // Il messaggio grezzo va bene finche' descrive il lavoro. Ma le risposte
      // piu' frequenti a una domanda del Collega sono "vai", "procedi", "ok":
      // cercare quelle nella conoscenza non produce niente. E' il paradosso
      // per cui piu' il Collega fa bene il suo mestiere, piu' la KB diventa
      // cieca al turno dopo.
      const _domandaKB = domandaPerLaConoscenza(incaricoCorrente, message);
      if (_domandaKB !== message) {
        ctx.log(`[KB] Cerco per l'incarico invece che per il messaggio: "${_domandaKB.slice(0, 60)}"`);
      }
      try { ctx.session.kbSnippets = await ctx.searchKB(_domandaKB); } catch { ctx.session.kbSnippets = []; }

      // 6. SuperMario assemble
      const lastToolResult = ctx.session.lastPage
        ? { url: ctx.session.lastPage.url, title: ctx.session.lastPage.title, snippet: (ctx.session.lastPage.markdown || '').substring(0, 500) }
        : (ctx.toolHistory.length > 0 ? ctx.toolHistory[ctx.toolHistory.length - 1] : null);
      const conversationHistory = chatMem ? chatMem.getAPIMessages() : [];
      // ── Si apre la missione ──
      //
      // Solo se e' un LAVORO: intent 'chat' vuol dire due parole scambiate, e
      // registrarle riempirebbe il diario di niente. La distinzione la fa gia'
      // il routing, non serve rifarla qui.
      if (ctx._missioni && intent !== 'chat') {
        try {
          _missione = ctx._missioni.apri(message, { ambiti: routing.scopes, modello: null });
        } catch (_) { /* si prosegue senza diario */ }
      }

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

      // ── Quello che si sa gia' del sito e del lavoro ──
      //
      // Non serve che il modello si ricordi di chiedere: se e' aperta una
      // pagina di un sito su cui ci siamo gia' stati, o se la richiesta somiglia
      // a una procedura imparata, glielo si mette davanti. Uno strumento che
      // bisogna ricordarsi di chiamare viene chiamato meta' delle volte — e' la
      // lezione di list_local_files, che in due giorni non e' stato usato mai.
      try {
        const { MemoriaSiti } = require('../memory/siti');
        if (!ctx._memoriaSiti) ctx._memoriaSiti = new MemoriaSiti(ctx.dataDir);
        const urlOra = ctx.session.lastPage?.url;
        if (urlOra) {
          const blocco = ctx._memoriaSiti.perIlPrompt(urlOra);
          if (blocco) {
            systemPrompt += '\n\n' + blocco;
            ctx.log(`[MemoriaSiti] So gia' qualcosa di ${urlOra.slice(0, 40)}`);
          }
        }
      } catch (e) { ctx.log(`[MemoriaSiti] saltata: ${e.message}`); }

      try {
        const { Procedure } = require('../memory/procedure');
        if (!ctx._procedure) ctx._procedure = new Procedure(ctx.dataDir);
        const blocco = ctx._procedure.perIlPrompt(
          message + ' ' + (incaricoCorrente ? incaricoCorrente.obiettivo : ''));
        if (blocco) {
          systemPrompt += '\n\n' + blocco;
          ctx.emitReasoning('Questa cosa l\'ho gia\' fatta: seguo la procedura invece di riscoprirla', '📖');
        }
      } catch (e) { ctx.log(`[Procedure] saltate: ${e.message}`); }

      // Il foglio della ripresa va in cima a tutto il resto: e' la prima cosa
      // che deve leggere chi riprende, e contiene la riga che conta —
      // "NON RICOMINCIARE DA CAPO". Senza, il modello vede un obiettivo e una
      // lista di cose mancanti e rifa' il lavoro dall'inizio.
      if (_ripresa && _ripresa.pacchetto) {
        systemPrompt += '\n\n' + _ripresa.pacchetto;
        ctx.log(`[Supervisore] Pacchetto di ripresa nel prompt (${_ripresa.pacchetto.length} caratteri)`);
      }
      // Quello che l'esperienza ha gia' insegnato sulle fonti entra nel
      // prompt: non si riscopre a spese del tempo di Luca.
      if (ctx.registroFonti) {
        const blocco = ctx.registroFonti.perIlPrompt();
        if (blocco) systemPrompt += '\n\n' + blocco;
      }

      // E quello che ha imparato lavorando: strade che hanno funzionato,
      // ostacoli gia' visti, moduli gia' compilati.
      if (ctx._lezioni || ctx.dataDir) {
        try {
          const { Lezioni } = require('../memory/lezioni');
          if (!ctx._lezioni) ctx._lezioni = new Lezioni(ctx.dataDir);
          const domini = [...new Set((ctx.session.pagineDelTurno || [])
            .map(p => { try { return new URL(p.url || p).hostname.replace(/^www\./, ''); } catch { return ''; } })
            .filter(Boolean))];
          const blocco = ctx._lezioni.perIlPrompt({
            obiettivo: incaricoCorrente ? incaricoCorrente.obiettivo : message, domini });
          if (blocco) { systemPrompt += '\n\n' + blocco; ctx.log('[Lezioni] richiamate quelle pertinenti'); }
        } catch (e) { ctx.log(`[Lezioni] richiamo fallito: ${e.message}`); }
      }

      // Prompt audit
      ctx.auditPrompt(message, routing, marioResult, taskPlan, ctx.session.kbSnippets);
      if (taskPlan) systemPrompt += '\n\n' + ctx.SuperMario.buildPlanPrompt(taskPlan);

      // 7. Messages + repetition
      const msgs = chatMem ? chatMem.getAPIMessages() : [{ role: 'user', content: message }];
      const repetitionWarning = ctx.detectRepetition(msgs);
      if (repetitionWarning) { systemPrompt += '\n\n' + repetitionWarning; ctx.log('Repetition detected'); }

      // 8. AI call
      // Il modello lo decide l'ordine di lavoro quando c'e' un incarico.
      // Senza incarico — chiacchiera, domanda secca — resta il vecchio
      // criterio, che li' va benissimo.
      const modelSelection = ctx._ordineDiLavoro
        ? { tier: ctx._ordineDiLavoro.tier, reason: 'ordine di lavoro' }
        : ctx.SuperMario.selectModel(marioResult.scopes, taskPlan, message, ctx.session);

      ctx.emitReasoning(`Modello: ${modelSelection.tier}`, '🧠');
      const _chatStart = Date.now();
      // Il cantiere va davanti al modello dal PRIMO giro, non solo quando si
      // insiste: altrimenti la prima passata — quella che apre dieci pagine —
      // la fa senza sapere che deve posare quello che trova.
      let result = await ctx.callAI(systemPrompt + _bloccoCantiere(ctx) + _bloccoRicerca(ctx), msgs, useTools,
        { ...ctx, modelTier: modelSelection.tier });

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
        // ── Un messaggio partito non si ripete MAI ──
        //
        // Il 7 agosto Luca ha visto quattro "✓ whatsapp_send" per una sola
        // richiesta: lo stesso messaggio e' arrivato a Jose quattro volte. Non
        // era un difetto dell'invio — era questo ciclo. Il Collega giudicava il
        // turno contro criteri che parlavano di intestazione, data e fonti (un
        // report, non un messaggio), lo trovava incompleto, e faceva riprovare.
        // L'Esecutore, per "completare", rimandava.
        //
        // Insistere e' giusto su una ricerca: rifare una ricerca non costa
        // niente a nessuno. Su un invio e' un'altra cosa — dall'altra parte
        // c'e' una persona che riceve quattro volte lo stesso messaggio, e
        // quello non si richiama. Se in questo turno e' partito qualcosa, si
        // consegna com'e': eventuali mancanze si riferiscono al resto del
        // lavoro e si dicono a Luca, non si correggono rimandando.
        const _INVII = ['whatsapp_scrivi', 'linkedin_scrivi', 'whatsapp_send',
          'linkedin_send_message', 'linkedin_connect', 'send_email'];
        // CHIAMATO non vuol dire PARTITO.
        //
        // L'8 agosto, richiesta di collegamento a Brandon Dvorak: l'estensione
        // ci ha messo 25 secondi, il relay ha rinunciato al secondo 25, il
        // risultato e' tornato 5 millisecondi dopo ed e' finito orfano.
        // linkedin_connect ha risposto {ok:false, "Timeout"} — cioe' NON e'
        // partito niente, il pulsante "Collegati" e' ancora sul profilo.
        //
        // Ma questo controllo guardava solo il NOME dello strumento usato, non
        // il suo esito: ha visto "linkedin_connect" nell'elenco e ha concluso
        // che era partito un messaggio. Ha quindi zittito le insistenze del
        // Collega proprio nel turno in cui c'era da protestare, e il turno e'
        // stato consegnato come riuscito.
        //
        // Il freno serve ancora — quattro messaggi a Jose sono usciti da qui —
        // ma deve scattare su un invio RIUSCITO. Se l'invio e' fallito non c'e'
        // nessuno dall'altra parte che riceve due volte: si puo' e si deve dire.
        const _ePartitoQualcosa = () =>
          (result.toolsUsed || []).some(t =>
            _INVII.includes(t && (t.name || t.tool || t)) && !(t && t.ok === false));

        if (_ePartitoQualcosa()) {
          ctx.log('[Collega] In questo turno e\' partito un messaggio: niente insistenze.');
          valutazioneFinale = collega.giudica(incaricoCorrente, {
            testo: result.content || '', righe: null,
            file: ctx.session.fileDelTurno || [], pagine: ctx.session.pagineDelTurno || [],
          }, ctx.session, 99, null, 99).valutazione;
          insistenzeEsaurite = true;
        }

        for (; !_ePartitoQualcosa();) {
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
              systemPrompt + _bloccoCantiere(ctx) + _bloccoRicerca(ctx) + '\n\n# NOTA DEL COLLEGA\n' + giudizio.istruzione,
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

      // 8b-bis. Il cancello: chi dice "fatto" non e' chi ha lavorato.
      //
      // La guardia sopra difende dai DATI inventati. Questa difende dai
      // SUCCESSI inventati, che l'8 agosto sono stati quattro in un giorno:
      // "Il messaggio di auguri e' stato inviato correttamente" mentre non era
      // partito niente, "linkedin_connect OK" su una richiesta mai arrivata.
      //
      // Un dato falso lo si puo' verificare aprendo la fonte. Un successo
      // falso no: Luca chiude la conversazione convinto che una cosa sia
      // successa, e lo scopre giorni dopo — o non lo scopre.
      //
      // Il verdetto non guarda la frase: guarda i criteri, il cantiere, i file
      // prodotti e i passi eseguiti. La frase entra come un dato fra gli altri
      // e vale zero quando gli altri dicono il contrario.
      const _verdetto = decidiCompletamento({
        incarico: incaricoCorrente,
        valutazione: valutazioneFinale,
        cantiere: ctx.session.cantiere,
        files: ctx.session.fileDelTurno || [],
        passi: (result.toolsUsed || []).map((t, i) => ({ step: i + 1, tool: t.name, ok: t.ok })),
        dettoDalModello: result.content,
      });

      if (_verdetto.dichiarazioneSmentita) {
        // Non si riscrive la risposta: si aggiunge la verita' sotto, con le
        // parole di chi ha guardato le prove. Riscriverla significherebbe
        // buttare via anche la parte giusta di quello che ha fatto.
        ctx.log(`[Cancello] Diceva di aver finito ma ${_verdetto.perche}`);
        ctx.wsBroadcast({ type: 'ai_reasoning',
          text: `Diceva di aver finito, ma ${_verdetto.perche}`, icon: '🚧' });
        result.content = String(result.content || '').trimEnd()
          + '\n\n---\n**Non e\' finito.** ' + _verdetto.perche + ':\n'
          + _verdetto.mancano.map(m => `- ${m}`).join('\n');
        result.completamentoNegato = true;
      }
      ctx.session._ultimoVerdetto = _verdetto;

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

      // ── Il cantiere si salva, e si chiude solo quando il lavoro e' finito ──
      //
      // Cosi' la richiesta dopo riprende da dove si era arrivati invece di
      // ricominciare — che e' la ragione per cui quattro tentativi di fila su
      // otto aziende non erano arrivati in fondo.
      if (ctx.session.cantiere && ctx._archivioCantieri) {
        const r = ctx.session.cantiere.riepilogo();
        if (r.finito) {
          ctx._archivioCantieri.chiudi();
          ctx.log(`[Cantiere] Lavoro finito (${r.complete}/${r.attese}): chiudo il cantiere`);
        } else {
          // Si salva il lavoro INTERO: cosa e' stato raccolto (il cantiere),
          // dove si e' arrivati (il processo) e con quali criteri lo si
          // giudichera' finito. Salvarne solo una parte significa che alla
          // ripresa il modello ripianifica da zero, e con un piano nuovo i
          // passi gia' chiusi tornano "in attesa".
          ctx._archivioCantieri.salva(
            ctx.session.cantiere,
            ctx.session.processo || null,
            incaricoCorrente ? incaricoCorrente.criteri : null);
          const _p = ctx.session.processo;
          ctx.log(`[Cantiere] Lascio aperto: ${r.voci} voci, ${r.buchi} incomplete`
            + (_p ? ` — piano a ${_p.passi.filter(x => x.stato === 'completato').length}/${_p.passi.length} passi` : '')
            + ' — si riprende da qui');
        }
      }

      // ── Si impara dal LAVORO, non solo da quello che Luca dice ──
      //
      // Fino al 7 agosto l'archivio aveva 15 fatti, tutti raccolti ascoltando.
      // Di quello che COBRA faceva non restava niente: che europages torna
      // vuoto, che ITA blocca, che su tmwe.it il banner si toglie cliccando
      // "impostazione cookie". Ogni mattina si ricominciava dalla stessa
      // ignoranza.
      try {
        tiraLezioni(ctx, {
          obiettivo: incaricoCorrente ? incaricoCorrente.obiettivo : message,
          riuscito: !!(valutazioneFinale && valutazioneFinale.soddisfatto),
          pagine: ctx.session._letturePerLezioni || [],
          ostacoli: ctx.session._ostacoliPerLezioni || [],
          moduli: ctx.session._moduliPerLezioni || [],
        });
      } catch (e) { ctx.log(`[Lezioni] non ho potuto imparare da questo turno: ${e.message}`); }

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
      // ── Si chiude la missione ──
      //
      // L'esito non lo decide il modello: lo dicono i fatti del turno. Un
      // lavoro che non ha prodotto niente e ha inciampato e' fallito, anche se
      // la risposta suona bene — ed e' esattamente il caso che oggi ha fatto
      // dire "procedo con l'invio" a un messaggio mai partito.
      if (ctx._missioni && _missione) {
        try {
          for (const t of (result.toolsUsed || [])) {
            const nome = typeof t === 'string' ? t : t.name;
            ctx._missioni.annota(_missione, { strumento: nome });
            // Uno strumento fallito e' un inciampo: e' la parte che serve.
            if (typeof t === 'object' && t.ok === false) {
              ctx._missioni.inciampo(_missione, nome,
                String(t.error || t.motivo || 'non riuscito').slice(0, 200));
            }
          }
          for (const f of (ctx.session.fileDelTurno || [])) {
            ctx._missioni.annota(_missione, { file: f.filename || String(f) });
          }
          for (const p of (ctx.session.pagineDelTurno || [])) {
            ctx._missioni.annota(_missione, { pagina: (p.url || p || '').slice(0, 120) });
          }
          const haProdotto = (ctx.session.fileDelTurno || []).length > 0;
          const mancanze = valutazioneFinale && !valutazioneFinale.soddisfatto;
          ctx._missioni.chiudi(_missione,
            mancanze ? 'incompleto' : (haProdotto || (result.toolsUsed || []).length ? 'consegnato' : 'incompleto'),
            mancanze ? (valutazioneFinale.mancanze || []).slice(0, 2).join('; ') : null);
        } catch (e) { ctx.log(`[Diario] non sono riuscito a chiudere la missione: ${e.message}`); }
      }

      ctx.ResponseRecorder.recordChat({ userMessage: message, intent, systemPromptLength: systemPrompt.length, provider: result.provider, model: result.model || '', response: result.content, toolsUsed: result.toolsUsed || [], durationMs: Date.now() - _chatStart, kbEntries: (ctx.session.kbSnippets || []).length, repetitionDetected: !!repetitionWarning, marioScope: marioResult.scope, marioTraceId: marioResult.trace_id, agenteLavoro: marioResult.agenteLavoro, agenteVoce: ctx._agenteScelto, taskPlanSteps: taskPlan ? taskPlan.steps.length : 0 });

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
