// lib/tools/communicate.js — Communication tools
module.exports = function createCommunicateTools(deps) {
  const { log, emitThinking, bridgeReady, bridgeCommand } = deps;

  async function toolPrepareEmailDraft(args) {
    emitThinking(`Preparing email draft to ${args.to}...`);
    const draft = { to: args.to, subject: args.subject, body: args.body, status: 'draft' };
    return JSON.stringify({ ok: true, draft, message: 'Draft prepared (not sent)' });
  }

  async function toolSendEmail(args) {
    emitThinking(`Sending email to ${args.to}...`);
    if (!args.to || !args.subject || !args.body) {
      return JSON.stringify({ error: 'Missing: to, subject, or body' });
    }
    try {
      if (bridgeReady()) {
        const result = await bridgeCommand('send_email', { to: args.to, subject: args.subject, body: args.body });
        return JSON.stringify({ ok: result.ok, message: result.ok ? 'Email sent' : 'Send failed', via: 'bridge' });
      }
      log(`[Email] Would send to ${args.to}: "${args.subject}"`);
      return JSON.stringify({ ok: true, message: 'Email queued (no SMTP configured)' });
    } catch (e) {
      return JSON.stringify({ error: `Send failed: ${e.message}` });
    }
  }

  async function toolCheckEmails(args) {
    emitThinking('Checking emails...');
    if (bridgeReady()) {
      try {
        const result = await bridgeCommand('check_emails', { limit: args.limit || 10 });
        return JSON.stringify({ ok: result.ok, emails: result.emails || [], count: (result.emails || []).length });
      } catch (e) { }
    }
    return JSON.stringify({ ok: true, emails: [], count: 0, message: 'No IMAP configured' });
  }

  async function toolReadInbox(args) {
    return toolCheckEmails(args);
  }

  async function toolLinkedinSearch(args) {
    emitThinking(`Searching LinkedIn for: ${args.query}...`);
    if (bridgeReady()) {
      try {
        const result = await bridgeCommand('linkedin_search', { query: args.query });
        return JSON.stringify({ ok: result.ok, results: result.results || [], count: (result.results || []).length });
      } catch (e) { }
    }
    return JSON.stringify({ ok: true, results: [], count: 0, message: 'LinkedIn extension not available' });
  }

  async function toolLinkedinSendMessage(args) {
    emitThinking(`Sending LinkedIn message...`);
    if (bridgeReady()) {
      try {
        const result = await bridgeCommand('linkedin_send_message', { profileId: args.profileId, message: args.message });
        return JSON.stringify({ ok: result.ok, message: result.ok ? 'Message sent' : 'Send failed' });
      } catch (e) { }
    }
    return JSON.stringify({ error: 'LinkedIn extension not available' });
  }

  async function toolWhatsappSend(args) {
    emitThinking(`Sending WhatsApp to ${args.phone}...`);
    if (bridgeReady()) {
      try {
        const result = await bridgeCommand('whatsapp_send', { phone: args.phone, message: args.message });
        return JSON.stringify({ ok: result.ok, message: result.ok ? 'Message sent' : 'Send failed' });
      } catch (e) { }
    }
    return JSON.stringify({ error: 'WhatsApp extension not available' });
  }

  return {
    toolPrepareEmailDraft, toolSendEmail, toolCheckEmails, toolReadInbox,
    toolLinkedinSearch, toolLinkedinSendMessage, toolWhatsappSend,
  };
};
