# COBRA v11 — Refactoring Progress

## Sessione 1 — 2026-05-06

### Completato

| Fase | Moduli | Files | Righe | Status |
|------|--------|-------|-------|--------|
| 0.1 | Audit /lib/ | - | - | ✅ 55 file = 100% dead code |
| 0.3 | Backup + Git | - | - | ✅ server.js.v10.2.backup + git init |
| 1.1 | Config | 3 | 115 | ✅ index.js, whitelist.js, constants.js |
| 1.2 | Security | 5 | 199 | ✅ auth.js, ssrf.js, sanitize.js, body-parser.js, human-driver.js |
| 1.3 | Risk | 7 | 368 | ✅ taxonomy.js, classifiers.js, click-intent.js, js-detector.js, calculator.js, confirm-summary.js, pending-actions.js |
| 1.4 | Prompts | 5 | 487 | ✅ cobra-core.js, agents.js, voice-rules.js, identity.js, kb-rules.js |
| 1.14p | Utils | 1 | 13 | ✅ language.js |

**Totale sessione 1: 21 moduli, 1182 righe estratte**

---

## Sessione 2 — 2026-05-06

### Completato

| Fase | Moduli | Files | Righe | Status |
|------|--------|-------|-------|--------|
| 1.5 | KB (Supabase) | 5 | 276 | ✅ supabase.js, search.js, persistence.js, api-keys.js, index.js |
| 1.6 | Memory | 5 | 348 | ✅ chat-memory.js, conversation.js, conversation-context.js, temp-docs.js, index.js |
| 1.7 | Persona | 1 | 47 | ✅ cobra-persona.js |
| 1.8 | Browser | 6 | 443 | ✅ browser.js, pages.js, cookie-banner.js, modals.js, scrape.js, scrape-content.js |
| 1.9 | Bridge | 2 | 93 | ✅ connection.js, navigate.js |
| 1.10 | Tools | 2 | 114 | ✅ schemas.js (60+ tool), validator.js |
| 1.11 | AI Providers | 4 | 273 | ✅ openai.js, anthropic.js, gemini.js, router.js (cascade) |
| 1.14 | Utils | 4 | 142 | ✅ tokens.js, context.js, repetition.js, index.js |
| 1.15 | Supervisor | 1 | 113 | ✅ cobra.js (completo con loop detection) |
| 1.12 | Routes | 1 | 21 | ⏳ stub — setup framework pronto |
| 1.13 | WebSocket | 1 | 30 | ⏳ stub — setup framework pronto |

**Totale sessione 2: 32 moduli, 1900 righe estratte**

---

---

## Sessione 3 — 2026-05-06

### Completato

| Fase | Moduli | Files | Righe | Status |
|------|--------|-------|-------|--------|
| 1.10b | Tool Executor | 1 | 104 | ✅ executor.js — dispatcher + pre/post guards |
| 1.10b | Tool Handlers | 10 | 1107 | ✅ navigate, search, read-scrape, dom, interaction, browser-control, bridge-tools, data, communication, index |

**Totale sessione 3: 11 moduli, 1211 righe estratte**

---

## Sessione 4 — 2026-05-06

### Completato

| Fase | Moduli | Files | Righe | Status |
|------|--------|-------|-------|--------|
| 1.13 | WebSocket reale | 1 | 133 | ✅ ws/server.js — setupWebSocket, wsBroadcast, broadcastFile, bridge protocol, heartbeat |
| 1.12 | HTTP Routes reali | 7 | 728 | ✅ chat.js, tts.js, config.js, pending.js, monitoring.js, misc.js, index.js (dispatcher) |
| 2.0 | Server.js slim orchestrator | 1 | 198 | ✅ server-slim.js — 198 righe, require + DI + boot |

**Totale sessione 4: 9 moduli, 1059 righe estratte**

---

### Riepilogo globale

| | Files | Righe | Note |
|---|---|---|---|
| Sessione 1 | 21 | 1182 | Config, Security, Risk, Prompts |
| Sessione 2 | 32 | 1900 | KB, Memory, Persona, Browser, Bridge, Tools, AI, Supervisor |
| Sessione 3 | 11 | 1211 | Tool Executor + 9 Handler modules |
| Sessione 4 | 9 | 1059 | Routes, WebSocket, server-slim.js |
| Sessione 5 | — | — | Prompt Diet, /lib/ cleanup, Audit finale |
| **Totale** | **71** | **5146** | **da 9141 monolite → 71 moduli, media 72 righe/file** |

### Validazione sessione 4

- ✅ Tutti i 70 moduli caricano senza errori (70/70)
- ✅ ws/server.js (133) — full WebSocket implementation: auth gate, bridge connect/disconnect, webapp hello, heartbeat 30s, ext_result relay, human_takeover_resume, delegate_to_app
- ✅ routes/index.js (115) — lightweight router dispatcher: pattern matching (exact, wildcard, prefix), CORS, auth gate, body parsing, static file serving con CSP + path traversal protection
- ✅ routes/chat.js (190) — SuperMario pipeline completa: human takeover check → pending auto-approve → supervisor → conversation → routeIntent → LLM clarify → decompose → bridge wait → KB search → assemble → prompt audit → repetition → callAI → post-flight → record
- ✅ routes/tts.js (66) — ElevenLabs TTS + voices list
- ✅ routes/config.js (57) — API keys + email SMTP config
- ✅ routes/pending.js (38) — pending actions GET/approve/reject
- ✅ routes/monitoring.js (155) — response-log (6 endpoint), token-meter, monitoring stats/audit/prompts/feedback, human-driver, research, status, logs, conversations, memory, persona, version, bridge-status
- ✅ routes/misc.js (107) — bridge-token, monitor/file, page-preview (sanitized), ws-test, test-monitor, seed-kb, acceptance tests
- ✅ Context injection via `ctx` — nessuna dipendenza circolare tra route modules

