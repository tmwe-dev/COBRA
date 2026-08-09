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
const { verifyAuditChain, flushAuditSync } = require('./security/audit-log');
const { HumanDriver } = require('./security/human-driver');

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
const { LearningStore } = require('./memory/learning');
const { RegistroFonti } = require('./fonti/registro');

// ── 7. AI ──
const { callAI } = require('./ai/router');

// ── 8. Browser ──
const { getOrCreateBrowser, getState, setState } = require('./browser/browser');
const { smartScrape, scrapeUrl } = require('./browser/scrape');
const { dismissModals, dismissModalsBridge } = require('./browser/modals');
const { getActivePage, detectCaptcha } = require('./browser/pages');
const { getFeedbackStats } = require('./risk/pending-actions');

// ── Dipendenze opzionali (degradano graziosamente se non installate) ──
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch { /* Puppeteer non installato — si usa il bridge */ }
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* nodemailer non installato — send_email disabilitato */ }

// ── 9. Bridge ──
const { bridgeCommand, bridgeNavigate } = require('./bridge/connection');

// ── 10. Tools ──
const { COBRA_TOOLS } = require('./tools/schemas');
const { executeTool, registerHandlers } = require('./tools/executor');
const allHandlers = require('./tools/handlers');

// ── 11. Supervisor ──
const { CobraSupervisor } = require('./supervisor/cobra');

// ── 10b. Diario delle esecuzioni ──
const { Giornale } = require('./diario/giornale');

// ── 12. Utils ──
const { estimateTokens } = require('./utils/tokens');
const { detectRepetition } = require('./utils/repetition');
const { digestToolResult } = require('./utils/context');
const { writeJsonAtomicSync, readJsonSafeSync } = require('./utils/atomic-file');

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

// ── Scrivere un log non deve poter rompere il server ──
//
// Il 7 agosto crash.log pesava 3,1 GB: centinaia di migliaia di "Error: write
// EIO", tutti identici, tutti nati qui.
//
// Succede quando il server sopravvive al Terminale che l'ha avviato — con
// screen o nohup e' la norma. Il socket dello standard output muore, console.log
// solleva EIO, l'eccezione risale, viene registrata come crash, e la
// registrazione passa di nuovo da console.log. Un log che fallisce genera un
// errore che si tenta di loggare, che fallisce. Nessuno se ne accorge finche'
// non mancano tre giga sul disco.
//
// La cura e' banale e mancava: se la console non c'e' piu', si smette di
// usarla. Il registro in memoria resta, e /api/log continua a funzionare.
let _consoleMorta = false;
function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  serverLogs.push(entry);
  if (serverLogs.length > 500) serverLogs.shift();
  if (_consoleMorta) return;
  try {
    console.log(entry);
  } catch (e) {
    // EIO/EPIPE = chi ascoltava se n'e' andato. Da qui in poi si scrive solo
    // in memoria. Non si prova a segnalarlo: segnalarlo vorrebbe dire
    // scrivere sulla console, ed e' esattamente cio' che ha appena fallito.
    if (e && (e.code === 'EIO' || e.code === 'EPIPE')) _consoleMorta = true;
  }
}

// Stessa ragione: senza questi, un EPIPE sullo stdout diventa un'eccezione non
// gestita e il processo muore quando chiudi il Terminale.
process.stdout.on('error', (e) => { if (e && (e.code === 'EIO' || e.code === 'EPIPE')) _consoleMorta = true; });
process.stderr.on('error', () => { _consoleMorta = true; });

// ── Paywall domains persistent set ──
const _paywallFile = path.join(dataDir, 'paywall_domains.json');
const _paywallDomains = new Set(readJsonSafeSync(_paywallFile, []) || []);
function _savePaywallDomains() { writeJsonAtomicSync(_paywallFile, [..._paywallDomains], { pretty: false }); }

