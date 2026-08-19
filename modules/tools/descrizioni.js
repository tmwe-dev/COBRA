// modules/tools/descrizioni.js — Dire cosa si sta facendo, in italiano.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Nella chat, mentre COBRA lavora, Luca vede questo:
//
//     ✓google_search ✓navigate ✓leggi_modulo ✗agisci ✗guarda_pagina
//
// Sono i nomi delle funzioni. Dicono tutto a chi ha scritto il codice e niente
// a chi sta aspettando: non si capisce se sta cercando, se e' bloccato, se sta
// per finire o se e' partito per la tangente. E quando una cosa dura tre
// minuti, non capire cosa stia succedendo e' la differenza fra aspettare e
// pensare che si sia piantato.
//
// Qui ogni azione diventa una frase che si legge:
//
//     Apro skyscanner.it
//     Leggo il modulo di ricerca
//     Scrivo "Milano" nel campo partenza
//
// ── PERCHE' NON BASTAVA LA TASSONOMIA ──
//
// Tutti e 91 gli strumenti hanno gia' un `truth` in risk/taxonomy.js — ma e'
// scritto per chi decide il rischio, non per chi guarda: "Naviga a URL",
// "Lista elementi interattivi". Giusto li', illeggibile qui.
//
// Quindi: una frase in prima persona quando la conosciamo, il `truth` come
// rete di sicurezza. Nessuno strumento resta senza descrizione — e' la stessa
// regola del diario, dove un fallimento senza motivo non e' ammesso.
// ══════════════════════════════════════════════════════════════════════

const { TOOL_RISK_TAXONOMY } = require('../risk/taxonomy');

/** Il nome del sito, che e' quello che una persona riconosce. */
function _sito(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); }
  catch (_) { return String(url || '').replace(/^https?:\/\//, '').split('/')[0]; }
}

function _corto(s, n = 40) {
  const t = String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * Cosa sta facendo, adesso, detto come lo direbbe una persona.
 *
 * In prima persona e al presente: "Apro", non "Apertura di". Chi legge sta
 * guardando qualcuno lavorare, non un registro di sistema.
 */
const COME_SI_DICE = {
  navigate: (a) => `Apro ${_sito(a.url)}`,
  scrape_url: (a) => `Leggo ${_sito(a.url)}`,
  read_page: () => 'Leggo la pagina',
  batch_scrape: (a) => `Leggo ${(a.urls || []).length || 'piu\''} pagine insieme`,
  crawl_website: (a) => `Esploro ${_sito(a.url)}`,
  google_search: (a) => `Cerco «${_corto(a.query, 50)}»`,
  screenshot: () => 'Fotografo la pagina',

  guarda_pagina: () => 'Guardo cosa c\'è sulla pagina',
  agisci: (a) => {
    const cosa = String(a.cosa || 'clicca');
    if (cosa === 'scrivi') return `Scrivo «${_corto(a.valore, 30)}» nel campo ${a.id}`;
    if (cosa === 'guarda') return `Rileggo l'elemento ${a.id}`;
    return `Premo ${a.id}`;
  },
  leggi_modulo: () => 'Guardo com\'è fatto il modulo',
  fill_form: (a) => {
    const n = a.fields ? Object.keys(a.fields).length : (a.campi ? Object.keys(a.campi).length : 0);
    return n ? `Compilo il modulo (${n} campi)` : 'Compilo il modulo';
  },
  click_element: (a) => `Clicco ${_corto(a.selector || a.testo, 30)}`,
  press_key: (a) => `Premo ${a.key || 'un tasto'}`,
  select_option: (a) => `Scelgo «${_corto(a.value || a.valore, 25)}» dall'elenco`,
  set_datepicker: (a) => `Metto la data ${a.date || a.data || ''}`.trim(),
  scroll_page: () => 'Scorro la pagina',
  wait_network_idle: () => 'Aspetto che la pagina finisca di caricare',
  detect_block: () => 'Controllo se il sito sta bloccando',

  extract_data: () => 'Estraggo i dati dalla pagina',
  read_table: () => 'Leggo la tabella',
  annota: (a) => `Segno ${_corto(a.nome, 30)} nel cantiere`,
  crea_report: (a) => `Preparo il report ${_corto(a.filename, 30)}`,
  create_file: (a) => `Scrivo il file ${_corto(a.filename, 30)}`,
  scrivi_raccolta: (a) => `Scrivo il file con quello che ho raccolto${a.filename ? `: ${_corto(a.filename, 25)}` : ''}`,

  whatsapp_scrivi: (a) => `Scrivo a ${_corto(a.a, 25)} su WhatsApp`,
  linkedin_scrivi: (a) => `Scrivo a ${_corto(a.a, 25)} su LinkedIn`,
  linkedin_connect: (a) => `Chiedo il collegamento a ${_corto(a.a || a.nome, 25)}`,
  linkedin_search: (a) => `Cerco ${_corto(a.query || a.nome, 25)} su LinkedIn`,
  linkedin_inbox: () => 'Guardo la posta di LinkedIn',
  whatsapp_unread: () => 'Guardo i messaggi non letti',
  check_emails: () => 'Controllo la posta',
  send_email: (a) => `Mando una mail a ${_corto(a.to || a.a, 25)}`,

  processo_avvia: () => 'Preparo il piano di lavoro',
  processo_inizia_passo: (a) => `Comincio il passo ${a.step ?? a.passo ?? ''}`.trim(),
  processo_completa_passo: (a) => `Chiudo il passo ${a.step ?? a.passo ?? ''}`.trim(),
  processo_fallisci_passo: (a) => `Il passo ${a.step ?? a.passo ?? ''} non è riuscito`.trim(),
  stato_lavoro: () => 'Controllo a che punto sono',

  search_kb: (a) => `Cerco «${_corto(a.query, 35)}» in quello che so`,
  save_memory: () => 'Mi segno una cosa da ricordare',
  search_local_files: (a) => `Cerco «${_corto(a.query, 30)}» fra i file`,
  request_human_takeover: () => 'Chiedo a Luca di intervenire',
};

/**
 * La frase da mostrare mentre lo strumento gira.
 *
 * Non lancia mai: se qualcosa va storto nel comporre la frase, si mostra il
 * nome dello strumento. Meglio un nome tecnico che una riga vuota.
 */
function descrivi(nome, args = {}) {
  try {
    const f = COME_SI_DICE[nome];
    if (f) { const s = f(args || {}); if (s && s.trim()) return s.trim(); }
  } catch (_) { /* si passa alla rete di sicurezza */ }
  const t = TOOL_RISK_TAXONOMY[nome];
  if (t && t.truth) return t.truth.replace(/\.$/, '');
  return nome;
}

/**
 * Com'e' andata, in una riga.
 *
 * Quando riesce non si spiega: si e' visto. Quando fallisce si dice PERCHE',
 * perche' e' l'unica informazione che serve a chi guarda — e adesso il motivo
 * ce l'abbiamo, dal diario.
 */
function comeEAndata(esito) {
  if (!esito || esito.ok) return '';
  return esito.reason ? _corto(esito.reason, 90) : (esito.code || 'non riuscito');
}

module.exports = { descrivi, comeEAndata, COME_SI_DICE };
