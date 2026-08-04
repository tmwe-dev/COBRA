// modules/utils/mail-autoconfig.js — Trova da solo i server di posta
//
// L'utente digita solo il proprio indirizzo email. I parametri IMAP e SMTP
// vengono cercati in quattro modi, dal più affidabile al più generico:
//
//   1. Elenco dei provider più comuni (immediato, nessuna rete)
//   2. Autoconfig del provider stesso: autoconfig.<dominio>/mail/config-v1.1.xml
//   3. Database pubblico di Mozilla, lo stesso che usa Thunderbird
//   4. Record DNS SRV, poi tentativi sui nomi convenzionali (imap., mail.)
//
// Se nessun metodo dà un risultato certo, si restituisce comunque il tentativo
// più probabile segnalando che va confermato.

const dns = require('dns').promises;
const tls = require('tls');

// ── 1. Provider noti ────────────────────────────────────────────
// Coprono la stragrande maggioranza dei casi italiani senza toccare la rete.
const PROVIDER_NOTI = {
  'gmail.com':        { imap: 'imap.gmail.com',        smtp: 'smtp.gmail.com',        nome: 'Gmail',            passwordApp: true },
  'googlemail.com':   { imap: 'imap.gmail.com',        smtp: 'smtp.gmail.com',        nome: 'Gmail',            passwordApp: true },
  'outlook.com':      { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',    nome: 'Outlook',          passwordApp: true },
  'hotmail.com':      { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',    nome: 'Outlook',          passwordApp: true },
  'hotmail.it':       { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',    nome: 'Outlook',          passwordApp: true },
  'live.com':         { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',    nome: 'Outlook',          passwordApp: true },
  'live.it':          { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',    nome: 'Outlook',          passwordApp: true },
  'office365.com':    { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',    nome: 'Microsoft 365',    passwordApp: true },
  'yahoo.com':        { imap: 'imap.mail.yahoo.com',   smtp: 'smtp.mail.yahoo.com',   nome: 'Yahoo',            passwordApp: true },
  'yahoo.it':         { imap: 'imap.mail.yahoo.com',   smtp: 'smtp.mail.yahoo.com',   nome: 'Yahoo',            passwordApp: true },
  'icloud.com':       { imap: 'imap.mail.me.com',      smtp: 'smtp.mail.me.com',      nome: 'iCloud',           passwordApp: true },
  'me.com':           { imap: 'imap.mail.me.com',      smtp: 'smtp.mail.me.com',      nome: 'iCloud',           passwordApp: true },
  // Provider italiani
  'libero.it':        { imap: 'imapmail.libero.it',    smtp: 'smtp.libero.it',        nome: 'Libero' },
  'virgilio.it':      { imap: 'in.virgilio.it',        smtp: 'out.virgilio.it',       nome: 'Virgilio' },
  'alice.it':         { imap: 'in.alice.it',           smtp: 'out.alice.it',          nome: 'Alice' },
  'tin.it':           { imap: 'box.tin.it',            smtp: 'box.tin.it',            nome: 'TIN' },
  'tiscali.it':       { imap: 'imap.tiscali.it',       smtp: 'smtp.tiscali.it',       nome: 'Tiscali' },
  'fastwebnet.it':    { imap: 'imap.fastwebnet.it',    smtp: 'smtp.fastwebnet.it',    nome: 'Fastweb' },
  'aruba.it':         { imap: 'imaps.aruba.it',        smtp: 'smtps.aruba.it',        nome: 'Aruba' },
  'pec.it':           { imap: 'imaps.pec.aruba.it',    smtp: 'smtps.pec.aruba.it',    nome: 'PEC Aruba' },
  'register.it':      { imap: 'imaps.register.it',     smtp: 'smtps.register.it',     nome: 'Register.it' },
  'legalmail.it':     { imap: 'mbox.cert.legalmail.it', smtp: 'sendm.cert.legalmail.it', nome: 'Legalmail' },
};

function dominioDi(email) {
  const m = String(email || '').trim().toLowerCase().match(/@([^@\s]+)$/);
  return m ? m[1] : null;
}

/** Verifica che un host risponda davvero su una porta IMAP/SMTP cifrata. */
function provaHost(host, port = 993, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let risolto = false;
    const fine = (esito) => { if (!risolto) { risolto = true; resolve(esito); } };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      socket.once('data', (d) => {
        const saluto = d.toString('utf8', 0, 120);
        socket.destroy();
        // Un server IMAP saluta con "* OK", uno SMTP con "220"
        fine(/^\* OK|^220/.test(saluto));
      });
      setTimeout(() => { socket.destroy(); fine(false); }, timeoutMs);
    });
    socket.on('error', () => { socket.destroy(); fine(false); });
    setTimeout(() => { try { socket.destroy(); } catch { /* già chiuso */ } fine(false); }, timeoutMs);
  });
}

/** Estrae i parametri da un XML in formato autoconfig (Mozilla / provider). */
function leggiAutoconfig(xml) {
  const blocco = (tipo) => {
    const re = new RegExp(`<incomingServer[^>]*type="${tipo}"[\\s\\S]*?</incomingServer>`, 'i');
    const m = xml.match(re);
    return m ? m[0] : null;
  };
  const imapXml = blocco('imap');
  const smtpXml = (xml.match(/<outgoingServer[\s\S]*?<\/outgoingServer>/i) || [])[0];
  const campo = (frammento, tag) => {
    if (!frammento) return null;
    const m = frammento.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const imapHost = campo(imapXml, 'hostname');
  if (!imapHost) return null;
  return {
    imap: imapHost,
    imapPort: Number(campo(imapXml, 'port')) || 993,
    smtp: campo(smtpXml, 'hostname') || null,
    smtpPort: Number(campo(smtpXml, 'port')) || 587,
  };
}

async function scarica(url, timeoutMs = 5000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

/**
 * Trova i parametri di posta a partire dall'indirizzo email.
 *
 * @returns {Promise<{trovato:boolean, fonte:string, provider?:string,
 *   imapHost?:string, imapPort?:number, smtpHost?:string, smtpPort?:number,
 *   richiedePasswordApp?:boolean, nota?:string, daConfermare?:boolean}>}
 */
async function trovaServerPosta(email, { provaConnessione = true } = {}) {
  const dominio = dominioDi(email);
  if (!dominio) return { trovato: false, fonte: 'nessuna', errore: 'Indirizzo email non valido' };

  // ── 1. Elenco dei provider noti ──
  const noto = PROVIDER_NOTI[dominio];
  if (noto) {
    return {
      trovato: true, fonte: 'provider noto', provider: noto.nome,
      imapHost: noto.imap, imapPort: 993,
      smtpHost: noto.smtp, smtpPort: 587,
      richiedePasswordApp: !!noto.passwordApp,
      nota: noto.passwordApp
        ? `${noto.nome} non accetta la password normale: serve una "password per le app".`
        : undefined,
    };
  }

  // ── 2. Autoconfig pubblicato dal dominio stesso ──
  for (const url of [
    `https://autoconfig.${dominio}/mail/config-v1.1.xml`,
    `https://${dominio}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ]) {
    const xml = await scarica(url);
    const cfg = xml && leggiAutoconfig(xml);
    if (cfg) {
      return {
        trovato: true, fonte: 'autoconfig del dominio', provider: dominio,
        imapHost: cfg.imap, imapPort: cfg.imapPort,
        smtpHost: cfg.smtp, smtpPort: cfg.smtpPort,
      };
    }
  }

  // ── 3. Database pubblico di Mozilla (quello di Thunderbird) ──
  const xmlMozilla = await scarica(`https://autoconfig.thunderbird.net/v1.1/${dominio}`);
  const cfgMozilla = xmlMozilla && leggiAutoconfig(xmlMozilla);
  if (cfgMozilla) {
    return {
      trovato: true, fonte: 'database Mozilla', provider: dominio,
      imapHost: cfgMozilla.imap, imapPort: cfgMozilla.imapPort,
      smtpHost: cfgMozilla.smtp, smtpPort: cfgMozilla.smtpPort,
    };
  }

  // ── 4. Record DNS SRV, come previsto dallo standard ──
  try {
    const srv = await dns.resolveSrv(`_imaps._tcp.${dominio}`);
    if (srv && srv.length > 0) {
      const scelto = srv.sort((a, b) => a.priority - b.priority)[0];
      return {
        trovato: true, fonte: 'record DNS SRV', provider: dominio,
        imapHost: scelto.name, imapPort: scelto.port || 993,
        smtpHost: `smtp.${dominio}`, smtpPort: 587,
      };
    }
  } catch { /* il dominio non pubblica record SRV */ }

  // ── 5. Nomi convenzionali, verificati con una connessione reale ──
  const candidati = [`imap.${dominio}`, `mail.${dominio}`, `imaps.${dominio}`, `in.${dominio}`];
  if (provaConnessione) {
    for (const host of candidati) {
      if (await provaHost(host, 993)) {
        return {
          trovato: true, fonte: 'verifica diretta del server', provider: dominio,
          imapHost: host, imapPort: 993,
          smtpHost: `smtp.${dominio}`, smtpPort: 587,
        };
      }
    }
  }

  // Nessuna certezza: si propone il tentativo più probabile
  return {
    trovato: false, fonte: 'ipotesi', provider: dominio,
    imapHost: `imap.${dominio}`, imapPort: 993,
    smtpHost: `smtp.${dominio}`, smtpPort: 587,
    daConfermare: true,
    nota: 'Non sono riuscito a rilevare i server automaticamente. Questi sono i valori più probabili: verificali col tuo fornitore se la connessione non riesce.',
  };
}

module.exports = { trovaServerPosta, PROVIDER_NOTI, dominioDi, leggiAutoconfig, provaHost };
