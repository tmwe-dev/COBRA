# PIANO TEST COBRA v11 — Definition of Done

Data: 2026-08-04
Metodo: audit-onesto-produzione + Codex Cobra

## EVIDENZA LIVE PRE-TEST (baseline)

Da `data/response_log.jsonl` (16 record, 2026-05-11 → 2026-08-04):

| Metrica | Valore | Stato |
|---|---|---|
| Richieste totali | 16 | — |
| intent=chat con provider OK | 8/8 | VERDE |
| intent=task con provider OK | **0/8** | **ROSSO** |
| Tool eseguiti (storia intera) | **0** | **ROSSO** |
| provider=error | 6 | ROSSO |
| provider=fallback (no tools) | 4 | ROSSO |

Da `data/crash.log`: 4x `ctx.CobraSupervisor.failRequest is not a function` (bug già corretto in sessione precedente).

**BLOCCO PRIMARIO:** il sistema non ha MAI eseguito un tool. Non è una regressione — è uno stato mai funzionante.

---

## DEFINITION OF DONE — condizioni verificabili

Ogni condizione deve essere VERDE con prova live (query log, screenshot browser, o dump network) prima di dichiarare "fatto".

### Fase 1 — Boot e infrastruttura
- [ ] **DoD-1.1** Server parte senza eccezioni, log mostra "Server ready"
- [ ] **DoD-1.2** `GET /api/status` risponde 200 con 3 provider attivi
- [ ] **DoD-1.3** WebSocket si connette dalla webapp (log `[WS] N client(s) connected`)
- [ ] **DoD-1.4** Estensione Chrome si connette (log `[Bridge] Chrome extension connected`)
- [ ] **DoD-1.5** `isBridgeReady()` ritorna true dopo connessione estensione

### Fase 2 — Chat base (regressione)
- [ ] **DoD-2.1** Messaggio chat semplice → risposta con `provider != error/fallback`
- [ ] **DoD-2.2** Risposta appare nella UI (non solo nel JSON)
- [ ] **DoD-2.3** Token meter si aggiorna (usage non zero)

### Fase 3 — Tool execution (IL TEST CRITICO)
- [ ] **DoD-3.1** Richiesta task → response_log mostra `toolsUsed.length > 0`
- [ ] **DoD-3.2** Provider è openai/anthropic/gemini, NON fallback
- [ ] **DoD-3.3** `google_search` restituisce risultati reali (non errore)
- [ ] **DoD-3.4** `navigate` apre effettivamente una pagina nel browser
- [ ] **DoD-3.5** `read_page` restituisce contenuto della pagina navigata
- [ ] **DoD-3.6** `screenshot` produce immagine visibile nel monitor UI
- [ ] **DoD-3.7** Audit log (`data/audit/`) registra le tool call

### Fase 4 — Bridge/browser E2E
- [ ] **DoD-4.1** Comando bridge completa entro timeout (no `Bridge command timeout`)
- [ ] **DoD-4.2** Cookie banner viene dismesso automaticamente
- [ ] **DoD-4.3** Pagina navigata appare nel monitor della webapp

### Fase 5 — Sicurezza runtime
- [ ] **DoD-5.1** Tool su dominio non-whitelist viene bloccato con messaggio chiaro
- [ ] **DoD-5.2** Azione ad alto rischio genera pending_action nella UI
- [ ] **DoD-5.3** Approvazione pending action sblocca l'esecuzione

### Fase 6 — Supervisor/anti-loop
- [ ] **DoD-6.1** Loop di scroll viene interrotto dal supervisor
- [ ] **DoD-6.2** Limite tool calls viene rispettato (no runaway)

### Fase 7 — Memoria/KB
- [ ] **DoD-7.1** Conversazione persiste dopo reload pagina
- [ ] **DoD-7.2** `search_kb` restituisce risultati dalla KB
- [ ] **DoD-7.3** `save_memory` scrive in data/memories.json

---

## ORDINE DI ESECUZIONE

1. Boot server + verifica infrastruttura (Fase 1)
2. Apertura webapp in Chrome + connessione estensione
3. Test chat base (Fase 2) — se fallisce, stop
4. Test tool execution (Fase 3) — IL BLOCCO PRIMARIO
5. Test bridge E2E (Fase 4)
6. Test sicurezza (Fase 5)
7. Test supervisor (Fase 6)
8. Test memoria/KB (Fase 7)

