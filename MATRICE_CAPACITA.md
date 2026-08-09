# Matrice delle capacita'

*generata il 2026-08-09 02:48 da `attrezzi/matrice-capacita.js`*

## Riepilogo

| misura | valore |
|---|---|
| schemi dichiarati | 83 |
| handler registrati | 90 |
| comandi estensione | 115 |
| turni analizzati | 132 |
| **capacita' con un anello rotto** | **4** |
| **handler senza schema, non voluti** | **0** |
| handler chiusi apposta (documentati) | 7 |
| **comandi estensione che nessuno chiama** | **76** |
| **comandi chiesti che l'estensione non espone** | **0** |
| **il cancello d'avvio disabiliterebbe** | **0** |
| **il cancello d'avvio bloccherebbe** | **0** |

| classe | quante |
|---|---|
| DA-PROVARE | 40 |
| TIENI | 25 |
| FIX | 7 |
| LEGACY | 7 |
| ROTTO-MAI-USATO | 4 |

## Handler senza schema — non voluti

_nessuno_

## Handler chiusi apposta — il modello non deve vederli

- `web_search` — alias interno di google_search
- `execute_js` — esecuzione arbitraria: resta per i flussi interni, mai in mano al modello
- `read_inbox` — alias interno di check_emails
- `send_whatsapp` — alias interno della vecchia strada
- `send_linkedin` — alias interno della vecchia strada
- `linkedin_send_message` — idem, lato LinkedIn
- `whatsapp_send` — seconda strada senza regole d'invio: il 7 agosto ne uscirono sette fuori conteggio

## Comandi dell'estensione che nessun handler chiama

- `stato_canali`
- `mappa_pagine`
- `mappa_dimentica`
- `stato_ritmo`
- `stato_moduli_esterni`
- `get_action_log`
- `clear_action_log`
- `mostra_cursore`
- `linkedin_posta`
- `linkedin_conversazione`
- `linkedin_scrivi`
- `linkedin_diagnosi`
- `type`
- `fill_form`
- `submit_form`
- `file_upload`
- `iframe_type`
- `sblocca_coda`
- `handle_dialog`
- `dismiss_cookies`
- `dismiss_overlay`
- `get_cookies`
- `double_click`
- `right_click`
- `click_coord`
- `drag_drop`
- `scroll_to_element`
- `select_text`
- `focus`
- `file_drop`
- `download_file`
- `download_status`
- `clipboard_read`
- `iframe_list`
- `iframe_execute`
- `iframe_click`
- `shadow_query`
- `shadow_click`
- `wait_download`
- `get_links`
- `get_buttons`
- `highlight`
- `request_human`
- `resume_after_human`
- `get_storage`
- `go_back`
- `go_forward`
- `reload`
- `get_url`
- `elenco_schede`
- `open_tab`
- `switch_tab`
- `close_tab`
- `list_tabs`
- `wait_url_change`
- `whatsapp_sessione`
- `whatsapp_conversazione`
- `whatsapp_diagnosi`
- `text`
- `aria`
- `placeholder`
- `role`
- `xpath`
- `coord`
- `near`
- `wait_for`
- `hidden`
- `text_contains`
- `clickable`
- `url_contains`
- `element_exists`
- `element_text`
- `element_visible`
- `no_error`
- `toast`
- `retry`

## Comandi chiesti al ponte che l'estensione non espone

_nessuno_

## Tutte le capacita'

