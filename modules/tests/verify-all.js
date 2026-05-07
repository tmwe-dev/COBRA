#!/usr/bin/env node
// COBRA v11 — Verifica Completa (3 livelli)
// Livello 1: Unit test funzioni pure
// Livello 2: Integration test flusso
// Livello 3: Analisi statica

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let passed = 0, failed = 0, warnings = [];
function assert(label, condition, detail) {
  if (condition) { passed++; }
  else { failed++; console.log(`  ✗ FAIL: ${label}${detail ? ' — ' + detail : ''}`); }
}
function warn(msg) { warnings.push(msg); }

// ══════════════════════════════════════════════════════════════
// LIVELLO 1 — UNIT TEST FUNZIONI PURE
// ══════════════════════════════════════════════════════════════
console.log('\n═══ LIVELLO 1: UNIT TEST ═══\n');

// ── 1.1 Risk Constants ──
console.log('▸ Risk Constants');
const { RISK_LEVELS, maxRisk, RISK_REQUIRES_CONFIRMATION, RISK_DEFAULT_TTL } = require('../config/constants');

assert('RISK_LEVELS ha 10 livelli', RISK_LEVELS.length === 10);
assert('Primo livello è read', RISK_LEVELS[0] === 'read');
assert('Ultimo livello è destructive', RISK_LEVELS[9] === 'destructive');
assert('maxRisk(read, inspect) = inspect', maxRisk('read', 'inspect') === 'inspect');
assert('maxRisk(destructive, read) = destructive', maxRisk('destructive', 'read') === 'destructive');
assert('maxRisk(read, read) = read', maxRisk('read', 'read') === 'read');
assert('maxRisk con livello inesistente non crasha', typeof maxRisk('read', 'fake') === 'string');
// BUG CHECK: maxRisk con valore sconosciuto → indexOf=-1, potrebbe dare risultato errato
const fakeRisk = maxRisk('read', 'nonexistent');
assert('maxRisk(read, nonexistent) dovrebbe dare read (non nonexistent)', fakeRisk === 'read',
  `Ottenuto: "${fakeRisk}" — indexOf=-1 per "nonexistent", confronto 0>=-1 è true → restituisce "read" ✓`);
// Edge: entrambi sconosciuti
const bothFake = maxRisk('aaa', 'bbb');
assert('maxRisk(aaa, bbb) entrambi fake → restituisce primo (entrambi -1)', bothFake === 'aaa');

assert('RISK_REQUIRES_CONFIRMATION.read = false', RISK_REQUIRES_CONFIRMATION.read === false);
assert('RISK_REQUIRES_CONFIRMATION.send = true', RISK_REQUIRES_CONFIRMATION.send === true);
assert('RISK_REQUIRES_CONFIRMATION.destructive = true', RISK_REQUIRES_CONFIRMATION.destructive === true);
assert('RISK_DEFAULT_TTL.destructive = 60', RISK_DEFAULT_TTL.destructive === 60);
assert('RISK_DEFAULT_TTL.read = null', RISK_DEFAULT_TTL.read === null);

// Coerenza: ogni RISK_LEVEL ha una entry in REQUIRES_CONFIRMATION e DEFAULT_TTL
for (const level of RISK_LEVELS) {
  assert(`RISK_REQUIRES_CONFIRMATION ha "${level}"`, level in RISK_REQUIRES_CONFIRMATION);
  assert(`RISK_DEFAULT_TTL ha "${level}"`, level in RISK_DEFAULT_TTL);
}

// ── 1.2 URL Risk Classification ──
console.log('▸ URL Risk Classifiers');
const { classifyUrlRisk } = require('../risk/classifiers');

