// modules/tools/handlers/communication.js — email, whatsapp, linkedin, prepare, human_takeover, extension relay
// Source: server.js lines 6876-7187
const { sanitizeOutboundMessage } = require('../../security/output-sanitizer');
const { leggiPosta } = require('../../utils/imap');

// ── Prepare tools (in-memory drafts) ──
async function prepareEmailDraft(args) {
  return JSON.stringify({ ok: true, type: 'draft', to: args.to, subject: args.subject, body: args.body || '', cc: args.cc || null, note: 'Bozza preparata. Mostra TO, SUBJECT e BODY. Chiedi conferma PRIMA di send_email.' });
}
async function prepareWhatsappMessage(args) {
  return JSON.stringify({ ok: true, type: 'draft', phone: args.phone, text_length: (args.text || '').length, note: 'Testo WhatsApp preparato. Usa open_whatsapp per aprire WhatsApp Web.' });
}
async function prepareLinkedinMessage(args) {
  return JSON.stringify({ ok: true, type: 'draft', recipient: args.recipient, text_length: (args.text || '').length, note: 'Testo LinkedIn preparato. Usa open_linkedin per aprire LinkedIn.' });
}

// ── Human Takeover ──
async function requestHumanTakeover(args, ctx) {
  const reason = args.reason || 'COBRA richiede il tuo intervento sul browser.';

  // L'intervento umano esiste per le cose che l'AI NON PUÒ fare: password,
  // pagamenti, verifiche di identità, decisioni che non le competono.
  //
  // Successo davvero: il lavoro si è fermato dieci minuti in attesa
  // dell'operatore con il motivo "Creazione del report finale in formato
  // Excel" — cioè per fare esattamente il proprio mestiere. L'utente vedeva
  // tutto fermo senza capire perché. Un motivo che non riguarda credenziali,
  // pagamenti o autorizzazioni non è un motivo: è una resa travestita.
  const motiviVeri = /password|credenzial|login|acced|2fa|codice(?:\s+di)?\s+verifica|otp|captcha|pagament|carta|bonifico|autorizza|conferma dell'utente|decisione|firma/i;
  const resaTravestita = /report|file|excel|documento|creazion|scriv|riassun|cerca|ricerca|analisi/i;
  if (!motiviVeri.test(reason) || (resaTravestita.test(reason) && !motiviVeri.test(reason))) {
    ctx.log(`[HumanTakeover] RIFIUTATO: "${reason}" non richiede un umano`);
    return JSON.stringify({
      error: 'INTERVENTO UMANO RIFIUTATO: "' + reason + '" è parte del TUO lavoro, non di quello dell\'utente. '
        + 'L\'intervento umano serve solo per password, pagamenti, codici di verifica o decisioni che non ti competono. '
        + 'Per il report usa crea_report; per i dati usa navigate e read_page. Continua da solo.',
    });
  }

  ctx.log(`[HumanTakeover] Requested: ${reason}`);
  ctx.session.humanTakeover = true;
  ctx.wsBroadcast({ type: 'human_takeover_request', reason, instructions: args.instructions || '', url: ctx.getState('activePage')?.url?.() || null, ts: Date.now() });
  ctx.emitThinking(`⏸️ In attesa dell'operatore: ${reason}`);
  await new Promise(resolve => {
    ctx.session.humanTakeoverResolve = resolve;
    setTimeout(() => { if (ctx.session.humanTakeover) { ctx.session.humanTakeover = false; ctx.session.humanTakeoverResolve = null; ctx.wsBroadcast({ type: 'human_takeover_timeout', ts: Date.now() }); resolve(); } }, 600000);
  });
  try { await ctx.takeActiveScreenshot(ctx.getState('activePage')?.url?.(), ctx.session.lastPage?.title); } catch (_) { /* best-effort */ }
  ctx.wsBroadcast({ type: 'human_takeover_ended', ts: Date.now() });
  return JSON.stringify({ ok: true, message: 'L\'operatore ha completato il suo intervento.', url: ctx.getState('activePage')?.url?.() || null });
}

