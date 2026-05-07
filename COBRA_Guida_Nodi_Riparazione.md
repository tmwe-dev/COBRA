# COBRA v10.2 — Guida Nodi per Riparazione Rapida

> **Scopo:** Mappa a nodi per individuare in <3 salti il file, la funzione e le dipendenze da toccare per qualsiasi riparazione. Ogni nodo = 1 modulo con: cosa fa, da chi dipende, chi lo consuma, rischi, e pattern di errore comuni.

---

## ALBERO DEI NODI

```
server-slim.js (orchestratore)
├── config/
│   ├── index.js ........... ENV, COBRA_DEFAULTS, paths
│   ├── constants.js ....... RISK_LEVELS, maxRisk(), TTL
│   └── whitelist.js ....... INTERACTION_WHITELIST, isDomainWhitelisted()
├── security/
│   ├── auth.js ............ COBRA_API_TOKEN, isAuthenticatedRequest()
│   ├── ssrf.js ............ isSSRFSafe() — blocco IP privati/IPv6
│   ├── sanitize.js ........ sanitizeForLog() — redazione PII/credenziali
│   ├── human-driver.js .... HumanDriver — rate limit + delay anti-detection
│   ├── injection.js ....... detectPromptInjection(), sanitizeScrapedContent() — P0.1
│   ├── audit-log.js ....... appendAuditEntry(), auditToolCall(), readAuditLog() — P0.2
│   └── output-sanitizer.js  sanitizeOutboundMessage() — P0.3
├── risk/
│   ├── taxonomy.js ........ TOOL_RISK_TAXONOMY (70+ tool → livello rischio)
│   ├── classifiers.js ..... classifyUrlRisk() — URL → risk level
│   ├── calculator.js ...... computeEffectiveRisk(), classifyClickIntent(), detectDangerousJs()
│   └── pending-actions.js . guardToolCall(), approve/reject, HMAC token
├── tools/
│   ├── executor.js ........ executeTool() — dispatcher centrale + pre/post guards
│   ├── schemas.js ......... COBRA_TOOLS — definizioni OpenAI function calling
│   └── handlers/
│       ├── index.js ....... registry merge di tutti i handler
│       ├── navigate.js .... navigate tool
│       ├── search.js ...... google_search, web_search
│       ├── read-scrape.js . read_page, scrape_url, crawl_website, extract_data
│       ├── dom.js ......... inspect_dom_js, mutate_dom_js, execute_js, elements, snapshot
│       ├── interaction.js . click_element, fill_form, select_option
│       ├── browser-ctrl.js  screenshot, scroll, hover, drag, upload, tab, wait, key
│       ├── bridge-tools.js  type_human, key_combo, detect_block, verify, dropdown...
│       ├── data.js ........ KB CRUD, files, memory, tasks, batch_scrape
│       └── communication.js email, whatsapp, linkedin, prepare, human_takeover
├── ai/
│   ├── router.js .......... callAI() — cascade OpenAI → Anthropic → Gemini
│   ├── openai.js .......... callOpenAI()
│   ├── anthropic.js ....... callAnthropic()
│   └── gemini.js .......... callGemini()
├── memory/
│   ├── chat-memory.js ..... ChatMemory — sliding window + rolling summary
│   └── conversation.js .... ConversationEngine — multi-session + persistence
├── browser/
│   ├── browser.js ......... getOrCreateBrowser() — Puppeteer lifecycle
│   ├── scrape.js .......... smartScrape(), simpleScrape() + getContentScript()
│   ├── pages.js ........... getActivePage(), takeActiveScreenshot(), cookies
│   ├── modals.js .......... dismissModals(), dismissModalsBridge()
│   └── cookie-banner.js ... dismissCookieBanner()
├── bridge/
│   └── connection.js ...... bridgeCommand(), bridgeNavigate(), isBridgeReady()
├── supervisor/
│   └── cobra.js ........... CobraSupervisor — loop detection, watchdog, health
├── prompts/
│   ├── cobra-core.js ...... COBRA_CORE system prompt
│   ├── agents.js .......... Agent-specific prompt overlay
│   └── kb-rules.js ........ Always-loaded KB rules
├── routes/
│   ├── index.js ........... Router dispatcher + CORS + auth + static
│   ├── chat.js ............ /api/chat — SuperMario pipeline principale
│   ├── monitoring.js ...... /api/response-log, /api/monitoring, /api/status
│   ├── pending.js ......... /api/pending-actions (approve/reject)
│   ├── config.js .......... /api/config/keys, /api/config/email
│   ├── tts.js ............. /api/tts (ElevenLabs)
│   └── misc.js ............ bridge-token, page-preview, ws-test, seed-kb
├── ws/
│   └── server.js .......... WebSocket server + bridge protocol
├── utils/
│   ├── tokens.js .......... estimateTokens(), TokenMeter
│   ├── repetition.js ...... detectRepetition()
│   └── context.js ......... digestToolResult()
└── kb/
    ├── api-keys.js ........ loadAIKeys(), loadOperatorConfig()
    ├── search.js .......... searchKB(), saveKB(), updateKB(), deleteKB()
    └── supabase.js ........ Supabase client config
```

