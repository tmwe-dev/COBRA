// modules/server-slim.js — COBRA v11 Slim Orchestrator
// Replaces monolithic server.js (~9141 lines) with modular wiring

const http = require('http');
const path = require('path');
const fs = require('fs');

// ── 1. Config ──
const config = require('./config');
const { ALLOWED_ORIGINS, MAX_BODY_SIZE, RISK_LEVELS } = require('./config/constants');
const { COBRA_DEFAULTS } = require('./config');
const { isDomainWhitelisted } = require('./config/whitelist');

// ── 2. Security ──
const { isAuthenticatedRequest, COBRA_API_TOKEN } = require('./security/auth');
const { sanitizeForLog } = require('./security/sanitize');
const HumanDriver = require('./security/human-driver');

// ── 3. Risk ──
const { TOOL_RISK_TAXONOMY, getToolRiskSpec } = require('./risk/taxonomy');
const { classifyUrlRisk } = require('./risk/classifiers');
const { computeEffectiveRisk, classifyClickIntent, detectDangerousJs } = require('./risk/calculator');
const { getActivePendingActions, approvePendingAction, rejectPendingAction, guardToolCall, _pendingActions } = require('./risk/pending-actions');

// ── 4. Prompts ──
const { COBRA_CORE } = require('./prompts/cobra-core');
const { AGENT_PROMPTS } = require('./prompts/agents');
const { ALWAYS_LOADED_KB } = require('./prompts/kb-rules');

// ── 5. KB ──
const { searchKB, saveToKB, updateKB, deleteKB } = require('./kb/search');
const { loadAPIKeys, loadOperatorConfig } = require('./kb/api-keys');

// ── 6. Memory ──
const ChatMemory = require('./memory/chat-memory');
const ConversationEngine = require('./memory/conversation');

// ── 7. AI ──
const { callAI } = require('./ai/router');

// ── 8. Browser ──
const { launchBrowser, getActivePage } = require('./browser/browser');
const { smartScrape } = require('./browser/scrape');

// ── 9. Bridge ──
const { bridgeCommand, bridgeNavigate } = require('./bridge/connection');

// ── 10. Tools ──
const { COBRA_TOOLS } = require('./tools/schemas');
const { executeTool, registerHandlers } = require('./tools/executor');
const allHandlers = require('./tools/handlers');

// ── 11. Supervisor ──
const CobraSupervisor = require('./supervisor/cobra');

// ── 12. Utils ──
const { estimateTokens } = require('./utils/tokens');
const { detectRepetition } = require('./utils/repetition');

// ── 13. WebSocket ──
const wsModule = require('./ws/server');

// ── 14. Routes ──
const { setupRoutes } = require('./routes');

