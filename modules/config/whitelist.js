// modules/config/whitelist.js — Domain interaction whitelist
// Source: server.js lines 49-67

const INTERACTION_WHITELIST = [
  // Google Workspace
  'docs.google.com', 'sheets.google.com', 'drive.google.com',
  'slides.google.com', 'forms.google.com',
  // Supabase
  'supabase.com', 'supabase.co',
  // Internal
  'localhost', '127.0.0.1',
  // TMWE services
  'reportaziende.it', 'www.reportaziende.it',
];

function isDomainWhitelisted(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return INTERACTION_WHITELIST.some(d =>
      hostname === d || hostname.endsWith('.' + d)
    );
  } catch { return false; }
}

module.exports = { INTERACTION_WHITELIST, isDomainWhitelisted };
