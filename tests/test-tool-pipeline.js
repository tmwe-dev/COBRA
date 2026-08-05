#!/usr/bin/env node
// tests/test-tool-pipeline.js — Verifica end-to-end della pipeline tool
// Testa che executeTool riceva il ctx e dispatchi ai handler reali.
// Non richiede rete verso i provider AI.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { FAIL++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}

function section(t) { console.log(`\n\x1b[1m── ${t} ──\x1b[0m`); }

(async () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  TEST PIPELINE TOOL — COBRA v11          ║');
  console.log('╚══════════════════════════════════════════╝');

  // ═══════════════════════════════════════════
  section('1. Caricamento ctx dal server');
  // ═══════════════════════════════════════════
  let ctx;
  try {
    const srv = require('../modules/server-slim');
    ctx = srv.ctx;
    ok('server-slim esporta ctx', !!ctx);
  } catch (e) {
    ok('server-slim carica', false, e.message);
    process.exit(1);
  }

  // ═══════════════════════════════════════════
  section('2. Integrità del DI context');
  // ═══════════════════════════════════════════
  const required = [
    'executeTool', 'callAI', 'digestToolResult', 'bridgeCommand', 'bridgeNavigate',
    'isBridgeReady', 'wsBroadcast', 'log', 'emitThinking', 'emitReasoning',
    'session', 'toolHistory', 'aiKeys', 'SuperMario', 'CobraSupervisor',
    'HumanDriver', 'TokenMeter', 'ResponseRecorder', 'guardToolCall',
    'searchKB', 'saveToKB', 'paywallDomains', 'savePaywallDomains',
    'scrapeUrl', 'getActivePage', 'emitSiteVisit', 'takeActiveScreenshot',
    'persistTasks', 'persistMemories', 'COBRA_TOOLS', 'smartScrape',
  ];
  for (const k of required) {
    ok(`ctx.${k} presente`, ctx[k] !== undefined && ctx[k] !== null, `tipo=${typeof ctx[k]}`);
  }

  // ═══════════════════════════════════════════
  section('3. executeTool ha il ctx iniettato (BUG ROOT CAUSE)');
  // ═══════════════════════════════════════════
  ok('ctx.executeTool è funzione', typeof ctx.executeTool === 'function');
  ok('ctx.executeTool accetta 2 arg (wrappata)', ctx.executeTool.length === 2,
     `arity=${ctx.executeTool.length}`);

  // Chiamata con tool inesistente: deve rispondere "non implementato",
  // NON crashare con "Cannot read properties of undefined"
  {
    let res, err = null;
    try { res = await ctx.executeTool('__tool_inesistente__', {}); }
    catch (e) { err = e; }
    ok('nessuna eccezione su tool sconosciuto', err === null, err && err.message);
    ok('risposta è JSON valido', (() => { try { JSON.parse(res); return true; } catch { return false; } })());
    const parsed = err ? {} : JSON.parse(res);
    // Fail-safe: un tool sconosciuto è classificato 'destructive' dalla tassonomia
    // e intercettato per conferma PRIMA del dispatch. Questo è il comportamento corretto.
    ok('tool sconosciuto intercettato dal fail-safe (destructive)',
       parsed.status === 'pending_confirmation' || /non implementato/i.test(parsed.error || ''),
       JSON.stringify(parsed).substring(0, 140));
    ok('NON contiene "Cannot read properties of undefined"',
       !/Cannot read properties of undefined/i.test(JSON.stringify(parsed)),
       JSON.stringify(parsed).substring(0, 120));
  }

  // ═══════════════════════════════════════════
  section('4. Dispatch verso handler reali');
  // ═══════════════════════════════════════════
  // save_memory — handler puramente locale, non richiede rete né bridge
  {
    let res, err = null;
    try { res = await ctx.executeTool('save_memory', { content: 'test pipeline COBRA', category: 'test' }); }
    catch (e) { err = e; }
    ok('save_memory non lancia eccezioni', err === null, err && err.message);
    if (!err) {
      const p = (() => { try { return JSON.parse(res); } catch { return { raw: res }; } })();
      ok('save_memory NON è "non implementato"', !/non implementato/i.test(p.error || ''), p.error);
      ok('save_memory NON ha TypeError su ctx',
         !/Cannot read properties of undefined/i.test(res), res.substring(0, 150));
    }
  }

  // create_file — handler locale con filesystem
  {
    let res, err = null;
    try { res = await ctx.executeTool('create_file', { filename: 'test_pipeline.txt', content: 'ok' }); }
    catch (e) { err = e; }
    ok('create_file non lancia eccezioni', err === null, err && err.message);
    if (!err) {
      ok('create_file NON ha TypeError su ctx',
         !/Cannot read properties of undefined/i.test(res), res.substring(0, 150));
    }
  }

  // list_tasks — handler locale
  {
    let res, err = null;
    try { res = await ctx.executeTool('list_tasks', {}); }
    catch (e) { err = e; }
    ok('list_tasks non lancia eccezioni', err === null, err && err.message);
    if (!err) ok('list_tasks NON ha TypeError', !/Cannot read properties of undefined/i.test(res), res.substring(0, 150));
  }

  // ═══════════════════════════════════════════
  section('5. Handler bridge senza bridge connesso (degradazione)');
  // ═══════════════════════════════════════════
  // Questi devono fallire GRAZIOSAMENTE, non con TypeError
  for (const tool of ['screenshot', 'read_page', 'get_page_elements']) {
    let res, err = null;
    try { res = await ctx.executeTool(tool, {}); }
    catch (e) { err = e; }
    ok(`${tool} non lancia eccezione non gestita`, err === null, err && err.message);
    if (!err) {
      ok(`${tool} NON ha TypeError su ctx`,
         !/Cannot read properties of undefined|is not a function/i.test(res),
         res.substring(0, 150));
    }
  }

  // ═══════════════════════════════════════════
  section('6. Guardrail di sicurezza attivi');
  // ═══════════════════════════════════════════
  {
    // navigate verso IP privato → SSRF guard
    const res = await ctx.executeTool('navigate', { url: 'http://127.0.0.1:22/' });
    ok('SSRF guard blocca IP locale', /bloccato|locale|privato/i.test(res), res.substring(0, 150));
  }
  {
    // Fuori whitelist l'esplorazione è consentita: cliccare un link o un
    // filtro non è pericoloso, e senza questo COBRA non potrebbe navigare.
    ctx.session.lastPage = { url: 'https://sito-esterno-xyz.com/', title: 'x' };
    const esplora = await ctx.executeTool('click_element', { selector: '#pagina-successiva' });
    ok('click di esplorazione consentito fuori whitelist',
       !/whitelist|non consentito/i.test(esplora), esplora.substring(0, 150));

    // Ma i tool che caricano file o alterano la pagina restano vietati
    const vietato = await ctx.executeTool('upload_file', { selector: '#f', path: '/tmp/x' });
    ok('upload_file resta vietato fuori whitelist',
       /non è consentito|non consentito/i.test(vietato), vietato.substring(0, 150));

    // E un click su un bottone di pagamento richiede comunque conferma.
    // Si riparte da una richiesta pulita: il supervisore blocca i click
    // consecutivi senza uno sguardo alla pagina, e qui interferirebbe.
    ctx.CobraSupervisor.startRequest(null, 'verifica conferma pagamento');
    const rischioso = await ctx.executeTool('click_element', { selector: '#pay', text: 'Paga ora' });
    ok('click su "Paga ora" richiede conferma anche fuori whitelist',
       /pending_confirmation|conferma/i.test(rischioso), rischioso.substring(0, 150));
    ctx.CobraSupervisor.completeRequest('fine verifica');
    ctx.session.lastPage = null;
  }

  // ═══════════════════════════════════════════
  section('7. Supervisor anti-loop funzionante');
  // ═══════════════════════════════════════════
  {
    ctx.CobraSupervisor.startRequest(null, 'test loop');
    let stopped = false;
    for (let i = 0; i < 8; i++) {
      const r = await ctx.executeTool('scroll_page', { direction: 'down' });
      if (/loop|force_stop|Loop/i.test(r)) { stopped = true; break; }
    }
    ok('supervisor interrompe loop di scroll', stopped);
    ctx.CobraSupervisor.completeRequest('test');
  }

  // ═══════════════════════════════════════════
  section('7b. Confrontare più fonti non è un loop');
  // ═══════════════════════════════════════════
  {
    ctx.CobraSupervisor.startRequest(null, 'confronto multi-sito');
    const visite = [
      ['navigate', { url: 'https://kayak.it/a' }], ['read_page', {}],
      ['navigate', { url: 'https://momondo.it/b' }], ['read_page', {}],
      ['navigate', { url: 'https://skyscanner.it/c' }], ['read_page', {}],
      ['navigate', { url: 'https://expedia.it/d' }], ['read_page', {}],
    ];
    let fermato = null;
    for (const [t, a] of visite) {
      const r = ctx.CobraSupervisor.recordToolCall(t, a);
      if (r && r.warning === 'force_stop') { fermato = t; break; }
    }
    ok('quattro siti diversi non vengono scambiati per un loop', fermato === null,
       `fermato su ${fermato}`);
    ctx.CobraSupervisor.completeRequest('ok');

    // Ma tornare sulla stessa pagina resta un loop
    ctx.CobraSupervisor.startRequest(null, 'loop reale');
    let fermato2 = null;
    for (let i = 0; i < 10; i++) {
      const r = ctx.CobraSupervisor.recordToolCall(i % 2 ? 'read_page' : 'navigate', { url: 'https://stesso.it' });
      if (r && r.warning === 'force_stop') { fermato2 = i; break; }
    }
    ok('il loop vero sulla stessa pagina viene fermato', fermato2 !== null, 'non fermato');
    ctx.CobraSupervisor.completeRequest('ok');
  }

  // ═══════════════════════════════════════════
  section('8. Audit log persistente scritto');
  // ═══════════════════════════════════════════
  {
    const fs = require('fs');
    const auditDir = path.join(process.cwd(), 'data', 'audit');
    let found = false, recent = false;
    if (fs.existsSync(auditDir)) {
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f);
          if (fs.statSync(fp).isDirectory()) walk(fp);
          else if (f.endsWith('.jsonl')) {
            found = true;
            if (Date.now() - fs.statSync(fp).mtimeMs < 60000) recent = true;
          }
        }
      };
      walk(auditDir);
    }
    ok('audit log esiste', found);
    ok('audit log scritto in questa sessione', recent);
  }

  // ═══════════════════════════════════════════
  section('9. SuperMario assembla tool per intent task');
  // ═══════════════════════════════════════════
  {
    const routing = ctx.SuperMario.routeIntent('cerca voli per Milano domani');
    ok('routeIntent classifica come task', routing.intent === 'task', `intent=${routing.intent}`);
    const asm = await ctx.SuperMario.assemble({
      intent: routing.intent, scopes: routing.scopes, operationLevel: 'read',
      userMessage: 'cerca voli per Milano domani', conversationHistory: [],
      lastToolResult: null, voiceMode: false, allTools: ctx.COBRA_TOOLS,
    });
    ok('assemble produce tool per task', asm.tools.length > 0, `tools=${asm.tools.length}`);
    ok('tool hanno formato OpenAI valido',
       asm.tools.every(t => t.type === 'function' && t.function?.name && t.function?.parameters));
    // Verifica che nessuno schema abbia object senza properties (rifiutato da Gemini)
    const bad = asm.tools.filter(t => {
      const p = t.function.parameters;
      if (!p || !p.properties) return true;
      return Object.values(p.properties).some(v => v.type === 'object' && !v.properties);
    });
    ok('nessuno schema object senza properties (Gemini-safe)', bad.length === 0,
       bad.map(t => t.function.name).join(','));
  }

  // ═══════════════════════════════════════════
  section('10. callAI gestisce ctx correttamente');
  // ═══════════════════════════════════════════
  {
    // Con aiKeys vuoto deve rispondere "nessuna API key", non crashare
    const res = await ctx.callAI('sys', [{ role: 'user', content: 'hi' }], undefined, {
      ...ctx, aiKeys: {}, modelTier: 'lite',
    });
    ok('callAI senza chiavi non crasha', res && res.provider === 'none', JSON.stringify(res).substring(0, 120));
  }

  // ═══════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  RISULTATO: ${PASS} PASS, ${FAIL} FAIL`);
  console.log('╚══════════════════════════════════════════╝');
  if (failures.length) {
    console.log('\n\x1b[31mFALLIMENTI:\x1b[0m');
    failures.forEach(f => console.log('  • ' + f));
  }
  process.exit(FAIL > 0 ? 1 : 0);
})();
