// modules/risk/confirm-summary.js — Build human-readable confirmation summaries
// Source: server.js lines 311-348

function buildConfirmSummary(toolName, toolArgs, riskLevel) {
  switch (toolName) {
    case 'send_email': {
      const to = toolArgs.to || '?';
      const subj = toolArgs.subject || '(senza oggetto)';
      const body = String(toolArgs.body || '').slice(0, 200);
      return `📧 INVIO EMAIL\n→ ${to}\nOggetto: ${subj}\n\n${body}${body.length >= 200 ? '...' : ''}`;
    }
    case 'open_whatsapp': {
      const to = toolArgs.phone || toolArgs.to || '?';
      const text = String(toolArgs.text || '').slice(0, 200);
      return `💬 APRE WHATSAPP\n→ ${to}\n\n${text}`;
    }
    case 'open_linkedin':
      return `🔗 APRE LINKEDIN\n→ ${toolArgs.profile || toolArgs.url || '?'}`;
    case 'linkedin_send_message': {
      const msg = String(toolArgs.message || '').slice(0, 200);
      return `✉️ MSG LINKEDIN\n→ ${toolArgs.url || '?'}\n\n${msg}${msg.length >= 200 ? '...' : ''}`;
    }
    case 'linkedin_connect': {
      const note = toolArgs.note ? `\nNota: ${String(toolArgs.note).slice(0, 150)}` : '';
      return `🤝 COLLEGAMENTO LINKEDIN\n→ ${toolArgs.url || '?'}${note}`;
    }
    case 'whatsapp_send': {
      const text = String(toolArgs.text || '').slice(0, 200);
      return `📱 MSG WHATSAPP\n→ ${toolArgs.phone || '?'}\n\n${text}${text.length >= 200 ? '...' : ''}`;
    }
    case 'kb_delete':
      return `🗑️ CANCELLA KB\nTitolo: ${toolArgs.title || toolArgs.id}\nIRREVERSIBILE`;
    case 'mutate_dom_js':
      return `⚠️ JS MUTATIVO\n\n${String(toolArgs.code || '').slice(0, 300)}`;
    case 'click_element':
      return `🖱️ CLICK su ${toolArgs.selector} (potenziale azione irreversibile)`;
    default:
      return `[${riskLevel.toUpperCase()}] ${toolName}\n${JSON.stringify(toolArgs, null, 2).slice(0, 500)}`;
  }
}

module.exports = { buildConfirmSummary };