// ── Email SMTP ──
async function sendEmail(args, ctx) {
  if (!ctx.nodemailer) return JSON.stringify({ error: 'nodemailer non installato.' });
  const smtp = ctx.session.emailConfig;
  if (!smtp?.host) return JSON.stringify({ error: 'SMTP non configurato. Usa /api/config/email.' });
  try {
    // P0.3: Sanitize outbound content
    const bodyScan = sanitizeOutboundMessage(args.body || '', 'email');
    const htmlScan = args.html ? sanitizeOutboundMessage(args.html, 'email') : { text: undefined, blocked: false, warnings: [] };
    if (bodyScan.blocked || htmlScan.blocked) {
      ctx.log(`[Security] Email BLOCKED: ${[...bodyScan.warnings, ...htmlScan.warnings].join('; ')}`);
      return JSON.stringify({ error: 'Contenuto email bloccato per motivi di sicurezza.', warnings: [...bodyScan.warnings, ...htmlScan.warnings] });
    }
    if (bodyScan.warnings.length || htmlScan.warnings.length) ctx.log(`[Security] Email sanitized: ${[...bodyScan.warnings, ...htmlScan.warnings].join('; ')}`);
    const transporter = ctx.nodemailer.createTransport({ host: smtp.host, port: smtp.port || 587, secure: (smtp.port || 587) === 465, auth: { user: smtp.user, pass: smtp.pass }, tls: { rejectUnauthorized: true } });
    const info = await transporter.sendMail({ from: smtp.from || smtp.user, to: args.to, subject: args.subject || '(nessun oggetto)', text: bodyScan.text, html: htmlScan.text, cc: args.cc, bcc: args.bcc });
    ctx.log(`[Email] Sent to ${ctx.sanitizeForLog(args.to)} — ${info.messageId}`);
    return JSON.stringify({ ok: true, to: args.to, subject: args.subject, messageId: info.messageId });
  } catch (e) { return JSON.stringify({ error: `Invio email fallito: ${e.message}` }); }
}

async function checkEmails(args, ctx) {
  const cfg = ctx.session.emailConfig || {};
  // La lettura usa IMAP; se non è configurato si prova a dedurlo dai dati SMTP
  const host = cfg.imapHost || (cfg.host ? cfg.host.replace(/^smtp\./i, 'imap.') : null);
  const user = cfg.imapUser || cfg.user;
  const pass = cfg.imapPass || cfg.pass;

  if (!host || !user || !pass) {
    return JSON.stringify({
      error: 'Casella di posta non configurata.',
      comeRisolvere: 'Imposta imapHost, imapUser e imapPass con POST /api/config/email.',
    });
  }

  ctx.emitReasoning('Controllo la casella di posta...', '📬');
  try {
    const esito = await leggiPosta(
      { host, port: cfg.imapPort || 993, user, pass },
      { limit: args.limit || 10, onlyUnread: args.onlyUnread !== false }
    );
    ctx.log(`[Email] Lette ${esito.messaggi.length} email da ${ctx.sanitizeForLog(host)}`);
    if (esito.messaggi.length === 0) {
      return JSON.stringify({ ok: true, messaggi: [], info: 'Nessuna email non letta.' });
    }
    return JSON.stringify({
      ok: true,
      totaleInCasella: esito.totale,
      nonLette: esito.nonLette,
      messaggi: esito.messaggi,
    });
  } catch (e) {
    ctx.log(`[Email] Lettura fallita: ${e.message}`);
    return JSON.stringify({ error: `Lettura posta fallita: ${e.message}` });
  }
}

