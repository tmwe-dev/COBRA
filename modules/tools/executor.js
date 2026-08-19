// modules/tools/executor.js — executeTool() dispatcher + pre/post guards
// Source: server.js lines 4939-7204

const { COBRA_DEFAULTS } = require('../config');
const { spiega } = require('../security/spiegazioni');
const { isDomainWhitelisted } = require('../config/whitelist');
const { auditToolCall, auditSecurityEvent } = require('../security/audit-log');
const { classifica: classificaEsito } = require('../diario/tassonomia');
const { daRisultato, posaNelCantiere } = require('../cantiere/raccolta');
const { Indagine } = require('../ricerca/indagine');
const { FontiPreferite, tipoDiLavoro } = require('../ricerca/fonti-preferite');
const { descrivi, comeEAndata } = require('./descrizioni');

/**
 * Quante volte questa stessa chiamata e' gia' stata tentata in questo turno.
 *
 * Serve al diario per distinguere "e' fallito" da "e' fallito la terza volta
 * di fila uguale", che sono due malattie diverse: la seconda dice che la
 * strategia non cambia mai, ed e' quella che ci ha fatto perdere i minuti.
 */
function _quantiTentativi(ctx, descrizione) {
  try { return (ctx.toolHistory || []).filter((x) => x === descrizione).length || 1; }
  catch (_) { return 1; }
}

const INTERACT_TOOLS = ['click_element', 'fill_form', 'type_human', 'select_option', 'press_key',
  'key_combo', 'select_dropdown', 'set_datepicker', 'drag_drop', 'upload_file', 'clipboard_write',
  'mutate_dom_js', 'hover_element'];

function validateToolArgs(name, args) {
  if (name === 'navigate' || name === 'scrape_url') {
    let url = args.url || '';
    if (!url.startsWith('http')) url = 'https://' + url;
    args.url = url;
  }
  if (['execute_js', 'inspect_dom_js', 'mutate_dom_js'].includes(name) && args.code?.length > COBRA_DEFAULTS.MAX_JS_CODE_LENGTH) {
    throw new Error(`Code troppo lungo (${args.code.length} > ${COBRA_DEFAULTS.MAX_JS_CODE_LENGTH})`);
  }
  if (name === 'click_element' && args.selector?.length > COBRA_DEFAULTS.MAX_SELECTOR_LENGTH) {
    throw new Error('Selector troppo lungo');
  }
  if (name === 'google_search' && args.query?.length > COBRA_DEFAULTS.MAX_SEARCH_QUERY_LENGTH) {
    args.query = args.query.substring(0, COBRA_DEFAULTS.MAX_SEARCH_QUERY_LENGTH);
  }
  return args;
}

// Adaptive retry map: tool → alternative tools da provare
const TOOL_ALTERNATIVES = {
  navigate: ['google_search', 'scrape_url'],
  scrape_url: ['read_page', 'extract_data'],
  read_page: ['screenshot', 'get_page_snapshot'],
  screenshot: ['read_page', 'get_page_snapshot'],
  click_element: ['fill_form', 'type_human'],
  fill_form: ['type_human', 'click_element'],
  google_search: ['navigate'],
  extract_data: ['read_table', 'scrape_url'],
  read_table: ['extract_data', 'read_page'],
  get_page_elements: ['get_page_snapshot', 'read_page'],
  inspect_dom_js: ['get_page_snapshot', 'read_page'],
  linkedin_search: ['google_search'],
};

function _getAlternativeTools(toolName) {
  return TOOL_ALTERNATIVES[toolName] || [];
}

// Handler registry — populated by registerHandlers()
const _handlers = {};

function registerHandlers(handlerMap) {
  for (const [toolName, fn] of Object.entries(handlerMap)) _handlers[toolName] = fn;
}