const session = {
  id: Date.now().toString(36),
  lastPage: null, kbSnippets: [], emailConfig: {},
  humanTakeover: false, humanTakeoverResolve: null,
  chatAborted: false, currentOperationLevel: 'read',
  currentApprovalToken: null,
};
const toolHistory = [];
const aiKeys = {};
// ── Auto-load API keys from .env ──
if (process.env.OPENAI_API_KEY) aiKeys.openaiKey = process.env.OPENAI_API_KEY;
if (process.env.ANTHROPIC_API_KEY) aiKeys.anthropicKey = process.env.ANTHROPIC_API_KEY;
if (process.env.GEMINI_API_KEY) aiKeys.geminiKey = process.env.GEMINI_API_KEY;
if (process.env.GROQ_API_KEY) aiKeys.groqKey = process.env.GROQ_API_KEY;
if (process.env.ELEVENLABS_API_KEY) aiKeys.elevenlabsKey = process.env.ELEVENLABS_API_KEY;
// La casella di posta si rilegge all'avvio: senza questo, salvarla non
// servirebbe a niente e bisognerebbe reinserirla ad ogni riavvio.
const _postaSalvata = {};
if (process.env.MAIL_USER && process.env.MAIL_PASS) {
  Object.assign(_postaSalvata, {
    imapHost: process.env.MAIL_IMAP_HOST || '',
    imapPort: Number(process.env.MAIL_IMAP_PORT || 993),
    imapUser: process.env.MAIL_USER,
    imapPass: process.env.MAIL_PASS,
    host: process.env.MAIL_SMTP_HOST || '',
    port: Number(process.env.MAIL_SMTP_PORT || 587),
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
    from: process.env.MAIL_USER,
  });
  console.log(`[Config] Casella di posta ripresa: ${String(process.env.MAIL_USER).replace(/(.{2}).*(@)/, '$1***$2')}`);
  session.emailConfig = _postaSalvata;
}

if (process.env.OPENAI_MODEL) aiKeys.openaiModel = process.env.OPENAI_MODEL;
if (process.env.ANTHROPIC_MODEL) aiKeys.anthropicModel = process.env.ANTHROPIC_MODEL;
if (process.env.GEMINI_MODEL) aiKeys.geminiModel = process.env.GEMINI_MODEL;
// ── Memory persistence ──
const _memoriesFile = path.join(dataDir, 'memories.json');
const memories = readJsonSafeSync(_memoriesFile, []) || [];
function _saveMemories() { writeJsonAtomicSync(_memoriesFile, memories); }
const conversationEngine = new ConversationEngine();
// Memoria a tre livelli: azioni di sessione, fatti operativi, fatti permanenti
const learningStore = new LearningStore(dataDir);
// Il diario: una riga per ogni esecuzione, col motivo quando va storta.
// Prima di questo, di 880 chiamate e 67 fallimenti restava solo `ok:false`.
const giornale = new Giornale(dataDir);
// Dove cercare, imparato dalle letture fatte davvero: Kayak vuoto, Google
// Voli pieno — scoperto una volta, scritto per sempre.
const registroFonti = new RegistroFonti(dataDir);
// Manutenzione periodica: promuove ciò che si conferma, fa decadere ciò che
// non serve più. Senza, la memoria diventa un archivio piatto dove tutto pesa
// uguale e il contesto si riempie di dettagli irrilevanti.
const _manutenzioneMemoria = setInterval(() => {
  try {
    const esiti = learningStore.promuoviEDecadi();
    learningStore.potaAzioni();
    if (esiti.promossiA2 || esiti.promossiA3 || esiti.dimenticati) {
      log(`[Memoria] ${esiti.promossiA2} promossi a L2, ${esiti.promossiA3} a L3, ${esiti.dimenticati} dimenticati`);
    }
  } catch (e) { log(`[Memoria] Manutenzione fallita: ${e.message}`); }
}, 15 * 60 * 1000);
if (_manutenzioneMemoria.unref) _manutenzioneMemoria.unref();

// ── Task persistence ──
const _tasksFile = path.join(dataDir, 'tasks.json');
const tasks = readJsonSafeSync(_tasksFile, []) || [];
function _saveTasks() { writeJsonAtomicSync(_tasksFile, tasks); }
// Patch task mutations to auto-save
const _origPush = tasks.push.bind(tasks);
tasks.push = function(...args) { const r = _origPush(...args); _saveTasks(); return r; };
const _origSplice = tasks.splice.bind(tasks);
tasks.splice = function(...args) { const r = _origSplice(...args); _saveTasks(); return r; };

