// modules/supervisor/cobra.js — CobraSupervisor health monitoring
// Source: server.js lines 2729-2920

const INSPECTION_TOOLS = new Set(['get_page_elements','scroll_page','screenshot','read_page','hover_element','inspect_dom_js','wait_for','switch_tab','detect_block','verify_action','read_table','wait_network_idle','get_page_snapshot']);
const ACTION_TOOLS = new Set(['fill_form','click_element','select_option','type_human','press_key','drag_drop','upload_file','key_combo','select_dropdown','set_datepicker','navigate','mutate_dom_js','clipboard_write']);

const CobraSupervisor = {
  _status: 'idle', _requestStart: null, _lastActivity: Date.now(),
  _errorCount: 0, _errorWindowStart: Date.now(), _toolCallLog: [],
  _watchdogTimer: null, IDLE_TIMEOUT: 30000,
  _inspectionBlocked: false, _consecutiveBlocks: 0,
  _failedToolCount: 0, _totalToolCount: 0, _navDomainCount: {},

  startRequest() {
    this._status = 'running'; this._requestStart = Date.now(); this._lastActivity = Date.now();
    this._toolCallLog = []; this._inspectionBlocked = false; this._consecutiveBlocks = 0;
    this._failedToolCount = 0; this._totalToolCount = 0; this._navDomainCount = {};
    this._startWatchdog();
  },
  completeRequest() { this._status = 'completed'; this._stopWatchdog(); },
  failRequest(err) { this._status = 'failed'; this._stopWatchdog(); this._trackError(); },
  abort() { this._status = 'aborted'; this._stopWatchdog(); },

  recordToolCall(toolName, toolArgs) {
    this._totalToolCount++; this._lastActivity = Date.now();
    const argsKey = JSON.stringify(toolArgs || {});
    this._toolCallLog.push({ tool: toolName, args: argsKey, ts: Date.now() });

    // Reset inspection block on action
    if (ACTION_TOOLS.has(toolName)) { this._inspectionBlocked = false; this._consecutiveBlocks = 0; }

    // HARD BLOCK: inspection after block
    if (this._inspectionBlocked && INSPECTION_TOOLS.has(toolName)) {
      this._consecutiveBlocks++;
      if (this._consecutiveBlocks >= 3) return { warning: 'force_stop', tool: toolName, message: 'ABORT FORZATO: Hai ignorato 3 blocchi consecutivi. DEVI usare un tool di AZIONE oppure fermati.' };
      return { warning: 'inspection_blocked', tool: toolName, message: `BLOCCATO: puoi usare SOLO tool di azione. Tool di ispezione (${toolName}) vietati.` };
    }

    // Scroll loop: 3+ scrolls without action
    if (toolName === 'scroll_page') {
      const last4 = this._toolCallLog.slice(-4);
      if (last4.filter(t => t.tool === 'scroll_page').length >= 3) {
        this._inspectionBlocked = true;
        return { warning: 'force_stop', tool: toolName, message: 'STOP SCROLL: 3+ scroll senza azione. USA fill_form o type_human ADESSO.' };
      }
    }

    // Anti-blind-click: 2+ clicks without snapshot
    if (toolName === 'click_element') {
      const recent = this._toolCallLog.slice(-3);
      if (recent.filter(t => t.tool === 'click_element').length >= 2) {
        return { warning: 'blind_click', tool: toolName, message: 'STOP: Hai cliccato ' + recent.filter(t => t.tool === 'click_element').length + ' volte senza aggiornare la vista. Fai get_page_snapshot o screenshot ORA.' };
      }
    }

    // 4 consecutive inspection tools
    const last4 = this._toolCallLog.slice(-4);
    if (last4.length >= 4 && last4.every(t => INSPECTION_TOOLS.has(t.tool))) {
      this._inspectionBlocked = true;
      return { warning: 'inspection_loop', tool: toolName, message: 'LOOP RILEVATO: 4 tool ispezione consecutivi. DEVI agire: fill_form, click_element, type_human.' };
    }

    // Hard limit: 20+ total calls
    // Confrontare tre o quattro fonti richiede facilmente una ventina di
    // passi fra navigazioni, letture e screenshot: con il limite a 20 il
    // lavoro veniva troncato a metà proprio sulle richieste più utili.
    if (this._totalToolCount > 32) return { warning: 'force_stop', tool: toolName, message: 'STOP: Hai fatto troppi tentativi (' + this._totalToolCount + '). Fermati e rispondi con quello che hai raccolto.' };

    // 5+ consecutive failures
    if (this._failedToolCount >= 5) return { warning: 'force_stop', tool: toolName, message: 'STOP: 5 tool consecutivi falliti. Fai screenshot() e rispondi.' };

    // Circular loop: same tool+args 3x
    const recent3 = this._toolCallLog.slice(-3);
    if (recent3.length === 3 && recent3.every(t => t.tool === toolName && t.args === argsKey)) {
      return { warning: 'circular_loop', tool: toolName };
    }

    // Loop di sequenza.
    //
    // Il confronto avviene su tool E argomenti. Guardando solo i nomi, la
    // sequenza navigate→read_page ripetuta su TRE SITI DIVERSI veniva scambiata
    // per un loop e il lavoro si interrompeva: ma confrontare più fonti è
    // esattamente ciò che si chiede a una segretaria. Un loop vero è tornare
    // sulla STESSA pagina, non visitarne di nuove.
    const passi = this._toolCallLog.map(t => `${t.tool}:${t.args}`);
    for (const seqLen of [2, 3, 4]) {
      if (passi.length >= seqLen * 3) {
        const ultima = passi.slice(-seqLen);
        let ripetizioni = 0;
        for (let i = passi.length - seqLen; i >= 0; i -= seqLen) {
          const blocco = passi.slice(i, i + seqLen);
          if (blocco.length === seqLen && blocco.every((p, j) => p === ultima[j])) ripetizioni++;
          else break;
        }
        if (ripetizioni >= 2) {
          const schema = ultima.map(p => p.split(':')[0]).join('→');
          return { warning: 'force_stop', tool: toolName, message: `LOOP DI SEQUENZA: [${schema}] ripetuto ${ripetizioni + 1}x sugli stessi argomenti. FERMATI.` };
        }
      }
    }
    return null;
  },

  _trackError() {
    const now = Date.now();
    if (now - this._errorWindowStart > 30000) { this._errorCount = 0; this._errorWindowStart = now; }
    this._errorCount++;
  },
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (this._status !== 'running') return;
      if (Date.now() - this._lastActivity > this.IDLE_TIMEOUT) this._status = 'stuck';
    }, 10000);
  },
  _stopWatchdog() { if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; } },
  getStatus() {
    return { status: this._status, elapsed: this._requestStart ? Date.now() - this._requestStart : 0, toolCalls: this._toolCallLog.length, errorCount: this._errorCount };
  },
};

module.exports = { CobraSupervisor };
