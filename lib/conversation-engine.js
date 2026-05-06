// lib/conversation-engine.js — Main conversation handler
const path = require('path');
const fs = require('fs');

module.exports = function createConversationEngine(deps) {
  const { log, ChatMemory } = deps;

  class ConversationEngine {
    constructor() {
      this.conversations = new Map();
      this.activeConversationId = null;
      this.saveTimeout = null;
      this.summaryThreshold = 10;
      this.chatMemories = new Map();
      this._dataFile = path.join(__dirname, '..', 'data', 'conversations.json');
    }

    async load() {
      try {
        if (fs.existsSync(this._dataFile)) {
          const raw = fs.readFileSync(this._dataFile, 'utf8');
          const data = JSON.parse(raw);
          for (const [id, conv] of Object.entries(data.conversations || {})) {
            this.conversations.set(id, conv);
          }
          this.activeConversationId = data.activeConversationId || null;
          for (const [id, conv] of this.conversations) {
            const cm = new ChatMemory();
            if (conv.messages) {
              for (const msg of conv.messages.slice(-cm.MAX_LIVE || 20)) {
                cm.liveWindow.push({ id: msg.id, role: msg.role, content: msg.content, timestamp: msg.timestamp });
              }
            }
            if (conv.summary) cm.rollingSummary = conv.summary;
            this.chatMemories.set(id, cm);
          }
          log(`[CE] Loaded ${this.conversations.size} conversations`);
        }
      } catch (e) {
        log('[CE] Load error: ' + e.message);
      }
    }

    save() {
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(() => {
        try {
          const dir = path.dirname(this._dataFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const obj = {};
          for (const [id, conv] of this.conversations.entries()) obj[id] = conv;
          fs.writeFileSync(this._dataFile, JSON.stringify({ conversations: obj, activeConversationId: this.activeConversationId }, null, 2));
        } catch (e) {
          log('[CE] Save error: ' + e.message);
        }
        this.saveTimeout = null;
      }, 800);
    }

    createConversation(title, metadata = {}) {
      const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      const now = new Date().toISOString();
      const conversation = { id, title, messages: [], summary: '', metadata, createdAt: now, updatedAt: now };
      this.conversations.set(id, conversation);
      this.activeConversationId = id;
      this.chatMemories.set(id, new ChatMemory());
      this.save();
      return conversation;
    }

    addMessage(convId, role, content, metadata = {}) {
      const conversation = this.conversations.get(convId);
      if (!conversation) throw new Error(`Conversation not found: ${convId}`);
      const message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        role, content, metadata, timestamp: new Date().toISOString()
      };
      conversation.messages.push(message);
      conversation.updatedAt = new Date().toISOString();
      const chatMemory = this.chatMemories.get(convId);
      if (chatMemory) chatMemory.addMessage(role, content);
      if (conversation.messages.length > this.summaryThreshold) this.rollingSummary(convId);
      this.activeConversationId = convId;
      this.save();
      return message;
    }

    getConversation(convId) {
      return this.conversations.get(convId) || null;
    }

    getActiveConversation() {
      if (!this.activeConversationId) return null;
      return this.conversations.get(this.activeConversationId) || null;
    }

    getOrCreateActive(title = 'Conversation') {
      let conv = this.getActiveConversation();
      if (!conv) conv = this.createConversation(title);
      return conv;
    }

    buildContextForAI(convId, maxMessages = 20) {
      const conversation = this.conversations.get(convId);
      if (!conversation) return '';
      let context = '';
      if (conversation.summary) context += `## Prior Context\n${conversation.summary}\n\n`;
      const recentMessages = conversation.messages.slice(-maxMessages);
      if (recentMessages.length > 0) {
        context += `## Recent Messages\n`;
        for (const msg of recentMessages) context += `[${msg.role.toUpperCase()}]: ${msg.content}\n`;
      }
      return context;
    }

    rollingSummary(convId) {
      const conversation = this.conversations.get(convId);
      if (!conversation) return;
      const messages = conversation.messages;
      if (messages.length <= this.summaryThreshold) return;
      try {
        const oldMessages = messages.slice(0, -this.summaryThreshold);
        const recentMessages = messages.slice(-this.summaryThreshold);
        if (oldMessages.length === 0) return;
        let summaryText = `**Summary (${oldMessages.length} messages)**\n`;
        const byRole = {};
        for (const msg of oldMessages) {
          if (!byRole[msg.role]) byRole[msg.role] = [];
          byRole[msg.role].push(msg.content || '(empty)');
        }
        for (const [role, contents] of Object.entries(byRole)) {
          const preview = contents.map(c => String(c).substring(0, 100)).join(' | ');
          summaryText += `- **${role}**: ${preview}\n`;
        }
        conversation.summary = summaryText;
        conversation.updatedAt = new Date().toISOString();
        conversation.messages = recentMessages;
        this.save();
      } catch (err) {
        log('[CE] RollingSummary error: ' + err.message);
      }
    }

    listConversations() {
      return Array.from(this.conversations.values()).sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    }

    deleteConversation(convId) {
      this.conversations.delete(convId);
      this.chatMemories.delete(convId);
      if (this.activeConversationId === convId) this.activeConversationId = null;
      this.save();
    }
  }

  return new ConversationEngine();
};