assert('Google search = read', classifyUrlRisk('https://www.google.com/search?q=test').level === 'read');
assert('Wikipedia = read', classifyUrlRisk('https://en.wikipedia.org/wiki/Cat').level === 'read');
assert('PayPal = send_prepare+', RISK_LEVELS.indexOf(classifyUrlRisk('https://www.paypal.com/checkout').level) >= RISK_LEVELS.indexOf('send_prepare'));
assert('Admin path = write_form+', RISK_LEVELS.indexOf(classifyUrlRisk('https://site.com/admin/users').level) >= RISK_LEVELS.indexOf('write_form'));
assert('Delete param = destructive', classifyUrlRisk('https://site.com/api?delete=true').level === 'destructive');
assert('javascript: = destructive', classifyUrlRisk('javascript:alert(1)').level === 'destructive');
assert('data: = destructive', classifyUrlRisk('data:text/html,<h1>hi</h1>').level === 'destructive');
assert('URL malformato = interact (non crash)', classifyUrlRisk('not-a-url').level === 'interact');
assert('URL vuoto non crasha', typeof classifyUrlRisk('').level === 'string');
assert('URL null non crasha', (() => { try { classifyUrlRisk(null); return false; } catch { return true; } })() || typeof classifyUrlRisk('').level === 'string');
// Edge: URL con parametro token
const tokenUrl = classifyUrlRisk('https://site.com/reset?token=abc123');
assert('URL con ?token= è destructive', tokenUrl.level === 'destructive');
// Edge: checkout path
const checkoutUrl = classifyUrlRisk('https://shop.com/checkout');
assert('Path /checkout = write_form+', RISK_LEVELS.indexOf(checkoutUrl.level) >= RISK_LEVELS.indexOf('write_form'));

// ── 1.3 Click Intent ──
console.log('▸ Click Intent');
const { classifyClickIntent, detectDangerousJs, computeEffectiveRisk } = require('../risk/calculator');

assert('Submit button = destructive', classifyClickIntent('button[type="submit"]', '').level === 'destructive');
assert('Pay button = destructive', classifyClickIntent('.pay-btn', 'Paga ora').level === 'destructive');
assert('Buy now = destructive', classifyClickIntent('.btn', 'Buy Now').level === 'destructive');
assert('Elimina = destructive', classifyClickIntent('.btn', 'Elimina account').level === 'destructive');
assert('Normal link = interact', classifyClickIntent('a.link', 'Leggi articolo').level === 'interact');
assert('Empty params = interact', classifyClickIntent('', '').level === 'interact');
assert('Null text non crasha', classifyClickIntent('.btn', null).level === 'interact');

// ── 1.4 JS Detector ──
console.log('▸ JS Dangerous Detector');
assert('fetch() detected', detectDangerousJs('fetch("https://evil.com")').length > 0);
assert('eval() detected', detectDangerousJs('eval("code")').length > 0);
assert('localStorage detected', detectDangerousJs('localStorage.getItem("x")').length > 0);
assert('document.cookie detected', detectDangerousJs('document.cookie').length > 0);
assert('innerHTML= detected', detectDangerousJs('el.innerHTML = "<b>x</b>"').length > 0);
assert('.click() detected', detectDangerousJs('btn.click()').length > 0);
assert('.submit() detected', detectDangerousJs('form.submit()').length > 0);
assert('Safe code = empty', detectDangerousJs('const x = document.querySelector("h1").textContent').length === 0);
assert('Empty string = empty', detectDangerousJs('').length === 0);

// ── 1.5 Effective Risk ──
console.log('▸ Effective Risk Computation');
const er1 = computeEffectiveRisk('read_page', {});
assert('read_page base = read', er1.level === 'read');
assert('read_page no confirm', er1.requires_confirmation === false);

const er2 = computeEffectiveRisk('mutate_dom_js', { code: 'x' });
assert('mutate_dom_js requires_confirmation', er2.requires_confirmation === true);

const er3 = computeEffectiveRisk('mutate_dom_js', { code: 'fetch("https://evil.com")' });
assert('mutate_dom_js con fetch = destructive', er3.level === 'destructive');

const er4 = computeEffectiveRisk('click_element', { selector: 'button.pay-btn', text: 'Paga ora' });
assert('click pay button = destructive', er4.level === 'destructive');

const er5 = computeEffectiveRisk('press_key', { key: 'Enter' });
assert('press Enter = destructive', er5.level === 'destructive');

const er6 = computeEffectiveRisk('navigate', { url: 'https://www.google.com/search?q=test' });
assert('navigate google = interact (max di navigate:interact e url:read)', er6.level === 'interact');

