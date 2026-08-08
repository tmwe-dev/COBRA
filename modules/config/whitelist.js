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
  // Canali di messaggistica su cui COBRA lavora tramite l'estensione.
  //
  // Mancavano, ed e' per questo che COBRA rispondeva "non posso inviare
  // messaggi WhatsApp" pur avendo whatsapp_scrivi davanti: il prompt gli dice
  // "interazione DOM SOLO su domini whitelistati, gli altri SOLO lettura", e
  // web.whatsapp.com non era qui dentro. Diceva la verita': come era
  // configurato, su WhatsApp poteva soltanto guardare.
  //
  // Aggiungerli NON toglie nessuna protezione: chi decide se un messaggio
  // parte resta modules/security/regole-invio.js (destinatario, orari,
  // limiti, ritmo). Questa lista dice solo DOVE le mani possono muoversi.
  'web.whatsapp.com',
  'linkedin.com', 'www.linkedin.com',
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