// ── TokenMeter — real implementation with budget cap ──
const _tokenMeterState = { totalPrompt: 0, totalCompletion: 0, calls: 0, dailyCap: 2000000, dayStart: Date.now() };
const TokenMeter = {
  track({ promptTokens, completionTokens }) {
    _tokenMeterState.totalPrompt += promptTokens || 0;
    _tokenMeterState.totalCompletion += completionTokens || 0;
    _tokenMeterState.calls++;
    // Reset daily
    if (Date.now() - _tokenMeterState.dayStart > 86400000) {
      _tokenMeterState.totalPrompt = promptTokens || 0;
      _tokenMeterState.totalCompletion = completionTokens || 0;
      _tokenMeterState.calls = 1;
      _tokenMeterState.dayStart = Date.now();
    }
  },
  getStatus() {
    const total = _tokenMeterState.totalPrompt + _tokenMeterState.totalCompletion;
    const pct = Math.round((total / _tokenMeterState.dailyCap) * 100);
    return { totalTokens: total, promptTokens: _tokenMeterState.totalPrompt, completionTokens: _tokenMeterState.totalCompletion, calls: _tokenMeterState.calls, level: pct > 90 ? 'critical' : pct > 70 ? 'warning' : 'ok', percentUsed: pct };
  },
  checkBudget() {
    const total = _tokenMeterState.totalPrompt + _tokenMeterState.totalCompletion;
    return { allowed: total < _tokenMeterState.dailyCap, consumed: total, cap: _tokenMeterState.dailyCap };
  },
  reset() { _tokenMeterState.totalPrompt = 0; _tokenMeterState.totalCompletion = 0; _tokenMeterState.calls = 0; _tokenMeterState.dayStart = Date.now(); },
};