| capacita' | classe | ambiti | handler | rischio | chiamate | falliti | rotture |
|---|---|---|---|---|---|---|---|
| `accedi` | DA-PROVARE | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `agisci` | FIX | interact communicate | ✓ | ✓ | 1 | 1 | — |
| `annota` | TIENI | search browse data file | ✓ | ✓ | 5 | 1 | — |
| `annota_sul_sito` | DA-PROVARE | browse interact communicate | ✓ | ✓ | 0 | 0 | — |
| `batch_scrape` | TIENI | search data | ✓ | ✓ | 6 | 0 | — |
| `check_emails` | DA-PROVARE | communicate | ✓ | ✓ | 0 | 0 | — |
| `click_element` | LEGACY | interact communicate | ✓ | ✓ | 3 | 1 | — |
| `clipboard_write` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `conto_invii` | DA-PROVARE | communicate | ✓ | ✓ | 0 | 0 | — |
| `cosa_so_del_sito` | DA-PROVARE | browse interact communicate | ✓ | ✓ | 0 | 0 | — |
| `crawl_website` | DA-PROVARE | data | ✓ | ✓ | 0 | 0 | — |
| `crea_report` | FIX | data file | ✓ | ✓ | 16 | 12 | — |
| `create_file` | TIENI | data file | ✓ | ✓ | 11 | 0 | — |
| `create_task` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `delete_task` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `detect_block` | TIENI | browse interact | ✓ | ✓ | 1 | 0 | — |
| `drag_drop` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `elenco_procedure` | DA-PROVARE | browse | ✓ | ✓ | 0 | 0 | — |
| `extract_data` | TIENI | data | ✓ | ✓ | 2 | 0 | — |
| `fill_form` | DA-PROVARE | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `get_page_elements` | LEGACY | browse interact communicate | ✓ | ✓ | 10 | 0 | — |
| `get_page_snapshot` | LEGACY | browse interact communicate | ✓ | ✓ | 0 | 0 | — |
| `google_search` | TIENI | search communicate | ✓ | ✓ | 136 | 5 | — |
| `guarda_pagina` | FIX | interact communicate | ✓ | ✓ | 2 | 2 | — |
| `hover_element` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `impara_procedura` | DA-PROVARE | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `inspect_dom_js` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `kb_delete` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `kb_update` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `key_combo` | LEGACY | interact | ✓ | ✓ | 0 | 0 | — |
| `leggi_manuale` | DA-PROVARE | search browse interact data file | ✓ | ✓ | 0 | 0 | — |
| `leggi_modulo` | TIENI | interact communicate | ✓ | ✓ | 2 | 0 | — |
| `linkedin_connect` | FIX | communicate | ✓ | ✓ | 9 | 6 | — |
| `linkedin_inbox` | TIENI | communicate | ✓ | ✓ | 14 | 4 | — |
| `linkedin_profile` | DA-PROVARE | communicate | ✓ | ✓ | 0 | 0 | — |
| `linkedin_read_thread` | TIENI | communicate | ✓ | ✓ | 2 | 1 | — |
| `linkedin_scrivi` | TIENI | communicate | ✓ | ✓ | 10 | 0 | — |
| `linkedin_search` | TIENI | communicate | ✓ | ✓ | 6 | 0 | — |
| `list_local_files` | DA-PROVARE | admin file | ✓ | ✓ | 0 | 0 | — |
| `list_tasks` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `mutate_dom_js` | LEGACY | interact | ✓ | ✓ | 0 | 0 | — |
| `navigate` | TIENI | search browse interact data communicate | ✓ | ✓ | 148 | 10 | — |
| `open_linkedin` | ROTTO-MAI-USATO | — | ✓ | ✓ | 0 | 0 | FUORI-AMBITO |
| `open_whatsapp` | ROTTO-MAI-USATO | — | ✓ | ✓ | 0 | 0 | FUORI-AMBITO |
| `prepare_email_draft` | TIENI | communicate | ✓ | ✓ | 1 | 0 | — |
| `prepare_linkedin_message` | ROTTO-MAI-USATO | — | ✓ | ✓ | 0 | 0 | FUORI-AMBITO |
| `prepare_whatsapp_message` | ROTTO-MAI-USATO | — | ✓ | ✓ | 0 | 0 | FUORI-AMBITO |
| `press_key` | DA-PROVARE | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `processo_avvia` | TIENI | search browse interact data admin file communicate | ✓ | ✓ | 56 | 0 | — |
| `processo_completa_passo` | TIENI | search browse interact data admin file communicate | ✓ | ✓ | 67 | 4 | — |
| `processo_fallisci_passo` | TIENI | search browse interact data admin file communicate | ✓ | ✓ | 46 | 1 | — |
| `processo_inizia_passo` | TIENI | search browse interact data admin file communicate | ✓ | ✓ | 137 | 8 | — |
| `processo_stato` | TIENI | search browse interact data admin file communicate | ✓ | ✓ | 2 | 0 | — |
| `read_local_file` | DA-PROVARE | file | ✓ | ✓ | 0 | 0 | — |
| `read_page` | TIENI | search browse interact data communicate | ✓ | ✓ | 57 | 4 | — |
| `read_table` | FIX | search browse data | ✓ | ✓ | 1 | 1 | — |
| `request_human_takeover` | FIX | browse interact | ✓ | ✓ | 4 | 3 | — |
| `run_task` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `save_local_file` | DA-PROVARE | file | ✓ | ✓ | 0 | 0 | — |
| `save_memory` | TIENI | admin | ✓ | ✓ | 1 | 0 | — |
| `save_to_kb` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `scrape_url` | TIENI | search data | ✓ | ✓ | 66 | 2 | — |
| `screenshot` | TIENI | browse interact communicate | ✓ | ✓ | 14 | 0 | — |
| `scrivi_raccolta` | DA-PROVARE | search browse data file | ✓ | ✓ | 0 | 0 | — |
| `scroll_page` | DA-PROVARE | browse interact communicate | ✓ | ✓ | 0 | 0 | — |
| `search_kb` | DA-PROVARE | admin | ✓ | ✓ | 0 | 0 | — |
| `search_local_files` | TIENI | file | ✓ | ✓ | 36 | 1 | — |
| `select_dropdown` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `select_option` | LEGACY | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `send_email` | DA-PROVARE | communicate | ✓ | ✓ | 0 | 0 | — |
| `set_datepicker` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `siti_con_accesso` | DA-PROVARE | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `stato_lavoro` | DA-PROVARE | search browse data file | ✓ | ✓ | 0 | 0 | — |
| `switch_tab` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `type_human` | LEGACY | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `upload_file` | DA-PROVARE | interact | ✓ | ✓ | 0 | 0 | — |
| `usa_procedura` | DA-PROVARE | browse interact communicate | ✓ | ✓ | 0 | 0 | — |
| `verify_action` | DA-PROVARE | browse interact | ✓ | ✓ | 0 | 0 | — |
| `wait_for` | DA-PROVARE | interact communicate | ✓ | ✓ | 0 | 0 | — |
| `wait_network_idle` | FIX | browse interact | ✓ | ✓ | 1 | 1 | — |
| `whatsapp_read_thread` | DA-PROVARE | communicate | ✓ | ✓ | 0 | 0 | — |
| `whatsapp_scrivi` | TIENI | communicate | ✓ | ✓ | 9 | 1 | — |
| `whatsapp_unread` | TIENI | communicate | ✓ | ✓ | 1 | 0 | — |
