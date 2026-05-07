// modules/memory/chat-memory.js — Sliding window + rolling summary (temp-docs inlined)
// Source: server.js lines 1300-1450

class ChatMemory {
  constructor() {
    this.liveWindow = [];
    this.MAX_LIVE = 10;
    this.rollingSummary = '';
    this.MAX_FULL_TOKENS = 150000;
    this.FULL_RECENT = 5;
    this.TARGET_SUMMARY = 25000;
    this._sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  addMessage(role, content, tier = 'full') {
    const msg = { id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9), role, content, tier, timestamp: new Date().toISOString() };
    this.liveWindow.push(msg);
    if (this.liveWindow.length > this.MAX_LIVE) this._consolidateOldest();
    this._safetyCap();
    return msg;
  }

  _consolidateOldest() {
    if (this.liveWindow.length <= this.FULL_RECENT) return;
    const old = this.liveWindow.shift();
    if (!old) return;
    const txt = `[${old.role}]: ${(old.content || '(empty)').substring(0, 200)}`;
    this.rollingSummary = this.rollingSummary ? this.rollingSummary + '\n' + txt : `**Conversation started**\n${txt}`;
    // Trim if too long
    if (this._est(this.rollingSummary) > this.TARGET_SUMMARY) {
      const lines = this.rollingSummary.split('\n');
      let packed = '', est = 0;
      for (const line of lines) { const lt = this._est(line); if (est + lt > this.TARGET_SUMMARY) break; packed += line + '\n'; est += lt; }
      this.rollingSummary = packed.trim() || this.rollingSummary;
    }
  }

  _est(text) { return text ? Math.ceil(text.length / 4) : 0; }

  _safetyCap() {
    const recent = this.liveWindow.slice(-this.FULL_RECENT);
    const fullT = recent.reduce((s, m) => s + this._est(m.content || ''), 0);
    if (fullT > this.MAX_FULL_TOKENS) {
      const toCompress = recent.slice(0, Math.max(1, Math.ceil((fullT - this.MAX_FULL_TOKENS) / 500)));
      for (const m of toCompress) { m.content = (m.content || '').split('\n')[0].substring(0, 100) + '...'; m.tier = 'synthetic'; }
    }
  }

  getAPIMessages() {
    const msgs = [];
    if (this.rollingSummary) {
      msgs.push({ role: 'user', content: `[Riepilogo conversazione precedente]\n${this.rollingSummary}` });
      msgs.push({ role: 'assistant', content: 'Ho presente il contesto della conversazione. Continua pure.' });
    }
    for (const m of this.liveWindow) msgs.push({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content });
    return msgs;
  }

  getPromptContext() {
    return { rollingSummary: this.rollingSummary, liveMessages: this.liveWindow.map(m => ({ role: m.role, content: m.content, tier: m.tier })),
      estimatedLiveTokens: this.liveWindow.reduce((s, m) => s + this._est(m.content || ''), 0) };
  }

  getStats() {
    const lt = this.liveWindow.reduce((s, m) => s + this._est(m.content || ''), 0);
    return { liveWindowCount: this.liveWindow.length, liveTokens: lt, summaryTokens: this._est(this.rollingSummary), sessionId: this._sessionId };
  }

  clear() { this.liveWindow = []; this.rollingSummary = ''; }

  serialize() { return { liveWindow: this.liveWindow, rollingSummary: this.rollingSummary, sessionId: this._sessionId }; }

  static deserialize(data) {
    const cm = new ChatMemory();
    if (data.liveWindow) cm.liveWindow = data.liveWindow;
    if (data.rollingSummary) cm.rollingSummary = data.rollingSummary;
    if (data.sessionId) cm._sessionId = data.sessionId;
    return cm;
  }
}

module.exports = ChatMemory;