// ══════════════════════════════════════════════════════════════
// Runtime State
// ══════════════════════════════════════════════════════════════
const PORT = config.PORT || 3000;
const BRIDGE_SESSION_TOKEN = config.BRIDGE_SESSION_TOKEN || require('crypto').randomBytes(32).toString('hex');
const baseDir = path.resolve(__dirname, '..');
const dataDir = path.join(baseDir, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const serverLogs = [];
function log(msg) { const ts = new Date().toISOString(); const entry = `[${ts}] ${msg}`; console.log(entry); serverLogs.push(entry); if (serverLogs.length > 500) serverLogs.shift(); }

const session = {
  id: Date.now().toString(36),
  lastPage: null, kbSnippets: [], emailConfig: {},
  humanTakeover: false, humanTakeoverResolve: null,
  chatAborted: false, currentOperationLevel: 'read',
  currentApprovalToken: null,
};
const toolHistory = [];
const aiKeys = {};
const memories = [];
const tasks = [];
const conversationEngine = new ConversationEngine();

// Placeholder objects
const TokenMeter = { getStatus: () => ({ totalTokens: 0, level: 'ok' }), reset: () => {} };
const ResponseRecorder = { recordChat: () => {}, recordTTS: () => {}, getLog: () => [], getStats: () => ({}), exportJSON: () => [], exportCSV: () => '', exportConversation: () => '', loadFromFile: () => {}, _log: [], _filePath: '' };
const SuperMario = {
  routeIntent: () => ({ intent: 'chat', scopes: [], operationLevel: 'read' }),
  clarifyIntentWithLLM: async () => null,
  decompose: () => null,
  assemble: async (opts) => {
    const { estimateTokens } = require('./utils/tokens');
    const { ALWAYS_LOADED_KB } = require('./prompts/kb-rules');
    let prompt = COBRA_CORE;

    // F6: XML-delimited context sections for injection defense
    // KB context (F7: only always_load rules + search results, F9: budget 2000 tokens)
    const kbParts = [];
    for (const rule of ALWAYS_LOADED_KB) kbParts.push(`[${rule.title}] ${rule.content}`);
    let kbText = kbParts.join('\n\n');
    if (estimateTokens(kbText) > 2000) kbText = kbText.substring(0, 8000);
    prompt += `\n\n<system_rules>\n${kbText}\n</system_rules>`;

    // Last tool result context (F9: budget 1500 tokens)
    if (opts.lastToolResult) {
      let toolCtx = `URL: ${opts.lastToolResult.url || ''}\nTitolo: ${opts.lastToolResult.title || ''}\n${opts.lastToolResult.snippet || ''}`;
      if (estimateTokens(toolCtx) > 1500) toolCtx = toolCtx.substring(0, 6000);
      prompt += `\n\n<untrusted_content source="last_page">\n${toolCtx}\n</untrusted_content>`;
    }

    // Task plan context
    if (opts.taskPlan) {
      prompt += `\n\n<task_plan>\n${JSON.stringify(opts.taskPlan)}\n</task_plan>`;
    }

    return { systemPrompt: prompt, tools: opts.allTools || [], scopes: opts.scopes, preflight: { ok: true }, trace_id: Date.now() };
  },
  selectModel: () => ({ tier: 'default', reason: 'default' }),
  complete: () => ({ warnings: [] }),
  updateNarrativeSummary: async () => {},
  getInvocationLog: () => [],
  logToolExecution: () => {},
  validateToolCall: () => ({ allowed: true }),
};

function emitThinking(text) { wsModule.wsBroadcast({ type: 'thinking', text }); }
function emitReasoning(text, icon) { wsModule.wsBroadcast({ type: 'ai_reasoning', text, icon }); }
function auditPrompt(message, routing, marioResult) {
  try {
    fs.appendFileSync(path.join(dataDir, 'supermario_prompts.jsonl'),
      JSON.stringify({ timestamp: new Date().toISOString(), message: message.substring(0, 200), routing: { intent: routing.intent, scopes: routing.scopes }, assembly: { toolCount: marioResult.tools.length, promptLength: marioResult.systemPrompt.length } }) + '\n');
  } catch { /* audit log write failure — non-blocking */ }
}

// ── Register tool handlers ──
registerHandlers(allHandlers);

// ══════════════════════════════════════════════════════════════
// DI Context
// ══════════════════════════════════════════════════════════════
const ctx = {
  session, toolHistory, aiKeys, memories, tasks, serverLogs,
  baseDir, dataDir, PORT,
  BRIDGE_SESSION_TOKEN, COBRA_API_TOKEN, ALLOWED_ORIGINS, RISK_LEVELS,
  APP_VERSION: config.APP_VERSION || '11.0', APP_BUILD: config.APP_BUILD || 'modular',
  COBRA_TOOLS, _pendingActions,
  log, emitThinking, emitReasoning, auditPrompt,
  sanitizeForLog, isDomainWhitelisted, isAuthenticatedRequest,
  classifyUrlRisk, classifyClickIntent, detectDangerousJs, computeEffectiveRisk,
  getActivePendingActions, approvePendingAction, rejectPendingAction, guardToolCall,
  searchKB, saveToKB, updateKB, deleteKB,
  detectRepetition,
  isBridgeReady: wsModule.isBridgeReady,
  getBridgeCapabilities: wsModule.getBridgeCapabilities,
  getWsClientCount: () => wsModule.getWsClients().size,
  wsBroadcast: wsModule.wsBroadcast,
  broadcastFile: wsModule.broadcastFile,
  executeTool, callAI,
  conversationEngine, SuperMario, CobraSupervisor,
  HumanDriver, TokenMeter, ResponseRecorder,
};

// ══════════════════════════════════════════════════════════════
// Boot
// ══════════════════════════════════════════════════════════════
const handleRequest = setupRoutes(ctx);
const server = http.createServer(handleRequest);
wsModule.setupWebSocket(server, ctx);

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`\n  COBRA v11 — http://127.0.0.1:${PORT} (localhost only)`);
  console.log(`  Tools: ${COBRA_TOOLS.length} | Handlers: ${Object.keys(allHandlers).length}\n`);
  await loadAPIKeys();
  await loadOperatorConfig();
  await conversationEngine.load();
  log(`Server ready.`);
});

process.on('SIGINT', () => { console.log('\nBye!'); process.exit(0); });
module.exports = { server, ctx };
