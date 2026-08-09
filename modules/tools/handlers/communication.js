// modules/tools/handlers/communication.js — email, whatsapp, linkedin, prepare, human_takeover, extension relay
// Source: server.js lines 6876-7187
const { sanitizeOutboundMessage } = require('../../security/output-sanitizer');
const { leggiPosta } = require('../../utils/imap');

// ══════════════════════════════════════════════════════════════════════
// UNA SOLA STRADA: IL PONTE DI COBRA
//
// C'erano DUE ponti verso il browser, e uno era un fantasma.
//
//   ctx.bridgeCommand      → l'estensione COBRA. Collegata, funziona, la si
//                             vede lavorare: apre le schede, legge il DOM,
//                             scrive con il ritmo umano.
//   ctx.extRelay           → un'ALTRA estensione, che riceveva i comandi
//                             via postMessage con
//                             `direction: from-webapp-li`. Sul computer di
//                             Luca nessuno ascolta su quel canale.
//
// L'8 agosto: quattro tentativi di mandare una richiesta di collegamento a
// Brandon Dvorak, quattro "Extension timeout". Nessun errore, nessuna pagina
// che si apre, solo un'attesa a vuoto — perche' il comando partiva verso
// un'estensione che non c'e'. Luca l'ha visto prima di me: "io non vedo
// cercare su linkedin la pagina corretta". Non la cercava nessuno.
//
// Tre strumenti passavano SOLO di li' (linkedin_profile, linkedin_connect,
// whatsapp_unread): non potevano riuscire, mai, in nessun caso. Altri quattro
// tenevano il fantasma come riserva, e una riserva che non risponde non e' una
// rete di sicurezza: e' un minuto e mezzo buttato prima di dire "non ce l'ho
// fatta".
//
// Da qui in avanti si passa da un ponte solo. Se non risponde, si dice.
// Il controllo che lo fa rispettare sta in tests/test-un-ponte-solo.js.
// ══════════════════════════════════════════════════════════════════════

/** Il ponte di COBRA, con la risposta gia' scartata dall'involucro. */
async function _ponte(ctx, comando, args = {}) {
  if (!ctx.isBridgeReady || !ctx.isBridgeReady()) {
    return { ok: false, motivo: 'il browser non e\' collegato', cosaFare: 'Apri COBRA nel browser e riprova.' };
  }
  try {
    const r = await ctx.bridgeCommand(comando, args);
    return (r && r.result) || r || { ok: false, motivo: 'il ponte non ha risposto' };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}


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
  const query = String(args.query || '').trim();
  if (!query) return JSON.stringify({ ok: false, motivo: 'non mi hai detto cosa cercare' });
  ctx.emitReasoning(`Cerco "${query}" su LinkedIn...`, '🔍');
  const d = await _ponte(ctx, 'linkedin_cerca', { query, quanti: Number(args.quanti) || 10 });
  if (d.ok) await _mostraPagina(ctx, `LinkedIn — ricerca "${query}"`, d.url || 'https://www.linkedin.com/search/results/people/');
  return JSON.stringify(d);
}