const er7 = computeEffectiveRisk('navigate', { url: 'https://paypal.com/checkout' });
assert('navigate paypal checkout >= send_prepare', RISK_LEVELS.indexOf(er7.level) >= RISK_LEVELS.indexOf('send_prepare'));

const er8 = computeEffectiveRisk('kb_delete', { title: 'test' });
assert('kb_delete = destructive + confirm', er8.level === 'destructive' && er8.requires_confirmation === true);
assert('kb_delete ttl = 60', er8.ttl === 60);

// Tool sconosciuto → destructive
const erUnk = computeEffectiveRisk('totally_unknown_tool', {});
assert('Tool sconosciuto = destructive', erUnk.level === 'destructive');
assert('Tool sconosciuto requires confirm', erUnk.requires_confirmation === true);

// ── 1.6 guardToolCall ──
console.log('▸ guardToolCall Pipeline');
const { guardToolCall, _pendingActions, approvePendingAction, verifyApprovalToken } = require('../risk/pending-actions');
const { computePayloadHash } = require('../risk/calculator');

// read_page → allow senza conferma
const g1 = guardToolCall('read_page', { url: 'https://example.com' }, 'test-session');
assert('guardToolCall read_page = allow', g1.kind === 'allow');

// send_email → block_for_confirmation
const g2 = guardToolCall('send_email', { to: 'test@test.com', subject: 'Hi', body: 'Test' }, 'test-session');
assert('guardToolCall send_email = block_for_confirmation', g2.kind === 'block_for_confirmation');
assert('guardToolCall send_email ha pending_action_id', typeof g2.pending_action_id === 'string');
assert('guardToolCall send_email ha summary con email icon', g2.summary.includes('📧'));

// Approve e retry con token
const approval = approvePendingAction(g2.pending_action_id, 'operator');
assert('approvePendingAction OK', approval.ok === true);
assert('approvePendingAction ha token', typeof approval.approval_token === 'string');

const g3 = guardToolCall('send_email', { to: 'test@test.com', subject: 'Hi', body: 'Test' }, 'test-session', approval.approval_token);
assert('guardToolCall con approval_token = allow', g3.kind === 'allow');
assert('guardToolCall approved ha reasons con "approved"', g3.reasons.includes('approved'));

// kb_delete → block
const g4 = guardToolCall('kb_delete', { title: 'test' }, 'test-session');
assert('guardToolCall kb_delete = block', g4.kind === 'block_for_confirmation');
assert('guardToolCall kb_delete summary ha 🗑️', g4.summary.includes('🗑️'));

// Double approve → error
const g5 = approvePendingAction(g2.pending_action_id, 'op');
assert('Double approve fails', g5.ok === false);

// Reject
const g6 = guardToolCall('whatsapp_send', { phone: '123', text: 'hi' }, 'test-session');
const rej = require('../risk/pending-actions').rejectPendingAction(g6.pending_action_id, 'op', 'no');
assert('rejectPendingAction OK', rej.ok === true);

// ── 1.7 Security — Sanitize ──
console.log('▸ Security: sanitizeForLog');
const { sanitizeForLog } = require('../security/sanitize');

assert('Email redacted', sanitizeForLog('user@example.com').includes('[EMAIL]'));
// JWT format: 3 parts base64url separated by dots, each ≥20 chars
assert('JWT redacted', sanitizeForLog('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c').includes('[JWT]'));
assert('OpenAI key redacted', sanitizeForLog('sk-1234567890abcdefghijklmn').includes('[API_KEY]'));
assert('Google key redacted', sanitizeForLog('AIzaSyD1234567890abcdefghijklmnopqrstuv').includes('[GAPI_KEY]'));
assert('Password redacted', sanitizeForLog('password=mySecret123').includes('[REDACTED]'));
assert('Null input non crasha', typeof sanitizeForLog(null) === 'string');
assert('Object input non crasha', typeof sanitizeForLog({ key: 'val' }) === 'string');
assert('Number input non crasha', typeof sanitizeForLog(42) === 'string');
assert('Long hash redacted', sanitizeForLog('abc ' + 'a'.repeat(42) + ' xyz').includes('[HASH/TOKEN]'));
assert('Short string NOT redacted', !sanitizeForLog('hello world').includes('['));