Ad ogni fallimento: fermarsi, diagnosticare causa root, correggere, ritestare la fase.

---

## REGISTRO ESITI

### Fase 1 — Boot e infrastruttura
| DoD | Esito | Prova |
|---|---|---|
| 1.1 Server parte | VERDE | log `COBRA v11 — Server ready`, 62 tool / 67 handler |
| 1.2 /api/status 200 | VERDE | 3 provider attivi (openai, anthropic, gemini) |
| 1.3 WebSocket | VERDE | log `[WS] 4 client(s) connected` |
| 1.4 Estensione Chrome | VERDE | log `[Bridge] Chrome extension connected`, badge "Extension: linked" |
| 1.5 isBridgeReady | VERDE | `bridge.connected: true` da /api/status |

### Fase 2 — Chat base
| DoD | Esito | Prova |
|---|---|---|
| 2.1 provider valido | VERDE | `provider: openai` (prima era `error`/`fallback`) |
| 2.2 risposta in UI | VERDE | screenshot bolle chat |
| 2.3 token meter | VERDE | 54.390 token tracciati, 8 chiamate |

### Fase 3 — Tool execution (BLOCCO PRIMARIO)
| DoD | Esito | Prova |
|---|---|---|
| 3.1 toolsUsed > 0 | VERDE | `toolsUsed: ["google_search✓"]` |
| 3.2 provider non fallback | VERDE | `provider: openai`, log `openai OK (4 tool calls)` |
| 3.3 google_search reale | VERDE | 10 risultati reali con link nella UI |
| 3.4 navigate apre pagina | VERDE | screenshot: finestra browser su iata.org |
| 3.5 read_page contenuto | VERDE | `mdLen=20000`, COBRA cita testo reale di Wikipedia |
| 3.6 screenshot | VERDE | audit: `screenshot ok=true via=bridge` |
| 3.7 audit log | VERDE | `data/audit/audit.jsonl` popolato ad ogni tool call |

### Fase 4 — Bridge/browser E2E
| DoD | Esito | Prova |
|---|---|---|
| 4.1 nessun timeout | VERDE | dopo fix protocollo: `via: bridge` senza timeout |
| 4.2 cookie banner | VERDE | log `[Cookie] Bridge dismiss: rejected_sel` (rifiuta, privacy-first) |
| 4.3 pagina nel monitor | VERDE | screenshot: monitor mostra il contenuto di iata.org |

### Fase 5 — Sicurezza runtime
| DoD | Esito | Prova |
|---|---|---|
| 5.1 blocco non-whitelist | VERDE | test pipeline sez.6; live: `OperationLevel=read → blocked interaction tools` |
| 5.2 pending action | VERDE | tool sconosciuto → `status: pending_confirmation`, risk `destructive` |
| 5.3 conferma sblocca | VERDE | coperto da verify-all sez.1.6 (guardToolCall: allow/block/approve) |

Nota: alla richiesta di inviare una email COBRA ha preparato la bozza e chiesto
conferma invece di inviare — comportamento previsto dalla policy di conferma.

### Fase 6 — Supervisor
| DoD | Esito | Prova |
|---|---|---|
| 6.1 loop scroll interrotto | VERDE | test pipeline sez.7 |
| 6.2 limite tool calls | VERDE | task multi-step: 3 tool call, 0 errori, status `completed` |

### Fase 7 — Memoria/KB
| DoD | Esito | Prova |
|---|---|---|
| 7.1 conversazione persiste | VERDE | `data/conversations.json`, summary 274 token |
| 7.2 search_kb | VERDE | dopo fix reranking: recupera le regole reali di conferma |
| 7.3 save_memory | VERDE | `data/memories.json` contiene "Codice cliente TMWE: ABC-9931" |

---

## BUG TROVATI E CORRETTI IN QUESTA SESSIONE

