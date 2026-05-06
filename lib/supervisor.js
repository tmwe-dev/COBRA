// ══════════════════════════════════════════════════════════════
// lib/supervisor.js — CobraSupervisor object
// Extracted from server.js lines 2559-2750
// ══════════════════════════════════════════════════════════════

module.exports = function createSupervisor(deps) {
  const { log } = deps;

  const CobraSupervisor = {
    _status: 'idle', // idle/running/stuck/completed/failed/aborted
    _requestStart: null,
    _lastActivity: Date.now(),
    _errorCount: 0,
    _errorWindowStart: Date.now(),
    _toolCallLog: [],
    _watchdogTimer: null,
    IDLE_TIMEOUT: 30000,

    startRequest(id, message) {
      this._status = 'running';
      this._requestStart = Date.now();
      this._lastActivity = Date.now();
      this._toolCallLog = [];
      this._inspectionBlocked = false;
      this._consecutiveBlocks = 0;
      this._failedToolCount = 0;
      this._totalToolCount = 0;
      this._navDomainCount = {};
      this._startWatchdog();
      log('[Supervisor] Request started');
    },

    completeRequest(result) {
      this._status = 'completed';
      this._stopWatchdog();
      const elapsed = Date.now() - (this._requestStart || Date.now());
      log(`[Supervisor] Request completed in ${elapsed}ms`);
    },

    failRequest(error) {
      this._status = 'failed';
      this._stopWatchdog();
      this._trackError();
      log(`[Supervisor] Request failed: ${error}`);
    },

    abort() {
      this._status = 'aborted';
      this._stopWatchdog();
      log('[Supervisor] Request aborted');
    },

    _inspectionBlocked: false,
    _consecutiveBlocks: 0,
    _failedToolCount: 0,
    _totalToolCount: 0,

    recordToolCall(toolName, toolArgs) {
      this._totalToolCount++;
      this._lastActivity = Date.now();
      const argsKey = JSON.stringify(toolArgs || {});
      this._toolCallLog.push({ tool: toolName, args: argsKey, ts: Date.now() });

      const inspectionTools = new Set(['get_page_elements', 'scroll_page', 'screenshot', 'read_page', 'hover_element', 'inspect_dom_js', 'wait_for', 'switch_tab', 'detect_block', 'verify_action', 'read_table', 'wait_network_idle']);
      const actionTools = new Set(['fill_form', 'click_element', 'select_option', 'type_human', 'press_key', 'drag_drop', 'upload_file', 'key_combo', 'select_dropdown', 'set_datepicker', 'navigate', 'mutate_dom_js', 'clipboard_write']);

      if (actionTools.has(toolName)) {
        this._inspectionBlocked = false;
        this._consecutiveBlocks = 0;
      }

      if (this._inspectionBlocked && inspectionTools.has(toolName)) {
        this._consecutiveBlocks++;
        if (this._consecutiveBlocks >= 3) {
          log(`[Supervisor] HARD ABORT: AI ignored 3 inspection blocks`);
          return { warning: 'force_stop', tool: toolName, message: 'ABORT FORZATO: Hai ignorato 3 blocchi. DEVI usare tool di AZIONE o fermarti.' };
        }
        log(`[Supervisor] BLOCKED: ${toolName} (block #${this._consecutiveBlocks})`);
        return { warning: 'inspection_blocked', tool: toolName, message: `BLOCCATO: usa SOLO tool di azione (fill_form, click_element, type_human).` };
      }

      if (toolName === 'scroll_page') {
        const lastTools = this._toolCallLog.slice(-4);
        const scrollCount = lastTools.filter(t => t.tool === 'scroll_page').length;
        if (scrollCount >= 3) {
          this._inspectionBlocked = true;
          log(`[Supervisor] SCROLL LOOP: 3+ scrolls without action`);
          return { warning: 'force_stop', tool: toolName, message: 'STOP SCROLL: Hai scrollato 3+ volte. I campi sono visibili. USA fill_form o type_human ADESSO.' };
        }
      }

      if (toolName === 'click_element') {
        const recent = this._toolCallLog.slice(-3);
        const prevClicks = recent.filter(t => t.tool === 'click_element').length;
        if (prevClicks >= 2) {
          log(`[Supervisor] BLIND CLICK: ${prevClicks} consecutive clicks`);
          return { warning: 'blind_click', tool: toolName, message: 'STOP: Hai cliccato ' + prevClicks + ' volte. Dopo OGNI click fai get_page_snapshot.' };
        }
      }

      const last4 = this._toolCallLog.slice(-4);
      if (last4.length >= 4 && last4.every(t => inspectionTools.has(t.tool))) {
        this._inspectionBlocked = true;
        log(`[Supervisor] INSPECTION LOOP: 4 consecutive inspection tools`);
        return { warning: 'inspection_loop', tool: toolName, message: 'LOOP: 4 tool di ispezione. DEVI agire: fill_form, click_element, type_human.' };
      }

      if (this._totalToolCount > 20) {
        log(`[Supervisor] HARD LIMIT: ${this._totalToolCount} tool calls`);
        return { warning: 'force_stop', tool: toolName, message: 'STOP: Hai fatto troppi tentativi. Fermati e rispondi all\'utente.' };
      }

      if (this._failedToolCount >= 5) {
        log(`[Supervisor] FAILURE LIMIT: ${this._failedToolCount} consecutive failures`);
        return { warning: 'force_stop', tool: toolName, message: 'STOP: 5 tool falliti. Rispondi all\'utente spiegando il problema.' };
      }

      const recent = this._toolCallLog.slice(-3);
      if (recent.length === 3 && recent.every(t => t.tool === toolName && t.args === argsKey)) {
        log(`[Supervisor] Circular loop: ${toolName} called 3x with same args`);
        return { warning: 'circular_loop', tool: toolName };
      }

      const toolNames = this._toolCallLog.map(t => t.tool);
      for (const seqLen of [2, 3, 4]) {
        if (toolNames.length >= seqLen * 3) {
          const lastSeq = toolNames.slice(-seqLen);
          let repeats = 0;
          for (let i = toolNames.length - seqLen; i >= 0; i -= seqLen) {
            const chunk = toolNames.slice(i, i + seqLen);
            if (chunk.length === seqLen && chunk.every((t, j) => t === lastSeq[j])) {
              repeats++;
            } else break;
          }
          if (repeats >= 2) {
            const pattern = lastSeq.join('→');
            log(`[Supervisor] SEQUENCE LOOP: [${pattern}] repeated ${repeats + 1}x`);
            return { warning: 'force_stop', tool: toolName, message: `LOOP DI SEQUENZA: stai ripetendo [${pattern}] ${repeats + 1} volte. FERMATI SUBITO.` };
          }
        }
      }

      return null;
    },

    _trackError() {
      const now = Date.now();
      if (now - this._errorWindowStart > 30000) {
        this._errorCount = 0;
        this._errorWindowStart = now;
      }
      this._errorCount++;
      if (this._errorCount >= 3) {
        log('[Supervisor] WARNING: 3+ errors in 30s');
      }
    },

    _startWatchdog() {
      this._stopWatchdog();
      this._watchdogTimer = setInterval(() => {
        if (this._status !== 'running') return;
        const idle = Date.now() - this._lastActivity;
        if (idle > this.IDLE_TIMEOUT) {
          log(`[Supervisor] WARNING: Idle for ${Math.round(idle / 1000)}s`);
          this._status = 'stuck';
        }
      }, 10000);
    },

    _stopWatchdog() {
      if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    },

    getStatus() {
      return {
        status: this._status,
        elapsed: this._requestStart ? Date.now() - this._requestStart : 0,
        toolCalls: this._toolCallLog.length,
        errorCount: this._errorCount,
      };
    },
  };

  return CobraSupervisor;
};
