#!/usr/bin/env node
// tests/test-ssrf.js — Verifica la protezione SSRF contro i vettori di bypass noti.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { isSSRFSafe, assertSSRFSafe, isPrivateAddress } = require('../modules/security/ssrf');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

// Deve essere BLOCCATO
const BLOCK = [
  ['localhost', 'http://localhost/admin'],
  ['loopback puntato', 'http://127.0.0.1:3000'],
  ['loopback altro ottetto', 'http://127.1.2.3/'],
  ['rete 10.x', 'http://10.0.0.1/api'],
  ['rete 172.16-31', 'http://172.20.10.5/'],
  ['rete 192.168', 'http://192.168.1.1'],
  ['link-local', 'http://169.254.1.1/'],
  ['metadata AWS', 'http://169.254.169.254/latest/meta-data/'],
  ['metadata GCP', 'http://metadata.google.internal/'],
  ['zero network', 'http://0.0.0.0/admin'],
  ['IPv6 loopback', 'http://[::1]/admin'],
  ['IPv6 unspecified', 'http://[::]/'],
  ['IPv6 link-local', 'http://[fe80::1]/'],
  ['IPv6 unique-local', 'http://[fd00::1]/'],
  ['IPv4-mapped in IPv6', 'http://[::ffff:127.0.0.1]/'],
  ['IPv4-mapped esadecimale', 'http://[::ffff:7f00:1]/'],
  ['decimale intero', 'http://2130706433/'],          // 127.0.0.1
  ['esadecimale', 'http://0x7f000001/'],              // 127.0.0.1
  ['ottale puntato', 'http://0177.0.0.01/'],          // 127.0.0.1
  ['decimale intero rete privata', 'http://3232235777/'], // 192.168.1.1
  ['protocollo file', 'file:///etc/passwd'],
  ['protocollo ftp', 'ftp://example.com/f'],
  ['protocollo gopher', 'gopher://127.0.0.1/'],
  ['credenziali offuscanti', 'http://example.com@127.0.0.1/'],
  ['suffisso .local', 'http://stampante.local/'],
  ['suffisso .internal', 'http://db.internal/'],
  ['CGNAT', 'http://100.64.0.1/'],
  ['multicast', 'http://224.0.0.1/'],
  ['url malformato', 'non-un-url'],
  ['stringa vuota', ''],
];

// Deve essere CONSENTITO
const ALLOW = [
  ['dominio pubblico', 'https://www.google.com'],
  ['dominio con path', 'https://it.wikipedia.org/wiki/Logistica'],
  ['172.15 non privata', 'http://172.15.0.1/'],
  ['172.32 non privata', 'http://172.32.0.1/'],
  ['11.x pubblica', 'http://11.0.0.1/'],
  ['IP pubblico noto', 'http://8.8.8.8/'],
];

(async () => {
  console.log('\n=== PROTEZIONE SSRF ===');

  section('Controllo sincrono: deve bloccare');
  for (const [name, url] of BLOCK) ok(name, isSSRFSafe(url) === false, `isSSRFSafe ha restituito true per ${url}`);

  section('Controllo sincrono: deve consentire');
  for (const [name, url] of ALLOW) ok(name, isSSRFSafe(url) === true, `isSSRFSafe ha bloccato ${url}`);

  section('Classificazione indirizzi risolti');
  ok('127.0.0.1 privato', isPrivateAddress('127.0.0.1') === true);
  ok('10.1.2.3 privato', isPrivateAddress('10.1.2.3') === true);
  ok('169.254.169.254 privato', isPrivateAddress('169.254.169.254') === true);
  ok('::1 privato', isPrivateAddress('::1') === true);
  ok('fd00::1 privato', isPrivateAddress('fd00::1') === true);
  ok('8.8.8.8 pubblico', isPrivateAddress('8.8.8.8') === false);
  ok('93.184.216.34 pubblico', isPrivateAddress('93.184.216.34') === false);

  section('DNS rebinding (dominio pubblico -> IP interno)');
  // Si simula la risoluzione DNS sostituendo dns.lookup
  const dnsMod = require('dns').promises;
  const realLookup = dnsMod.lookup;

  dnsMod.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const r1 = await assertSSRFSafe('https://dominio-malevolo.example');
  ok('blocca dominio che risolve a 127.0.0.1', r1.safe === false, JSON.stringify(r1));
  ok('spiega il motivo del blocco', /interni/i.test(r1.reason || ''), r1.reason);

  dnsMod.lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  const r2 = await assertSSRFSafe('https://innocuo.example');
  ok('blocca dominio che risolve al metadata endpoint', r2.safe === false, JSON.stringify(r2));

  dnsMod.lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  const r3 = await assertSSRFSafe('https://misto.example');
  ok('blocca se anche UN SOLO indirizzo e interno', r3.safe === false, JSON.stringify(r3));

  dnsMod.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const r4 = await assertSSRFSafe('https://legittimo.example');
  ok('consente dominio che risolve a IP pubblico', r4.safe === true, JSON.stringify(r4));

  dnsMod.lookup = async () => { throw new Error('ENOTFOUND'); };
  const r5 = await assertSSRFSafe('https://inesistente.example');
  ok('nega in caso di errore DNS (fail-safe)', r5.safe === false, JSON.stringify(r5));

  dnsMod.lookup = async () => [];
  const r6 = await assertSSRFSafe('https://vuoto.example');
  ok('nega se il DNS non restituisce indirizzi', r6.safe === false, JSON.stringify(r6));

  dnsMod.lookup = realLookup;

  section('IP letterali non richiedono DNS');
  const r7 = await assertSSRFSafe('http://8.8.8.8/');
  ok('IP pubblico letterale consentito senza DNS', r7.safe === true, JSON.stringify(r7));
  const r8 = await assertSSRFSafe('http://127.0.0.1/');
  ok('IP privato letterale bloccato', r8.safe === false, JSON.stringify(r8));

  console.log('');
  console.log(FAIL === 0
    ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
    : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
  process.exit(FAIL > 0 ? 1 : 0);
})();