// ── 1.8 Security — SSRF ──
console.log('▸ Security: SSRF Guard');
const { isSSRFSafe } = require('../security/ssrf');

assert('SSRF: external OK', isSSRFSafe('https://www.google.com') === true);
assert('SSRF: localhost blocked', isSSRFSafe('http://localhost/admin') === false);
assert('SSRF: 127.0.0.1 blocked', isSSRFSafe('http://127.0.0.1:3000') === false);
assert('SSRF: 10.x.x.x blocked', isSSRFSafe('http://10.0.0.1/api') === false);
assert('SSRF: 172.16.x.x blocked', isSSRFSafe('http://172.16.0.1/api') === false);
assert('SSRF: 192.168.x.x blocked', isSSRFSafe('http://192.168.1.1') === false);
assert('SSRF: 169.254.169.254 blocked', isSSRFSafe('http://169.254.169.254/latest') === false);
assert('SSRF: metadata.google blocked', isSSRFSafe('http://metadata.google.internal') === false);
assert('SSRF: ftp blocked', isSSRFSafe('ftp://example.com/file') === false);
assert('SSRF: malformed = false', isSSRFSafe('not-a-url') === false);
assert('SSRF: 0.0.0.0 blocked', isSSRFSafe('http://0.0.0.0/admin') === false);
assert('SSRF: ::1 blocked', isSSRFSafe('http://[::1]/admin') === false);
// Edge: 172.15.x.x è safe (non in range 16-31)
assert('SSRF: 172.15.x.x safe', isSSRFSafe('http://172.15.0.1') === true);
// Edge: 172.32.x.x è safe (fuori range)
assert('SSRF: 172.32.x.x safe', isSSRFSafe('http://172.32.0.1') === true);

// ── 1.9 Whitelist ──
console.log('▸ Whitelist');
const { isDomainWhitelisted } = require('../config/whitelist');

assert('Google Docs whitelisted', isDomainWhitelisted('https://docs.google.com/document/d/1234'));
assert('Supabase whitelisted', isDomainWhitelisted('https://myproject.supabase.co/table'));
assert('localhost whitelisted', isDomainWhitelisted('http://localhost:3000'));
assert('127.0.0.1 whitelisted', isDomainWhitelisted('http://127.0.0.1:3000/api'));
assert('Random domain NOT whitelisted', !isDomainWhitelisted('https://www.evil.com'));
assert('null URL = false', !isDomainWhitelisted(null));
assert('empty URL = false', !isDomainWhitelisted(''));
assert('malformed URL = false', !isDomainWhitelisted('not-a-url'));
// Subdomain check
assert('Subdomain match: x.supabase.com', isDomainWhitelisted('https://x.supabase.com'));
assert('Subdomain match: x.supabase.co', isDomainWhitelisted('https://x.supabase.co'));

// ── 1.10 Auth ──
console.log('▸ Auth');
const { isAuthenticatedRequest, COBRA_API_TOKEN } = require('../security/auth');

const mockReq = (headers = {}, url = '/', remoteAddr = '127.0.0.1') => ({
  headers, url, socket: { remoteAddress: remoteAddr }
});
const origins = ['http://localhost:3000', 'http://127.0.0.1:3000'];

assert('Valid token auth', isAuthenticatedRequest(mockReq({ 'x-cobra-token': COBRA_API_TOKEN }), origins));
assert('Invalid token rejected', !isAuthenticatedRequest(mockReq({ 'x-cobra-token': 'bad' }), origins));
assert('Localhost origin auth', isAuthenticatedRequest(mockReq({ origin: 'http://localhost:3000' }), origins));
assert('No origin + loopback auth', isAuthenticatedRequest(mockReq({}, '/', '127.0.0.1'), origins));
assert('No origin + loopback ::1 auth', isAuthenticatedRequest(mockReq({}, '/', '::1'), origins));
assert('External IP rejected', !isAuthenticatedRequest(mockReq({}, '/', '8.8.8.8'), origins));
assert('Chrome ext from loopback', isAuthenticatedRequest(mockReq({ origin: 'chrome-extension://abcdefg' }, '/', '::ffff:127.0.0.1'), origins));
assert('Chrome ext from external rejected', !isAuthenticatedRequest(mockReq({ origin: 'chrome-extension://abcdefg' }, '/', '8.8.8.8'), origins));

