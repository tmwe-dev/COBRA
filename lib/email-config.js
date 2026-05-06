/**
 * lib/email-config.js
 * Email provider configuration
 * ~50 lines
 */

const KNOWN_MAIL_PROVIDERS = {
  'gmail.com': { host: 'smtp.gmail.com', port: 587, secure: false },
  'outlook.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'hotmail.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 587, secure: false },
  'icloud.com': { host: 'smtp.mail.icloud.com', port: 587, secure: false },
  'protonmail.com': { host: 'smtp.protonmail.com', port: 587, secure: false },
};

async function autoConfigureEmail(email, opConfig = {}) {
  const [, domain] = email.split('@');
  const lowerDomain = domain.toLowerCase();
  if (KNOWN_MAIL_PROVIDERS[lowerDomain]) {
    return { ok: true, config: KNOWN_MAIL_PROVIDERS[lowerDomain], provider: lowerDomain };
  }
  try {
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${lowerDomain}`);
    if (res.ok) {
      const xml = await res.text();
      const hostMatch = xml.match(/<hostname[^>]*>([^<]+)<\/hostname>/i);
      const portMatch = xml.match(/<port[^>]*>(\d+)<\/port>/i);
      if (hostMatch && portMatch) {
        return { ok: true, config: { host: hostMatch[1], port: parseInt(portMatch[1]), secure: false }, provider: lowerDomain };
      }
    }
  } catch (e) { }
  return { ok: false, reason: `Email provider non configurato automaticamente per ${lowerDomain}` };
}

module.exports = { KNOWN_MAIL_PROVIDERS, autoConfigureEmail };