// ── ResponseRecorder — real implementation with file persistence ──
const _responseLog = [];
const _responseFile = path.join(dataDir, 'response_log.jsonl');
const ResponseRecorder = {
  recordChat(entry) {
    const record = { ...entry, timestamp: new Date().toISOString() };
    _responseLog.push(record);
    if (_responseLog.length > 200) _responseLog.shift();
    try { fs.appendFileSync(_responseFile, JSON.stringify(record) + '\n'); } catch {}
  },
  recordTTS() {},
  getLog() { return _responseLog; },
  getStats() {
    const providers = {};
    for (const r of _responseLog) { providers[r.provider] = (providers[r.provider] || 0) + 1; }
    return { total: _responseLog.length, providers, avgDuration: _responseLog.length > 0 ? Math.round(_responseLog.reduce((s, r) => s + (r.durationMs || 0), 0) / _responseLog.length) : 0 };
  },
  exportJSON() { return _responseLog; },
  exportCSV() {
    const cols = ['timestamp', 'intent', 'provider', 'model', 'durationMs', 'kbEntries', 'toolsUsed', 'userMessage', 'response'];
    const esc = (v) => {
      if (v === undefined || v === null) return '';
      const s = Array.isArray(v) ? v.map(t => t.name || t).join(' ') : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [cols.join(',')];
    for (const r of _responseLog) rows.push(cols.map(c => esc(r[c])).join(','));
    return rows.join('\n');
  },
  exportConversation() {
    if (_responseLog.length === 0) return 'Nessuna conversazione registrata.';
    const out = ['COBRA — Esportazione conversazioni', `Generato: ${new Date().toLocaleString('it-IT')}`, `Scambi: ${_responseLog.length}`, ''.padEnd(60, '=' ), ''];
    for (const r of _responseLog) {
      const ts = r.timestamp ? new Date(r.timestamp).toLocaleString('it-IT') : '';
      out.push(`[${ts}]  intent=${r.intent || '-'}  provider=${r.provider || '-'}`);
      out.push(`UTENTE: ${r.userMessage || ''}`);
      out.push(`COBRA:  ${r.response || ''}`);
      const tools = (r.toolsUsed || []).map(t => t.name || t);
      if (tools.length) out.push(`TOOL:   ${tools.join(', ')}`);
      out.push(''.padEnd(60, '-'));
    }
    return out.join('\n');
  },
  _log: _responseLog,
};
const SuperMario = require('./supermario');

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

// ── Bridge command via WS server infrastructure ──
const { attesaPer } = require('./bridge/connection');
let _bridgeCmdId = 0;
function _bridgeCmd(command, args = {}) {
  if (!wsModule.isBridgeReady()) throw new Error('Bridge not ready');
  const client = wsModule.getBridgeClient();
  const pending = wsModule.getBridgePending();
  return new Promise((resolve, reject) => {
    const id = ++_bridgeCmdId;
    // L'attesa dipende dal comando: vedi modules/bridge/connection.js.
    // ATTENZIONE: questa e' la copia VIVA di bridgeCommand. Quella in
    // bridge/connection.js esiste ma non viene usata da qui — il 7 agosto ho
    // corretto solo quella e il timeout e' rimasto identico, facendo sembrare
    // che la modifica non avesse effetto.
    const quanto = attesaPer(command);
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Bridge command timeout: ${command} (dopo ${quanto / 1000}s)`));
    }, quanto);
    pending.set(id, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
    // Protocollo atteso dall'estensione (cobra-extension/background.js:122)
    client.send(JSON.stringify({ type: 'bridge_command', id, command, args }));
  });
}

async function _bridgeNav(url) {
  const navResult = await _bridgeCmd('navigate', { url });
  if (!navResult.ok) return navResult;
  await new Promise(r => setTimeout(r, 2000));
  let cookieResult = await _bridgeCmd('dismiss_cookies').catch(() => ({ action: 'error' }));
  if (cookieResult?.action === 'no_banner') {
    await new Promise(r => setTimeout(r, 2000));
    cookieResult = await _bridgeCmd('dismiss_cookies').catch(() => ({}));
  }
  if (cookieResult?.action && cookieResult.action !== 'no_banner' && cookieResult.action !== 'error') {
    log(`[Cookie] Bridge dismiss: ${cookieResult.action}`);
    await new Promise(r => setTimeout(r, 500));
  }
  const overlayResult = await _bridgeCmd('dismiss_overlay').catch(() => ({}));
  if (overlayResult?.action && overlayResult.action !== 'no_overlay') {
    log(`[Overlay] Bridge dismiss: ${overlayResult.action}`);
    await new Promise(r => setTimeout(r, 1000));
    await _bridgeCmd('dismiss_overlay').catch(() => {});
  }
  const ssResult = await _bridgeCmd('screenshot', { quality: 70 })
    .catch((e) => ({ ok: false, error: e.message }));
  if (ssResult?.ok && ssResult?.screenshot) {
    wsModule.wsBroadcast({ type: 'screenshot', data: ssResult.screenshot, url, title: '' });
  } else {
    // Senza questo messaggio l'anteprima spariva dal monitor senza spiegazione
    log(`[Screenshot] Non ottenuto per ${url}: ${ssResult?.error || 'risposta senza immagine'} (chiavi=${Object.keys(ssResult || {}).join(',')})`);
  }
  const contentResult = await _bridgeCmd('get_page_content').catch(() => ({}));
  return { ok: true, url, screenshot: ssResult?.screenshot, content: contentResult };
}

// ── Extension relay (LinkedIn / WhatsApp via webapp postMessage) ──
const _extPending = new Map();
let _extReqId = 0;
function _extRelay(channel, action, args = {}, timeoutMs = 25000) {
  if (wsModule.getWsClients().size === 0) {
    return Promise.resolve({ success: false, error: 'Nessuna webapp connessa: impossibile raggiungere le estensioni.', errorCode: 'NO_WEBAPP' });
  }
  return new Promise((resolve) => {
    const requestId = `ext_${++_extReqId}_${Date.now().toString(36)}`;
    const timer = setTimeout(() => {
      _extPending.delete(requestId);
      resolve({ success: false, error: `Timeout estensione ${channel}.${action}`, errorCode: 'TIMEOUT' });
    }, timeoutMs);
    _extPending.set(requestId, (response) => {
      clearTimeout(timer);
      resolve(response || { success: false, error: 'Risposta vuota dall\'estensione' });
    });
    // Il tempo lo decide CHI CHIAMA, e va detto anche alla pagina: il ponte
    // nel browser aveva 25 secondi fissi per qualunque comando, e
    // sendConnectionRequest ne vuole di piu' — apre il profilo, attende il
    // caricamento, cerca il pulsante, apre il riquadro della nota. L'8 agosto
    // l'invito a Brandon Dvorak e' morto li' due volte: "Extension timeout
    // (25s)", mentre il server aspettava paziente per altri cinque.
    wsModule.wsBroadcast({ type: 'ext_command', requestId, channel, action, args, timeoutMs });
    log(`[ExtRelay] → ${channel}.${action} (${requestId})`);
  });
}

// ── Bridge helper: click e fill form ──
async function _bridgeClick(selector) {
  return _bridgeCmd('click', { selector });
}
async function _bridgeFillForm(fields) {
  return _bridgeCmd('fill_form', { fields });
}

// ── Seed KB con le regole always-loaded ──
async function _seedKB() {
  let saved = 0, errors = [];
  for (const entry of ALWAYS_LOADED_KB) {
    try {
      const r = await saveToKB(
        entry.domain || 'general',
        entry.type || 'rule',
        entry.title || entry.id || 'regola',
        entry.content || '',
        entry.tags || []
      );
      if (r) saved++;
    } catch (e) { errors.push(e.message); }
  }
  return { ok: errors.length === 0, saved, total: ALWAYS_LOADED_KB.length, errors };
}

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
  sanitizeForLog, isDomainWhitelisted,
  isAuthenticatedRequest: (req) => isAuthenticatedRequest(req, ALLOWED_ORIGINS),
  classifyUrlRisk, classifyClickIntent, detectDangerousJs, computeEffectiveRisk,
  getActivePendingActions, approvePendingAction, rejectPendingAction, guardToolCall,
  searchKB, saveToKB, updateKB, deleteKB,
  detectRepetition,
  // Bridge — wired to WS server infrastructure
  bridgeCommand: _bridgeCmd,
  bridgeNavigate: _bridgeNav,
  isBridgeReady: wsModule.isBridgeReady,
  getBridgeCapabilities: wsModule.getBridgeCapabilities,
  getWsClientCount: () => wsModule.getWsClients().size,
  wsBroadcast: wsModule.wsBroadcast,
  broadcastFile: wsModule.broadcastFile,
  // Browser — Puppeteer fallback + paywall
  getOrCreateBrowser, getState, setState, smartScrape, scrapeUrl,
  dismissModals, dismissModalsBridge, detectCaptcha,
  puppeteer, nodemailer,
  paywallDomains: _paywallDomains,
  savePaywallDomains: _savePaywallDomains,
  getActivePage: (url) => getActivePage(url, ctx),
  // Cattura uno screenshot della pagina attiva. Prova prima il bridge (unica via
  // se Puppeteer non è installato), poi la pagina Puppeteer attiva.
  takeActiveScreenshot: async (url, title) => {
    if (wsModule.isBridgeReady()) {
      try {
        const ss = await _bridgeCmd('screenshot', { quality: 70 });
        if (ss?.ok && ss.screenshot) {
          session.lastScreenshotData = ss.screenshot;
          wsModule.wsBroadcast({ type: 'screenshot', data: ss.screenshot, url, title });
          return ss.screenshot;
        }
      } catch (e) { log(`[Screenshot] Bridge fallito: ${e.message}`); }
    }
    if (puppeteer) {
      try {
        const page = getState('activePage');
        if (page) {
          const buf = await page.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
          session.lastScreenshotData = buf;
          wsModule.wsBroadcast({ type: 'screenshot', data: buf, url, title });
          return buf;
        }
      } catch (e) { log(`[Screenshot] Puppeteer fallito: ${e.message}`); }
    }
    return null;
  },
  emitSiteVisit: (url, title, status) => {
    wsModule.wsBroadcast({ type: 'page_loaded', url, title, status });
    // Si tiene traccia delle pagine consultate nel turno: a fine lavoro
    // diventano collegamenti su cui l'utente può proseguire da solo, per
    // esempio per completare una prenotazione.
    if (url) {
      if (!Array.isArray(session.pagineDelTurno)) session.pagineDelTurno = [];
      if (!session.pagineDelTurno.some(p => p.url === url)) {
        session.pagineDelTurno.push({ url, title: title || url });
      }
    }
  },
  // Extension relay + bridge helper + KB seed
  extRelay: _extRelay,
  bridgeClick: _bridgeClick,
  bridgeFillForm: _bridgeFillForm,
  seedKB: _seedKB,
  getFeedbackStats,
  verifyAuditChain,
  // AI + Tools — executeTool wrapped with ctx self-reference
  executeTool: null, // set below after ctx is created
  callAI, digestToolResult,
  conversationEngine, learningStore, giornale, registroFonti, SuperMario, CobraSupervisor,
  // Il Collega si puo' spegnere senza toccare il codice: se un giorno dovesse
  // dare problemi, COLLEGA=off riporta il sistema al comportamento diretto.
  CollegaAttivo: String(process.env.COLLEGA || '').toLowerCase() !== 'off',
  HumanDriver, TokenMeter, ResponseRecorder, estimateTokens,
  // Persistence helpers for tool handlers
  persistTasks: _saveTasks,
  persistMemories: _saveMemories,
  // Extension relay result — risolve la promise di _extRelay
  // CHI SI ARRENDE PER PRIMO NON DECIDE PER TUTTI
  //
  // Il comando va in broadcast a OGNI pagina collegata. Se ce n'e' piu' di
  // una — una finestra dimenticata, COBRA.app, una scheda con la cache
  // vecchia — ognuna fa partire il proprio conto alla rovescia, e la prima
  // che scade manda "TIMEOUT". Quel messaggio chiudeva la pratica: la
  // risposta vera, che stava arrivando, trovava la porta chiusa e finiva
  // "orfana".
  //
  // L'8 agosto, invito a Brandon Dvorak: quattro tentativi, sempre "Extension
  // timeout (25s)" anche dopo aver portato l'attesa a 90 secondi. Il risultato
  // buono arrivava puntuale venti secondi dopo, ogni volta scartato. Avevo
  // alzato il tempo alla pagina giusta mentre a rispondere era un'altra.
  //
  // Adesso il tempo lo tiene UNA sola sveglia, quella del server. La resa di
  // un client e' un'opinione, non un fatto: si annota e si continua ad
  // aspettare. Se non risponde nessuno, scatta il timer di _extRelay.
  handleExtResult(msg) {
    const cb = _extPending.get(msg.requestId);
    if (!cb) { log(`[ExtRelay] Risultato orfano per ${msg.requestId}`); return; }

    if (msg.response && msg.response.errorCode === 'TIMEOUT') {
      log(`[ExtRelay] Una pagina si e' arresa su ${msg.requestId}: aspetto le altre`);
      return;
    }

    _extPending.delete(msg.requestId);
    log(`[ExtRelay] ← ${msg.channel} (${msg.requestId})`);
    cb(msg.response);
  },
  handleDelegateFromExtension: async (ws, msg) => { log(`[Bridge] Delegate task: ${msg.task}`); },
};
// ── Critical: wrap executeTool with ctx self-reference ──
ctx.executeTool = (name, args) => executeTool(name, args, ctx);

// ══════════════════════════════════════════════════════════════
// Boot
// ══════════════════════════════════════════════════════════════
const handleRequest = setupRoutes(ctx);
const server = http.createServer(handleRequest);
wsModule.setupWebSocket(server, ctx);

// Avvia il listen solo se eseguito direttamente (importabile per i test)
//
// La porta occupata NON è un errore fatale: è una coda. Stasera COBRA.app e
// il server del guardiano si sono ammazzati a vicenda per un'ora — ognuno
// moriva con EADDRINUSE, il guardiano lo rilanciava, e via da capo, con
// l'utente davanti a "failed to fetch". Un server adulto aspetta il suo
// turno: riprova ogni tre secondi e lo scrive, così quando l'altro processo
// muore o viene chiuso, questo prende la porta da solo.
const _isMain = require.main === module;
let _tentativiPorta = 0;
// Il gestore va registrato UNA VOLTA e PRIMA del listen: con server.once()
// dentro la funzione l'errore sfuggiva all'uncaughtException e il processo
// moriva comunque. Verificato dal vivo: due server sulla stessa porta.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    _tentativiPorta++;
    if (_tentativiPorta === 1 || _tentativiPorta % 10 === 0) {
      log(`[Avvio] Porta ${PORT} occupata da un altro processo: aspetto il mio turno (tentativo ${_tentativiPorta})`);
    }
    setTimeout(() => { try { server.listen(PORT, '127.0.0.1'); } catch (_) { /* si riprova */ } }, 3000);
    return;
  }
  log(`[Server] Errore: ${err && err.message}`);
});

