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

**Totale: 21 moduli, 1182 righe estratte**

### Validazione

- Tutti i 21 moduli caricano senza errori (`node -e "require('./modules/...')"`)
- Tutti i file di logica < 120 righe
- File prompt (cobra-core, agents, voice-rules) sono content, non logica — eccezione al limite
- Test funzionali passati: whitelist, SSRF, sanitize, risk calc, click intent, JS detect, language detect

### Prossime fasi

| Fase | Descrizione | Server.js lines | Stima |
|------|-------------|-----------------|-------|
| 1.5 | KB (Supabase) | ~3600-3780 | 1 sessione |
| 1.6 | Memory | ~1300-1500 | combinata |
| 1.7 | Persona | ~3780-3900 | combinata |
| 1.8 | Browser | ~1900-2100 | 1 sessione |
| 1.9 | Bridge | ~2200-2400 | combinata |
| 1.10 | Tool Execution | ~4800-7100 | 2 sessioni |
| 1.11 | AI Providers | ~7200-7500 | 1 sessione |
| 1.12 | HTTP Routes | ~7800-9000 | combinata |
| 1.13 | WebSocket | ~7600-7800 | combinata |
| 1.14 | Utilities | ~sparse | combinata |
| 1.15 | Supervisor | ~4100-4200 | combinata |

### Struttura /modules/

```
modules/
├── config/
│   ├── index.js         (61 lines) — ENV, PORT, COBRA_DEFAULTS
│   ├── whitelist.js     (26 lines) — INTERACTION_WHITELIST
│   └── constants.js     (28 lines) — RISK_LEVELS, maxRisk()
├── security/
│   ├── auth.js          (40 lines) — API tokens, isAuthenticatedRequest
│   ├── ssrf.js          (26 lines) — isSSRFSafe
│   ├── sanitize.js      (18 lines) — sanitizeForLog
│   ├── body-parser.js   (20 lines) — readBodyWithLimit
│   └── human-driver.js  (101 lines) — HumanDriver anti-detection
├── risk/
│   ├── taxonomy.js      (78 lines) — TOOL_RISK_TAXONOMY
│   ├── classifiers.js   (40 lines) — classifyUrlRisk
│   ├── click-intent.js  (22 lines) — classifyClickIntent
│   ├── js-detector.js   (20 lines) — detectDangerousJs
│   ├── calculator.js    (72 lines) — computeEffectiveRisk
│   ├── confirm-summary.js (42 lines) — buildConfirmSummary
│   └── pending-actions.js (106 lines) — guardToolCall, pending store
├── prompts/
│   ├── cobra-core.js    (156 lines) — COBRA_CORE personality [content]
│   ├── agents.js        (139 lines) — 6 agent prompts [content]
│   ├── voice-rules.js   (81 lines) — TTS pronunciation [content]
│   ├── identity.js      (47 lines) — IT/EN identity fallbacks
│   └── kb-rules.js      (55 lines) — always-loaded KB entries
└── utils/
    └── language.js      (13 lines) — detectLanguage
```