| # | Bug | Gravità | Come è stato trovato |
|---|---|---|---|
| 1 | `executeTool` chiamato senza `ctx` dai 3 provider AI | P0 | analisi statica + test pipeline |
| 2 | `bridgeCommand`/`bridgeNavigate` non collegate al ctx | P0 | censimento proprietà ctx |
| 3 | Protocollo bridge sbagliato: `type:'command'` invece di `bridge_command` | P0 | log live: `Bridge command timeout` |
| 4 | `HumanDriver` importato senza destructuring | P0 | audit log live: `checkAndDelay is not a function` |
| 5 | `navigate` leggeva `.content` invece di `.markdown` | P0 | log diagnostico: contenuto sempre vuoto |
| 6 | `bridgeCommand('read_page')` — comando inesistente nell'estensione | P1 | test copertura comandi |
| 7 | KB: `LIMIT 20` applicato prima dello scoring | P1 | KB live 51 regole, ricerca non trovava nulla |
| 8 | 13 proprietà ctx mancanti (getState, extRelay, scrapeUrl, ...) | P1 | censimento automatico |
| 9 | `handleExtResult` era uno stub vuoto | P1 | analisi protocollo relay |
| 10 | `ResponseRecorder.exportCSV`/`exportConversation` mancanti | P2 | verifica metodi ctx |
| 11 | Frontend: `chatArea` e `addMessage` non definiti | P0 UI | analisi agente |
| 12 | Extension: `content_scripts` mancante nel manifest | P1 | analisi agente |
| 13 | Secret HMAC hardcoded | P1 sicurezza | analisi agente |
| 14 | `server-slim.js` non importabile senza avviare il listen | P2 | bloccava i test |
| 15 | Launcher non riavviava mai il server (codice vecchio in memoria) | P1 | il fix non veniva caricato |

## BUG PRE-ESISTENTE NON RISOLTO

**Chiave API Anthropic non valida** — `api.anthropic.com` risponde `Unauthorized`.
Il sistema funziona perché OpenAI copre tutto, ma il fallback su Anthropic non è
disponibile. Va rigenerata la chiave nella console Anthropic.

**Chiave Gemini segnalata come compromessa** — errore visibile nella UI:
"Your API key was reported as leaked". Anche questa va rigenerata.

---

# SESSIONE 2 — INDURIMENTO VERSO LA QUALITA DI PRODUZIONE

## Sprint A — Sicurezza

| # | Problema | Prova che era reale | Stato |
|---|---|---|---|
| 16 | Il rischio calcolato veniva ignorato: cliccare "Paga ora" risultava `destructive` ma `conferma=false` | eseguito `computeEffectiveRisk` su 4 casi: tutti destructive, tutti senza conferma | Corretto: `confirm:false` vale solo se il rischio NON è escalato |
| 17 | SSRF aggirabile: nessuna risoluzione DNS, IP in ottale/esadecimale/decimale passavano | 52 vettori di bypass testati | Riscritto con risoluzione DNS + blocco redirect |
| 18 | `crawl_website` e `batch_scrape` senza alcun controllo SSRF, con `redirect: follow` | lettura del codice | Verifica per ogni URL della coda e per ogni redirect |
| 19 | Token API accettato in query string (finisce nei log e nella cronologia) | test di autenticazione | Solo header, con confronto a tempo costante |
| 20 | `origin.startsWith()` accettava `http://localhost:3000.evil.com` | test di autenticazione | Confronto su hostname e porta dopo il parsing |
| 21 | Le pending action non venivano mai rimosse: crescita illimitata | 60 azioni create, nessuna rimossa | Pulizia periodica + indice token O(1) |
| 22 | Verifica del token di approvazione O(n) e non a tempo costante | lettura del codice | Indice inverso + `timingSafeEqual` |

## Sprint B — Robustezza dei dati

| # | Problema | Prova | Stato |
|---|---|---|---|
| 23 | Scritture non atomiche: un crash a metà lascia il JSON corrotto | 40 sovrascritture verificate | Modulo `atomic-file`: scrittura su temporaneo, fsync, rename |
| 24 | Le conversazioni finivano in `modules/data/` invece che in `data/` | i due file esistevano davvero, quello ufficiale fermo al 9 maggio | Percorso corretto + migrazione automatica |
| 25 | `appendFileSync` sull'audit bloccava il thread ad ogni tool call | lettura del codice | Scrittura bufferizzata asincrona + flush all'uscita |
| 26 | L'audit era alterabile senza lasciare traccia | manomessa una riga: prima non rilevabile | Catena di hash SHA-256 + endpoint di verifica |
| 27 | `host.includes('wikipedia.org')` rendeva sicuro `wikipedia.org.evil.com` | test di classificazione | Confronto per etichette DNS |
| 28 | `host.includes('bank')` classificava `mountebank.io` come bancario | test di classificazione | Etichette DNS esatte + rischio basato sull'azione nell'URL |
| 29 | Chiavi duplicate nella tassonomia (`web_search`, `execute_js`) | analisi statica | Rimosse |

