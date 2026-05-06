# lib/tools: Refactored Tool Dispatcher

Refactoring of the massive `executeTool` function (2100 lines) from server.js into organized, modular category files.

## Architecture

```
lib/tools/
├── index.js              Master dispatcher (creates factory)
├── navigate.js           Navigation & search (6 tools: 1 complete, 5 stubs)
├── read.js               Read-only inspection (10 tools: stubs)
├── interact.js           DOM interaction (12 tools: stubs)
├── inspect.js            JS execution (3 tools: stubs)
├── communicate.js        Email, LinkedIn, WhatsApp (7 tools: stubs)
└── admin.js              Files, KB, Tasks, Memory (11 tools: stubs)

STATUS: 50 tools total
  - 1 fully implemented (toolNavigate)
  - 49 stubbed and ready for extraction
  - All stubs have placeholder error responses
```

## File Status

| File | Lines | Status | Tools |
|------|-------|--------|-------|
| index.js | 312 | ✅ DONE | Master routing, factory function |
| navigate.js | 228 | 🟡 PARTIAL | 1/6 complete; needs 5 extraction |
| read.js | 15 | 🟠 STUBS | 10 tools stubbed |
| interact.js | 18 | 🟠 STUBS | 12 tools stubbed |
| inspect.js | 7 | 🟠 STUBS | 3 tools stubbed |
| communicate.js | 11 | 🟠 STUBS | 7 tools stubbed |
| admin.js | 14 | 🟠 STUBS | 11 tools stubbed |
| **TOTAL** | **605** | | **50 tools** |

## Quick Reference

### Fully Implemented
- `navigate` (server.js 4856-4997, ~140 lines)

### Need Extraction (organized by file & server.js line ranges)

**navigate.js** (5 remaining):
- `google_search` / `web_search` (5000-5198)
- `read_page` (5201-5254)
- `scrape_url` (5257-5283)
- `batch_scrape` (6076-6095)
- `read_table` (6604-6626)

**interact.js** (12 cases):
- `click_element` (5347-5424)
- `fill_form` (5427-5660) ← LARGE: 230 lines
- `type_human` (6478-6492)
- `press_key` (6450-6477)
- `select_option` (6360-6449)
- `select_dropdown` (6567-6582)
- `set_datepicker` (6583-6603)
- `drag_drop` (6226-6276)
- `upload_file` (6277-6300)
- `key_combo` (6493-6509)
- `submit_form` (check if exists)
- `clipboard_write` (6642-6659)

**read.js** (10 cases):
- `get_page_elements` (5663-5811) ← LARGE: ~150 lines
- `get_page_snapshot` (5812-5830)
- `screenshot` (5831-5851)
- `scroll_page` (6158-6179)
- `hover_element` (6180-6225)
- `wait_for` (6339-6359)
- `switch_tab` (6301-6338)
- `detect_block` (6510-6528)
- `verify_action` (6529-6566)
- `wait_network_idle` (6627-6641)

**communicate.js** (7 cases):
- `prepare_email_draft` (6660-6670)
- `send_email` (6728-6759)
- `check_emails` / `read_inbox` (6760-6770)
- `open_whatsapp` / `send_whatsapp` (6771-6810)
- `open_linkedin` / `send_linkedin` (6811-6876)
- `linkedin_search` (6877-6893)
- `linkedin_send_message` (6903-6912)
- `whatsapp_send` (6941-6954)

**admin.js** (11 cases):
- `save_local_file` (6117-6131)
- `search_kb` (5939-5944)
- `save_kb` / `save_to_kb` (5933-5938)
- `kb_update` (5945-5950)
- `kb_delete` (5951-5957)
- `create_task` (5993-6009)
- `list_tasks` (6062-6075)
- `complete_task` (6054-6061)
- `save_memory` (5983-5992)
- `recall_memory` / `list_memories` (not found yet)
- `create_file` (5958-5982)
- `list_local_files` (6096-6104)
- `read_local_file` (6105-6116)
- `search_local_files` (6132-6157)

**inspect.js** (3 cases):
- `inspect_dom_js` (5286-5307)
- `mutate_dom_js` (5310-5331)
- `execute_js` (5334-5344)

## Usage

### Creating the Factory (in server.js)

```javascript
const { createExecuteToolFactory } = require('./lib/tools');

// Initialize once at module load
const toolDeps = {
  log, session, wsBroadcast, emitThinking, emitReasoning,
  isBridgeReady, bridgeNavigate, bridgeCommand, bridgeClick, bridgeFillForm,
  _activePage, takeActiveScreenshot, smartScrape, scrapeUrl, getActivePage,
  HumanDriver, ResearchStrategy, Supervisor, isSSRFSafe, detectCaptcha, puppeteer,
  COBRA_DEFAULTS, _paywallDomains, _savePaywallDomains, emitSiteVisit,
  dismissModals, dismissModalsBridge,
  validateToolArgs, SuperMario, CobraSupervisor, guardToolCall,
  toolHistory, PersistentMemory, // optional
  // ... add any other deps from server.js
};

const executeTool = createExecuteToolFactory(toolDeps);
```

### Using Tools (unchanged API)

```javascript
// All tools use the same async pattern
const result = await executeTool('navigate', { url: 'https://example.com' });
const parsed = JSON.parse(result);
```

## Refactoring Principles (COBRA)

1. **Extract Verbatim**: Copy exact code from switch cases, no logic changes
2. **Immutable Signature**: `async function toolName(args, deps) { ... }`
3. **Dependency Injection**: All deps passed once at factory creation
4. **File Size**: Keep files under 300 lines; split if exceeds
5. **Validation**: Verify syntax with `node -c lib/tools/file.js`
6. **No Side Effects**: Each tool is a pure function (given same deps/args → same result)

## Integration Checklist

- [ ] All files pass syntax check (`node -c`)
- [ ] index.js routes all 44 tools
- [ ] toolNavigate verified working
- [ ] Security checks (payment blocks, SSRF) still active
- [ ] Supervisor loop detection functional
- [ ] Error messages consistent
- [ ] Bridge fallback paths working
- [ ] No regression in existing functionality

## Documents

- **REFACTORING_STATUS.md** — Detailed case-by-case breakdown and deps mapping
- **INTEGRATION_GUIDE.md** — Step-by-step integration instructions & testing plan
- **README.md** — This file

## Next Steps

1. Extract remaining cases from server.js into respective files
2. Run syntax checks on each file
3. Integration test in server.js
4. Verify all 44 tools work as before
5. Commit with detailed changelog

See INTEGRATION_GUIDE.md for detailed instructions.
