// modules/routes/config.js — /api/config/keys, /api/config/email

const { trovaServerPosta } = require('../utils/mail-autoconfig');
const { leggiPosta } = require('../utils/imap');

function register(router, ctx) {
  // ── POST /api/config/keys ──
  router.post('/api/config/keys', (body, res) => {
    try {
      const cfg = JSON.parse(body);
      if (cfg.openai) ctx.aiKeys.openaiKey = cfg.openai;
      if (cfg.anthropic) ctx.aiKeys.anthropicKey = cfg.anthropic;
      if (cfg.gemini) ctx.aiKeys.geminiKey = cfg.gemini;
      if (cfg.groq) ctx.aiKeys.groqKey = cfg.groq;
      if (cfg.elevenlabs) ctx.aiKeys.elevenlabsKey = cfg.elevenlabs;
      if (cfg.openaiModel) ctx.aiKeys.openaiModel = cfg.openaiModel;
      if (cfg.anthropicModel) ctx.aiKeys.anthropicModel = cfg.anthropicModel;
      if (cfg.geminiModel) ctx.aiKeys.geminiModel = cfg.geminiModel;
      const active = Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key') && ctx.aiKeys[k]).map(k => k.replace('Key', ''));
      ctx.log(`[API Keys] Configurate: ${active.join(', ')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providers: active }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'JSON non valido' }));
    }
  });

  // ── GET /api/config/keys ──
  router.get('/api/config/keys', (body, res) => {
    const active = Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key') && ctx.aiKeys[k]).map(k => k.replace('Key', ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ providers: active, hasKeys: active.length > 0 }));
  });

  // ── POST /api/config/email ──
  router.post('/api/config/email', (body, res) => {
    try {
      const cfg = JSON.parse(body);
      ctx.session.emailConfig = { ...ctx.session.emailConfig, ...cfg };
      ctx.log('[Email Config] Updated: ' + Object.keys(cfg).join(', '));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, configured: Object.keys(ctx.session.emailConfig) }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'JSON non valido' }));
    }
  });

  // ── POST /api/config/email/setup ──
  // L'utente fornisce solo indirizzo e password: i server vengono trovati da
  // soli, le credenziali provate subito e salvate solo se funzionano.
  router.post('/api/config/email/setup', async (body, res) => {
    const rispondi = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    let email, password;
    try {
      const b = JSON.parse(body || '{}');
      email = (b.email || '').trim();
      password = b.password || '';
    } catch { return rispondi(400, { error: 'Richiesta non valida' }); }

    if (!email || !password) {
      return rispondi(400, { error: 'Servono indirizzo email e password' });
    }

    try {
      // 1. Trova i server
      const scoperta = await trovaServerPosta(email);
      ctx.log(`[Email] Rilevamento per ${ctx.sanitizeForLog(email)}: ${scoperta.imapHost} (${scoperta.fonte})`);

      // 2. Prova davvero le credenziali prima di salvarle
      let verifica;
      try {
        verifica = await leggiPosta(
          { host: scoperta.imapHost, port: scoperta.imapPort, user: email, pass: password },
          { limit: 1, onlyUnread: false, timeoutMs: 12000 }
        );
      } catch (e) {
        const msg = String(e.message || '');
        const credenzialiRifiutate = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|autentic/i.test(msg);
        return rispondi(200, {
          ok: false,
          server: { imapHost: scoperta.imapHost, imapPort: scoperta.imapPort, fonte: scoperta.fonte, provider: scoperta.provider },
          error: credenzialiRifiutate
            ? 'Il server ha rifiutato le credenziali.'
            : `Connessione non riuscita: ${msg}`,
          suggerimento: scoperta.richiedePasswordApp
            ? `${scoperta.provider} non accetta la password normale dell'account: serve una "password per le app" generata dalle impostazioni di sicurezza.`
            : scoperta.daConfermare
              ? 'I server non sono stati rilevati con certezza: verifica i parametri IMAP col tuo fornitore.'
              : 'Controlla che indirizzo e password siano corretti.',
          richiedePasswordApp: !!scoperta.richiedePasswordApp,
        });
      }

      // 3. Salva solo dopo che la connessione è riuscita
      ctx.session.emailConfig = {
        ...ctx.session.emailConfig,
        imapHost: scoperta.imapHost, imapPort: scoperta.imapPort,
        imapUser: email, imapPass: password,
        host: scoperta.smtpHost, port: scoperta.smtpPort,
        user: email, pass: password, from: email,
      };
      ctx.log(`[Email] Casella configurata e verificata: ${ctx.sanitizeForLog(email)} su ${scoperta.imapHost}`);
      return rispondi(200, {
        ok: true,
        provider: scoperta.provider,
        fonte: scoperta.fonte,
        server: { imapHost: scoperta.imapHost, imapPort: scoperta.imapPort, smtpHost: scoperta.smtpHost, smtpPort: scoperta.smtpPort },
        casella: { totale: verifica.totale },
      });
    } catch (e) {
      ctx.log(`[Email] Configurazione fallita: ${e.message}`);
      return rispondi(500, { error: `Configurazione fallita: ${e.message}` });
    }
  });

  // ── GET /api/config/email ──
  router.get('/api/config/email', (body, res) => {
    const safe = { ...ctx.session.emailConfig };
    // Nessuna password deve uscire da questo endpoint, né SMTP né IMAP
    for (const chiave of Object.keys(safe)) {
      if (/pass|password|secret/i.test(chiave) && safe[chiave]) safe[chiave] = '***';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
  });
}

module.exports = { register };