async function linkedinProfile(args, ctx) {
  const url = String(args.url || args.profilo || '').trim();
  if (!/linkedin\.com\/(in|pub)\//i.test(url)) {
    return JSON.stringify({ ok: false, motivo: 'serve l\'indirizzo di un profilo LinkedIn' });
  }
  ctx.emitReasoning('Leggo il profilo LinkedIn...', '👤');
  const d = await _ponte(ctx, 'linkedin_profilo', { url });
  if (d.ok) await _mostraPagina(ctx, `LinkedIn — ${d.nome || 'profilo'}`, d.url || url);
  return JSON.stringify(d);
}
async function linkedinSendMessage(args, ctx) {
  ctx.emitReasoning('Invio messaggio LinkedIn...', '✉️');
  // P0.3: Sanitize outbound LinkedIn message
  const liScan = sanitizeOutboundMessage(args.message || '', 'linkedin');
  if (liScan.blocked) { ctx.log(`[Security] LinkedIn BLOCKED: ${liScan.warnings.join('; ')}`); return JSON.stringify({ error: 'Contenuto LinkedIn bloccato per motivi di sicurezza.' }); }
  if (liScan.warnings.length) ctx.log(`[Security] LinkedIn sanitized: ${liScan.warnings.join('; ')}`);
  args.message = liScan.text;
  // Fuori da ogni ambito: chi scrive su LinkedIn passa da linkedin_scrivi,
  // che ha le regole, la verifica del destinatario e il registro. Questo
  // resta solo per i flussi interni e per l'ambito 'full'.
  return JSON.stringify({
    ok: false,
    motivo: 'strada dismessa: usa linkedin_scrivi (regole, verifica del destinatario, registro)',
  });
}
// ── L'invito passa dalle stesse regole del messaggio ──
//
// Stava fuori dagli ambiti, e c'era un test a tenerlo fuori: "invito senza
// regole". Era vero — chiamava l'estensione e basta, senza limiti, senza
// registro, senza ritmo. La stessa porta di servizio da cui il 7 agosto sono
// usciti sette messaggi fuori conteggio.
//
// Ma a Luca serve poter chiedere un collegamento, e la risposta a "questa
// strada e' senza guardrail" non e' chiudere la strada: e' metterci il
// guardrail. Ora l'invito fa lo stesso percorso del messaggio — RegoleInvio
// prima, pausa umana, registro dopo — e puo' stare in 'communicate' senza
// riaprire il buco.
async function linkedinConnect(args, ctx) {
  const url = String(args.url || args.profilo || args.a || args.nome || '').trim();
  const nota = String(args.note || args.nota || args.testo || '');
  if (!url) return JSON.stringify({ ok: false, motivo: 'non mi hai detto a chi' });

  const { RegoleInvio, pausaProssima } = require('../../security/regole-invio');
  const modo = ctx.session?.automatico === true ? 'automatico' : 'diretto';
  const R = ctx._regoleLi || (ctx._regoleLi = new RegoleInvio(ctx.dataDir, 'linkedin'));

  const verdetto = R.puoScrivere({ a: url, testo: nota, conosciuto: true, modo });
  if (!verdetto.si) {
    ctx.emitReasoning(`Non invito: ${verdetto.motivo}`, '\u{1F6D1}');
    return JSON.stringify({ ok: false, bloccato: true, motivo: verdetto.motivo, cosaFare: verdetto.cosaFare });
  }

  const pausa = pausaProssima('linkedin', modo);
  ctx.emitReasoning(`Aspetto ${pausa}s prima di chiedere il collegamento`, '\u23F3');
  await new Promise(r => setTimeout(r, pausa * 1000));

  ctx.emitReasoning('Apro il profilo e chiedo il collegamento...', '\u{1F91D}');
  const d = await _ponte(ctx, 'linkedin_collegati', { url, nota });

  if (!d.ok) {
    ctx.log(`[LinkedIn] Invito NON partito verso ${ctx.sanitizeForLog ? ctx.sanitizeForLog(url) : url}: ${d.motivo || 'senza motivo'}`);
    return JSON.stringify(d);
  }

  // Si registra solo dopo che la pagina ha confermato: un invito segnato e
  // mai partito e' peggio di uno partito e non segnato.
  R.registra({ a: d.a || url, testo: nota || '[invito]' });
  await _mostraPagina(ctx, `LinkedIn — ${d.a || 'profilo'}`, d.url || url);
  return JSON.stringify(d);
}
// ── La posta di LinkedIn ──
//
// Passava da readLinkedInInbox, il lettore del Navigator. Misurato sulla
// messaggistica vera di Luca il 7 agosto: 26 righe per 12 conversazioni (ogni
// persona due volte, la seconda vuota), etichette come "Messaggio InMail" e
// "Stato: offline" scambiate per contatti, e 28 secondi — perche' il metodo
// principale scade (optimus_inbox_timeout_12000ms) e ripiega sul vecchio.
//
// Il lettore nuovo sta nell'estensione (linkedin_elenco_chat), e' scritto
// guardando il DOM vero e sulla stessa pagina fa 10 conversazioni pulite in
// 0,1 secondi. Da qui in avanti si usa quello. Il vecchio resta come riserva:
// se l'estensione non e' collegata, meglio un dato sporco che nessun dato.
async function linkedinInbox(args, ctx) {
  ctx.emitReasoning('Leggo la posta LinkedIn...', '📬');

  if (ctx.isBridgeReady && ctx.isBridgeReady()) {
    try {
      const r = await ctx.bridgeCommand('linkedin_elenco_chat', { quante: Number(args.quante) || 50 });
      const d = r?.result || r;
      if (d?.ok && Array.isArray(d.chat)) {
        const sospetto = await _vuotoSospetto(ctx, d.chat.length, 'conversazioni LinkedIn');
        if (sospetto) return JSON.stringify(sospetto);
        _annota(ctx, d.chat.map(c => ({ ...c, haScritto: true })), 'linkedin');
        const titolo = `LinkedIn — ${d.conversazioni} conversazioni, ${d.conNonLetti} da leggere`;
        // La foto arriva dall'estensione: e' della scheda che ha letto davvero,
        // non della scheda attiva (che di solito e' COBRA stesso).
        if (d.screenshot) {
          ctx.session.lastScreenshotData = d.screenshot;
          ctx.session.lastPage = { url: d.url || 'https://www.linkedin.com/messaging/', title: titolo, html: '' };
          ctx.wsBroadcast({ type: 'screenshot', data: d.screenshot, url: d.url || '', title: titolo });
          ctx.wsBroadcast({ type: 'page_loaded', url: d.url || '', title: titolo });
        }
        await _mostraPagina(ctx, titolo, d.url || 'https://www.linkedin.com/messaging/');
        return JSON.stringify({
          ok: true,
          conversazioni: d.conversazioni,
          conNonLetti: d.conNonLetti,
          chat: d.chat,
          nota: d.nota,
        });
      }
      // Non e' andata: si dice perche' invece di ripiegare in silenzio.
      if (d && d.motivo) ctx.emitReasoning(`Lettore nuovo: ${d.motivo}`, '⚠️');
    } catch (e) {
      ctx.log(`[LinkedIn] lettore nuovo fallito (${e.message}), provo il vecchio`);
    }
  }

  // Qui finiva la riserva sul ponte fantasma. Non c'e' una seconda strada:
  // se il ponte di COBRA non ce l'ha fatta, si dice.
  return JSON.stringify({
    ok: false,
    motivo: `non sono riuscito a leggere la posta LinkedIn`,
    cosaFare: 'Controlla che la pagina sia aperta e l\'accesso fatto, poi riprova.',
  });
  _annota(ctx, _personeDa(r), 'linkedin');
  return JSON.stringify({ ok: true, ...r });
}
// ── Entrare nella conversazione, non fermarsi all'anteprima ──
//
// Passava da readLinkedInThread, che vuole un threadUrl. Quel dato la
// messaggistica non lo espone (verificato: zero link nelle righe della lista),
// quindi questo strumento non era chiamabile e COBRA restava fermo alle
// anteprime: centocinquanta caratteri tagliati, da cui uscivano riepiloghi
// tipo "ha inviato un allegato".
//
// Adesso si apre per NOME e si leggono i messaggi veri.
async function linkedinReadThread(args, ctx) {
  const chi = String(args.nome || args.contact || args.threadUrl || '').trim();
  ctx.emitReasoning(`Apro la conversazione con ${chi || 'il contatto'}...`, '💬');

  if (chi && ctx.isBridgeReady && ctx.isBridgeReady()) {
    try {
      const r = await ctx.bridgeCommand('linkedin_leggi_conversazione', { nome: chi, quanti: Number(args.quanti) || 30 });
      const d = r?.result || r;
      if (d?.ok) {
        const titolo = `LinkedIn — ${d.conversazione}, ${d.quanti} messaggi`;
        if (d.screenshot) {
          ctx.session.lastScreenshotData = d.screenshot;
          ctx.session.lastPage = { url: d.url || '', title: titolo, html: '' };
          ctx.wsBroadcast({ type: 'screenshot', data: d.screenshot, url: d.url || '', title: titolo });
          ctx.wsBroadcast({ type: 'page_loaded', url: d.url || '', title: titolo });
        } else {
          // Niente foto: si dice dov'era la pagina, invece di lasciare il
          // pannello nero e muto. Il titolo e l'indirizzo sono veri comunque.
          ctx.wsBroadcast({ type: 'page_loaded', url: d.url || '', title: titolo });
          if (d.notaFoto) ctx.emitReasoning(d.notaFoto, '📷');
        }
        _annota(ctx, [{ nome: d.conversazione, haScritto: true }], 'linkedin');
        await _mostraPagina(ctx, titolo, d.url || 'https://www.linkedin.com/messaging/');
        return JSON.stringify(d);
      }
      // Ambiguo o non trovato: si riferisce, non si tira a indovinare.
      if (d && (d.ambiguo || d.disponibili)) return JSON.stringify(d);
      if (d && d.motivo) ctx.emitReasoning(d.motivo, '⚠️');
    } catch (e) {
      ctx.log(`[LinkedIn] apertura conversazione fallita: ${e.message}`);
    }
  }

  // Qui finiva la riserva sul ponte fantasma. Non c'e' una seconda strada:
  // se il ponte di COBRA non ce l'ha fatta, si dice.
  return JSON.stringify({
    ok: false,
    motivo: `non sono riuscito a leggere la conversazione LinkedIn`,
    cosaFare: 'Controlla che la pagina sia aperta e l\'accesso fatto, poi riprova.',
  });
  _annota(ctx, _personeDa(r), 'linkedin');
  return JSON.stringify({ ok: true, ...r });
}
async function whatsappSend(args, ctx) {
  ctx.emitReasoning('Invio messaggio WhatsApp...', '📱');
  // P0.3: Sanitize outbound WhatsApp text
  const waScan = sanitizeOutboundMessage(args.text || '', 'whatsapp');
  if (waScan.blocked) { ctx.log(`[Security] WhatsApp BLOCKED: ${waScan.warnings.join('; ')}`); return JSON.stringify({ error: 'Contenuto WhatsApp bloccato per motivi di sicurezza.' }); }
  if (waScan.warnings.length) ctx.log(`[Security] WhatsApp sanitized: ${waScan.warnings.join('; ')}`);
  args.text = waScan.text;
  // Fuori da ogni ambito dal 7 agosto: da qui erano usciti sette messaggi
  // senza regole e senza registro. Chi scrive passa da whatsapp_scrivi.
  return JSON.stringify({
    ok: false,
    motivo: 'strada dismessa: usa whatsapp_scrivi (regole, verifica del destinatario, registro)',
  });
}
// ── Leggere serve anche a ricordare ──
//
// Ogni lettura passa davanti a nomi e numeri veri, e prima li buttava. Da qui
// in poi finiscono in rubrica: e' cosi' che "manda un messaggio a Jose" smette
// di richiedere una scansione di tutto WhatsApp per finire in venti omonimi.
//
// Non fallisce mai per colpa della rubrica: se annotare non riesce, la lettura
// viene restituita lo stesso.
// ── Far vedere dove sta guardando ──
//
// Il pannello a destra dice "Qui vedrai cosa fa COBRA in tempo reale", e
// durante una lettura di WhatsApp o LinkedIn restava nero. Non era rotto:
// nessuno gli mandava niente. Le foto le spediva solo browser-control.js,
// cioe' i tool che navigano; i lettori passano dall'estensione e non
// spedivano nulla.
//
// Il risultato pratico e' che Luca vedeva comparire un elenco di messaggi
// senza nessuna prova di dove fosse stato preso. Con la foto della pagina
// vera, l'elenco si puo' controllare a occhio in un secondo.
async function _mostraPagina(ctx, titolo, url) {
  // ── Anche una chat e' una fonte ──
  //
  // Il 7 agosto crea_report e' fallito sette volte di fila con "Mancano le
  // fonti: senza gli indirizzi letti il documento non e' verificabile". Il
  // report prende le fonti da ctx.session.pagineDelTurno, che si riempie solo
  // con navigate: leggere LinkedIn dall'estensione non registrava niente,
  // quindi fonti = [] e il documento veniva rifiutato SEMPRE.
  //
  // La regola e' giusta — un documento senza fonti non si firma — ma era
  // scritta pensando alle ricerche sul web. Una conversazione LinkedIn letta
  // dalla pagina vera e' una fonte quanto un sito: va registrata, non aggirata.
  try {
    if (url) {
      if (!Array.isArray(ctx.session.pagineDelTurno)) ctx.session.pagineDelTurno = [];
      if (!ctx.session.pagineDelTurno.some(p => (p.url || p) === url)) {
        ctx.session.pagineDelTurno.push({ url, title: titolo });
      }
    }
  } catch (_) { /* non deve mai impedire la lettura */ }

  try {
    if (!ctx.isBridgeReady || !ctx.isBridgeReady()) return;
    const r = await ctx.bridgeCommand('screenshot', { quality: 60 });
    const d = r?.result || r;
    if (d?.ok && d.screenshot) {
      ctx.session.lastScreenshotData = d.screenshot;
      ctx.session.lastPage = { url: url || '', title: titolo, html: '' };
      ctx.wsBroadcast({ type: 'screenshot', data: d.screenshot, url: url || '', title: titolo });
      ctx.wsBroadcast({ type: 'page_loaded', url: url || '', title: titolo });
    }
  } catch (_) { /* la foto e' un di piu': se non viene, la lettura vale uguale */ }
}

