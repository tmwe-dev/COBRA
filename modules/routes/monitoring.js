// modules/routes/monitoring.js — /api/response-log/*, /api/monitoring/*, /api/status, /api/logs, /api/token-meter, etc.
// Source: server.js lines 8442-8968

const path = require('path');
const fs = require('fs');

const { Credenziali } = require('../security/credenziali');

function _archivioAccessi(ctx) {
  if (!ctx._credenziali) {
    ctx._credenziali = new Credenziali(ctx.dataDir, process.env.COBRA_CREDENZIALI_CHIAVE);
  }
  return ctx._credenziali;
}

function register(router, ctx) {
  // ── Response Log ──
  router.get('/api/response-log', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.ResponseRecorder.getLog())); });
  router.get('/api/response-log/stats', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.ResponseRecorder.getStats())); });
  router.get('/api/response-log/export/json', (b, res) => {
    const data = JSON.stringify(ctx.ResponseRecorder.exportJSON(), null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="cobra-responses-${new Date().toISOString().split('T')[0]}.json"` });
    res.end(data);
  });
  router.get('/api/response-log/export/csv', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="cobra-responses-${new Date().toISOString().split('T')[0]}.csv"` });
    res.end(ctx.ResponseRecorder.exportCSV());
  });
  router.get('/api/response-log/export/txt', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="cobra-conversazioni-${new Date().toISOString().split('T')[0]}.txt"` });
    res.end(ctx.ResponseRecorder.exportConversation());
  });
  router.get('/api/response-log/problems', (b, res) => {
    const problems = ctx.ResponseRecorder.getLog({ hasFlags: ['raw_url_list', 'excessive_bullets', 'robot_opener', 'heavy_markdown', 'ai_self_reference', 'raw_urls_shown', 'possible_copypaste'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: problems.length, entries: problems }));
  });
  router.delete('/api/response-log', (b, res) => {
    ctx.ResponseRecorder._log = [];
    try { fs.writeFileSync(ctx.ResponseRecorder._filePath, ''); } catch (e) { ctx.log(`[Recorder] reset error: ${e.message}`); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Log cancellato' }));
  });

  // ── Token Meter ──
  router.get('/api/token-meter', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.TokenMeter.getStatus())); });
  router.delete('/api/token-meter', (b, res) => { ctx.TokenMeter.reset(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });

  // ── Monitoring Stats ──
  router.get('/api/monitoring/stats', (b, res) => {
    const stats = { total: 0, approved: 0, rejected: 0, expired: 0, executed: 0, pending: 0, byTool: {}, byRisk: {}, blockedPatterns: {} };
    const now = new Date();
    for (const [id, a] of ctx._pendingActions) {
      stats.total++;
      let status = a.status;
      if (status === 'pending' && now > a.expires_at) status = 'expired';
      stats[status] = (stats[status] || 0) + 1;
      stats.byTool[a.tool_name] = stats.byTool[a.tool_name] || { total: 0, approved: 0, rejected: 0, expired: 0 };
      stats.byTool[a.tool_name].total++;
      stats.byTool[a.tool_name][status] = (stats.byTool[a.tool_name][status] || 0) + 1;
      stats.byRisk[a.risk_level] = (stats.byRisk[a.risk_level] || 0) + 1;
    }
    const decided = stats.approved + stats.rejected + stats.expired + stats.executed;
    stats.rates = { approval: decided > 0 ? Math.round(stats.approved / decided * 100) : 0, rejection: decided > 0 ? Math.round(stats.rejected / decided * 100) : 0, expiry: decided > 0 ? Math.round(stats.expired / decided * 100) : 0, execution: decided > 0 ? Math.round(stats.executed / decided * 100) : 0 };
    stats.topTools = Object.entries(stats.byTool).sort((a, b) => b[1].total - a[1].total).slice(0, 10).map(([name, data]) => ({ name, ...data }));
    const invLog = ctx.SuperMario.getInvocationLog();
    stats.invocations = { total: invLog.length, avgLatency: invLog.length > 0 ? Math.round(invLog.reduce((s, l) => s + (l.latency_ms || 0), 0) / invLog.length) : 0, preflightWarnings: invLog.filter(l => l.preflight_warnings?.length > 0).length, postflightWarnings: invLog.filter(l => l.postflight_warnings?.length > 0).length, toolsUsedTotal: invLog.reduce((s, l) => s + (l.tools_used?.length || 0), 0) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  });

  // ── Audit Log ──
  router.get('/api/monitoring/audit-log', (b, res) => {
    const allActions = [];
    for (const [id, a] of ctx._pendingActions) {
      allActions.push({ id, tool: a.tool_name, risk: a.risk_level, status: a.status, summary: (a.summary || '').substring(0, 200), created: a.created_at, decided: a.decided_at, decided_by: a.decided_by, expires: a.expires_at });
    }
    const invLog = ctx.SuperMario.getInvocationLog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending_actions: allActions.sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 100), invocations: invLog.slice(-50) }));
  });

  // ── Memoria appresa (fatti durevoli sull'utente) ──
  router.get('/api/learning/facts', (b, res) => {
    const store = ctx.learningStore;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!store) { res.end(JSON.stringify({ facts: [], stats: { total: 0 } })); return; }
    res.end(JSON.stringify({
      facts: [...store.facts].sort((a, b) => b.confidence - a.confidence),
      stats: store.getStats(),
    }));
  });

  router.post('/api/learning/forget', (body, res) => {
    const store = ctx.learningStore;
    let removed = 0, errore = null;
    try {
      const { fact, all } = JSON.parse(body || '{}');
      if (!store) errore = 'memoria non disponibile';
      else if (all === true) { removed = store.facts.length; store.facts = []; store.save(); }
      else if (fact) removed = store.forget(fact);
      else errore = 'serve "fact" oppure "all": true';
    } catch (e) { errore = e.message; }
    res.writeHead(errore ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errore ? { error: errore } : { ok: true, removed }));
  });

  // Verifica che il registro di audit non sia stato alterato
  router.get('/api/monitoring/audit-integrity', (b, res) => {
    let result;
    try { result = ctx.verifyAuditChain(); }
    catch (e) { result = { valid: false, reason: `verifica fallita: ${e.message}` }; }
    res.writeHead(result.valid ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  // ── Prompt Audit ──
  router.get('/api/monitoring/prompts', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const promptLog = path.join(ctx.dataDir, 'supermario_prompts.jsonl');
      if (fs.existsSync(promptLog)) {
        const lines = fs.readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean);
        const entries = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        res.end(JSON.stringify({ total: lines.length, entries }));
      } else { res.end(JSON.stringify({ total: 0, entries: [] })); }
    } catch (e) { res.end(JSON.stringify({ total: 0, entries: [], error: e.message })); }
  });

  // ── Feedback ──
  router.get('/api/monitoring/feedback', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.getFeedbackStats())); });

  // ── Human Driver Stats ──
  router.get('/api/human-driver/stats', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ctx.HumanDriver.getStats())); });

  // Research Status — rimosso (ResearchStrategy eliminato nella semplificazione)

  // ── Status ──
  // ── Riavvio dal pannello ──
  //
  // Ogni modifica al codice richiede di rilanciare il server, e finora
  // l'unico modo era che Luca aprisse il Terminale e incollasse un comando.
  // Su una giornata di lavoro sono decine di interruzioni, ognuna delle
  // quali spezza il filo del discorso.
  //
  // Il processo esce con codice 0; il guardiano che lo tiene in piedi lo
  // rilancia dopo due secondi, e la porta ormai sa aspettare il proprio turno.
  //
  // Sicurezza: le rotte /api/ sono già dietro il controllo del token, e il
  // server ascolta solo su 127.0.0.1. In più si pretende una conferma
  // esplicita nel corpo: spegnere il server è una cosa che si fa apposta,
  // non per sbaglio o per una chiamata partita di rimbalzo.
  router.post('/api/riavvia', (corpo, res) => {
    let conferma = null;
    try { conferma = JSON.parse(corpo || '{}').conferma; } catch (_) { /* corpo non leggibile */ }
    if (conferma !== 'riavvia') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, errore: 'serve {"conferma":"riavvia"}' }));
      return;
    }
    ctx.log('[Riavvio] Richiesto dal pannello: esco, il guardiano mi rilancia');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messaggio: 'Riavvio in corso: fra qualche secondo sono di nuovo qui.' }));
    setTimeout(() => process.exit(0), 300);
  });

  // ── Provare un comando dell'estensione, senza il modello in mezzo ──
  //
  // Serve a una cosa sola: sapere se una funzione presa dalle estensioni del
  // Navigator funziona DAVVERO sul browser di Luca. Con il modello in mezzo la
  // risposta e' ambigua — se dice "non ci sono riuscito" non si capisce se ha
  // fallito il selettore o se ha sbagliato lui a raccontarlo.
  //
  // Solo comandi che GUARDANO. Niente che scriva un messaggio, niente che
  // compili un accesso: una via diretta all'estensione e' comoda per provare e
  // pericolosa per tutto il resto, quindi passa di qui solo cio' che legge.
  // Solo comandi che GUARDANO. Niente che scriva un messaggio, niente che
  // compili un accesso: una via diretta all'estensione e' comoda per provare e
  // pericolosa per tutto il resto, quindi passa di qui solo cio' che legge.
  const COMANDI_DI_PROVA = [
    'stato_moduli_esterni', 'elenco_schede', 'stato_ritmo', 'stato_canali',
    'whatsapp_sessione', 'whatsapp_elenco_chat', 'whatsapp_non_letti', 'whatsapp_diagnosi',
    'linkedin_posta', 'linkedin_diagnosi', 'linkedin_elenco_chat',
    'linkedin_leggi_conversazione', 'whatsapp_leggi_conversazione',
    'diagnosi_selettori', 'mappa_pagine', 'sblocca_coda',
  // Il registro delle durate: serve a rispondere a "perche' ci ha messo tre
  // minuti" con un numero invece che con un'ipotesi. E' in sola lettura come
  // tutti gli altri qui: nessuno di questi comandi manda niente fuori.
  'get_action_log',
    // NOTA: whatsapp_rispondi e linkedin_rispondi NON sono qui apposta.
    // Questa rotta e' di sola lettura: un comando che manda un messaggio a una
    // persona vera non deve poter partire da un indirizzo nella barra del
    // browser. Si provano dalla chat, dove passano dalle regole di invio.
  ];

  // ── Gli argomenti dalla barra dell'indirizzo ──
  //
  // Prima queste prove chiamavano il comando con {} e basta. Va bene per
  // "leggi l'elenco", non per "apri la chat con Brandon": senza il nome il
  // comando risponde giustamente "non mi hai detto quale chat", e la prova
  // non si puo' fare.
  //
  // I comandi ammessi sono un elenco chiuso e di sola lettura — nessuno di
  // questi manda niente a nessuno — quindi passare gli argomenti non apre
  // nessuna porta: /api/prova/whatsapp_leggi_conversazione?nome=Brandon%20Usa
  const _argomentiDa = (req) => {
    const args = {};
    try {
      // Attenzione: il gestore riceve `pathname`, che la query NON ce l'ha —
      // e' gia' stata tolta da new URL(...).pathname. Gli argomenti stanno
      // nell'url grezzo della richiesta.
      const q = String((req && req.url) || '').split('?')[1];
      if (!q) return args;
      for (const [k, v] of new URLSearchParams(q)) {
        args[k] = /^\d+$/.test(v) ? Number(v) : v;
      }
    } catch (_) { /* senza argomenti si procede come prima */ }
    return args;
  };

  for (const comando of COMANDI_DI_PROVA) {
    router.get(`/api/prova/${comando}`, async (b, res, percorso, req) => {
      const rispondi = (codice, corpo) => {
        res.writeHead(codice, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(corpo, null, 2));
      };
      if (!ctx.isBridgeReady()) {
        return rispondi(503, { errore: 'il browser non risulta collegato',
          cosaFare: 'apri Chrome e controlla che l\'estensione COBRA sia attiva' });
      }
      const partito = Date.now();
      try {
        const args = _argomentiDa(req);
        const r = await ctx.bridgeCommand(comando, args);
        rispondi(200, { comando, secondi: +((Date.now() - partito) / 1000).toFixed(1), risposta: r?.result ?? r });
      } catch (e) {
        rispondi(200, { comando, secondi: +((Date.now() - partito) / 1000).toFixed(1), errore: e.message });
      }
    });
  }

  router.get('/api/prova', (b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ammessi: COMANDI_DI_PROVA.map(c => `/api/prova/${c}`) }, null, 2));
  });

  // ── Sto girando col codice che c'e' su disco? ──
  //
  // E' la domanda che ci e' costata piu' tempo di tutte. Node carica i file
  // una volta sola, all'avvio, e li tiene in memoria: se modifichi un prompt e
  // non riavvii, il server continua a usare la versione vecchia senza dirlo a
  // nessuno. Piu' volte abbiamo corretto un file, riprovato, visto lo stesso
  // errore e cercato la causa altrove — mentre la causa era che quel file non
  // era mai stato letto.
  //
  // Qui si confronta l'ora di avvio del processo con l'ora dell'ultima
  // modifica dei file che contano. Se un file e' piu' recente dell'avvio, il
  // server sta usando roba vecchia, e lo dice.
  router.get('/api/versione', (b, res) => {
    const fs = require('fs');
    const path = require('path');
    const radice = path.join(__dirname, '..', '..');
    const avviato = Date.now() - Math.round(process.uptime() * 1000);

    // ── Si guardano TUTTI i moduli, non una lista scritta a mano ──
    //
    // Prima qui c'era un elenco di nove file scelti da me. Il 7 agosto ho
    // corretto monitoring.js, connection.js e schemas.js — nessuno dei tre era
    // nella lista — e il diagnostico ha risposto serenamente "il server sta
    // usando il codice che c'e' su disco". Era falso, e mi ha fatto cercare la
    // causa altrove per tre giri.
    //
    // Un controllo che verifica solo cio' che qualcuno si e' ricordato di
    // aggiungere non e' un controllo: e' una lista della spesa. L'elenco si
    // ricava dal disco, cosi' un file nuovo e' coperto dal momento in cui
    // esiste.
    const file = [];
    let daRicaricare = 0;

    const guarda = (dir, prefisso = '') => {
      let voci;
      try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const v of voci) {
        if (v.name === 'node_modules' || v.name.startsWith('.')) continue;
        const intero = path.join(dir, v.name);
        const rel = prefisso ? `${prefisso}/${v.name}` : v.name;
        if (v.isDirectory()) { guarda(intero, rel); continue; }
        if (!v.name.endsWith('.js')) continue;
        try {
          const m = fs.statSync(intero).mtimeMs;
          if (m > avviato) { daRicaricare++; file.push({ file: `modules/${rel}`, modificato: new Date(m).toISOString() }); }
        } catch (_) { /* avanti */ }
      }
    };
    guarda(path.join(radice, 'modules'));

    file.sort((a, b) => (a.modificato < b.modificato ? 1 : -1));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      aggiornato: daRicaricare === 0,
      avviato: new Date(avviato).toISOString(),
      daQuanto: Math.round(process.uptime() / 60) + ' minuti',
      verdetto: daRicaricare === 0
        ? 'Il server sta usando il codice che c\'e\' su disco.'
        : `${daRicaricare} file sono stati modificati DOPO l'avvio: il server usa ancora la versione vecchia. `
          + 'Riavvialo, o quello che leggi non e\' quello che gira.',
      // Solo i file piu' recenti dell'avvio: quelli a posto non servono a
      // nessuno, e un elenco di duecento righe non si legge.
      daRicaricare: file.slice(0, 30),
    }, null, 2));
  });

  // ── Il diario: cosa e' stato fatto, e cosa e' andato storto ──
  //
  // Serve a Luca per chiedere conto senza dover leggere un JSON da 300 KB, e
  // a me per rispondere a "si ricorda quando ha sbagliato?" con dei fatti.
  router.get('/api/missioni', (b, res) => {
    let out;
    try {
      const { Missioni } = require('../memory/missioni');
      if (!ctx._missioni) ctx._missioni = new Missioni(ctx.dataDir);
      out = ctx._missioni.riepilogo(15);
      out.scrivania = ctx._missioni.scrivania(path.join(ctx.dataDir, 'files'), 10);
    } catch (e) { out = { errore: e.message }; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out, null, 2));
  });

  // ── Gli accessi ai sistemi chiusi ──
  //
  // L'elenco NON contiene mai le password: solo dominio, utente e note. Cosi'
  // anche chi guarda questa risposta — o il registro del browser — non vede
  // niente di segreto.
  router.get('/api/accessi', (b, res) => {
    const A = _archivioAccessi(ctx);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configurato: A.attiva,
      nota: A.attiva ? null
        : 'Manca COBRA_CREDENZIALI_CHIAVE nel file .env. Senza, le password resterebbero in chiaro.',
      accessi: A.attiva ? A.elenco() : [],
    }));
  });

  router.post('/api/accessi', (corpo, res) => {
    let dati = {};
    try { dati = JSON.parse(corpo || '{}'); } catch (_) { /* corpo illeggibile */ }
    const A = _archivioAccessi(ctx);
    const r = A.aggiungi(dati);
    // La password non viene registrata da nessuna parte, nemmeno nel log.
    if (r.ok) ctx.log(`[Accessi] aggiunto ${r.dominio} (utente ${r.utente})`);
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });

  router.post('/api/accessi/togli', (corpo, res) => {
    let dati = {};
    try { dati = JSON.parse(corpo || '{}'); } catch (_) { /* corpo illeggibile */ }
    const A = _archivioAccessi(ctx);
    const r = A.togli(dati.dominio, dati.utente || null);
    ctx.log(`[Accessi] tolto ${dati.dominio}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });

  // Lo stato dei canali per il badge in alto. Se il browser non e' collegato
  // non e' un errore: e' semplicemente "spento", ed e' quello che il badge deve
  // mostrare senza far comparire un allarme rosso ogni volta che Chrome dorme.
  // ── Chi sono i colleghi fra cui si puo' scegliere ──
  //
  // Solo l'elenco: la voce con cui parlano vive su ElevenLabs, non qui. Questa
  // rotta serve al pannello per mostrarli e per ricordare quale ha scelto Luca.
  router.get('/api/agenti', (b, res) => {
    const { elenco } = require('../config/agenti');
    const scelto = ctx._agenteScelto || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agenti: elenco(), scelto }));
  });

  router.post('/api/agenti/scegli', (corpo, res) => {
    let d = {};
    try { d = JSON.parse(corpo || '{}'); } catch (_) { /* corpo illeggibile */ }
    const { quello } = require('../config/agenti');
    const a = quello(d.id);
    ctx._agenteScelto = a.id;
    ctx.log(`[Agente] adesso parla ${a.nome} (${a.lingua})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agente: a }));
  });

  router.get('/api/canali', async (b, res) => {
    const spento = { scheda: false, connesso: false, perche: 'browser non collegato' };
    if (!ctx.isBridgeReady()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ whatsapp: spento, linkedin: spento }));
    }
    try {
      const r = await ctx.bridgeCommand('stato_canali', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r?.result || r));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ whatsapp: spento, linkedin: spento, errore: e.message }));
    }
  });

  router.get('/api/status', (b, res) => {
    const conv = ctx.conversationEngine.getActiveConversation();
    const chatMem = conv ? ctx.conversationEngine.chatMemories.get(conv.id) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      keys: Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key')).map(k => k.replace('Key', '')),
      clients: ctx.getWsClientCount(),
      lastPage: ctx.session.lastPage ? { url: ctx.session.lastPage.url, title: ctx.session.lastPage.title } : null,
      supervisor: ctx.CobraSupervisor.getStatus(),
      persona: { version: 'v11-slim', layers: [] },
      conversation: conv ? { id: conv.id, title: conv.title, messageCount: conv.messages.length, hasSummary: !!conv.summary } : null,
      memory: chatMem ? chatMem.getStats() : { liveWindowCount: 0 },
      toolRegistry: { count: ctx.COBRA_TOOLS.length, tools: ctx.COBRA_TOOLS.map(t => t.function.name) },
      toolHistory: ctx.toolHistory.slice(-10),
      bridge: { connected: ctx.isBridgeReady(), capabilities: ctx.getBridgeCapabilities() },
    }));
  });

  // ── Logs ──
  router.get('/api/logs', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ logs: ctx.serverLogs.slice(-50) })); });

  // ── Conversations ──
  router.get('/api/conversations', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ conversations: ctx.conversationEngine.listConversations() })); });
  router.post('/api/conversations/new', (b, res) => {
    const conv = ctx.conversationEngine.createConversation('Nuova Chat');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, conversation: conv }));
  });

  // ── Memory Clear ──
  router.post('/api/memory/clear', (b, res) => {
    const conv = ctx.conversationEngine.getActiveConversation();
    if (conv) { const m = ctx.conversationEngine.chatMemories.get(conv.id); if (m) m.clear(); }
    ctx.session.lastPage = null;
    ctx.toolHistory.length = 0;
    ctx.session.kbSnippets = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  // Persona — rimosso (CobraPersona eliminato nella semplificazione)

  // ── Version ──
  router.get('/api/version', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: ctx.APP_VERSION, build: ctx.APP_BUILD })); });

  // ── Bridge Status ──
  router.get('/api/bridge-status', (b, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: ctx.isBridgeReady(), capabilities: ctx.getBridgeCapabilities() })); });

  // ── Il diario ──
  //
  // Due indirizzi, perche' servono a due domande diverse: "come sta andando"
  // si guarda di continuo, "cosa e' successo esattamente" si guarda quando
  // qualcosa e' andato storto. Sono in sola lettura come tutto quello che sta
  // qui dentro.
  //
  //   /api/diario            le ultime righe, per capire un caso
  //   /api/diario/riepilogo  cosa fallisce e quanto costa, nelle ultime 24 ore
  router.get('/api/diario/riepilogo', (b, res) => {
    const ore = Number(new URL('http://x' + (b.url || '/')).searchParams.get('ore')) || 24;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ctx.giornale ? ctx.giornale.riepilogo(ore) : { errore: 'diario non attivo' }, null, 2));
  });

  router.get('/api/diario', (b, res) => {
    const p = new URL('http://x' + (b.url || '/')).searchParams;
    const quante = Math.min(Number(p.get('quante')) || 100, 2000);
    let righe = ctx.giornale ? ctx.giornale.leggi(quante) : [];
    // Filtri: servono a rispondere "fammi vedere solo quello che non ha
    // funzionato", che e' la domanda che si fa il 90% delle volte.
    if (p.get('solo') === 'falliti') righe = righe.filter((r) => !r.ok);
    if (p.get('capacita')) righe = righe.filter((r) => r.capacita === p.get('capacita'));
    if (p.get('code')) righe = righe.filter((r) => r.code === p.get('code'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ quante: righe.length, righe }, null, 2));
  });
}

module.exports = { register };
