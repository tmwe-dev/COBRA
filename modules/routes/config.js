// modules/routes/config.js — /api/config/keys, /api/config/email

const fs = require('fs');
const path = require('path');
const { trovaServerPosta } = require('../utils/mail-autoconfig');
const { leggiPosta } = require('../utils/imap');
const { writeAtomicSync } = require('../utils/atomic-file');

/**
 * Scrive le chiavi nel file .env, aggiornando quelle già presenti e
 * aggiungendo le nuove. Senza questo, una chiave inserita dall'interfaccia
 * andava persa al primo riavvio e l'utente doveva reinserirla ogni volta.
 *
 * @returns {string[]} nomi delle variabili effettivamente scritte
 */
function salvaChiaviNelEnv(coppie, ctx) {
  const file = path.join(__dirname, '..', '..', '.env');
  const daScrivere = Object.entries(coppie).filter(([, v]) => v && String(v).trim());
  if (daScrivere.length === 0) return [];

  let righe = [];
  try { righe = fs.readFileSync(file, 'utf8').split('\n'); } catch { righe = []; }

  const scritte = [];
  for (const [nome, valore] of daScrivere) {
    const pulito = String(valore).trim();
    const i = righe.findIndex(r => r.trim().startsWith(nome + '='));
    if (i >= 0) righe[i] = `${nome}=${pulito}`;
    else righe.push(`${nome}=${pulito}`);
    scritte.push(nome);
    // Rende la chiave disponibile anche ai moduli che leggono da process.env
    process.env[nome] = pulito;
  }

  const testo = righe.filter((r, i) => r.trim() !== '' || i < righe.length - 1).join('\n').replace(/\n+$/, '') + '\n';
  const ok = writeAtomicSync(file, testo);
  if (!ok && ctx?.log) ctx.log('[API Keys] Scrittura del .env non riuscita: le chiavi valgono solo per questa sessione');
  return ok ? scritte : [];
}

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
      // Le chiavi inserite dall'interfaccia vivevano solo in memoria e sparivano
      // ad ogni riavvio: vanno scritte nel .env come le altre, così si
      // inseriscono una volta sola.
      const salvate = salvaChiaviNelEnv({
        OPENAI_API_KEY: cfg.openai,
        ANTHROPIC_API_KEY: cfg.anthropic,
        GEMINI_API_KEY: cfg.gemini,
        GROQ_API_KEY: cfg.groq,
        ELEVENLABS_API_KEY: cfg.elevenlabs,
        OPENAI_MODEL: cfg.openaiModel,
        ANTHROPIC_MODEL: cfg.anthropicModel,
        GEMINI_MODEL: cfg.geminiModel,
      }, ctx);

      const active = Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key') && ctx.aiKeys[k]).map(k => k.replace('Key', ''));
      ctx.log(`[API Keys] Configurate: ${active.join(', ')}${salvate ? ' (salvate su .env)' : ''}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providers: active, persistite: salvate }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'JSON non valido' }));
    }
  });

  // ── GET /api/config/keys/test ──
  // Prova ogni chiave con una chiamata minima al fornitore. Sapere che una
  // chiave è "presente" non serve: conta se funziona.
  router.get('/api/config/keys/test', async (body, res) => {
    const k = ctx.aiKeys;
    const esiti = {};

    const prova = async (nome, chiave, esegui) => {
      if (!chiave) { esiti[nome] = { stato: 'assente', messaggio: 'Nessuna chiave configurata' }; return; }
      const t0 = Date.now();
      try {
        const r = await esegui(chiave);
        esiti[nome] = { ...r, ms: Date.now() - t0 };
      } catch (e) {
        esiti[nome] = { stato: 'errore', messaggio: e.message, ms: Date.now() - t0 };
      }
    };

    await Promise.all([
      prova('openai', k.openaiKey, async (key) => {
        const r = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12000),
        });
        if (r.ok) { const d = await r.json(); return { stato: 'ok', messaggio: `${(d.data || []).length} modelli disponibili` }; }
        if (r.status === 401) return { stato: 'non valida', messaggio: 'Chiave rifiutata' };
        if (r.status === 429) return { stato: 'limite', messaggio: 'Quota esaurita o troppe richieste' };
        return { stato: 'errore', messaggio: `HTTP ${r.status}` };
      }),

      prova('anthropic', k.anthropicKey, async (key) => {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok) return { stato: 'ok', messaggio: 'Risponde correttamente' };
        const testo = await r.text().catch(() => '');
        if (r.status === 401 || /authentication/i.test(testo)) return { stato: 'non valida', messaggio: 'Chiave rifiutata' };
        if (r.status === 429) return { stato: 'limite', messaggio: 'Quota esaurita' };
        if (r.status === 400 && /model/i.test(testo)) return { stato: 'ok', messaggio: 'Chiave valida (modello di prova non disponibile)' };
        return { stato: 'errore', messaggio: `HTTP ${r.status}` };
      }),

      prova('gemini', k.geminiKey, async (key) => {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok) { const d = await r.json(); return { stato: 'ok', messaggio: `${(d.models || []).length} modelli disponibili` }; }
        const testo = await r.text().catch(() => '');
        if (/leaked|compromised/i.test(testo)) return { stato: 'compromessa', messaggio: 'Google l\'ha segnalata come esposta: va rigenerata' };
        if (r.status === 400 || r.status === 403) return { stato: 'non valida', messaggio: 'Chiave rifiutata' };
        return { stato: 'errore', messaggio: `HTTP ${r.status}` };
      }),

      prova('elevenlabs', k.elevenlabsKey, async (key) => {
        const r = await fetch('https://api.elevenlabs.io/v1/user', {
          headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(12000),
        });
        if (r.ok) {
          const d = await r.json().catch(() => ({}));
          const sub = d.subscription || {};
          const residui = (sub.character_limit || 0) - (sub.character_count || 0);
          return { stato: 'ok', messaggio: `Piano ${sub.tier || 'attivo'}${sub.character_limit ? `, ${residui} caratteri residui` : ''}` };
        }
        if (r.status === 401) return { stato: 'non valida', messaggio: 'Chiave rifiutata' };
        return { stato: 'errore', messaggio: `HTTP ${r.status}` };
      }),
    ]);

    const funzionanti = Object.values(esiti).filter(e => e.stato === 'ok').length;
    ctx.log(`[API Keys] Verifica: ${Object.entries(esiti).map(([n, e]) => `${n}=${e.stato}`).join(' ')}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ funzionanti, totale: Object.keys(esiti).length, esiti }));
  });

  // ── GET /api/config/keys ──
  router.get('/api/config/keys', (body, res) => {
    const active = Object.keys(ctx.aiKeys).filter(k => k.endsWith('Key') && ctx.aiKeys[k]).map(k => k.replace('Key', ''));

    // La finestra mostrava sempre i segnaposto vuoti anche quando le chiavi
    // c'erano tutte nel .env: sembravano perse ad ogni apertura e si finiva
    // per reinserirle senza motivo. Si restituisce un'impronta — le ultime
    // quattro cifre — che basta a riconoscerle senza esporle.
    const impronte = {};
    for (const [nome, valore] of Object.entries(ctx.aiKeys)) {
      if (!nome.endsWith('Key') || !valore) continue;
      const v = String(valore);
      impronte[nome.replace('Key', '')] = { presente: true, coda: v.slice(-4), lunghezza: v.length };
    }
    const posta = ctx.session.emailConfig || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      providers: active, hasKeys: active.length > 0, impronte,
      posta: posta.imapUser ? { presente: true, indirizzo: posta.imapUser, server: posta.imapHost } : { presente: false },
    }));
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
      const tentativo = { host: scoperta.imapHost, port: scoperta.imapPort, user: email, pass: password };
      try {
        verifica = await leggiPosta(tentativo, { limit: 1, onlyUnread: false, timeoutMs: 12000 });
        // Se il certificato ha imposto un nome diverso, si conserva quello
        if (tentativo.hostEffettivo && tentativo.hostEffettivo !== scoperta.imapHost) {
          ctx.log(`[Email] Server corretto in base al certificato: ${scoperta.imapHost} → ${tentativo.hostEffettivo}`);
          scoperta.imapHost = tentativo.hostEffettivo;
          scoperta.fonte += ' (nome corretto dal certificato)';
        }
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
      // Fino a ieri la casella viveva solo in memoria: bastava un riavvio e
      // bisognava reinserire indirizzo e password. Ora si salva accanto alle
      // chiavi, sulla macchina di Luca, e si rilegge da sola all'avvio.
      const salvatePosta = salvaChiaviNelEnv({
        MAIL_USER: email,
        MAIL_PASS: password,
        MAIL_IMAP_HOST: scoperta.imapHost,
        MAIL_IMAP_PORT: String(scoperta.imapPort || 993),
        MAIL_SMTP_HOST: scoperta.smtpHost || '',
        MAIL_SMTP_PORT: String(scoperta.smtpPort || 587),
      }, ctx);
      ctx.log(`[Email] Casella configurata e verificata: ${ctx.sanitizeForLog(email)} su ${scoperta.imapHost}`
        + (salvatePosta.length ? ' (salvata: resta dopo il riavvio)' : ' (NON salvata: varrà solo per questa sessione)'));
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
