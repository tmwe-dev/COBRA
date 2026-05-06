// lib/tools/index.js
// Main tool dispatcher - routes tool calls to category handlers
// CONSISTENT PATTERN: factory modules invoked with deps; plain modules wrapped with (args) => fn(args, deps)

// === PLAIN FUNCTION MODULES (take args, deps as parameters) ===
const { toolNavigate } = require('./navigate');
const { toolGoogleSearch, toolWebSearch } = require('./search');
const { toolReadPage, toolScrapeUrl, toolBatchScrape, toolReadTable } = require('./scrape');

// === FACTORY MODULES (take deps, return tools object) ===
const createInteractTools = require('./interact');
const createReadTools = require('./read');
const createInspectTools = require('./inspect');
const createCommunicateTools = require('./communicate');
const createAdminTools = require('./admin');

/**
 * Creates a bound version of executeTool with access to all dependencies
 * @param {Object} deps - Dependencies object with all helpers and services
 * @returns {Function} Bound executeTool function
 */
function createExecuteToolFactory(deps) {
  // === Invoke factory modules with deps to get tool functions ===
  const interactTools = createInteractTools(deps);
  const readTools = createReadTools(deps);
  const inspectTools = createInspectTools(deps);
  const communicateTools = createCommunicateTools(deps);
  const adminTools = createAdminTools(deps);

  const toolHandlers = {
    // Navigation & Search (plain functions - wrap with deps)
    navigate: (args) => toolNavigate(args, deps),
    google_search: (args) => toolGoogleSearch(args, deps),
    web_search: (args) => toolWebSearch(args, deps),
    scrape_url: (args) => toolScrapeUrl(args, deps),
    batch_scrape: (args) => toolBatchScrape(args, deps),
    read_table: (args) => toolReadTable(args, deps),

    // Read Operations
    read_page: (args) => toolReadPage(args, deps),
    get_page_elements: readTools.toolReadPageElements,
    get_page_snapshot: readTools.toolGetPageSnapshot,
    screenshot: readTools.toolScreenshot,
    scroll_page: readTools.toolScrollPage,
    hover_element: readTools.toolHoverElement,
    wait_for: readTools.toolWaitFor,
    switch_tab: readTools.toolSwitchTab,
    detect_block: readTools.toolDetectBlock,
    verify_action: readTools.toolVerifyAction,
    wait_network_idle: readTools.toolWaitNetworkIdle,

    // Interaction (from factory)
    click_element: interactTools.toolClickElement,
    fill_form: interactTools.toolFillForm,
    type_human: interactTools.toolTypeHuman,
    press_key: interactTools.toolPressKey,
    select_option: interactTools.toolSelectOption,
    select_dropdown: interactTools.toolSelectDropdown,
    set_datepicker: interactTools.toolSetDatepicker,
    drag_drop: interactTools.toolDragDrop,
    upload_file: interactTools.toolUploadFile,
    key_combo: interactTools.toolKeyCombo,
    submit_form: interactTools.toolSubmitForm,
    clipboard_write: interactTools.toolClipboardWrite,

    // Inspect & Execute JS (from factory)
    inspect_dom_js: inspectTools.toolInspectDomJs,
    mutate_dom_js: inspectTools.toolMutateDomJs,
    execute_js: inspectTools.toolExecuteJs,

    // Communication (from factory)
    prepare_email_draft: communicateTools.toolPrepareEmailDraft,
    send_email: communicateTools.toolSendEmail,
    check_emails: communicateTools.toolCheckEmails,
    read_inbox: communicateTools.toolReadInbox,
    linkedin_search: communicateTools.toolLinkedinSearch,
    linkedin_send_message: communicateTools.toolLinkedinSendMessage,
    whatsapp_send: communicateTools.toolWhatsappSend,

    // Admin & Knowledge Base (from factory)
    save_local_file: adminTools.toolSaveLocalFile,
    search_kb: adminTools.toolSearchKb,
    save_kb: adminTools.toolSaveKb,
    kb_update: adminTools.toolUpdateKb,
    kb_delete: adminTools.toolDeleteKb,
    create_task: adminTools.toolCreateTask,
    list_tasks: adminTools.toolListTasks,
    complete_task: adminTools.toolCompleteTask,
    save_memory: adminTools.toolSaveMemory,
    recall_memory: adminTools.toolRecallMemory,
    list_memories: adminTools.toolListMemories,
  };

  return async function executeTool(name, args) {
    const { log, session, wsBroadcast, validateToolArgs, SuperMario, CobraSupervisor, guardToolCall, toolHistory, COBRA_DEFAULTS } = deps;

    // Validate args format
    try { args = validateToolArgs(name, args); } catch (e) { return JSON.stringify({ error: e.message }); }

    // SuperMario hard guards
    const marioValidation = SuperMario.validateToolCall(name, args);
    if (!marioValidation.valid) {
      const blockWarnings = marioValidation.warnings.filter(w =>
        w.startsWith('dangerous_js_pattern') || w.startsWith('send_missing_recipient')
      );
      if (blockWarnings.length > 0) {
        log(`[SuperMario] BLOCKED tool ${name}: ${blockWarnings.join(', ')}`);
        return JSON.stringify({ error: `Tool bloccato: ${blockWarnings.join(', ')}`, blocked: true });
      }
      if (marioValidation.warnings.length > 0) {
        log(`[SuperMario] Tool ${name} warnings: ${marioValidation.warnings.join(', ')}`);
      }
    }

    // Track usage
    const desc = `${name}(${JSON.stringify(args).substring(0, 80)})`;
    toolHistory.push(desc);
    if (toolHistory.length > COBRA_DEFAULTS.ACTION_LOG_MAX_SIZE) toolHistory.shift();

    // Supervisor tracking
    const loopWarning = CobraSupervisor.recordToolCall(name, args);
    if (loopWarning) {
      const msg = loopWarning.message || `Loop circolare rilevato: ${name} chiamato 3 volte con stessi argomenti`;
      return JSON.stringify({ error: msg, warning: loopWarning.warning || 'circular_loop', force_stop: loopWarning.warning === 'force_stop' });
    }

    // Security guard
    const guard = guardToolCall(name, args, 'default', session.currentApprovalToken);
    if (guard.kind === 'reject') {
      log(`[Security] REJECTED ${name}: ${guard.reason}`);
      wsBroadcast({ type: 'tool_rejected', tool: name, reason: guard.reason });
      return JSON.stringify({ error: `Azione rifiutata: ${guard.reason}`, rejected: true });
    }
    if (guard.kind === 'block_for_confirmation') {
      log(`[Security] BLOCKED ${name} (risk=${guard.effective_risk}) — pending_action ${guard.pending_action_id}`);
      wsBroadcast({
        type: 'pending_action',
        id: guard.pending_action_id,
        tool: name,
        risk: guard.effective_risk,
        summary: guard.summary,
        expires_at: guard.expires_at.toISOString(),
        reasons: guard.reasons,
      });
      return JSON.stringify({
        status: 'pending_confirmation',
        pending_action_id: guard.pending_action_id,
        risk_level: guard.effective_risk,
        message: `Azione intercettata. In attesa di conferma utente. ID: ${guard.pending_action_id}`,
        instructions_for_ai: 'NON rigenerare la chiamata con args diversi. Spiega all\'utente cosa stai per fare e attendi conferma.',
      });
    }
    if (guard.effective_risk !== 'read' && guard.effective_risk !== 'inspect') {
      log(`[Security] ALLOW ${name} (risk=${guard.effective_risk}) ${guard.reasons.join(' | ')}`);
    }

    const _toolExecStart = Date.now();
    let _toolResult;
    try {
      const handler = toolHandlers[name];
      if (!handler) {
        return JSON.stringify({ error: `Tool "${name}" non implementato` });
      }
      _toolResult = await handler(args);
    } catch (e) {
      _toolResult = JSON.stringify({ error: `${name}: ${e.message}` });
      log(`[Tool] Exception in ${name}: ${e.message}`);
    } finally {
      // Log execution
      const _toolLatency = Date.now() - _toolExecStart;
      try {
        SuperMario.logToolExecution(name, args, (_toolResult || '').substring(0, 500), guard.effective_risk, guard.kind, _toolLatency);
      } catch (_logErr) { /* non-blocking */ }
      // Auto-save to persistent memory (fire-and-forget)
      try {
        const { PersistentMemory } = deps;
        if (PersistentMemory) {
          PersistentMemory.saveToolAction(name, args, null).catch(() => {});
        }
      } catch (_memErr) { /* non-blocking */ }
    }

    return _toolResult;
  };
}

module.exports = { createExecuteToolFactory };
