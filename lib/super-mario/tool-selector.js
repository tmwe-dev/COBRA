// ══════════════════════════════════════════════════════════════
// lib/super-mario/tool-selector.js — Tool selection & scope mapping
// ══════════════════════════════════════════════════════════════

module.exports = function createToolSelector(deps) {
  const { log, TOOL_RISK, computeEffectiveRisk, detectDangerousJs, TOOL_RISK_TAXONOMY } = deps;

  // ── 1. RUNTIME CONTRACT (codice, NON prompt — non bypassabile) ──
  const RUNTIME_CONTRACT = {
    maxToolChainPerTurn: 25,
    bannedToolPatterns: ['delete_task'],
    writeTools: ['save_to_kb', 'kb_update', 'kb_delete', 'create_file', 'save_local_file', 'save_memory', 'create_task',
                 'prepare_email_draft', 'prepare_whatsapp_message', 'prepare_linkedin_message'],
    sendTools: ['send_email', 'open_whatsapp', 'open_linkedin', 'linkedin_send_message', 'linkedin_connect', 'whatsapp_send'],
    destructiveTools: ['delete_task'],
    readTools: ['navigate', 'google_search', 'read_page', 'scrape_url', 'screenshot', 'get_page_elements', 'get_page_snapshot',
                'crawl_website', 'extract_data', 'read_table', 'search_kb', 'list_tasks', 'list_local_files',
                'read_local_file', 'search_local_files', 'batch_scrape', 'scroll_page', 'check_emails',
                'detect_block', 'verify_action', 'wait_network_idle',
                'linkedin_search', 'linkedin_profile', 'linkedin_inbox', 'linkedin_read_thread',
                'whatsapp_unread', 'whatsapp_read_thread'],
    interactTools: ['click_element', 'fill_form', 'inspect_dom_js', 'mutate_dom_js', 'hover_element', 'drag_drop', 'upload_file', 'switch_tab', 'wait_for', 'select_option', 'press_key',
                    'type_human', 'key_combo', 'select_dropdown', 'set_datepicker', 'clipboard_write', 'request_human_takeover'],
    executeTools: ['run_task'],
  };

  // ── 2. TOOL SCOPE — sottoinsiemi per intent ──
  const TOOL_SCOPES = {
    chat: [],
    search: ['google_search', 'navigate', 'read_page', 'scrape_url', 'batch_scrape', 'read_table'],
    browse: ['navigate', 'read_page', 'screenshot', 'scroll_page', 'get_page_elements', 'get_page_snapshot', 'read_table',
             'detect_block', 'verify_action', 'wait_network_idle', 'request_human_takeover'],
    interact: ['navigate', 'click_element', 'fill_form', 'inspect_dom_js', 'mutate_dom_js', 'scroll_page', 'screenshot', 'get_page_elements', 'get_page_snapshot', 'read_page',
               'hover_element', 'drag_drop', 'upload_file', 'switch_tab', 'wait_for', 'select_option', 'press_key',
               'type_human', 'key_combo', 'select_dropdown', 'set_datepicker', 'clipboard_write',
               'detect_block', 'verify_action', 'wait_network_idle', 'request_human_takeover'],
    data: ['extract_data', 'read_table', 'crawl_website', 'batch_scrape', 'create_file', 'scrape_url', 'navigate', 'read_page'],
    admin: ['save_to_kb', 'kb_update', 'kb_delete', 'create_task', 'run_task', 'list_tasks', 'delete_task', 'save_memory', 'search_kb', 'list_local_files'],
    file: ['list_local_files', 'read_local_file', 'save_local_file', 'search_local_files', 'create_file'],
    communicate: ['send_email', 'open_whatsapp', 'open_linkedin', 'prepare_email_draft', 'prepare_whatsapp_message', 'prepare_linkedin_message', 'check_emails',
                   'linkedin_search', 'linkedin_profile', 'linkedin_send_message', 'linkedin_connect', 'linkedin_inbox', 'linkedin_read_thread',
                   'whatsapp_send', 'whatsapp_unread', 'whatsapp_read_thread'],
    full: null,
  };

  // ── 3. TOOL RISK REGISTRY ──
  const TOOL_RISK_REGISTRY = {};
  RUNTIME_CONTRACT.readTools.forEach(t => TOOL_RISK_REGISTRY[t] = { level: 'read', confirm: false });
  RUNTIME_CONTRACT.interactTools.forEach(t => TOOL_RISK_REGISTRY[t] = { level: 'write', confirm: false });
  RUNTIME_CONTRACT.executeTools.forEach(t => TOOL_RISK_REGISTRY[t] = { level: 'write', confirm: false });
  RUNTIME_CONTRACT.writeTools.forEach(t => TOOL_RISK_REGISTRY[t] = { level: 'write', confirm: false });
  RUNTIME_CONTRACT.sendTools.forEach(t => TOOL_RISK_REGISTRY[t] = { level: 'send', confirm: true });
  RUNTIME_CONTRACT.destructiveTools.forEach(t => TOOL_RISK_REGISTRY[t] = { level: 'destructive', confirm: true });

  // ── SELECT TOOLS per scope ──
  function selectTools(scopes, allTools) {
    if (!scopes || scopes.includes('chat')) return [];
    const selectedNames = new Set();
    for (const scope of scopes) {
      const scopeTools = TOOL_SCOPES[scope];
      if (scopeTools === null) {
        return allTools;
      }
      if (scopeTools) scopeTools.forEach(t => selectedNames.add(t));
    }
    return allTools.filter(t => selectedNames.has(t.function.name));
  }

  // ── 7. HARD GUARDS (codice, NON prompt) ──
  function validateToolCall(toolName, toolArgs) {
    const warnings = [];

    const spec = TOOL_RISK_TAXONOMY[toolName];
    if (!spec) {
      warnings.push(`unknown_tool:${toolName} (trattato come destructive)`);
    }

    const risk = computeEffectiveRisk(toolName, toolArgs);
    if (risk.requires_confirmation) {
      warnings.push(`requires_confirmation:${toolName}:${risk.level}`);
    }

    if ((toolName === 'inspect_dom_js' || toolName === 'mutate_dom_js' || toolName === 'execute_js') && toolArgs?.code) {
      if (toolArgs.code.length > 10000) warnings.push('js_code_too_long');
      const dangerous = detectDangerousJs(toolArgs.code);
      if (dangerous.length > 0) {
        warnings.push(`dangerous_js_pattern:${dangerous.join(',')}`);
      }
    }

    if (toolName === 'send_email' || toolName === 'open_whatsapp' || toolName === 'open_linkedin') {
      if (!toolArgs?.to && !toolArgs?.phone && !toolArgs?.recipient) {
        warnings.push('send_missing_recipient');
      }
    }

    return { valid: warnings.length === 0, warnings };
  }

  return {
    selectTools,
    validateToolCall,
    RUNTIME_CONTRACT,
    TOOL_SCOPES,
    TOOL_RISK_REGISTRY,
  };
};