// ── Un vuoto sospetto non e' un vuoto ──
//
// Domanda di Luca: se il DOM cambia, COBRA se ne deve accorgere.
//
// Il guasto tipico dello scraping e' silenzioso: un selettore che non trova
// niente restituisce una lista vuota, e "lista vuota" e' indistinguibile da
// "non c'e' niente". Cosi' COBRA riferiva "non hai messaggi non letti" a uno
// che ne aveva otto — con la stessa serenita' con cui avrebbe detto la verita'.
//
// Qui si distinguono i due casi. Zero conversazioni su WhatsApp o LinkedIn non
// e' un risultato plausibile: quelle liste non sono mai vuote per davvero. Se
// escono zero, la pagina e' cambiata, e si dice — con la diagnosi accanto,
// cosi' il selettore nuovo si scrive guardando cosa c'e' invece di indovinare.
async function _vuotoSospetto(ctx, quante, cosa) {
  if (quante > 0) return null;
  ctx.emitReasoning(`Zero ${cosa}: non e' un numero credibile, controllo se la pagina e' cambiata`, '🔎');
  let diagnosi = null;
  try {
    const r = await ctx.bridgeCommand('diagnosi_selettori', {});
    diagnosi = r?.result || r;
  } catch (_) { /* senza diagnosi si avvisa lo stesso */ }
  return {
    ok: false,
    paginaCambiata: true,
    motivo: `Ho letto la pagina e ho trovato zero ${cosa}. Quella lista non e' mai `
      + 'vuota davvero: quasi sempre vuol dire che il sito ha cambiato struttura e '
      + 'non riconosco piu\' dove stanno le cose.',
    cosaDire: 'Dillo a Luca cosi\' com\'e\': NON dire che non ci sono messaggi, perche\' '
      + 'non lo sai. Di\' che il sito e\' cambiato e che i selettori vanno aggiornati.',
    diagnosi,
  };
}