---

## Sessione 5 — 2026-05-06

### Completato

| Fase | Descrizione | Status |
|------|-------------|--------|
| 2.1 | Prompt Diet — COBRA_CORE 156→54 righe, VOICE_RULES 81→38, agents.js 139→73 | ✅ ~56% token ridotti per request |
| 3.0 | /lib/ cleanup — 30 file JS archiviati in lib.archive/ (3130 righe dead code) | ✅ lib/ rimossa, codice morto isolato |
| 4.0 | Audit finale | ✅ 71/71 moduli OK, 0 dipendenze circolari |

### Dettaglio Audit Finale

- **71/71 moduli caricano senza errori** (require() test)
- **0 dipendenze circolari** (madge --circular)
- **71 file, 5146 righe totali** (media: 72 righe/file)
- **7 file >120 righe** (tutti giustificati: pipeline core, orchestrator, route aggregati)
- **classifyIntent** estratto da server.js → risk/classifiers.js (con session DI)
- **classifyUrlRisk** correttamente importato da risk/classifiers.js

### File >120 righe (giustificati)

| File | Righe | Motivo |
|------|-------|--------|
| server-slim.js | 203 | Orchestrator — require + DI ctx + boot |
| routes/chat.js | 190 | Pipeline SuperMario completa — non decomponibile |
| routes/monitoring.js | 155 | 20+ endpoint GET/DELETE aggregati |
| tools/handlers/data.js | 155 | 14 handler KB/file/memory/task |
| tools/handlers/interaction.js | 141 | 3 handler complessi (click, fill_form, select) |
| tools/handlers/browser-control.js | 140 | 8 handler browser |
| ws/server.js | 133 | Full WebSocket + bridge protocol |

### Struttura /modules/ completa

```
modules/
├── ai/
│   ├── anthropic.js      (65 lines)
│   ├── gemini.js          (68 lines)
│   ├── openai.js          (65 lines)
│   └── router.js          (75 lines)
├── bridge/
│   ├── connection.js      (46 lines)
│   └── navigate.js        (47 lines)
├── browser/
│   ├── browser.js         (50 lines)
│   ├── cookie-banner.js   (62 lines)
│   ├── modals.js          (78 lines)
│   ├── pages.js           (86 lines)
│   ├── scrape-content.js  (94 lines)
│   └── scrape.js          (73 lines)
├── config/
│   ├── index.js           (61 lines)
│   ├── whitelist.js       (26 lines)
│   └── constants.js       (28 lines)
├── kb/
│   ├── api-keys.js        (106 lines)
│   ├── index.js           (23 lines)
│   ├── persistence.js     (47 lines)
│   ├── search.js          (67 lines)
│   └── supabase.js        (33 lines)
├── memory/
│   ├── chat-memory.js     (110 lines)
│   ├── conversation.js    (108 lines)
│   ├── conversation-context.js (81 lines)
│   ├── temp-docs.js       (41 lines)
│   └── index.js           (8 lines)
├── persona/
│   └── cobra-persona.js   (47 lines)
├── prompts/
│   ├── cobra-core.js      (54 lines)  [diet: 156→54]
│   ├── agents.js          (73 lines)  [diet: 139→73]
│   ├── voice-rules.js     (38 lines)  [diet: 81→38]
│   ├── identity.js        (41 lines)
│   └── kb-rules.js        (50 lines)
├── risk/
│   ├── taxonomy.js        (78 lines)
│   ├── classifiers.js     (73 lines)  [+classifyIntent]
│   ├── click-intent.js    (22 lines)
│   ├── js-detector.js     (20 lines)
│   ├── calculator.js      (72 lines)
│   ├── confirm-summary.js (42 lines)
│   └── pending-actions.js (106 lines)
├── routes/
│   ├── index.js           (115 lines) — dispatcher + CORS + auth + static
│   ├── chat.js            (190 lines) — SuperMario pipeline [core logic]
│   ├── tts.js             (66 lines)
│   ├── config.js          (57 lines)
│   ├── pending.js         (38 lines)
│   ├── monitoring.js      (155 lines) — 20+ GET/DELETE endpoints
│   └── misc.js            (107 lines)
├── security/
│   ├── auth.js            (40 lines)
│   ├── ssrf.js            (26 lines)
│   ├── sanitize.js        (18 lines)
│   ├── body-parser.js     (20 lines)
│   └── human-driver.js    (101 lines)
├── supervisor/
│   └── cobra.js           (113 lines)
├── tools/
│   ├── executor.js        (104 lines)
│   ├── schemas.js         (87 lines)
│   ├── validator.js       (27 lines)
│   └── handlers/
│       ├── index.js           (27 lines)
│       ├── navigate.js        (119 lines)
│       ├── search.js          (103 lines)
│       ├── read-scrape.js     (105 lines)
│       ├── dom.js             (95 lines)
│       ├── interaction.js     (141 lines)
│       ├── browser-control.js (140 lines)
│       ├── bridge-tools.js    (111 lines)
│       ├── data.js            (155 lines)
│       └── communication.js   (111 lines)
├── utils/
│   ├── tokens.js          (54 lines)
│   ├── context.js         (47 lines)
│   ├── language.js        (15 lines)
│   ├── repetition.js      (38 lines)
│   └── index.js           (11 lines)
├── ws/
│   └── server.js          (133 lines) — WebSocket + bridge protocol
└── server-slim.js         (198 lines) — orchestrator (replaces 9141-line server.js)
```
