// modules/memory/conversation.js — ConversationEngine (merged conversation-context.js)
// Source: server.js lines 1300-1500

const path = require('path');
const fs = require('fs');
const ChatMemory = require('./chat-memory');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

class ConversationEngine {
  constructor() {
    this.conversations = new Map();
    this.activeConversationId = null;
    this.saveTimeout = null;
    this.summaryThreshold = 10;
    this._summarizingConversations = new Set();
    this.chatMemories = new Map();
    // data/ nella radice del progetto, insieme a memorie, task e audit.
    // __dirname è modules/memory, quindi servono due livelli su.
    this._dataFile = path.join(__dirname, '..', '..', 'data', 'conversations.json');
    // Percorso storico errato (modules/data/): da migrare una tantum
    this._legacyFile = path.join(__dirname, '..', 'data', 'conversations.json');
  }

  /** Sposta il file dalla vecchia posizione se la nuova non esiste ancora. */
  _migrateLegacy() {
    try {
      if (fs.existsSync(this._dataFile) || !fs.existsSync(this._legacyFile)) return;
      fs.mkdirSync(path.dirname(this._dataFile), { recursive: true });
      fs.copyFileSync(this._legacyFile, this._dataFile);
      fs.renameSync(this._legacyFile, this._legacyFile + '.migrato');
      console.log('[Persistenza] conversations.json migrato in data/');
    } catch { /* migrazione best-effort: in caso di errore si riparte dal file nuovo */ }
  }

  async load() {
    try {
      this._migrateLegacy();
      const data = readJsonSafeSync(this._dataFile, null);
      if (!data) return;
      this.conversations.clear();
      for (const [id, conv] of Object.entries(data.conversations || {})) this.conversations.set(id, conv);
      this.activeConversationId = data.activeConversationId || null;
      for (const [id, conv] of this.conversations) {
        const cm = new ChatMemory();
        if (conv.messages) for (const msg of conv.messages.slice(-cm.MAX_LIVE)) cm.liveWindow.push({ id: msg.id, role: msg.role, content: msg.content, tier: 'full', timestamp: msg.timestamp });
        if (conv.summary) cm.rollingSummary = conv.summary;
        this.chatMemories.set(id, cm);
      }
    } catch { /* conversations file missing or corrupt — start fresh */ }
  }

  /** Scrittura immediata e atomica (usata allo shutdown e dal debounce). */
  saveNow() {
    if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }
    const obj = {};
    for (const [id, conv] of this.conversations.entries()) obj[id] = conv;
    return writeJsonAtomicSync(this._dataFile, {
      conversations: obj,
      activeConversationId: this.activeConversationId,
    });
  }

  save() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    // Debounce ridotto: con la scrittura atomica il costo è contenuto e si
    // riduce la finestra in cui un crash perderebbe l'ultimo messaggio.
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveNow();
    }, 250);
  }

  createConversation(title, metadata = {}) {
    const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();
    const conv = { id, title, messages: [], summary: '', metadata, createdAt: now, updatedAt: now };
    this.conversations.set(id, conv);
    this.activeConversationId = id;
    this.chatMemories.set(id, new ChatMemory());
    this.save();
    return conv;
  }

  addMessage(convId, role, content, metadata = {}, tier = 'full') {
    const conv = this.conversations.get(convId);
    if (!conv) throw new Error(`Conversazione non trovata: ${convId}`);
    const msg = { id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9), role, content, metadata, timestamp: new Date().toISOString() };
    conv.messages.push(msg);
    conv.updatedAt = new Date().toISOString();
    const cm = this.chatMemories.get(convId);
    if (cm) cm.addMessage(role, content, tier);
    if (conv.messages.length > this.summaryThreshold) this._rollingSummary(convId);
    this.activeConversationId = convId;
    this.save();
    return msg;
  }

  // ── Context building (was conversation-context.js) ──
  _rollingSummary(convId) {
    const conv = this.conversations.get(convId);
    if (!conv || this._summarizingConversations.has(convId)) return;
    const messages = conv.messages;
    if (messages.length <= this.summaryThreshold) return;
    this._summarizingConversations.add(convId);
    try {
      const oldMessages = messages.slice(0, -this.summaryThreshold);
      if (oldMessages.length === 0) return;
      let summaryText = `**Riassunto (${oldMessages.length} messaggi)**\n`;
      const byRole = {};
      for (const msg of oldMessages) { if (!byRole[msg.role]) byRole[msg.role] = []; byRole[msg.role].push(msg.content || '(empty)'); }
      for (const [role, contents] of Object.entries(byRole)) {
        summaryText += `- **${role}**: ${contents.map(c => String(c).substring(0, 100)).join(' | ')}\n`;
      }
      conv.summary = summaryText;
      conv.messages = messages.slice(-this.summaryThreshold);
      conv.updatedAt = new Date().toISOString();
      this.save();
    } finally { this._summarizingConversations.delete(convId); }
  }

  buildContextForAI(convId, maxMessages = 20) {
    const conv = this.conversations.get(convId);
    if (!conv) return '';
    let context = '';
    if (conv.summary) context += `## Contesto Precedente\n${conv.summary}\n\n`;
    const recent = conv.messages.slice(-maxMessages);
    if (recent.length > 0) { context += `## Messaggi Recenti\n`; for (const msg of recent) context += `[${msg.role.toUpperCase()}]: ${msg.content}\n`; }
    return context;
  }

  getPromptContext(convId) { const cm = this.chatMemories.get(convId); return cm ? cm.getPromptContext() : null; }
  getConversation(convId) { return this.conversations.get(convId) || null; }
  getActiveConversation() { return this.activeConversationId ? this.conversations.get(this.activeConversationId) || null : null; }
  getOrCreateActive(title = 'Conversazione') { return this.getActiveConversation() || this.createConversation(title); }
  listConversations() { return Array.from(this.conversations.values()).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)); }
  deleteConversation(convId) { this.conversations.delete(convId); this.chatMemories.delete(convId); if (this.activeConversationId === convId) this.activeConversationId = null; this.save(); }
}

module.exports = ConversationEngine;
