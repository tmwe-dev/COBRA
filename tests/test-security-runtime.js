#!/usr/bin/env node
// tests/test-security-runtime.js — Conferme, token di approvazione, pulizia memoria, auth.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { computeEffectiveRisk } = require('../modules/risk/calculator');
const pa = require('../modules/risk/pending-actions');
const { isAuthenticatedRequest, safeEqual, COBRA_API_TOKEN, makeAllowedOrigins } = require('../modules/security/auth');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== SICUREZZA A RUNTIME ===');

// ─────────────────────────────────────────────
section('Escalation del rischio riattiva la conferma');
// ─────────────────────────────────────────────
const MUST_CONFIRM = [
  ['navigate su pagina di pagamento', 'navigate', { url: 'https://www.paypal.com/checkout?pay=1' }],
  ['navigate su transfer bancario', 'navigate', { url: 'https://mybank.com/transfer?amount=5000' }],
  ['click su "Paga ora"', 'click_element', { selector: '#pay', text: 'Paga ora' }],
  ['click su "Elimina"', 'click_element', { selector: '#del', text: 'Elimina definitivamente' }],
  ['click su submit', 'click_element', { selector: 'button[type=submit]' }],
  ['Enter (possibile submit)', 'press_key', { key: 'Enter' }],
  ['JS pericoloso', 'mutate_dom_js', { code: 'document.querySelector("#pay").click()' }],
];
for (const [name, tool, args] of MUST_CONFIRM) {
  const r = computeEffectiveRisk(tool, args);
  ok(`${name} richiede conferma`, r.requires_confirmation === true,
     `rischio=${r.level} conferma=${r.requires_confirmation}`);
}

const MUST_NOT_CONFIRM = [
  ['navigate su Wikipedia', 'navigate', { url: 'https://it.wikipedia.org/wiki/Logistica' }],
  ['ricerca su Google', 'google_search', { query: 'voli milano' }],
  ['lettura pagina', 'read_page', {}],
  ['scroll', 'scroll_page', { direction: 'down' }],
  ['screenshot', 'screenshot', {}],
];
for (const [name, tool, args] of MUST_NOT_CONFIRM) {
  const r = computeEffectiveRisk(tool, args);
  ok(`${name} NON richiede conferma`, r.requires_confirmation === false,
     `rischio=${r.level} conferma=${r.requires_confirmation}`);
}

// ─────────────────────────────────────────────
section('Ciclo di vita del token di approvazione');
// ─────────────────────────────────────────────
{
  const g1 = pa.guardToolCall('click_element', { selector: '#pay', text: 'Paga ora' }, 'sess1', null);
  ok('azione rischiosa viene intercettata', g1.kind === 'block_for_confirmation', g1.kind);

  const appr = pa.approvePendingAction(g1.pending_action_id, 'operatore');
  ok('approvazione emette un token', appr.ok === true && !!appr.approval_token);

  const g2 = pa.guardToolCall('click_element', { selector: '#pay', text: 'Paga ora' }, 'sess1', appr.approval_token);
  ok('il token approva la stessa azione', g2.kind === 'allow', g2.kind);

  const g3 = pa.guardToolCall('click_element', { selector: '#pay', text: 'Paga ora' }, 'sess1', appr.approval_token);
  ok('il token NON e riutilizzabile', g3.kind === 'block_for_confirmation', g3.kind);

  const g4 = pa.guardToolCall('click_element', { selector: '#altro', text: 'Paga ora' }, 'sess1', appr.approval_token);
  ok('il token non vale per argomenti diversi', g4.kind === 'block_for_confirmation', g4.kind);

  const bad = pa.verifyApprovalToken('token-inventato', 'hash-qualsiasi');
  ok('token inventato rifiutato', bad.valid === false);

  const short = pa.verifyApprovalToken('x', 'hash');
  ok('token di lunghezza diversa rifiutato senza crash', short.valid === false);
}

// ─────────────────────────────────────────────
section('Rifiuto');
// ─────────────────────────────────────────────
{
  const g = pa.guardToolCall('press_key', { key: 'Enter' }, 'sess2', null);
  const rej = pa.rejectPendingAction(g.pending_action_id, 'operatore', 'no');
  ok('rifiuto accettato', rej.ok === true);
  const again = pa.approvePendingAction(g.pending_action_id, 'operatore');
  ok('non si puo approvare dopo il rifiuto', again.ok === false, again.reason);
}