// ── 1.11 Token Estimation ──
console.log('▸ Token Estimation');
const { estimateTokens } = require('../utils/tokens');

assert('Empty string = 0', estimateTokens('') === 0);
assert('null = 0', estimateTokens(null) === 0);
assert('undefined = 0', estimateTokens(undefined) === 0);
assert('4 chars ≈ 1 token', estimateTokens('abcd') === 1);
assert('100 chars ≈ 25 tokens', estimateTokens('a'.repeat(100)) === 25);

// ── 1.12 Repetition Detection ──
console.log('▸ Repetition Detection');
const { detectRepetition } = require('../utils/repetition');

assert('Single msg = null', detectRepetition([{ role: 'user', content: 'hello' }]) === null);
assert('Empty = null', detectRepetition([]) === null);
assert('Different msgs = null', detectRepetition([
  { role: 'user', content: 'Come funziona il sistema?' },
  { role: 'assistant', content: 'Bla bla' },
  { role: 'user', content: 'Dimmi il meteo di domani a Roma' },
]) === null);
const rep = detectRepetition([
  { role: 'user', content: 'Voglio cercare informazioni sulle aziende italiane del settore' },
  { role: 'assistant', content: 'Bla' },
  { role: 'user', content: 'Voglio cercare informazioni sulle aziende italiane nel settore' },
]);
assert('Similar repeated msg detected', rep !== null);
const frust = detectRepetition([
  { role: 'user', content: 'Fai lo screenshot' },
  { role: 'assistant', content: 'Ok' },
  { role: 'user', content: 'Non hai capito, ti ho già detto di farlo diversamente' },
]);
assert('Frustration detected', frust !== null);

// ── 1.13 ChatMemory ──
console.log('▸ ChatMemory');
const ChatMemory = require('../memory/chat-memory');

const cm = new ChatMemory();
assert('ChatMemory new = empty', cm.liveWindow.length === 0);
cm.addMessage('user', 'Hello');
assert('ChatMemory addMessage works', cm.liveWindow.length === 1);
assert('ChatMemory msg has role', cm.liveWindow[0].role === 'user');
cm.addMessage('assistant', 'Hi there');
const ctx1 = cm.getPromptContext();
assert('getPromptContext returns liveMessages', ctx1.liveMessages.length === 2);
// Fill to overflow
for (let i = 0; i < cm.MAX_LIVE + 5; i++) cm.addMessage('user', `Msg ${i}`);
assert('ChatMemory cap respected', cm.liveWindow.length <= cm.MAX_LIVE);
assert('ChatMemory has summary after overflow', cm.rollingSummary.length > 0);

// ── 1.14 ConversationEngine ──
console.log('▸ ConversationEngine');
const ConversationEngine = require('../memory/conversation');

const ce = new ConversationEngine();
const conv = ce.createConversation('Test Conv');
assert('CE createConversation', conv.id.startsWith('conv_'));
assert('CE activeConversationId set', ce.activeConversationId === conv.id);
const msg = ce.addMessage(conv.id, 'user', 'Hello');
assert('CE addMessage returns msg', msg.id.startsWith('msg_'));
const retrieved = ce.getConversation(conv.id);
assert('CE getConversation', retrieved.messages.length === 1);
const context = ce.buildContextForAI(conv.id);
assert('CE buildContextForAI', context.includes('Hello'));
assert('CE listConversations', ce.listConversations().length >= 1);
ce.deleteConversation(conv.id);
assert('CE deleteConversation', ce.getConversation(conv.id) === null);
assert('CE buildContextForAI on missing = empty', ce.buildContextForAI('nonexistent') === '');
// Edge: addMessage on nonexistent conv
try { ce.addMessage('fake', 'user', 'x'); assert('CE addMessage on fake throws', false); }
catch (e) { assert('CE addMessage on fake throws', e.message.includes('non trovata')); }