// ── WhatsApp ──
async function openWhatsapp(args, ctx) {
  const phone = (args.phone || '').replace(/[\s\-\(\)]/g, '').replace(/^\+/, '');
  const text = args.text || '';
  if (!phone) return JSON.stringify({ error: 'Numero di telefono mancante.' });
  const waUrl = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text)}`;
  ctx.wsBroadcast({ type: 'open_url', url: waUrl, target: 'whatsapp', instructions: 'WhatsApp Web si aprirà con messaggio pre-compilato.' });
  ctx.session.lastPage = { url: waUrl, title: `WhatsApp → ${phone}`, html: '' };
  ctx.wsBroadcast({ type: 'page_loaded', url: waUrl, title: `WhatsApp → ${phone}` });
  return JSON.stringify({ ok: true, channel: 'whatsapp', phone, messageLength: text.length, url: waUrl, action: 'opened_in_browser', note: 'Messaggio pre-compilato. L\'utente deve cliccare Invio.' });
}

// ── LinkedIn ──
async function openLinkedin(args, ctx) {
  const recipient = args.recipient || '', text = args.text || '';
  if (!recipient) return JSON.stringify({ error: 'Destinatario LinkedIn mancante.' });
  let liUrl;
  if (recipient.includes('linkedin.com/in/')) liUrl = recipient;
  else if (recipient.includes('linkedin.com')) liUrl = recipient.startsWith('http') ? recipient : `https://${recipient}`;
  else liUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(recipient)}`;
  if (ctx.isBridgeReady()) {
    try { await ctx.bridgeCommand('navigate', { url: liUrl }); await new Promise(r => setTimeout(r, 3000));
      try { const snap = await ctx.bridgeCommand('get_page_content', { url: liUrl }); if (snap?.ok) ctx.session.lastPage = { url: snap.url || liUrl, title: snap.title || `LinkedIn → ${recipient}`, html: snap.html || '', markdown: snap.markdown || '' }; } catch (_) { /* best-effort */ }
    } catch (_) { ctx.wsBroadcast({ type: 'open_url', url: liUrl, target: 'linkedin' }); }
  } else { ctx.wsBroadcast({ type: 'open_url', url: liUrl, target: 'linkedin' }); }
  if (!ctx.session.lastPage?.url) ctx.session.lastPage = { url: liUrl, title: `LinkedIn → ${recipient}`, html: '' };
  ctx.wsBroadcast({ type: 'page_loaded', url: liUrl, title: `LinkedIn → ${recipient}` });
  return JSON.stringify({ ok: true, channel: 'linkedin', recipient, messageLength: text.length, url: liUrl, action: 'opened_in_browser', note: text ? `LinkedIn aperto su "${recipient}". Trova il profilo, clicca Messaggio, incolla e invia.` : `LinkedIn aperto su "${recipient}".` });
}

// ── Extension-based tools ──
async function linkedinSearch(args, ctx) {
  ctx.emitReasoning('Cerco profili LinkedIn...', '🔍');
  const r = await ctx.extRelay('linkedin', 'searchProfile', { query: args.query });
  if (!r.success) {
    const fallbackUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(args.query)}`;
    if (ctx.isBridgeReady()) { await ctx.bridgeCommand('navigate', { url: fallbackUrl }); await new Promise(r => setTimeout(r, 3000)); return JSON.stringify({ ok: true, fallback: true, url: fallbackUrl, note: 'Estensione non disponibile — aperta ricerca nel browser.' }); }
    return JSON.stringify({ error: `Estensione LinkedIn non disponibile: ${r.error}` });
  }
  return JSON.stringify({ ok: true, ...r });
}