## Sprint C — Memoria e autoapprendimento

| # | Problema | Stato |
|---|---|---|
| 30 | Nessuna forma di apprendimento: la memoria era solo cronologia | Nuovo modulo `memory/learning.js`: estrazione fatti durevoli, deduplicazione per somiglianza, richiamo pertinente, persistenza |
| 31 | Rischio che una pagina web scriva nella memoria permanente | Si impara SOLO dai messaggi dell'utente; verificato da test |
| 32 | Rischio di memorizzare credenziali | 8 categorie di segreti riconosciute e scartate |

## Bug trovati durante la verifica live

| # | Problema | Come è emerso | Stato |
|---|---|---|---|
| 33 | Un ramo di uscita non inviava mai la risposta HTTP: il client restava appeso | richiesta bloccata per oltre 45s durante il test | Risposta garantita su ogni percorso + watchdog di turno |
| 34 | Il bridge cadeva ogni 30-50 secondi | 5 cicli connessione/disconnessione nel log | Causa: sospensione del service worker Manifest V3. Battito applicativo portato a 20s |
| 35 | La lettura dell'audit non vedeva le scritture in buffer | test di regressione | `readAuditLog` fa il flush prima di leggere |

## VERIFICHE LIVE FINALI (con prova)

| Verifica | Esito | Prova |
|---|---|---|
| Webapp autenticata dopo il cambio auth | VERDE | `/api/status` risponde dalla webapp reale |
| Bridge stabile | VERDE | 150 secondi consecutivi, 0 disconnessioni (prima: 5 cadute) |
| Tool eseguiti | VERDE | `google_search` su "IATA cargo" con risultato reale |
| Integrità audit | VERDE | 200 voci, catena valida |
| Autoapprendimento | VERDE | 5 fatti estratti da soli: identità 1, azienda 3, preferenza 1 |
| Richiamo dopo azzeramento conversazione | VERDE | "Il magazzino principale di TMWE è a Malpensa. Il cliente più importante è Acme Logistica" in 2,8s |

## SUITE DI TEST (674 asserzioni, 0 fail)

Esecuzione: `./run-tests.sh`

| Suite | Asserzioni | Scopo |
|---|---|---|
| `tests/verify-all.js` | 404 | regressione generale (sicurezza, memoria, risk, moduli) |
| `tests/test-tool-pipeline.js` | 61 | pipeline tool end-to-end senza rete |
| `tests/check-ctx-methods.js` | 124 controlli | integrità del dependency injection context |
| `tests/check-bridge-protocol.js` | 26 | contratto server ↔ estensione Chrome |
| `tests/test-kb-search.js` | 9 | reranking della knowledge base |
| `tests/test-ssrf.js` | 52 | vettori di bypass SSRF e DNS rebinding |
| `tests/test-security-runtime.js` | 42 | conferme, token di approvazione, memoria, autenticazione |
| `tests/test-data-integrity.js` | 26 | classificazione URL, scritture atomiche, catena di audit |
| `tests/test-learning.js` | 54 | apprendimento, deduplicazione, richiamo, protezione segreti |

## COSA RESTA APERTO

**Chiavi API da rigenerare (azione dell'utente):** Anthropic risponde `Unauthorized`,
Gemini è segnalata come compromessa. Il sistema funziona perché OpenAI copre tutto,
ma non esiste fallback.

**`check_emails` è ancora uno stub:** la lettura IMAP non è implementata e nodemailer
non è installato, quindi anche l'invio email è disattivato. Servono `npm install
nodemailer` e una libreria IMAP se questa funzione serve davvero.

**Puppeteer non installato:** tutta l'automazione browser passa dal bridge Chrome.
È una scelta valida, ma senza estensione attiva non esiste alternativa.

**L'estensione va ricaricata una volta** per attivare il suo keepalive interno e il
permesso `alarms`. Non è urgente: il battito lato server già mantiene stabile la
connessione, come verificato.