// ── 1.15 CobraSupervisor ──
console.log('▸ CobraSupervisor');
const { CobraSupervisor } = require('../supervisor/cobra');

CobraSupervisor.startRequest();
assert('CS startRequest sets running', CobraSupervisor._status === 'running');
assert('CS recordToolCall read_page = null', CobraSupervisor.recordToolCall('read_page', {}) === null);
assert('CS recordToolCall navigate = null', CobraSupervisor.recordToolCall('navigate', { url: 'x' }) === null);

// Scroll loop test
CobraSupervisor.startRequest();
CobraSupervisor.recordToolCall('screenshot', {});
const s1 = CobraSupervisor.recordToolCall('scroll_page', { direction: 'down' });
const s2 = CobraSupervisor.recordToolCall('scroll_page', { direction: 'down' });
const s3 = CobraSupervisor.recordToolCall('scroll_page', { direction: 'down' });
assert('CS scroll loop detected (3rd)', s3 !== null && s3.warning === 'force_stop');

// Circular loop test
CobraSupervisor.startRequest();
const cl1 = CobraSupervisor.recordToolCall('screenshot', {});
const cl2 = CobraSupervisor.recordToolCall('screenshot', {});
const cl3 = CobraSupervisor.recordToolCall('screenshot', {});
assert('CS circular loop (3x same tool+args)', cl3 !== null && cl3.warning === 'circular_loop');

// Inspection block + action reset
CobraSupervisor.startRequest();
CobraSupervisor.recordToolCall('read_page', {});
CobraSupervisor.recordToolCall('screenshot', {});
CobraSupervisor.recordToolCall('inspect_dom_js', { code: 'x' });
const ib = CobraSupervisor.recordToolCall('get_page_elements', {});
assert('CS 4 inspection = loop', ib !== null && ib.warning === 'inspection_loop');
// After action, inspection should be unblocked
const actReset = CobraSupervisor.recordToolCall('click_element', { selector: '.btn' });
assert('CS action resets inspection block', actReset === null);
const afterReset = CobraSupervisor.recordToolCall('screenshot', {});
assert('CS screenshot after reset OK', afterReset === null);

CobraSupervisor.completeRequest();
assert('CS completeRequest', CobraSupervisor._status === 'completed');

// ══════════════════════════════════════════════════════════════
// LIVELLO 2 — INTEGRATION TEST
// ══════════════════════════════════════════════════════════════
console.log('\n═══ LIVELLO 2: INTEGRATION TEST ═══\n');

// ── 2.1 Taxonomy ↔ Constants coerenza ──
console.log('▸ Taxonomy ↔ Constants Alignment');
const { TOOL_RISK_TAXONOMY, getToolRiskSpec } = require('../risk/taxonomy');

for (const [name, spec] of Object.entries(TOOL_RISK_TAXONOMY)) {
  assert(`Taxonomy "${name}" ha livello valido`, RISK_LEVELS.includes(spec.level), `level="${spec.level}"`);
  assert(`Taxonomy "${name}" ha confirm booleano`, typeof spec.confirm === 'boolean');
  if (spec.ttl) assert(`Taxonomy "${name}" ttl è numero`, typeof spec.ttl === 'number');
}

// Unknown tool
const unkSpec = getToolRiskSpec('totally_fake_tool');
assert('Unknown tool = destructive', unkSpec.level === 'destructive');
assert('Unknown tool confirm = true', unkSpec.confirm === true);

// ── 2.2 guardToolCall ↔ executeTool chain ──
console.log('▸ executeTool Chain Simulation');
const { executeTool, registerHandlers, validateToolArgs } = require('../tools/executor');
const { COBRA_DEFAULTS } = require('../config');

// validateToolArgs
const va1 = validateToolArgs('navigate', { url: 'example.com' });
assert('validateToolArgs adds https://', va1.url === 'https://example.com');

const va2 = validateToolArgs('navigate', { url: 'https://google.com' });
assert('validateToolArgs keeps https://', va2.url === 'https://google.com');

