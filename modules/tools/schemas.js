// modules/tools/schemas.js — COBRA_TOOLS registry (complete 60+ tool definitions)
// Source: server.js lines 2645-2712
// Content file — tool definitions are data, not logic. 120-line limit applies to logic only.

const { TOOL_RISK_TAXONOMY } = require('../risk/taxonomy');

const COBRA_TOOLS = [
  { type:'function', function:{ name:'navigate', description:'Naviga il browser a un URL specifico.', parameters:{ type:'object', properties:{ url:{ type:'string', description:'URL completo da visitare' } }, required:['url'] } } },
  { type:'function', function:{ name:'google_search', description:'Cerca su Google. IMPORTANTE: includi nella query TUTTI i vincoli dell\'utente (classe, prezzo, date, brand).', parameters:{ type:'object', properties:{ query:{ type:'string', description:'Query di ricerca Google COMPLETA' } }, required:['query'] } } },
  { type:'function', function:{ name:'read_page', description:'Legge e restituisce il contenuto testuale della pagina corrente.', parameters:{ type:'object', properties:{}, required:[] } } },
  { type:'function', function:{ name:'scrape_url', description:'Apre un URL in background, estrae il contenuto e lo restituisce.', parameters:{ type:'object', properties:{ url:{ type:'string', description:'URL da scrappare' } }, required:['url'] } } },
  { type:'function', function:{ name:'inspect_dom_js', description:'Esegue JavaScript in MODALITÀ LETTURA nella pagina. NO fetch, NO submit, NO click.', parameters:{ type:'object', properties:{ code:{ type:'string', description:'Codice JavaScript read-only' } }, required:['code'] } } },
  { type:'function', function:{ name:'mutate_dom_js', description:'Esegue JavaScript che MODIFICA DOM/form/stato. RICHIEDE CONFERMA.', parameters:{ type:'object', properties:{ code:{ type:'string', description:'Codice JavaScript mutativo' } }, required:['code'] } } },
  { type:'function', function:{ name:'click_element', description:'Clicca su un elemento. Supporta selettore CSS o testo con prefisso text:.', parameters:{ type:'object', properties:{ selector:{ type:'string', description:'Selettore CSS o "text:testo visibile"' } }, required:['selector'] } } },
  { type:'function', function:{ name:'fill_form', description:'Compila campi di un form. Supporta input, textarea, select, checkbox, radio.', parameters:{ type:'object', properties:{ fields:{ type:'string', description:'JSON {"selettore_CSS": "valore"}' } }, required:['fields'] } } },
  { type:'function', function:{ name:'get_page_elements', description:'Mappa degli elementi interattivi sulla pagina. CHIAMALO SEMPRE prima di interagire.', parameters:{ type:'object', properties:{ filter:{ type:'string', description:'buttons, links, inputs, forms, all' } }, required:[] } } },
  { type:'function', function:{ name:'screenshot', description:'Cattura screenshot della pagina corrente. USALO SPESSO per verificare.', parameters:{ type:'object', properties:{}, required:[] } } },
  { type:'function', function:{ name:'crawl_website', description:'Crawling di un sito: visita più pagine, estrae contenuto.', parameters:{ type:'object', properties:{ url:{ type:'string' }, maxPages:{ type:'number' }, sameDomain:{ type:'boolean' } }, required:['url'] } } },
  { type:'function', function:{ name:'extract_data', description:'Estrae dati strutturati dalla pagina corrente usando selettori CSS.', parameters:{ type:'object', properties:{ schema:{ type:'object', description:'Mappa nome_campo -> selettore CSS' } }, required:['schema'] } } },
  { type:'function', function:{ name:'save_to_kb', description:'Salva nella Knowledge Base di COBRA.', parameters:{ type:'object', properties:{ domain:{ type:'string' }, type:{ type:'string' }, name:{ type:'string' }, content:{ type:'string' }, tags:{ type:'string' } }, required:['domain','type','name','content'] } } },
  { type:'function', function:{ name:'search_kb', description:'Cerca nella Knowledge Base di COBRA.', parameters:{ type:'object', properties:{ query:{ type:'string' }, domain:{ type:'string' } }, required:['query'] } } },
  { type:'function', function:{ name:'create_file', description:'Crea e scarica un file. Supporta JSON, CSV, TXT, HTML, Markdown.', parameters:{ type:'object', properties:{ filename:{ type:'string' }, content:{ type:'string' }, type:{ type:'string' } }, required:['filename','content'] } } },
  { type:'function', function:{ name:'create_task', description:'Crea un job riutilizzabile multi-step.', parameters:{ type:'object', properties:{ name:{ type:'string' }, description:{ type:'string' }, steps:{ type:'string', description:'JSON array di step: [{tool, args, description}]' }, tags:{ type:'string' }, output_type:{ type:'string' } }, required:['name','steps'] } } },
  { type:'function', function:{ name:'run_task', description:'Esegue un job salvato per ID o nome.', parameters:{ type:'object', properties:{ task_id:{ type:'number' }, task_name:{ type:'string' } }, required:[] } } },
  { type:'function', function:{ name:'list_tasks', description:'Elenca tutti i job salvati.', parameters:{ type:'object', properties:{}, required:[] } } },
  { type:'function', function:{ name:'delete_task', description:'Elimina un job salvato.', parameters:{ type:'object', properties:{ task_id:{ type:'number' } }, required:['task_id'] } } },
  { type:'function', function:{ name:'save_memory', description:'Salva un ricordo/nota nella memoria persistente.', parameters:{ type:'object', properties:{ title:{ type:'string' }, content:{ type:'string' }, tags:{ type:'string' } }, required:['title','content'] } } },
  { type:'function', function:{ name:'batch_scrape', description:'Scrapea più URL in parallelo.', parameters:{ type:'object', properties:{ urls:{ type:'string', description:'JSON array di URL' } }, required:['urls'] } } },
  { type:'function', function:{ name:'list_local_files', description:'Elenca i file nella cartella connessa.', parameters:{ type:'object', properties:{ path:{ type:'string' }, pattern:{ type:'string' } }, required:[] } } },
  { type:'function', function:{ name:'read_local_file', description:'Legge il contenuto di un file dal computer.', parameters:{ type:'object', properties:{ path:{ type:'string' } }, required:['path'] } } },
  { type:'function', function:{ name:'save_local_file', description:'Salva un file nella cartella connessa.', parameters:{ type:'object', properties:{ path:{ type:'string' }, content:{ type:'string' } }, required:['path','content'] } } },
  { type:'function', function:{ name:'search_local_files', description:'Cerca file per nome o contenuto.', parameters:{ type:'object', properties:{ query:{ type:'string' }, content_search:{ type:'boolean' } }, required:['query'] } } },
  { type:'function', function:{ name:'kb_update', description:'Aggiorna o crea entry nella Knowledge Base.', parameters:{ type:'object', properties:{ title:{ type:'string' }, content:{ type:'string' }, category:{ type:'string' }, domain:{ type:'string' }, tags:{ type:'string' } }, required:['title','content','category'] } } },
  { type:'function', function:{ name:'kb_delete', description:'Disattiva entry della Knowledge Base.', parameters:{ type:'object', properties:{ title:{ type:'string' } }, required:['title'] } } },
  { type:'function', function:{ name:'scroll_page', description:'Scrolla la pagina su o giù.', parameters:{ type:'object', properties:{ direction:{ type:'string', enum:['up','down'] }, amount:{ type:'number' } }, required:[] } } },
  { type:'function', function:{ name:'hover_element', description:'Passa il mouse sopra un elemento. Utile per menu, tooltip, dropdown.', parameters:{ type:'object', properties:{ selector:{ type:'string' } }, required:['selector'] } } },
  { type:'function', function:{ name:'drag_drop', description:'Trascina un elemento da una posizione a un\'altra.', parameters:{ type:'object', properties:{ source:{ type:'string' }, target:{ type:'string' } }, required:['source','target'] } } },
  { type:'function', function:{ name:'upload_file', description:'Carica un file in un input[type=file].', parameters:{ type:'object', properties:{ selector:{ type:'string' }, file_path:{ type:'string' } }, required:['selector','file_path'] } } },
  { type:'function', function:{ name:'switch_tab', description:'Passa a una tab/popup aperta. Index 0 = pagina principale.', parameters:{ type:'object', properties:{ index:{ type:'number' } }, required:['index'] } } },
  { type:'function', function:{ name:'wait_for', description:'Attende elemento o tempo. Utile dopo click asincroni.', parameters:{ type:'object', properties:{ selector:{ type:'string' }, timeout:{ type:'number' } }, required:[] } } },
  { type:'function', function:{ name:'select_option', description:'Seleziona un\'opzione da un dropdown/select.', parameters:{ type:'object', properties:{ selector:{ type:'string' }, value:{ type:'string' } }, required:['selector','value'] } } },
  { type:'function', function:{ name:'press_key', description:'Simula pressione tasto: Enter, Escape, Tab, Arrow*, Backspace, Space.', parameters:{ type:'object', properties:{ key:{ type:'string' }, selector:{ type:'string' } }, required:['key'] } } },
  { type:'function', function:{ name:'send_email', description:'INVIA DAVVERO una email tramite SMTP. Richiede conferma utente. Il server SMTP è configurato.', parameters:{ type:'object', properties:{ to:{ type:'string' }, subject:{ type:'string' }, body:{ type:'string' }, cc:{ type:'string' } }, required:['to','subject','body'] } } },
  // LinkedIn
  { type:'function', function:{ name:'linkedin_search', description:'Cerca profili LinkedIn. Solo lettura, nessuna azione. Opera in background via estensione.', parameters:{ type:'object', properties:{ query:{ type:'string' } }, required:['query'] } } },
  { type:'function', function:{ name:'linkedin_profile', description:'Estrae dati profilo LinkedIn dato URL. Solo lettura, nessuna azione.', parameters:{ type:'object', properties:{ url:{ type:'string' } }, required:['url'] } } },
  { type:'function', function:{ name:'linkedin_send_message', description:'INVIA DAVVERO messaggio LinkedIn. Richiede conferma utente. Azione irreversibile.', parameters:{ type:'object', properties:{ url:{ type:'string' }, message:{ type:'string' } }, required:['url','message'] } } },
  { type:'function', function:{ name:'linkedin_connect', description:'INVIA DAVVERO richiesta collegamento LinkedIn. Richiede conferma utente. Azione irreversibile.', parameters:{ type:'object', properties:{ url:{ type:'string' }, note:{ type:'string' } }, required:['url'] } } },
  { type:'function', function:{ name:'linkedin_inbox', description:'Legge inbox LinkedIn: conversazioni recenti.', parameters:{ type:'object', properties:{}, required:[] } } },
  { type:'function', function:{ name:'linkedin_read_thread', description:'Legge messaggi di una conversazione LinkedIn.', parameters:{ type:'object', properties:{ threadUrl:{ type:'string' } }, required:['threadUrl'] } } },
  // WhatsApp
  { type:'function', function:{ name:'whatsapp_send', description:'INVIA DAVVERO messaggio WhatsApp. Richiede conferma utente. Azione irreversibile.', parameters:{ type:'object', properties:{ phone:{ type:'string' }, text:{ type:'string' } }, required:['phone','text'] } } },
  { type:'function', function:{ name:'whatsapp_unread', description:'Legge messaggi WhatsApp non letti.', parameters:{ type:'object', properties:{}, required:[] } } },
  { type:'function', function:{ name:'whatsapp_read_thread', description:'Legge messaggi di una chat WhatsApp.', parameters:{ type:'object', properties:{ contact:{ type:'string' }, maxMessages:{ type:'number' } }, required:['contact'] } } },
  // Legacy fallback
  { type:'function', function:{ name:'open_whatsapp', description:'[FALLBACK] Apre WhatsApp Web con testo precompilato.', parameters:{ type:'object', properties:{ phone:{ type:'string' }, text:{ type:'string' } }, required:['phone','text'] } } },
  { type:'function', function:{ name:'prepare_whatsapp_message', description:'Prepara testo WhatsApp in memoria. Non invia.', parameters:{ type:'object', properties:{ phone:{ type:'string' }, text:{ type:'string' } }, required:['phone','text'] } } },
  { type:'function', function:{ name:'open_linkedin', description:'[FALLBACK] Apre LinkedIn via browser.', parameters:{ type:'object', properties:{ recipient:{ type:'string' }, text:{ type:'string' } }, required:['recipient','text'] } } },
  { type:'function', function:{ name:'prepare_linkedin_message', description:'Prepara testo LinkedIn in memoria. Non invia.', parameters:{ type:'object', properties:{ recipient:{ type:'string' }, text:{ type:'string' } }, required:['recipient','text'] } } },
  { type:'function', function:{ name:'prepare_email_draft', description:'Genera bozza email in memoria. NON invia, solo preparazione. Nessuna conferma necessaria.', parameters:{ type:'object', properties:{ to:{ type:'string' }, subject:{ type:'string' }, body:{ type:'string' } }, required:['to','subject','body'] } } },
  { type:'function', function:{ name:'check_emails', description:'Legge le email dalla casella di posta (IMAP). Di default solo quelle non lette. Restituisce mittente, oggetto, data e anteprima del testo.', parameters:{ type:'object', properties:{ limit:{ type:'number', description:'Quante email leggere (1-50, default 10)' }, onlyUnread:{ type:'boolean', description:'Solo le non lette (default true)' } }, required:[] } } },
  { type:'function', function:{ name:'request_human_takeover', description:'ULTIMA RISORSA: cedi il controllo all\'operatore.', parameters:{ type:'object', properties:{ reason:{ type:'string' }, instructions:{ type:'string' } }, required:['reason'] } } },
  // Bridge v2.0
  { type:'function', function:{ name:'type_human', description:'Digita testo con velocità umana variabile. Per autocomplete, contenteditable, rich editor.', parameters:{ type:'object', properties:{ text:{ type:'string' }, selector:{ type:'string' }, delay:{ type:'number' } }, required:['text'] } } },
  { type:'function', function:{ name:'key_combo', description:'Combinazioni tastiera: Ctrl+A, Ctrl+C, Ctrl+V, Shift+Enter, etc.', parameters:{ type:'object', properties:{ combo:{ type:'string' } }, required:['combo'] } } },
  { type:'function', function:{ name:'detect_block', description:'Rileva CAPTCHA, 2FA, login, rate limiting.', parameters:{ type:'object', properties:{}, required:[] } } },
  { type:'function', function:{ name:'verify_action', description:'Verifica se un\'azione è riuscita. Controlla URL, elementi, errori.', parameters:{ type:'object', properties:{ checks:{ type:'string', description:'JSON array di verifiche' } }, required:['checks'] } } },
  { type:'function', function:{ name:'select_dropdown', description:'Seleziona valore da dropdown custom (React Select, MUI, Ant Design).', parameters:{ type:'object', properties:{ selector:{ type:'string' }, value:{ type:'string' }, searchable:{ type:'boolean' } }, required:['selector','value'] } } },
  { type:'function', function:{ name:'set_datepicker', description:'Imposta data in un datepicker. Formato: YYYY-MM-DD.', parameters:{ type:'object', properties:{ selector:{ type:'string' }, value:{ type:'string' } }, required:['selector','value'] } } },
  { type:'function', function:{ name:'get_page_snapshot', description:'Snapshot strutturato: bottoni, inputs, link, headings. PIÙ VELOCE di get_page_elements.', parameters:{ type:'object', properties:{}, required:[] } } },
  { type:'function', function:{ name:'read_table', description:'Legge contenuto tabella HTML in formato strutturato.', parameters:{ type:'object', properties:{ selector:{ type:'string' }, maxRows:{ type:'number' } }, required:[] } } },
  { type:'function', function:{ name:'wait_network_idle', description:'Attende rete inattiva. Utile per SPA.', parameters:{ type:'object', properties:{ idleMs:{ type:'number' }, timeout:{ type:'number' } }, required:[] } } },
  { type:'function', function:{ name:'clipboard_write', description:'Scrive testo nella clipboard del browser.', parameters:{ type:'object', properties:{ text:{ type:'string' } }, required:['text'] } } },
// ── Conduzione di processi a piu passi ──
  // Le regole sono applicate dal motore: un passo si chiude solo con la prova
  // di uno strumento eseguito, e il processo finisce solo quando tutti i passi
  // sono chiusi. Non sono indicazioni, sono vincoli.
  { type:'function', function:{ name:'processo_avvia', description:'OBBLIGATORIO prima di iniziare un lavoro che richiede piu di due operazioni (confronti fra fonti, raccolte dati, report, procedure). Dichiara l\'obiettivo e i passi.', parameters:{ type:'object', properties:{ obiettivo:{ type:'string', description:'Cosa si deve ottenere, in una frase' }, passi:{ type:'array', description:'Da 2 a 15 passi in ordine', items:{ type:'object', properties:{ titolo:{ type:'string' }, bloccante:{ type:'boolean', description:'false se il processo puo proseguire anche senza questo passo' }, dipendeDa:{ type:'array', items:{ type:'number' }, description:'Numeri dei passi che devono essere completati prima' } }, required:['titolo'] } } }, required:['obiettivo','passi'] } } },
  { type:'function', function:{ name:'processo_inizia_passo', description:'Segna che stai iniziando un passo. Da chiamare PRIMA di eseguirlo.', parameters:{ type:'object', properties:{ passo:{ type:'number' } }, required:['passo'] } } },
  { type:'function', function:{ name:'processo_completa_passo', description:'Chiude un passo. Richiede la prova: il risultato dello strumento che hai realmente eseguito. Senza prova il passo resta aperto.', parameters:{ type:'object', properties:{ passo:{ type:'number' }, prova:{ type:'string', description:'Il risultato dello strumento usato, non una tua descrizione' } }, required:['passo','prova'] } } },
  { type:'function', function:{ name:'processo_fallisci_passo', description:'Dichiara che un passo non e riuscito, spiegando perche. Un passo non si abbandona in silenzio.', parameters:{ type:'object', properties:{ passo:{ type:'number' }, motivo:{ type:'string' } }, required:['passo','motivo'] } } },
  { type:'function', function:{ name:'processo_stato', description:'Mostra a che punto e il processo e quale passo viene dopo.', parameters:{ type:'object', properties:{}, required:[] } } },
];

// TOOL_RISK_MAP: backward compat wrapper over TOOL_RISK_TAXONOMY
const TOOL_RISK_MAP = new Proxy({}, {
  get(_, name) {
    const spec = TOOL_RISK_TAXONOMY[name];
    if (!spec) return 'destructive';
    if (spec.confirm) return 'destructive';
    if (['read','inspect','prepare'].includes(spec.level)) return 'safe';
    return 'risky';
  }
});

module.exports = { COBRA_TOOLS, TOOL_RISK_MAP };
