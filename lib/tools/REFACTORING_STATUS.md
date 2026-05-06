# ExecuteTool Refactoring Status

## Overview
The massive `executeTool` function (server.js lines 4788-6988, ~2100 lines) is being split into organized category files under `lib/tools/`.

## Architecture

```
lib/tools/
├── index.js                (DONE) Main dispatcher - imports all handlers, creates factory
├── navigate.js             (STUB) Navigation & search tools
├── read.js                 (STUB) Read-only page inspection tools
├── interact.js             (STUB) DOM interaction tools
├── inspect.js              (STUB) JS execution tools
├── communicate.js          (STUB) Email, LinkedIn, WhatsApp
└── admin.js                (STUB) File, KB, Task, Memory management
```

## Refactoring Rules (from COBRA)

1. **Function Signature**: `async function toolName(args, deps) { ... }`
   - `args`: User-provided arguments (e.g., `{ url: "...", selector: "..." }`)
   - `deps`: Injected dependencies object (passed once to factory)

2. **Extract Code Verbatim**: Copy exact logic from switch cases, just wrap in async functions

3. **Deps Object Contains**:
   - Logging: `log`, `emitThinking`, `emitReasoning`
   - Session: `session`, `wsBroadcast`
   - DOM Access: `_activePage`, `bridgeCommand`, `bridgeClick`, `bridgeFillForm`, etc.
   - Security: `isSSRFSafe`, `guardToolCall`, `SuperMario`, `CobraSupervisor`
   - Scrapers: `scrapeUrl`, `smartScrape`, `getActivePage`
   - State: `HumanDriver`, `ResearchStrategy`, `Supervisor`, `COBRA_DEFAULTS`
   - File/KB: `PersistentMemory` (when available)

4. **File Size Limit**: ~300 lines per file. If larger, split further.

5. **Validation**: Run `node -c <file>` before committing

6. **Module Exports**: Each file exports named functions
   - Example: `module.exports = { toolNavigate, toolWebSearch, toolGoogleSearch, ... };`

## Current Status

### DONE: index.js
- Master dispatcher created
- Routing table: all 44 tool names mapped to handler functions
- Creates factory function `createExecuteToolFactory(deps)`
- Security checks in place (SuperMario, guardToolCall, supervisor)
- Proper error handling and logging
- Module exports: `{ createExecuteToolFactory }`

### TODO: navigate.js
**Cases to extract** (server.js lines):
- `navigate` (4856-4997)
- `google_search` / `web_search` (5000-5198)
- `read_page` (5201-5254)
- `scrape_url` (5257-5283)
- `batch_scrape` (6076-6095)
- `read_table` (6604-6626)

**Deps needed**:
- `log`, `session`, `wsBroadcast`, `emitThinking`, `emitReasoning`
- `isBridgeReady`, `bridgeNavigate`, `bridgeCommand`
- `_activePage`, `takeActiveScreenshot`
- `smartScrape`, `scrapeUrl`, `getActivePage`
- `HumanDriver`, `ResearchStrategy`, `Supervisor`, `isSSRFSafe`, `detectCaptcha`, `puppeteer`
- `COBRA_DEFAULTS`, `_paywallDomains`, `_savePaywallDomains`, `emitSiteVisit`

### TODO: read.js
**Cases to extract** (server.js lines):
- `get_page_elements` (5663-5811)
- `get_page_snapshot` (5812-5830)
- `screenshot` (5831-5851)
- `scroll_page` (6158-6179)
- `hover_element` (6180-6225)
- `wait_for` (6339-6359)
- `switch_tab` (6301-6338)
- `detect_block` (6510-6528)
- `verify_action` (6529-6566)
- `wait_network_idle` (6627-6641)

**Deps needed**:
- `log`, `emitThinking`, `session`, `wsBroadcast`
- `isBridgeReady`, `bridgeCommand`
- `_activePage`, `takeActiveScreenshot`
- `COBRA_DEFAULTS`