---

## NODO → DETTAGLIO RAPIDO

### N01 — server-slim.js (161 righe)
- **Cosa fa:** Wiring DI, avvio HTTP server, assembla ctx
- **Dipende da:** TUTTI i moduli (è il root)
- **Consumato da:** processo Node.js (entry point)
- **Rischio:** Qualsiasi modifica qui impatta TUTTO il sistema
- **Errori comuni:** Modulo non wired nel ctx → crash a runtime su prima chiamata

### N02 — config/index.js (52 righe)
- **Cosa fa:** Carica .env, definisce COBRA_DEFAULTS (30+ costanti), data dir paths
- **Dipende da:** dotenv, path, fs
- **Consumato da:** TUTTI i moduli via `require('../config')`
- **Rischio:** Costante mancante → crash diffuso
- **Errori comuni:** Duplicazione con constants.js (RISOLTO), env var mancante

### N03 — config/constants.js (33 righe)
- **Cosa fa:** RISK_LEVELS[], maxRisk(), RISK_REQUIRES_CONFIRMATION, RISK_DEFAULT_TTL
- **Dipende da:** nessuno (puro)
- **Consumato da:** risk/classifiers.js, risk/calculator.js, risk/pending-actions.js
- **Rischio:** Aggiungere livello senza aggiornare tutti i consumer
- **Errori comuni:** maxRisk() ritorna corretto solo se entrambi i livelli sono in RISK_LEVELS

### N04 — risk/taxonomy.js (84 righe)
- **Cosa fa:** Mappa tool_name → {level, confirm, batchable, ttl, truth}
- **Dipende da:** nessuno (puro)
- **Consumato da:** risk/calculator.js → computeEffectiveRisk()
- **Rischio:** Tool non in mappa → default destructive con confirm obbligatorio
- **Errori comuni:** Alias senza entry (es. web_search, execute_js — RISOLTO)

### N05 — risk/calculator.js (93 righe)
- **Cosa fa:** computeEffectiveRisk(), classifyClickIntent(), detectDangerousJs()
- **Dipende da:** config/constants, risk/taxonomy, risk/classifiers
- **Consumato da:** risk/pending-actions.js → guardToolCall()
- **Rischio:** False positive su JS detector blocca tool legittimi
- **Errori comuni:** Pattern regex troppo largo cattura codice innocuo

### N06 — risk/pending-actions.js (104 righe)
- **Cosa fa:** guardToolCall(), approve/reject, HMAC token verification, feedback stats
- **Dipende da:** risk/calculator, crypto
- **Consumato da:** tools/executor.js, routes/pending.js, routes/chat.js
- **Rischio:** Token leak permette bypass conferma; timer expiry fa scadere azioni valide
- **Errori comuni:** Token calcolato su args diversi non matcha → ri-blocco (è corretto)