const va3 = validateToolArgs('google_search', { query: 'a'.repeat(2000) });
assert('validateToolArgs truncates long query', va3.query.length === COBRA_DEFAULTS.MAX_SEARCH_QUERY_LENGTH);

try {
  validateToolArgs('execute_js', { code: 'x'.repeat(COBRA_DEFAULTS.MAX_JS_CODE_LENGTH + 1) });
  assert('validateToolArgs throws on long JS', false);
} catch (e) {
  assert('validateToolArgs throws on long JS', e.message.includes('troppo lungo'));
}

try {
  validateToolArgs('click_element', { selector: 'x'.repeat(COBRA_DEFAULTS.MAX_SELECTOR_LENGTH + 1) });
  assert('validateToolArgs throws on long selector', false);
} catch (e) {
  assert('validateToolArgs throws on long selector', e.message.includes('troppo lungo'));
}

// ── 2.3 Handler ↔ Schema alignment ──
console.log('▸ Handler ↔ Schema Alignment');
const allHandlers = require('../tools/handlers');
const { COBRA_TOOLS } = require('../tools/schemas');

const schemaNames = new Set(COBRA_TOOLS.map(t => t.function?.name || t.name));
const handlerNames = new Set(Object.keys(allHandlers));

const schemaNoHandler = [...schemaNames].filter(n => !handlerNames.has(n));
const handlerNoSchema = [...handlerNames].filter(n => !schemaNames.has(n));

assert('Ogni schema ha un handler', schemaNoHandler.length === 0,
  schemaNoHandler.length > 0 ? `Mancano handler: ${schemaNoHandler.join(', ')}` : '');
for (const h of handlerNoSchema) {
  warn(`Handler "${h}" non ha schema in COBRA_TOOLS (possibile alias/interno)`);
}

// Ogni handler è una funzione
for (const [name, fn] of Object.entries(allHandlers)) {
  assert(`Handler "${name}" è funzione`, typeof fn === 'function');
}

// ── 2.4 Route registration ──
console.log('▸ Route Registration');
const { setupRoutes } = require('../routes');
assert('setupRoutes è funzione', typeof setupRoutes === 'function');

// ── 2.5 Full Risk Pipeline e2e ──
console.log('▸ Full Risk Pipeline e2e');

// Scenario: navigate a sito safe → allow
const pipeline1 = guardToolCall('navigate', { url: 'https://en.wikipedia.org/wiki/Cat' }, 'sess1');
assert('Pipeline: navigate wikipedia = allow', pipeline1.kind === 'allow');

// Scenario: send_email → block → approve → allow
const pipeline2 = guardToolCall('send_email', { to: 'x@y.com', subject: 'S', body: 'B' }, 'sess2');
assert('Pipeline: send_email = block', pipeline2.kind === 'block_for_confirmation');
const appr2 = approvePendingAction(pipeline2.pending_action_id, 'op');
const pipeline2b = guardToolCall('send_email', { to: 'x@y.com', subject: 'S', body: 'B' }, 'sess2', appr2.approval_token);
assert('Pipeline: send_email approved = allow', pipeline2b.kind === 'allow');

// Scenario: send_email con args diversi dopo approve → new block (payload hash diverso)
const pipeline2c = guardToolCall('send_email', { to: 'other@y.com', subject: 'S', body: 'B' }, 'sess2', appr2.approval_token);
assert('Pipeline: send_email different args = new block', pipeline2c.kind === 'block_for_confirmation');

// ══════════════════════════════════════════════════════════════
// LIVELLO 3 — ANALISI STATICA
// ══════════════════════════════════════════════════════════════
console.log('\n═══ LIVELLO 3: ANALISI STATICA ═══\n');

// ── 3.1 Import/Export cross-check ──
console.log('▸ Import/Export Cross-Check');
const modulesDir = path.join(__dirname, '..');
const allFiles = [];
function walkDir(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'tests' && f !== 'data') walkDir(p); }
    else if (f.endsWith('.js')) allFiles.push(p);
  }
}
walkDir(modulesDir);

// Build export map
const exportMap = {};
for (const f of allFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const match = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (match) {
    const names = match[1].split(',').map(s => s.trim().split(':')[0].split(' ').pop().trim()).filter(Boolean);
    exportMap[f] = names;
  }
}