// Si SONDA la porta prima di occuparla, invece di affidarsi all'evento
// 'error': verificato dal vivo che l'errore sfugge comunque all'handler e
// finisce in uncaughtException. Una connessione di prova dice con certezza
// se qualcuno c'e' gia', e non puo' fallire in modo silenzioso.
function _portaLibera() {
  return new Promise((risolvi) => {
    const sonda = require('net').connect({ port: PORT, host: '127.0.0.1' });
    const chiudi = (libera) => { try { sonda.destroy(); } catch (_) { /* sonda gia chiusa */ } risolvi(libera); };
    sonda.once('connect', () => chiudi(false));   // qualcuno risponde: occupata
    sonda.once('error', () => chiudi(true));      // nessuno risponde: libera
    setTimeout(() => chiudi(true), 1500);
  });
}

async function _avviaConPazienza(tentativo = 0) {
  if (!(await _portaLibera())) {
    if (tentativo === 0 || tentativo % 10 === 0) {
      log(`[Avvio] Porta ${PORT} occupata da un altro processo: aspetto il mio turno (tentativo ${tentativo + 1})`);
    }
    setTimeout(() => _avviaConPazienza(tentativo + 1), 3000);
    return;
  }
  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`\n  COBRA v11 — http://127.0.0.1:${PORT} (localhost only)`);
    console.log(`  Tools: ${COBRA_TOOLS.length} | Handlers: ${Object.keys(allHandlers).length}\n`);
    await loadAPIKeys();
    await loadOperatorConfig();
    await conversationEngine.load();
    log(`Server ready.`);
  });
}
if (_isMain) _avviaConPazienza();