### N07 — tools/executor.js (103 righe)
- **Cosa fa:** executeTool() — valida args, SuperMario guards, whitelist, supervisor, security, dispatch
- **Dipende da:** config, whitelist, risk/*, supervisor, handler registry
- **Consumato da:** ai/router.js (via tool_calls), server-slim.js (ctx.executeTool)
- **Rischio:** Guard bypassa → tool pericoloso eseguito senza conferma
- **Errori comuni:** Handler non registrato → "Tool non implementato", ghost reference a moduli eliminati (RISOLTO)

### N08 — tools/handlers/communication.js (111 righe)
- **Cosa fa:** send_email, open_whatsapp, whatsapp_send, linkedin_*, prepare_*, human_takeover
- **Dipende da:** nodemailer (email), bridge (whatsapp/linkedin), config
- **Consumato da:** tools/executor.js via handler registry
- **Rischio:** ALTO — invio messaggi reali. Output AI non sanitizzato (P0.3)
- **Errori comuni:** Credenziali SMTP mancanti, bridge non connesso

### N09 — ai/router.js (75 righe)
- **Cosa fa:** callAI() con cascade fallback OpenAI → Anthropic → Gemini
- **Dipende da:** ai/openai, ai/anthropic, ai/gemini, config
- **Consumato da:** routes/chat.js (pipeline principale)
- **Rischio:** Fallback silenzioso su provider degradato; token count non capped (P0.4)
- **Errori comuni:** API key mancante → skip silenzioso, tool_calls parsing diverso per provider

### N10 — memory/chat-memory.js (82 righe)
- **Cosa fa:** Sliding window (MAX_LIVE=10), rolling summary, safety cap, serialize/deserialize
- **Dipende da:** nessuno (puro)
- **Consumato da:** memory/conversation.js, routes/chat.js
- **Rischio:** Summary troppo lunga → token overflow; poisoning via summary (ASI06)
- **Errori comuni:** .liveWindow (non .messages), getAPIMessages() aggiunge summary come user msg

### N11 — supervisor/cobra.js (113 righe)
- **Cosa fa:** Loop detection (scroll, inspection, blind click), watchdog, tool call tracking
- **Dipende da:** nessuno (puro, singleton object)
- **Consumato da:** tools/executor.js, routes/chat.js
- **Rischio:** False positive blocca workflow legittimo; manca no-progress result-aware (P1)
- **Errori comuni:** Stato non resettato tra request → contamina la successiva (startRequest() resetta)

### N12 — browser/scrape.js (155 righe)
- **Cosa fa:** smartScrape() (Puppeteer), simpleScrape() (fetch), getContentScript() (DOM→MD)
- **Dipende da:** browser/browser, browser/cookie-banner, puppeteer
- **Consumato da:** handlers/read-scrape.js, handlers/navigate.js
- **Rischio:** ALTO — contenuto scrape-ato iniettato nel contesto AI senza sanitizzazione (P0.1)
- **Errori comuni:** Timeout su pagine pesanti, lazy-loaded content non catturato

### N13 — security/ssrf.js (26 righe)
- **Cosa fa:** isSSRFSafe() — blocca localhost, IP privati, metadata, IPv6
- **Dipende da:** nessuno (puro)
- **Consumato da:** handlers/read-scrape.js, handlers/navigate.js
- **Rischio:** Bypass → SSRF su rete interna. IPv6 bracket fix applicato.
- **Errori comuni:** Nuovi formati IP non coperti (es. decimal IP, DNS rebinding)

### N14 — utils/tokens.js (54 righe)
- **Cosa fa:** estimateTokens(), TokenMeter (tracking uso token per provider)
- **Dipende da:** nessuno (puro)
- **Consumato da:** routes/chat.js, routes/monitoring.js
- **Rischio:** Solo tracking, nessun cap enforcement (P0.4)
- **Errori comuni:** Stima token approssimativa (÷4) può sottostimare su lingue non-latine

---

## FLUSSO DATI PRINCIPALE (riparazione chat)

```
Utente digita → WebSocket (ws/server.js)
  → POST /api/chat (routes/chat.js)
    → SuperMario.routeIntent(message)        ← intent + scopes + opLevel
    → SuperMario.decompose(message, scopes)  ← taskPlan multi-step
    → searchKB(message)                      ← kbSnippets
    → SuperMario.assemble(...)               ← systemPrompt + tools filtrati
    → callAI(systemPrompt, msgs, tools)      ← ai/router.js cascade
      → [se tool_calls nella risposta]
        → executeTool(name, args, ctx)       ← tools/executor.js
          → validateToolArgs()               1. validazione
          → SuperMario.validateToolCall()     2. hard guards JS
          → isDomainWhitelisted()            3. whitelist DOM
          → CobraSupervisor.recordToolCall() 4. loop detection
          → guardToolCall()                  5. risk + pending
          → handler(args, ctx)               6. esecuzione
        → risultato → re-call AI con risultato
    → risposta finale → WebSocket broadcast
```

---

## LOOKUP PER SINTOMO

| Sintomo | Nodo | File | Funzione |
|---|---|---|---|
| Tool bloccato senza motivo | N04/N05 | taxonomy.js, calculator.js | getToolRiskSpec(), computeEffectiveRisk() |
| "Tool non implementato" | N07 | executor.js | _handlers[name] mancante |
| Conferma non richiesta/inutile | N04/N06 | taxonomy.js, pending-actions.js | spec.confirm, guardToolCall() |
| Loop infinito tool call | N11 | supervisor/cobra.js | recordToolCall() — scroll/inspect/blind |
| SSRF non bloccato | N13 | ssrf.js | isSSRFSafe() — controllare hostname/IP |
| Credenziali nei log | N12 | sanitize.js | sanitizeForLog() — aggiungere pattern |
| Pagina non letta | N12 | scrape.js, read-scrape.js | smartScrape(), readPage() |
| Bridge non connesso | bridge/connection.js | isBridgeReady() | Controllare WS bridge token |
| Email non inviata | N08 | communication.js | handle send_email — verificare SMTP config |
| AI non risponde | N09 | ai/router.js | callAI() — verificare API keys |
| Token esauriti | N14 | utils/tokens.js | TokenMeter.getStatus() — nessun cap (P0.4) |
| Contenuto iniettato | N12 | scrape.js | getContentScript() — no injection filter (P0.1) |
| Dominio non whitelisted | N03 | whitelist.js | isDomainWhitelisted() — aggiungere dominio |
| Risposta ripetitiva | utils/repetition.js | detectRepetition() | Soglia similarity |

---

## DIPENDENZE CRITICHE (chi rompe chi)

```
config/constants.js ──→ risk/classifiers.js ──→ risk/calculator.js ──→ risk/pending-actions.js
                                                      ↑                        ↓
                         risk/taxonomy.js ─────────────┘                tools/executor.js
                                                                              ↓
config/whitelist.js ──────────────────────────────────────────────→ tools/executor.js
                                                                              ↓
supervisor/cobra.js ──────────────────────────────────────────────→ tools/executor.js
                                                                              ↓
                                                                   handlers/* (tutti)
                                                                              ↓
browser/scrape.js ←── handlers/read-scrape.js, handlers/navigate.js
security/ssrf.js  ←── handlers/read-scrape.js, handlers/navigate.js
ai/router.js      ←── routes/chat.js
memory/*           ←── routes/chat.js
```

**Regola:** modificare un nodo "a sinistra" della freccia impatta TUTTI i nodi a destra.

---

## ANTI-PATTERN DI RIPARAZIONE

1. **Non aggiungere tool senza entry in taxonomy.js** → default destructive, conferma inutile
2. **Non modificare RISK_LEVELS senza aggiornare** RISK_REQUIRES_CONFIRMATION e RISK_DEFAULT_TTL
3. **Non aggiungere handler senza registrarlo** in handlers/index.js
4. **Non toccare executor.js guards** senza re-run test suite
5. **Non modificare ctx** in server-slim.js senza verificare che il nome esista nei consumer
6. **Non aggiungere route** senza registrarla in routes/index.js o nel file route corretto
7. **Mai catch vuoti** nei moduli security/risk/executor — sempre annotare o loggare