### TODO: interact.js
**Cases to extract** (server.js lines):
- `click_element` (5347-5424)
- `fill_form` (5427-5660)
- `get_page_elements` (5663-5811) — shared with read.js? Consider moving to read.js
- `type_human` (6478-6492)
- `press_key` (6450-6477)
- `select_option` (6360-6449)
- `select_dropdown` (6567-6582)
- `set_datepicker` (6583-6603)
- `drag_drop` (6226-6276)
- `upload_file` (6277-6300)
- `key_combo` (6493-6509)
- `submit_form` (not found — may need to add or create from fill_form)
- `clipboard_write` (6642-6659)

**Deps needed**:
- `log`, `emitThinking`, `session`, `wsBroadcast`
- `isBridgeReady`, `bridgeClick`, `bridgeFillForm`, `bridgeCommand`, `dismissModals`, `dismissModalsBridge`
- `_activePage`, `takeActiveScreenshot`
- `HumanDriver`, `COBRA_DEFAULTS`

### TODO: inspect.js
**Cases to extract** (server.js lines):
- `inspect_dom_js` (5286-5307)
- `mutate_dom_js` (5310-5331)
- `execute_js` (5334-5344)

**Deps needed**:
- `log`, `emitThinking`, `session`, `takeActiveScreenshot`
- `isBridgeReady`, `bridgeCommand`
- `_activePage`

### TODO: communicate.js
**Cases to extract** (server.js lines):
- `prepare_email_draft` (6660-6670)
- `send_email` (6728-6759)
- `check_emails` / `read_inbox` (6760-6770)
- `open_whatsapp` / `send_whatsapp` (6771-6810)
- `open_linkedin` / `send_linkedin` (6811-6876)
- `linkedin_search` (6877-6893)
- `linkedin_send_message` (6903-6912)
- `whatsapp_send` (6941-6954)

**Deps needed**:
- `log`, `session`, `wsBroadcast`, `emitThinking`
- `isBridgeReady`, `bridgeCommand`
- `_activePage`, `takeActiveScreenshot`
- Gmail/SMTP API helpers (if exist)

### TODO: admin.js
**Cases to extract** (server.js lines):
- `save_local_file` (6117-6131)
- `search_kb` (5939-5944)
- `save_kb` / `save_to_kb` (5933-5938, 5933-5938)
- `kb_update` (5945-5950)
- `kb_delete` (5951-5957)
- `create_task` (5993-6009)
- `list_tasks` (6062-6075)
- `complete_task` (6054-6061)
- `save_memory` (5983-5992)
- `recall_memory` / `list_memories` (not in list but likely exist)
- `create_file` (5958-5982)
- `list_local_files` (6096-6104)
- `read_local_file` (6105-6116)
- `search_local_files` (6132-6157)

**Deps needed**:
- `log`, `session`, `wsBroadcast`
- `PersistentMemory`, `KnowledgeBase` or similar KB API
- File system helpers

## Integration Steps

1. ✅ Create `lib/tools/` directory
2. ✅ Create `lib/tools/index.js` with master dispatcher
3. ⏳ Extract each case into category files
4. ⏳ Verify each file with `node -c`
5. ⏳ Update server.js to use the factory
6. ⏳ Test with tool execution flow
7. ⏳ Commit with changelog

## Usage in server.js

**Before**: Direct switch case in `executeTool(name, args)`
**After**:
```javascript
const { createExecuteToolFactory } = require('./lib/tools');

// Create dependencies object
const toolDeps = {
  log, session, wsBroadcast, emitThinking, emitReasoning,
  isBridgeReady, bridgeNavigate, bridgeCommand, bridgeClick, bridgeFillForm,
  // ... all other deps
  COBRA_DEFAULTS, _paywallDomains, _savePaywallDomains,
  // ...
};

// Create the bound executeTool function
const executeTool = createExecuteToolFactory(toolDeps);

// Use it as before:
// const result = await executeTool('navigate', { url: '...' });
```

## Notes

- Some tools may share logic (e.g., `get_page_elements` used in both `read.js` and possibly `interact.js`)
- Payment security blocks appear in `click_element` and `fill_form` — may need shared validation function
- Bridge path (real browser) + Puppeteer fallback pattern is consistent across tools
- Research Strategy & Supervisor tracking is integrated into most nav/search tools
- Test thoroughly before production — this refactoring preserves all logic but changes structure