async function linkedinProfile(args, ctx) { ctx.emitReasoning('Estraggo dati profilo LinkedIn...', '👤'); const r = await ctx.extRelay('linkedin', 'extractProfile', { url: args.url }); if (!r.success) return JSON.stringify({ error: `Estrazione fallita: ${r.error}` }); return JSON.stringify({ ok: true, ...r }); }
async function linkedinSendMessage(args, ctx) {
  ctx.emitReasoning('Invio messaggio LinkedIn...', '✉️');
  // P0.3: Sanitize outbound LinkedIn message
  const liScan = sanitizeOutboundMessage(args.message || '', 'linkedin');
  if (liScan.blocked) { ctx.log(`[Security] LinkedIn BLOCKED: ${liScan.warnings.join('; ')}`); return JSON.stringify({ error: 'Contenuto LinkedIn bloccato per motivi di sicurezza.' }); }
  if (liScan.warnings.length) ctx.log(`[Security] LinkedIn sanitized: ${liScan.warnings.join('; ')}`);
  args.message = liScan.text;
  const r = await ctx.extRelay('linkedin', 'sendMessage', { url: args.url, message: args.message }, 30000); if (!r.success) return JSON.stringify({ error: `Invio fallito: ${r.error}` }); return JSON.stringify({ ok: true, channel: 'linkedin', sent: true, ...r });
}
async function linkedinConnect(args, ctx) { ctx.emitReasoning('Invio richiesta collegamento...', '🤝'); const r = await ctx.extRelay('linkedin', 'sendConnectionRequest', { url: args.url, note: args.note || '' }, 30000); if (!r.success) return JSON.stringify({ error: `Richiesta fallita: ${r.error}` }); return JSON.stringify({ ok: true, channel: 'linkedin', ...r }); }
async function linkedinInbox(args, ctx) { ctx.emitReasoning('Leggo inbox LinkedIn...', '📬'); const r = await ctx.extRelay('linkedin', 'readLinkedInInbox', {}); if (!r.success) return JSON.stringify({ error: `Lettura inbox fallita: ${r.error}` }); return JSON.stringify({ ok: true, ...r }); }
async function linkedinReadThread(args, ctx) { ctx.emitReasoning('Leggo conversazione LinkedIn...', '💬'); const r = await ctx.extRelay('linkedin', 'readLinkedInThread', { threadUrl: args.threadUrl }); if (!r.success) return JSON.stringify({ error: `Lettura thread fallita: ${r.error}` }); return JSON.stringify({ ok: true, ...r }); }
async function whatsappSend(args, ctx) {
  ctx.emitReasoning('Invio messaggio WhatsApp...', '📱');
  // P0.3: Sanitize outbound WhatsApp text
  const waScan = sanitizeOutboundMessage(args.text || '', 'whatsapp');
  if (waScan.blocked) { ctx.log(`[Security] WhatsApp BLOCKED: ${waScan.warnings.join('; ')}`); return JSON.stringify({ error: 'Contenuto WhatsApp bloccato per motivi di sicurezza.' }); }
  if (waScan.warnings.length) ctx.log(`[Security] WhatsApp sanitized: ${waScan.warnings.join('; ')}`);
  args.text = waScan.text;
  const r = await ctx.extRelay('whatsapp', 'sendWhatsApp', { phone: args.phone, text: args.text }, 30000);
  if (!r.success) { const waUrl = `https://web.whatsapp.com/send?phone=${encodeURIComponent(args.phone)}&text=${encodeURIComponent(args.text)}`; ctx.wsBroadcast({ type: 'open_url', url: waUrl, target: 'whatsapp' }); return JSON.stringify({ ok: true, fallback: true, url: waUrl, note: 'Estensione non disponibile — aperto WhatsApp Web.' }); }
  return JSON.stringify({ ok: true, channel: 'whatsapp', sent: true, ...r });
}
async function whatsappUnread(args, ctx) { ctx.emitReasoning('Leggo messaggi non letti...', '📱'); const r = await ctx.extRelay('whatsapp', 'readUnread', {}); if (!r.success) return JSON.stringify({ error: `Lettura fallita: ${r.error}` }); return JSON.stringify({ ok: true, ...r }); }
async function whatsappReadThread(args, ctx) { ctx.emitReasoning('Leggo chat WhatsApp...', '💬'); const r = await ctx.extRelay('whatsapp', 'readThread', { contact: args.contact, maxMessages: args.maxMessages || 50 }); if (!r.success) return JSON.stringify({ error: `Lettura chat fallita: ${r.error}` }); return JSON.stringify({ ok: true, ...r }); }

module.exports = {
  prepare_email_draft: prepareEmailDraft, prepare_whatsapp_message: prepareWhatsappMessage, prepare_linkedin_message: prepareLinkedinMessage,
  request_human_takeover: requestHumanTakeover,
  send_email: sendEmail, check_emails: checkEmails, read_inbox: checkEmails,
  open_whatsapp: openWhatsapp, send_whatsapp: openWhatsapp,
  open_linkedin: openLinkedin, send_linkedin: openLinkedin,
  linkedin_search: linkedinSearch, linkedin_profile: linkedinProfile, linkedin_send_message: linkedinSendMessage,
  linkedin_connect: linkedinConnect, linkedin_inbox: linkedinInbox, linkedin_read_thread: linkedinReadThread,
  whatsapp_send: whatsappSend, whatsapp_unread: whatsappUnread, whatsapp_read_thread: whatsappReadThread,
};
