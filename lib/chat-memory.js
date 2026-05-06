/**
 * lib/chat-memory.js
 * 3-tier chat memory (live messages, rolling summary, temp documents)
 * ~140 lines
 */

class ChatMemory {
  constructor() {
    this.liveWindow = [];
    this.MAX_LIVE = 10;
    this.rollingSummary = '';
    this.tempDocs = new Map();
    this.MAX_SUMMARY_TOKENS = 40000;
    this.REPACK_THRESHOLD = 40000;
    this.TARGET_SUMMARY = 25000;
    this.MAX_FULL_TOKENS = 150000;
    this.FULL_RECENT = 5;
    this._sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  addMessage(role, content, tier = 'full') {
    const message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      role, content, tier,
      timestamp: new Date().toISOString(),
    };
    this.liveWindow.push(message);
    if (this.liveWindow.length > this.MAX_LIVE) this._consolidateOldest();
    if (this._estimateTokens(this.rollingSummary) > this.REPACK_THRESHOLD) this._repackSummary();
    this._safetyCap();
    return message;
  }

  _consolidateOldest() {
    if (this.liveWindow.length <= this.FULL_RECENT) return;
    const oldMsg = this.liveWindow.shift();
    if (!oldMsg) return;
    const msgText = `[${oldMsg.role}]: ${oldMsg.content || '(empty)'}`;
    if (!this.rollingSummary || this.rollingSummary.trim() === '') {
      this.rollingSummary = `**Conversation started**\n${msgText}`;
    } else {
      this._extendRollingSummary(msgText);
    }
  }

  _extendRollingSummary(newMessage) {
    const lines = this.rollingSummary.split('\n');
    const summary = lines.slice(0, Math.min(5, lines.length)).join('\n');
    this.rollingSummary = summary + '\n' + newMessage;
    if (this._estimateTokens(this.rollingSummary) > this.TARGET_SUMMARY) this._repackSummary();
  }

  _repackSummary() {
    if (this._estimateTokens(this.rollingSummary) <= this.TARGET_SUMMARY) return;
    const lines = this.rollingSummary.split('\n');
    let packed = '';
    let estimatedTokens = 0;
    for (const line of lines) {
      const lineTokens = this._estimateTokens(line);
      if (estimatedTokens + lineTokens > this.TARGET_SUMMARY) break;
      packed += line + '\n';
      estimatedTokens += lineTokens;
    }
    this.rollingSummary = packed.trim() || this.rollingSummary;
  }

  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  _safetyCap() {
    const recentFullMsgs = this.liveWindow.slice(-this.FULL_RECENT);
    const fullTokens = recentFullMsgs.reduce((sum, m) => sum + this._estimateTokens(m.content || ''), 0);
    if (fullTokens > this.MAX_FULL_TOKENS) {
      const excess = fullTokens - this.MAX_FULL_TOKENS;
      const toCompress = recentFullMsgs.slice(0, Math.max(1, Math.ceil(excess / 500))).map(m => m.id);
      for (const msgId of toCompress) {
        const msg = this.liveWindow.find(m => m.id === msgId);
        if (msg) {
          const synth = (msg.content || '').split('\n')[0];
          msg.content = synth.length > 100 ? synth.substr(0, 100) + '...' : synth;
          msg.tier = 'synthetic';
        }
      }
    }
  }

  getPromptContext() {
    return {
      rollingSummary: this.rollingSummary,
      liveMessages: this.liveWindow.map(m => ({ role: m.role, content: m.content, tier: m.tier })),
      estimatedLiveTokens: this.liveWindow.reduce((sum, m) => sum + this._estimateTokens(m.content || ''), 0),
    };
  }

  addLongDocument(text, title = 'document') {
    const tokenCount = this._estimateTokens(text);
    if (tokenCount <= 800) return null;
    const docId = 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const words = text.split(/\s+/).length;
    this.tempDocs.set(docId, { id: docId, content: text, title, words, tokenCount, createdAt: new Date().toISOString() });
    return `[document:${docId} - ${title} - ${words} words]`;
  }

  readTempDoc(id) {
    const doc = this.tempDocs.get(id);
    if (!doc) return null;
    doc.lastAccessedAt = new Date().toISOString();
    return { id: doc.id, content: doc.content, title: doc.title, words: doc.words };
  }

  clearOldTempDocs(hoursOld = 24) {
    const now = Date.now();
    const threshold = hoursOld * 60 * 60 * 1000;
    for (const [id, doc] of this.tempDocs.entries()) {
      if (now - new Date(doc.createdAt).getTime() > threshold) this.tempDocs.delete(id);
    }
  }

  getStats() {
    const liveTokens = this.liveWindow.reduce((sum, m) => sum + this._estimateTokens(m.content || ''), 0);
    const summaryTokens = this._estimateTokens(this.rollingSummary);
    return {
      liveWindowCount: this.liveWindow.length, liveTokens, summaryTokens,
      totalTokens: liveTokens + summaryTokens, tempDocsCount: this.tempDocs.size,
      sessionId: this._sessionId,
    };
  }

  getAPIMessages() {
    const msgs = [];
    if (this.rollingSummary) {
      msgs.push({ role: 'user', content: `[Riepilogo conversazione precedente]\n${this.rollingSummary}` });
      msgs.push({ role: 'assistant', content: 'Ho presente il contesto della conversazione. Continua pure.' });
    }
    for (const m of this.liveWindow) {
      msgs.push({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content });
    }
    return msgs;
  }

  clear() {
    this.liveWindow = [];
    this.rollingSummary = '';
    this.tempDocs.clear();
  }

  serialize() {
    return {
      liveWindow: this.liveWindow, rollingSummary: this.rollingSummary,
      tempDocs: Array.from(this.tempDocs.entries()).map(([id, doc]) => ({
        id, title: doc.title, words: doc.words, tokenCount: doc.tokenCount, createdAt: doc.createdAt
      })),
      sessionId: this._sessionId,
    };
  }

  static deserialize(data) {
    const cm = new ChatMemory();
    if (data.liveWindow) cm.liveWindow = data.liveWindow;
    if (data.rollingSummary) cm.rollingSummary = data.rollingSummary;
    if (data.sessionId) cm._sessionId = data.sessionId;
    return cm;
  }
}

module.exports = { ChatMemory };