// ─────────────────────────────────────────────
section('Pulizia memoria (niente crescita illimitata)');
// ─────────────────────────────────────────────
{
  const before = pa._pendingActions.size;
  for (let i = 0; i < 60; i++) {
    const g = pa.guardToolCall('press_key', { key: 'Enter', _n: i }, 'sess-leak', null);
    pa.rejectPendingAction(g.pending_action_id, 'operatore', 'test');
  }
  ok('le azioni create sono registrate', pa._pendingActions.size >= before + 60);

  // Sweep "nel futuro": tutte le decise oltre la finestra di ritenzione spariscono
  const futuro = new Date(Date.now() + 2 * 3600000);
  const res = pa.sweepPendingActions(futuro);
  ok('la pulizia rimuove le azioni decise', res.removed >= 60, JSON.stringify(res));
  ok('non restano azioni chiuse in memoria',
     [...pa._pendingActions.values()].every(a => a.status === 'pending'),
     `residue=${pa._pendingActions.size}`);
  ok('l indice dei token viene ripulito', pa._tokenIndex.size === 0, `token=${pa._tokenIndex.size}`);
}

// ─────────────────────────────────────────────
section('Autenticazione HTTP');
// ─────────────────────────────────────────────
{
  // Si usano gli STESSI origin che il server passa a runtime (prefissi con
  // porta aperta), non una lista costruita ad hoc: un test su valori diversi
  // da quelli reali non avrebbe intercettato il blocco della webapp.
  const { ALLOWED_ORIGINS } = require('../modules/config/constants');
  const origins = ALLOWED_ORIGINS;
  const mk = (headers, ip = '127.0.0.1', url = '/api/status') =>
    ({ headers, url, socket: { remoteAddress: ip } });

  ok('la webapp reale su localhost:3000 e autenticata',
     isAuthenticatedRequest(mk({ origin: 'http://localhost:3000' }, '10.0.0.9'), origins) === true);
  ok('la webapp su 127.0.0.1:3000 e autenticata',
     isAuthenticatedRequest(mk({ origin: 'http://127.0.0.1:3000' }, '10.0.0.9'), origins) === true);
  ok('altra porta di loopback accettata (porta libera)',
     isAuthenticatedRequest(mk({ origin: 'http://localhost:8080' }, '10.0.0.9'), origins) === true);
  ok('origin con host simile ma diverso rifiutato',
     isAuthenticatedRequest(mk({ origin: 'http://localhost.evil.com' }, '10.0.0.9'), origins) === false);
  ok('origin https esterno rifiutato',
     isAuthenticatedRequest(mk({ origin: 'https://localhost:3000' }, '10.0.0.9'), origins) === false);
  ok('anche con la lista reale il token errato viene rifiutato',
     isAuthenticatedRequest(mk({ 'x-cobra-token': 'no' }, '10.0.0.9'), origins) === false);

  ok('token corretto nell header accettato',
     isAuthenticatedRequest(mk({ 'x-cobra-token': COBRA_API_TOKEN }), origins) === true);
  ok('token errato rifiutato',
     isAuthenticatedRequest(mk({ 'x-cobra-token': 'sbagliato' }), origins) === false);
  ok('token in query string NON e piu accettato',
     isAuthenticatedRequest(mk({}, '10.0.0.9', `/api/status?token=${COBRA_API_TOKEN}`), origins) === false);
  ok('origin consentito accettato',
     isAuthenticatedRequest(mk({ origin: 'http://localhost:3000' }), origins) === true);
  ok('origin contraffatto per prefisso rifiutato',
     isAuthenticatedRequest(mk({ origin: 'http://localhost:3000.evil.com' }, '10.0.0.9'), origins) === false);
  ok('origin esterno rifiutato',
     isAuthenticatedRequest(mk({ origin: 'https://evil.com' }, '10.0.0.9'), origins) === false);
  ok('senza origin da IP remoto rifiutato',
     isAuthenticatedRequest(mk({}, '203.0.113.7'), origins) === false);
  ok('senza origin da loopback accettato',
     isAuthenticatedRequest(mk({}, '127.0.0.1'), origins) === true);

  ok('confronto a tempo costante corretto', safeEqual('abc', 'abc') === true);
  ok('confronto a tempo costante su lunghezze diverse', safeEqual('abc', 'abcd') === false);
  ok('confronto a tempo costante su tipi errati', safeEqual(null, 'abc') === false);
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