// ── Process-level error handling (production hardening) ──
process.on('uncaughtException', (err) => {
  log(`[FATAL] Uncaught exception: ${err.message}\n${err.stack}`);
  try { fs.appendFileSync(path.join(dataDir, 'crash.log'), `[${new Date().toISOString()}] UNCAUGHT: ${err.message}\n${err.stack}\n\n`); } catch {}
  // Non uccidere il processo per errori non critici
  // EADDRINUSE e' gestito dal listen paziente: qui non deve mai arrivare.
  if (err.message.includes('out of memory')) {
    console.error('[FATAL] Memoria esaurita, shutdown.');
    process.exit(1);
  }
  // Per tutti gli altri: log e continua
  console.error('[WARN] Server sopravvissuto a uncaught exception — vedi crash.log');
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`[WARN] Unhandled rejection: ${msg}`);
  try { fs.appendFileSync(path.join(dataDir, 'crash.log'), `[${new Date().toISOString()}] REJECTION: ${msg}\n\n`); } catch {}
});

process.on('SIGINT', () => {
  log('Shutdown requested');
  // Salva stato prima di uscire
  try { conversationEngine.saveNow(); _saveTasks(); _saveMemories(); _savePaywallDomains(); flushAuditSync(); } catch {}
  console.log('\nBye!');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('SIGTERM received');
  try { conversationEngine.saveNow(); _saveTasks(); _saveMemories(); _savePaywallDomains(); flushAuditSync(); } catch {}
  process.exit(0);
});

module.exports = { server, ctx };
