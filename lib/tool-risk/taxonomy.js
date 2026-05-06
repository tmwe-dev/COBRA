/**
 * lib/tool-risk/taxonomy.js
 * Risk taxonomy, levels, and tool specifications
 */

const RISK_LEVELS = ['read','inspect','prepare','write_local','write_form','interact','write_kb','send_prepare','send','destructive'];

function maxRisk(a, b) {
  return RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b;
}

const RISK_REQUIRES_CONFIRMATION = {
  read:false, inspect:false, prepare:false, write_local:false, write_form:false,
  interact:false, write_kb:true, send_prepare:true, send:true, destructive:true,
};

const RISK_DEFAULT_TTL = {
  read:null, inspect:null, prepare:null, write_local:null, write_form:null,
  interact:null, write_kb:600, send_prepare:300, send:600, destructive:60,
};

// ── Tool Risk Registry (10-level taxonomy) ──
const TOOL_RISK_TAXONOMY = {
  navigate:        { level:'interact', confirm:false, batchable:true, truth:'Naviga a URL. Rischio dipende dal target.' },
  read_page:       { level:'read', confirm:false, batchable:true, truth:'Legge contenuto testuale pagina.' },
  screenshot:      { level:'read', confirm:false, batchable:true, truth:'Screenshot pagina corrente.' },
  get_page_elements:{ level:'inspect', confirm:false, batchable:true, truth:'Lista elementi interattivi.' },
  get_page_snapshot:{ level:'inspect', confirm:false, batchable:true, truth:'Snapshot strutturato della pagina.' },
  google_search:   { level:'read', confirm:false, batchable:true, truth:'Ricerca Google.' },
  web_search:      { level:'read', confirm:false, batchable:true, truth:'Ricerca web.' },
  check_emails:    { level:'read', confirm:false, batchable:true, truth:'Controlla/legge email da IMAP (alias: read_inbox).' },
  scrape_url:      { level:'read', confirm:false, batchable:true, truth:'Scrape URL in background.' },
  crawl_website:   { level:'read', confirm:false, batchable:true, truth:'Crawl multi-pagina.' },
  extract_data:    { level:'read', confirm:false, batchable:true, truth:'Estrae dati strutturati.' },
  search_kb:       { level:'read', confirm:false, batchable:true, truth:'Cerca in KB.' },
  list_tasks:      { level:'read', confirm:false, batchable:true, truth:'Lista job.' },
  list_local_files:{ level:'read', confirm:false, batchable:true, truth:'Lista file locali.' },
  read_local_file: { level:'read', confirm:false, batchable:true, truth:'Legge file locale.' },
  search_local_files:{ level:'read', confirm:false, batchable:true, truth:'Cerca file locali.' },
  batch_scrape:    { level:'read', confirm:false, batchable:true, truth:'Scrape parallelo.' },
  scroll_page:     { level:'read', confirm:false, batchable:true, truth:'Scroll pagina.' },
  hover_element:   { level:'inspect', confirm:false, batchable:true, truth:'Hover su elemento.' },
  wait_for:        { level:'inspect', confirm:false, batchable:true, truth:'Attende elemento/tempo.' },
  switch_tab:      { level:'inspect', confirm:false, batchable:true, truth:'Cambia tab browser.' },
  request_human_takeover:{ level:'interact', confirm:false, batchable:false, truth:'Cede controllo all\'operatore.' },
  inspect_dom_js:  { level:'inspect', confirm:false, batchable:true, truth:'JS in modalità lettura. NO fetch/submit/click/storage.' },
  prepare_email_draft:      { level:'prepare', confirm:false, batchable:true, truth:'Genera bozza email in memoria. NON invia.' },
  prepare_whatsapp_message: { level:'prepare', confirm:false, batchable:true, truth:'Prepara testo WhatsApp. Non apre/invia.' },
  prepare_linkedin_message: { level:'prepare', confirm:false, batchable:true, truth:'Prepara testo LinkedIn. Non apre/invia.' },
  create_file:     { level:'write_local', confirm:false, batchable:true, truth:'Crea file sandbox locale.' },
  save_local_file: { level:'write_local', confirm:false, batchable:true, truth:'Salva file cartella locale.' },
  save_memory:     { level:'write_local', confirm:false, batchable:true, truth:'Salva in memoria persistente.' },
  fill_form:       { level:'write_form', confirm:false, batchable:true, truth:'Compila form senza submit.' },
  select_option:   { level:'write_form', confirm:false, batchable:true, truth:'Seleziona opzione dropdown.' },
  click_element:   { level:'interact', confirm:false, batchable:true, truth:'Click su elemento. Sale a destructive se submit/paga/conferma.' },
  press_key:       { level:'interact', confirm:false, batchable:true, truth:'Preme tasto. Enter su form = potenziale submit.' },
  drag_drop:       { level:'interact', confirm:false, batchable:true, truth:'Drag & drop elementi.' },
  upload_file:     { level:'interact', confirm:false, batchable:true, truth:'Upload file in input.' },
  type_human:      { level:'interact', confirm:false, batchable:true, truth:'Digitazione realistica char-by-char.' },
  key_combo:       { level:'interact', confirm:false, batchable:true, truth:'Combo tastiera (Ctrl+C, etc.).' },
  select_dropdown: { level:'interact', confirm:false, batchable:true, truth:'Seleziona da dropdown custom.' },
  set_datepicker:  { level:'interact', confirm:false, batchable:true, truth:'Imposta datepicker.' },
  clipboard_write: { level:'interact', confirm:false, batchable:true, truth:'Scrive in clipboard.' },
  detect_block:    { level:'read', confirm:false, batchable:true, truth:'Rileva CAPTCHA/2FA/blocchi.' },
  verify_action:   { level:'read', confirm:false, batchable:true, truth:'Verifica risultato azione.' },
  read_table:      { level:'read', confirm:false, batchable:true, truth:'Legge contenuto tabella.' },
  wait_network_idle: { level:'read', confirm:false, batchable:true, truth:'Attende network idle.' },
  mutate_dom_js:   { level:'write_form', confirm:true, batchable:false, ttl:60, truth:'JS mutativo: modifica DOM/form/stato. RICHIEDE CONFERMA.' },
  execute_js:      { level:'write_form', confirm:false, batchable:false, truth:'Legacy JS execution. Usato internamente dal bridge.' },
  save_to_kb:      { level:'write_kb', confirm:true, batchable:true, truth:'Salva entry KB.' },
  kb_update:       { level:'write_kb', confirm:true, batchable:false, truth:'Modifica entry KB esistente.' },
  send_email:      { level:'send', confirm:true, batchable:true, ttl:600, truth:'Invia email SMTP reale. Irreversibile.' },
  open_whatsapp:   { level:'send_prepare', confirm:false, batchable:false, ttl:300, truth:'Apre WhatsApp Web precompilato. NON invia.' },
  open_linkedin:   { level:'send_prepare', confirm:false, batchable:false, ttl:300, truth:'Apre LinkedIn. NON invia messaggi.' },
  linkedin_search:       { level:'read', confirm:false, batchable:true, truth:'Cerca profili LinkedIn. Solo lettura.' },
  linkedin_profile:      { level:'read', confirm:false, batchable:true, truth:'Estrae dati profilo LinkedIn. Solo lettura.' },
  linkedin_inbox:        { level:'read', confirm:false, batchable:true, truth:'Legge inbox LinkedIn. Solo lettura.' },
  linkedin_read_thread:  { level:'read', confirm:false, batchable:true, truth:'Legge thread LinkedIn. Solo lettura.' },
  linkedin_send_message: { level:'send', confirm:true, batchable:false, ttl:300, truth:'Invia messaggio LinkedIn REALE.' },
  linkedin_connect:      { level:'send', confirm:true, batchable:false, ttl:300, truth:'Invia richiesta collegamento LinkedIn.' },
  whatsapp_send:         { level:'send', confirm:true, batchable:false, ttl:300, truth:'Invia messaggio WhatsApp REALE.' },
  whatsapp_unread:       { level:'read', confirm:false, batchable:true, truth:'Legge messaggi WhatsApp non letti.' },
  whatsapp_read_thread:  { level:'read', confirm:false, batchable:true, truth:'Legge thread WhatsApp.' },
  kb_delete:       { level:'destructive', confirm:true, batchable:false, ttl:60, truth:'Cancella entry KB. Irreversibile.' },
  delete_task:     { level:'destructive', confirm:true, batchable:false, ttl:60, truth:'Cancella job. Irreversibile.' },
  create_task:     { level:'write_local', confirm:false, batchable:true, truth:'Crea job.' },
  run_task:        { level:'interact', confirm:false, batchable:false, truth:'Esegue job salvato.' },
};

function getToolRiskSpec(toolName) {
  return TOOL_RISK_TAXONOMY[toolName] || {
    level:'destructive', confirm:true, batchable:false, ttl:60,
    truth:`Tool sconosciuto "${toolName}". Default: destructive.`,
  };
}

module.exports = {
  RISK_LEVELS,
  RISK_REQUIRES_CONFIRMATION,
  RISK_DEFAULT_TTL,
  TOOL_RISK_TAXONOMY,
  maxRisk,
  getToolRiskSpec,
};