async function executeTool(name, args, ctx) {
  // Validate args
  try { args = validateToolArgs(name, args); } catch (e) { return JSON.stringify({ error: e.message }); }

  // SuperMario hard guards
  const marioValidation = ctx.SuperMario.validateToolCall(name, args);
  if (!marioValidation.valid) {
    const blockWarnings = marioValidation.warnings.filter(w => w.startsWith('dangerous_js_pattern') || w.startsWith('send_missing_recipient'));
    if (blockWarnings.length > 0) {
      ctx.log(`[SuperMario] BLOCKED tool ${name}: ${blockWarnings.join(', ')}`);
      return JSON.stringify({ error: `Tool bloccato: ${blockWarnings.join(', ')}`, blocked: true });
    }
    if (marioValidation.warnings.length > 0) ctx.log(`[SuperMario] Tool ${name} warnings: ${marioValidation.warnings.join(', ')}`);
  }

  // Interazione fuori dai domini di fiducia.
  //
  // Bloccare ogni click su un sito non elencato impediva anche le azioni
  // innocue — aprire un filtro, passare alla pagina successiva, scegliere una
  // data — e quindi impediva a COBRA di esplorare. Il rischio vero non sta nel
  // click in sé ma in COSA si clicca: "pagina successiva" e "Paga ora" sono
  // due cose diverse.
  //
  // Fuori whitelist si consente quindi l'esplorazione, mentre le azioni che
  // possono produrre effetti irreversibili restano soggette alla conferma
  // dell'utente, gestita subito sotto da guardToolCall.
  if (INTERACT_TOOLS.includes(name)) {
    const currentUrl = ctx.session.lastPage?.url;
    if (!isDomainWhitelisted(currentUrl)) {
      // Questi restano vietati fuori whitelist: caricano file dal disco,
      // scrivono negli appunti o alterano la pagina in modo arbitrario.
      const SEMPRE_VIETATI_FUORI_WHITELIST = ['upload_file', 'clipboard_write', 'mutate_dom_js'];
      if (SEMPRE_VIETATI_FUORI_WHITELIST.includes(name)) {
        ctx.log(`[Whitelist] ${name} negato su ${currentUrl}`);
        return JSON.stringify({
          error: `${name} non è consentito su un sito non autorizzato. Su questo sito posso leggere, navigare e cliccare, ma non caricare file o modificarne il contenuto.`,
          blocked: true, reason: 'tool_non_consentito_fuori_whitelist',
        });
      }
      ctx.log(`[Whitelist] ${name} consentito su ${currentUrl} (dominio esterno, azione soggetta a verifica del rischio)`);
    }
  }

  // Track usage
  const desc = `${name}(${JSON.stringify(args).substring(0, 80)})`;
  ctx.toolHistory.push(desc);
  if (ctx.toolHistory.length > COBRA_DEFAULTS.ACTION_LOG_MAX_SIZE) ctx.toolHistory.shift();

  // Supervisor tracking
  const loopWarning = ctx.CobraSupervisor.recordToolCall(name, args);
  if (loopWarning) {
    // Un'interruzione che non lascia traccia non si puo' diagnosticare.
    // L'utente vede "Interrotto per evitare loop" e nel registro non c'e'
    // niente: ne' quale delle sette regole ha deciso, ne' su cosa. Da fuori
    // sembra che il programma si sia fermato per capriccio, e non si sa da
    // dove ricominciare a guardare.
    const conteggio = ctx.CobraSupervisor._totalToolCount;
    ctx.log(`[Supervisore] INTERROTTO alla chiamata ${conteggio}: regola="${loopWarning.warning}" `
      + `strumento=${name} argomenti=${JSON.stringify(args || {}).substring(0, 160)}`);
    if (loopWarning.message) ctx.log(`[Supervisore] Motivo: ${loopWarning.message}`);
    const ultimi = (ctx.CobraSupervisor._toolCallLog || []).slice(-6)
      .map(t => `${t.tool}(${String(t.args).substring(0, 40)})`).join(' → ');
    ctx.log(`[Supervisore] Ultimi passi: ${ultimi}`);
    return JSON.stringify({ error: loopWarning.message || `Loop circolare: ${name}`, warning: loopWarning.warning || 'circular_loop', force_stop: loopWarning.warning === 'force_stop' });
  }

  // Security guard
  const guard = ctx.guardToolCall(name, args, 'default', ctx.session.currentApprovalToken);
  if (guard.kind === 'reject') {
    ctx.log(`[Security] REJECTED ${name}: ${guard.reason}`);
    ctx.wsBroadcast({ type: 'tool_rejected', tool: name, reason: guard.reason });
    auditSecurityEvent('tool_rejected', { tool: name, reason: guard.reason }, ctx.session?.id);
    return JSON.stringify({ error: `Azione rifiutata: ${guard.reason}`, rejected: true });
  }
  if (guard.kind === 'block_for_confirmation') {
    ctx.log(`[Security] BLOCKED ${name} (risk=${guard.effective_risk})`);
    // L'avviso deve poter essere LETTO: prima arrivava "DESTRUCTIVE annota"
    // con sotto il JSON grezzo, e chi guardava non poteva decidere, solo
    // premere a caso.
    const spiegazione = spiega(name, args, guard.effective_risk);
    ctx.wsBroadcast({ type: 'pending_action', id: guard.pending_action_id, tool: name,
      risk: guard.effective_risk, summary: guard.summary,
      titolo: spiegazione.titolo, dettaglio: spiegazione.dettaglio, perche: spiegazione.perche,
      expires_at: guard.expires_at.toISOString(), reasons: guard.reasons });
    return JSON.stringify({ status: 'pending_confirmation', pending_action_id: guard.pending_action_id, risk_level: guard.effective_risk, message: `Azione intercettata. In attesa di conferma. ID: ${guard.pending_action_id}`, instructions_for_ai: 'NON rigenerare la chiamata. Spiega all\'utente e attendi conferma.' });
  }
  if (guard.effective_risk !== 'read' && guard.effective_risk !== 'inspect') {
    ctx.log(`[Security] ALLOW ${name} (risk=${guard.effective_risk}) ${guard.reasons.join(' | ')}`);
  }

  // ── Cosa sto facendo, detto a chi guarda ──
  //
  // Prima la chat mostrava i nomi delle funzioni: "google_search navigate
  // leggi_modulo". Dicono tutto a chi ha scritto il codice e niente a chi
  // aspetta — e quando una cosa dura tre minuti, non capire cosa stia
  // succedendo e' la differenza fra aspettare e pensare che si sia piantato.
  //
  // Parte da QUI e non dai tre provider AI: li' erano tre punti da tenere
  // allineati, e il messaggio non poteva portare ne' il motivo ne' la durata,
  // che si sanno solo dopo l'esecuzione.
  const _attivitaId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    ctx.wsBroadcast({ type: 'attivita_inizio', id: _attivitaId, strumento: name,
      dice: descrivi(name, args), rischio: guard.effective_risk });
  } catch (_) { /* la chat non deve poter fermare il lavoro */ }

  const _toolExecStart = Date.now();
  let _toolResult;
  let _toolErrore = null;
  try {
    const handler = _handlers[name];
    if (!handler) return JSON.stringify({ error: `Tool "${name}" non implementato` });
    _toolResult = await handler(args, ctx);
    return _toolResult;
  } catch (e) {
    // L'eccezione va conservata: il messaggio che finisce nel risultato e'
    // gia' impastato con le alternative, e classificarlo su quello significa
    // leggere il suggerimento invece della causa.
    _toolErrore = e;
    // Adaptive retry: suggerisci alternative in base al tool fallito
    const alternatives = _getAlternativeTools(name);
    const altText = alternatives.length > 0 ? ` Alternative: prova ${alternatives.join(' o ')}.` : '';
    _toolResult = JSON.stringify({ error: `${name}: ${e.message}${altText}` });
    return _toolResult;
  } finally {
    const _toolLatency = Date.now() - _toolExecStart;

    // ── Il diario ──
    //
    // Qui, e non dentro i singoli handler, per una ragione sola: questo e'
    // l'unico punto da cui passano TUTTE le esecuzioni. Metterlo negli handler
    // avrebbe significato novantuno posti da ricordarsi, che e' esattamente il
    // difetto che stiamo togliendo.
    //
    // Non lancia mai: un registro che ferma il paziente non e' un registro.
    try {
      if (ctx.giornale) {
        const esito = classificaEsito(_toolResult, _toolErrore);
        ctx.giornale.registra({
          capacita: name,
          argomenti: args,
          esito,
          durataMs: _toolLatency,
          tentativo: _quantiTentativi(ctx, desc),
          rischio: guard.effective_risk,
          pagina: ctx.session?.lastPage?.url,
          lavoro: ctx.session?.lavoroCorrente?.id || null,
          passo: ctx.session?.lavoroCorrente?.passoCorrente ?? null,
        });
        // Un fallimento che nessuno sa spiegare e' un handler da sistemare:
        // si dice subito, invece di scoprirlo leggendo il diario fra una
        // settimana.
        if (!esito.ok && esito.code === 'SCONOSCIUTO') {
          ctx.log(`[Diario] ${name} fallito senza un motivo riconoscibile: "${String(esito.reason).slice(0, 120)}"`);
        }
      }
    } catch (_) { /* il diario non deve mai bloccare uno strumento */ }

    // Com'e' andata, con il motivo quando serve.
    try {
      const e = classificaEsito(_toolResult, _toolErrore);
      ctx.wsBroadcast({ type: 'attivita_fine', id: _attivitaId, strumento: name,
        dice: descrivi(name, args), ok: e.ok, code: e.code || null,
        perche: comeEAndata(e), durataMs: _toolLatency });
    } catch (_) { /* best-effort */ }

    // ── La raccolta ──
    //
    // Qui, accanto al diario, e per la stessa ragione: e' l'unico punto da cui
    // passano tutte le esecuzioni.
    //
    // Un dato che il sistema ha gia' in mano non si chiede al modello di
    // ricopiarlo. `annota` restava a 5 chiamate su 880 e il cantiere a zero
    // voci: non per pigrizia, ma perche' annotare costa subito e serve fra tre
    // passi, ed e' esattamente il tipo di cosa che si salta.
    try {
      if (ctx.session && ctx.session.cantiere) {
        const raccolto = daRisultato(name, args, _toolResult, ctx.session.lastPage && ctx.session.lastPage.url);
        const c = posaNelCantiere(ctx.session.cantiere, raccolto);
        if (c.annotate) ctx.log(`[Cantiere] ${c.annotate} voci raccolte da ${name}, senza chiederlo a nessuno`);

        // ── La contabilita' della ricerca ──
        //
        // Cosa ho gia' chiesto, dove sono gia' stato, cosa non ha reso. E' la
        // parte che un modello perde per strada quando il contesto si riempie,
        // ed e' il motivo per cui trentuno ricerche di voli hanno ripetuto le
        // stesse domande per cinque giorni.
        if (!ctx.session.indagine) ctx.session.indagine = new Indagine();
        const ind = ctx.session.indagine;
        if (name === 'google_search' && args && args.query) {
          const r = ind.cercato(args.query);
          if (!r.nuova) ctx.log(`[Ricerca] gia' chiesto lo stesso: "${r.gemella}"`);
        }
        const url = (args && args.url) || (ctx.session.lastPage && ctx.session.lastPage.url);
        if (url && ['scrape_url', 'read_page', 'navigate', 'read_table', 'extract_data'].includes(name)) {
          ind.letta(url, c.annotate > 0);
        }
        if (!esito.ok && esito.famiglia === 'STRATEGY') ind.fallita(name, url || '', esito.code);

        // ── Quale sito rende, per quale tipo di lavoro ──
        //
        // Il seme e' la conoscenza di Luca — "google voli e' molto efficiente,
        // poi booking, expedia" — ma l'ordine vero se lo guadagna il campo. Qui
        // si registra solo cio' che gia' sappiamo: la fonte ha prodotto voci
        // oppure no, e quanto ci ha messo.
        if (url && ['scrape_url', 'read_page', 'read_table', 'extract_data'].includes(name)) {
          if (!ctx._fontiPreferite) ctx._fontiPreferite = new FontiPreferite(ctx.dataDir);
          const tipi = tipoDiLavoro((ctx.session.cantiere && ctx.session.cantiere.obiettivo) || '');
          for (const t of (tipi.length ? tipi : ['generico'])) {
            ctx._fontiPreferite.comeEAndata(t, url, c.annotate > 0, _toolLatency);
          }
        }
      }
    } catch (_) { /* raccogliere e' un servizio, non una condizione per lavorare */ }

    try { ctx.SuperMario.logToolExecution(name, args, (_toolResult || '').substring(0, 500), guard.effective_risk, guard.kind, _toolLatency); } catch (_) { /* best-effort */ }
    // P0.2: Persistent audit log
    auditToolCall(name, args, guard.effective_risk, guard.kind, _toolResult, ctx.session?.id);
    // Memoria di sessione (L1): la cronologia di lavoro si costruisce da sé,
    // così COBRA sa cosa ha già fatto senza doverselo ricordare.
    try {
      if (ctx.learningStore) {
        let esito = {};
        try { esito = JSON.parse(_toolResult || '{}'); } catch { esito = {}; }
        ctx.learningStore.registraAzione(name, args, esito);
      }
    } catch (_) { /* la memoria non deve mai bloccare uno strumento */ }
  }
}

module.exports = { executeTool, registerHandlers, validateToolArgs };