function _annota(ctx, elenco, canale) {
  try {
    const { Rubrica } = require('../../security/rubrica');
    const R = new Rubrica(ctx.dataDir || './data');
    const n = R.daLettura(elenco, canale);
    if (n > 0) ctx.emitReasoning(`Segnati ${n} contatti in rubrica (${R.quante()} in tutto)`, '📇');
    return n;
  } catch (_) { return 0; }
}

// Da una risposta dell'estensione, le persone. I moduli copiati usano nomi di
// campo diversi a seconda di chi li ha scritti: si guardano tutti invece di
// scommettere su uno.
function _personeDa(r) {
  for (const c of ['chat', 'chats', 'contacts', 'messages', 'conversations', 'threads', 'items']) {
    if (Array.isArray(r[c]) && r[c].length) return r[c];
  }
  return [];
}

async function whatsappUnread(args, ctx) {
  ctx.emitReasoning('Leggo i messaggi non letti...', '📱');
  const d = await _ponte(ctx, 'whatsapp_non_letti', { quanti: Number(args.quanti) || 50 });
  if (d.ok) {
    _annota(ctx, _personeDa(d), 'whatsapp');
    await _mostraPagina(ctx, 'WhatsApp — messaggi non letti', d.url || 'https://web.whatsapp.com/');
  }
  return JSON.stringify(d);
}

