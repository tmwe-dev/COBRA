// modules/tools/executor.js — executeTool() dispatcher + pre/post guards
// Source: server.js lines 4939-7204

const { COBRA_DEFAULTS } = require('../config');
const { spiega } = require('../security/spiegazioni');
const { isDomainWhitelisted } = require('../config/whitelist');
const { auditToolCall, auditSecurityEvent } = require('../security/audit-log');

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

  const _toolExecStart = Date.now();
  let _toolResult;
  try {
    const handler = _handlers[name];
    if (!handler) return JSON.stringify({ error: `Tool "${name}" non implementato` });
    _toolResult = await handler(args, ctx);
    return _toolResult;
  } catch (e) {
    // Adaptive retry: suggerisci alternative in base al tool fallito
    const alternatives = _getAlternativeTools(name);
    const altText = alternatives.length > 0 ? ` Alternative: prova ${alternatives.join(' o ')}.` : '';
    _toolResult = JSON.stringify({ error: `${name}: ${e.message}${altText}` });
    return _toolResult;
  } finally {
    const _toolLatency = Date.now() - _toolExecStart;
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
