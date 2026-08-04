#!/usr/bin/env node
// tests/test-data-integrity.js — Classificazione URL, scritture atomiche, catena di audit.

const path = require('path');
const fs = require('fs');
const os = require('os');
process.chdir(path.resolve(__dirname, '..'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cobra-test-'));
process.env.COBRA_AUDIT_DIR = TMP;

const { classifyUrlRisk } = require('../modules/risk/classifiers');
const { TOOL_RISK_TAXONOMY } = require('../modules/risk/taxonomy');
const { writeJsonAtomicSync, readJsonSafeSync, writeAtomicSync } = require('../modules/utils/atomic-file');
const audit = require('../modules/security/audit-log');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== INTEGRITA DEI DATI ===');

// ─────────────────────────────────────────
section('Classificazione URL: nessun match per sottostringa');
// ─────────────────────────────────────────
ok('wikipedia.org e sicuro', classifyUrlRisk('https://it.wikipedia.org/wiki/X').level === 'read');
ok('wikipedia.org.evil.com NON e sicuro',
   classifyUrlRisk('https://wikipedia.org.evil.com/x').reasons[0] !== 'Whitelist read-only',
   JSON.stringify(classifyUrlRisk('https://wikipedia.org.evil.com/x')));
ok('parametro con nome di dominio fidato non rende sicuro il sito',
   classifyUrlRisk('https://evil.com/?ref=wikipedia.org').reasons[0] !== 'Whitelist read-only');
ok('mountebank.io NON e classificato bancario',
   classifyUrlRisk('https://mountebank.io/docs').level === 'read',
   JSON.stringify(classifyUrlRisk('https://mountebank.io/docs')));
ok('nologin.example.com NON e sensibile',
   classifyUrlRisk('https://nologin.example.com/').level === 'read',
   JSON.stringify(classifyUrlRisk('https://nologin.example.com/')));
ok('login.microsoftonline.com E sensibile',
   classifyUrlRisk('https://login.microsoftonline.com/').level !== 'read');
ok('paypal.com e sensibile', classifyUrlRisk('https://www.paypal.com/').level !== 'read');
ok('URL con credenziali e destructive',
   classifyUrlRisk('https://utente:pw@example.com/').level === 'destructive');
ok('query di pagamento e destructive',
   classifyUrlRisk('https://shop.com/x?pay=1').level === 'destructive');
ok('dominio fidato con /checkout non resta read',
   classifyUrlRisk('https://www.google.com/checkout').level !== 'read',
   JSON.stringify(classifyUrlRisk('https://www.google.com/checkout')));
ok('javascript: e destructive', classifyUrlRisk('javascript:alert(1)').level === 'destructive');

// ─────────────────────────────────────────
section('Tassonomia senza chiavi duplicate');
// ─────────────────────────────────────────
{
  const src = fs.readFileSync('modules/risk/taxonomy.js', 'utf8');
  const keys = [...src.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map(m => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  ok('nessuna chiave duplicata', dupes.length === 0, `duplicate: ${[...new Set(dupes)].join(', ')}`);
  ok('web_search resta definito', !!TOOL_RISK_TAXONOMY.web_search);
  ok('execute_js resta definito', !!TOOL_RISK_TAXONOMY.execute_js);
}

// ─────────────────────────────────────────
section('Scrittura atomica');
// ─────────────────────────────────────────
{
  const f = path.join(TMP, 'dati.json');
  ok('scrive un JSON', writeJsonAtomicSync(f, { a: 1, b: [1, 2] }) === true);
  ok('rilegge quanto scritto', JSON.stringify(readJsonSafeSync(f)) === '{"a":1,"b":[1,2]}');
  ok('nessun file temporaneo residuo',
     fs.readdirSync(TMP).filter(x => x.includes('.tmp')).length === 0,
     fs.readdirSync(TMP).join(','));

  // Sovrascrittura ripetuta: il file resta sempre leggibile
  let sempreValido = true;
  for (let i = 0; i < 40; i++) {
    writeJsonAtomicSync(f, { n: i, payload: 'x'.repeat(500) });
    if (readJsonSafeSync(f, null)?.n !== i) { sempreValido = false; break; }
  }
  ok('40 sovrascritture restano coerenti', sempreValido);

  // File corrotto: viene messo da parte, non perso
  const bad = path.join(TMP, 'corrotto.json');
  fs.writeFileSync(bad, '{ questo non e json');
  const val = readJsonSafeSync(bad, { fallback: true });
  ok('file corrotto non fa crashare', val && val.fallback === true);
  ok('file corrotto viene conservato a parte',
     fs.readdirSync(TMP).some(x => x.startsWith('corrotto.json.corrotto.')),
     fs.readdirSync(TMP).join(','));

  // Percorso non valido: un componente intermedio è un file, non una cartella
  const blocco = path.join(TMP, 'sono-un-file');
  fs.writeFileSync(blocco, 'x');
  ok('percorso non scrivibile restituisce false',
     writeAtomicSync(path.join(blocco, 'sotto', 'x.json'), 'x') === false);
}

// ─────────────────────────────────────────
section('Catena di hash del registro di audit');
// ─────────────────────────────────────────
{
  for (let i = 0; i < 12; i++) {
    audit.auditToolCall(`tool_${i}`, { i }, 'read', 'allow', '{"ok":true}', 'sessione-test');
  }
  audit.flushAuditSync();

  const v1 = audit.verifyAuditChain();
  ok('la catena e valida dopo le scritture', v1.valid === true, JSON.stringify(v1));
  ok('sono state registrate 12 voci', v1.entries === 12, `voci=${v1.entries}`);

  // Manomissione: si altera il contenuto di una riga
  const file = audit.LOG_FILE;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rec = JSON.parse(lines[5]);
  rec.result = '{"ok":false,"manomesso":true}';
  lines[5] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const v2 = audit.verifyAuditChain();
  ok('rileva il contenuto alterato', v2.valid === false, JSON.stringify(v2));
  ok('indica la riga alterata', v2.brokenAt === 6, `riga=${v2.brokenAt}`);

  // Rimozione di una riga
  fs.writeFileSync(file, lines.filter((_, i) => i !== 3).join('\n') + '\n');
  const v3 = audit.verifyAuditChain();
  ok('rileva la riga rimossa', v3.valid === false, JSON.stringify(v3));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* pulizia best-effort */ }

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