// ── Entrare nella chat WhatsApp ──
//
// Passava da readThread del Navigator, che non ha mai potuto funzionare:
// chiama _pageOpenAndReadThread e _pageDomReadMessages, due funzioni che non
// esistono in nessun file. Ogni chiamata finiva nel catch e tornava
// { success: false }, e il fallimento sembrava un problema di sessione.
//
// Il lettore nuovo sta nell'estensione, scritto guardando la pagina vera.
async function whatsappReadThread(args, ctx) {
  const chi = String(args.contact || args.nome || '').trim();
  ctx.emitReasoning(`Apro la chat con ${chi || 'il contatto'}...`, '💬');

  if (chi && ctx.isBridgeReady && ctx.isBridgeReady()) {
    try {
      const r = await ctx.bridgeCommand('whatsapp_leggi_conversazione',
        { nome: chi, quanti: Number(args.maxMessages) || 40 });
      const d = r?.result || r;
      if (d?.ok) {
        const titolo = `WhatsApp — ${d.conversazione}, ${d.quanti} messaggi`;
        if (d.screenshot) {
          ctx.session.lastScreenshotData = d.screenshot;
          ctx.session.lastPage = { url: d.url || 'https://web.whatsapp.com/', title: titolo, html: '' };
          ctx.wsBroadcast({ type: 'screenshot', data: d.screenshot, url: d.url || '', title: titolo });
        }
        ctx.wsBroadcast({ type: 'page_loaded', url: d.url || 'https://web.whatsapp.com/', title: titolo });
        if (!d.screenshot && d.notaFoto) ctx.emitReasoning(d.notaFoto, '📷');
        _annota(ctx, [{ nome: d.conversazione, haScritto: true }], 'whatsapp');
        await _mostraPagina(ctx, titolo, d.url || 'https://web.whatsapp.com/');
        return JSON.stringify(d);
      }
      // Ambiguo o non trovato: si riferisce, non si tira a indovinare.
      if (d && (d.ambiguo || d.disponibili)) return JSON.stringify(d);
      if (d && d.motivo) ctx.emitReasoning(d.motivo, '⚠️');
    } catch (e) {
      ctx.log(`[WhatsApp] apertura chat fallita: ${e.message}`);
    }
  }

  // Qui finiva la riserva sul ponte fantasma. Non c'e' una seconda strada:
  // se il ponte di COBRA non ce l'ha fatta, si dice.
  return JSON.stringify({
    ok: false,
    motivo: `non sono riuscito a leggere la chat WhatsApp`,
    cosaFare: 'Controlla che la pagina sia aperta e l\'accesso fatto, poi riprova.',
  });
  // Se ho aperto la sua chat e c'e' dentro qualcosa, quella persona esiste e
  // ci siamo scritti: e' l'informazione piu' affidabile che passa di qui.
  if (args.contact) {
    _annota(ctx, [{ nome: args.contact, haScritto: true, numero: r.phone || r.numero || null }], 'whatsapp');
  }
  _annota(ctx, _personeDa(r), 'whatsapp');
  return JSON.stringify({ ok: true, ...r });
}

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