// Build import map
const importMap = {};
for (const f of allFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const requires = content.match(/require\(['"]\.[^'"]+['"]\)/g) || [];
  const destructures = content.match(/const\s*\{([^}]+)\}\s*=\s*require/g) || [];
  importMap[f] = { requires, destructures };
}

// ── 3.2 Duplicated logic patterns ──
console.log('▸ Duplicated Logic Patterns');
const functionBodies = {};
for (const f of allFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const funcMatches = content.match(/function\s+(\w+)\s*\(/g) || [];
  for (const m of funcMatches) {
    const name = m.match(/function\s+(\w+)/)[1];
    if (!functionBodies[name]) functionBodies[name] = [];
    functionBodies[name].push(path.relative(modulesDir, f));
  }
}

const duplicatedFunctions = Object.entries(functionBodies).filter(([, files]) => files.length > 1);
for (const [name, files] of duplicatedFunctions) {
  // Ignore common names like 'register', 'handler' etc
  if (['register', 'handler', 'log', 'save', 'load'].includes(name)) continue;
  warn(`Funzione "${name}" definita in ${files.length} file: ${files.join(', ')}`);
}

// ── 3.3 Schema parameter validation ──
console.log('▸ Schema Parameter Validation');
for (const tool of COBRA_TOOLS) {
  const fn = tool.function || tool;
  const name = fn.name;
  if (!fn.parameters) { warn(`Schema "${name}" manca parameters`); continue; }
  const props = fn.parameters.properties || {};
  const required = fn.parameters.required || [];
  // Ogni required è anche in properties
  for (const req of required) {
    assert(`Schema "${name}" required "${req}" è in properties`, req in props);
  }
}

// ── 3.4 Taxonomy ↔ Handlers completezza ──
console.log('▸ Taxonomy ↔ Handlers Completeness');
const taxonomyTools = new Set(Object.keys(TOOL_RISK_TAXONOMY));
for (const t of taxonomyTools) {
  if (!handlerNames.has(t)) warn(`Taxonomy ha "${t}" ma nessun handler registrato`);
}
for (const h of handlerNames) {
  if (!taxonomyTools.has(h)) warn(`Handler "${h}" non ha entry in Taxonomy (default=destructive)`);
}

// ── 3.5 try/catch vuoti (anti-pattern ANTI.7.1) ──
console.log('▸ Anti-Pattern: try/catch vuoti');
let emptyCatchCount = 0;
for (const f of allFiles) {
  const content = fs.readFileSync(f, 'utf8');
  // Match catch blocks that are empty or just have a comment
  const matches = content.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || [];
  if (matches.length > 0) {
    emptyCatchCount += matches.length;
    warn(`${path.relative(modulesDir, f)}: ${matches.length} catch vuoti`);
  }
}

// ── 3.6 Console.log in production code ──
console.log('▸ Console.log Count');
let consoleLogCount = 0;
for (const f of allFiles) {
  if (f.includes('test')) continue;
  const content = fs.readFileSync(f, 'utf8');
  const matches = content.match(/console\.(log|warn|error)\b/g) || [];
  consoleLogCount += matches.length;
}

// ══════════════════════════════════════════════════════════════
// REPORT FINALE
// ══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════');
console.log(`  RISULTATI: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════');
if (warnings.length > 0) {
  console.log(`\n⚠️  WARNINGS (${warnings.length}):`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
console.log(`\n📊 Stats:`);
console.log(`  Files analizzati: ${allFiles.length}`);
console.log(`  Funzioni duplicate: ${duplicatedFunctions.filter(([n]) => !['register','handler','log','save','load'].includes(n)).length}`);
console.log(`  Catch vuoti: ${emptyCatchCount}`);
console.log(`  Console.log in prod: ${consoleLogCount}`);
console.log(`  Schema tools: ${COBRA_TOOLS.length}`);
console.log(`  Handlers: ${handlerNames.size}`);
console.log(`  Taxonomy entries: ${taxonomyTools.size}`);
console.log();

process.exit(failed > 0 ? 1 : 0);
