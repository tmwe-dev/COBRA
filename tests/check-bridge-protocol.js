#!/usr/bin/env node
// tests/check-bridge-protocol.js — Verifica che il protocollo WebSocket usato dal
// server corrisponda a quello implementato dall'estensione Chrome.
// Previene il bug "il server invia type:'command' ma l'estensione ascolta 'bridge_command'".

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let PASS = 0, FAIL = 0;

function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}

const ext = fs.readFileSync(path.join(ROOT, 'cobra-extension', 'background.js'), 'utf8');
const srv = fs.readFileSync(path.join(ROOT, 'modules', 'server-slim.js'), 'utf8');
const conn = fs.readFileSync(path.join(ROOT, 'modules', 'bridge', 'connection.js'), 'utf8');
const ws = fs.readFileSync(path.join(ROOT, 'modules', 'ws', 'server.js'), 'utf8');
const front = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

console.log('');
console.log('=== PROTOCOLLO BRIDGE: server <-> estensione ===');
console.log('');

// ── Direzione server -> estensione ──
console.log('Server -> Estensione');
const extListensFor = [...ext.matchAll(/msg\.type === '([a-z_]+)'/g)].map(m => m[1]);
ok(`estensione ascolta 'bridge_command'`, extListensFor.includes('bridge_command'),
   `ascolta: ${extListensFor.join(', ')}`);
ok(`server invia type:'bridge_command'`, /type:\s*'bridge_command'/.test(srv),
   'server-slim.js non invia bridge_command');
ok(`connection.js invia type:'bridge_command'`, /type:\s*'bridge_command'/.test(conn),
   'connection.js usa un tipo diverso');
ok(`server NON invia il vecchio type:'command'`, !/type:\s*'command'\s*,/.test(srv) && !/\{\s*id,\s*type:\s*'command'/.test(srv));

// ── Campi del messaggio ──
ok(`estensione legge msg.id`, /msgId = msg\.id/.test(ext) || /msg\.id/.test(ext));
ok(`estensione legge msg.command`, /msg\.command/.test(ext));
ok(`estensione legge msg.args`, /msg\.args/.test(ext));
ok(`server invia id, command, args`, /bridge_command', id, command, args/.test(srv));

// ── Direzione estensione -> server ──
console.log('');
console.log('Estensione -> Server');
ok(`estensione risponde con 'bridge_result'`, /type:\s*'bridge_result'/.test(ext));
ok(`ws/server.js gestisce 'bridge_result'`, /msg\.type === 'bridge_result'/.test(ws));
ok(`ws/server.js risolve tramite _bridgePending`, /_bridgePending\.get\(msg\.id\)/.test(ws));
ok(`server-slim usa getBridgePending() (stessa Map)`, /getBridgePending\(\)/.test(srv),
   'server-slim deve usare la Map del WS server, non una locale');

// ── Handshake ──
console.log('');
console.log('Handshake');
ok(`estensione invia 'bridge_connect' con token`, /type:\s*'bridge_connect', token/.test(ext));
ok(`ws/server.js valida 'bridge_connect'`, /msg\.type === 'bridge_connect'/.test(ws));
ok(`ws/server.js risponde 'bridge_auth_ok'`, /bridge_auth_ok/.test(ws));
ok(`estensione gestisce 'bridge_auth_ok'`, /bridge_auth_ok/.test(ext));

// ── Extension relay (LinkedIn / WhatsApp via webapp) ──
console.log('');
console.log('Extension relay (webapp)');
ok(`server invia 'ext_command'`, /type:\s*'ext_command'/.test(srv));
ok(`frontend gestisce 'ext_command'`, /case 'ext_command'/.test(front));
ok(`frontend risponde 'ext_result' con requestId`, /type:\s*'ext_result', requestId/.test(front));
ok(`ws/server.js instrada 'ext_result'`, /msg\.type === 'ext_result'/.test(ws));
ok(`server-slim implementa handleExtResult`, /handleExtResult\(msg\)\s*\{[\s\S]{0,400}_extPending/.test(srv),
   'handleExtResult deve risolvere la promise, non essere uno stub');

// ── Comandi richiesti dagli handler esistono nell'estensione ──
console.log('');
console.log('Copertura comandi');
const extCommands = [...ext.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]);
const handlersDir = path.join(ROOT, 'modules', 'tools', 'handlers');
const used = new Set();
for (const f of fs.readdirSync(handlersDir)) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(handlersDir, f), 'utf8');
  for (const m of src.matchAll(/bridgeCommand\(\s*'([a-z_]+)'/g)) used.add(m[1]);
}
const missing = [...used].filter(c => !extCommands.includes(c));
ok(`tutti i comandi bridge usati esistono nell'estensione`, missing.length === 0,
   missing.length ? `mancanti: ${missing.join(', ')}` : '');
console.log(`  i comandi estensione: ${extCommands.length} | usati dagli handler: ${used.size}`);

// ── Campi della risposta: il server deve leggere i campi che l'estensione produce ──
console.log('');
console.log('Campi risposta get_page_content');
// Il blocco contiene uno switch annidato (case 'h1' ecc.), quindi si usa una
// finestra fissa e si cerca la return finale che contiene i metadati di pagina.
const gpcStart = ext.indexOf("case 'get_page_content':");
const gpcBlock = ext.slice(gpcStart, gpcStart + 9000);
const gpcMatch = gpcBlock.match(/return \{ ok: true,[^\n]*title:[^\n]*\}/);
const gpcReturn = gpcMatch ? gpcMatch[0] : '';
ok(`estensione restituisce 'markdown'`, /\bmarkdown:/.test(gpcReturn),
   `return: ${gpcReturn.substring(0, 120)}`);
ok(`estensione NON restituisce 'content'`, !/\bcontent:/.test(gpcReturn),
   'se cambia, aggiornare gli handler che leggono .markdown');

// Nessun handler deve leggere un campo .content dal risultato di get_page_content
const navSrc = fs.readFileSync(path.join(handlersDir, 'navigate.js'), 'utf8');
ok(`navigate.js legge .markdown (non .content) dal bridge`,
   /bridgeNav\.content\?\.markdown/.test(navSrc) && !/bridgeNav\.content\?\.content/.test(navSrc),
   'navigate.js legge un campo che l\'estensione non produce');

const rsSrc = fs.readFileSync(path.join(handlersDir, 'read-scrape.js'), 'utf8');
ok(`read-scrape.js legge .markdown dal bridge`, /bc\?\.markdown|bc\.markdown/.test(rsSrc));
ok(`read-scrape.js riprova sulle pagine caricate via javascript`,
   /for \(const attesa of/.test(rsSrc),
   'senza attese la prima lettura torna vuota su Google Voli e simili');
ok(`navigate.js riprova sulle pagine caricate via javascript`,
   /for \(const attesa of/.test(navSrc));

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
