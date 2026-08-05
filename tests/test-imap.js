#!/usr/bin/env node
// tests/test-imap.js — Lettura posta: decodifica intestazioni, anteprima, parsing FETCH.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { decodeHeader, bodyPreview, analizzaFetch, leggiPosta,
        nomiDalCertificato, alternativeDaCertificato } = require('../modules/utils/imap');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== LETTURA POSTA (IMAP) ===');

// ─────────────────────────────────────────
section('Decodifica delle intestazioni');
// ─────────────────────────────────────────
ok('testo semplice invariato', decodeHeader('Preventivo spedizione') === 'Preventivo spedizione');
ok('base64 UTF-8',
   decodeHeader('=?UTF-8?B?U3BlZGl6aW9uZSB1cmdlbnRl?=') === 'Spedizione urgente',
   decodeHeader('=?UTF-8?B?U3BlZGl6aW9uZSB1cmdlbnRl?='));
ok('quoted-printable con accenti',
   decodeHeader('=?UTF-8?Q?Perch=C3=A9_=C3=A8_urgente?=') === 'Perché è urgente',
   decodeHeader('=?UTF-8?Q?Perch=C3=A9_=C3=A8_urgente?='));
ok('underscore diventa spazio',
   decodeHeader('=?UTF-8?Q?Due_parole?=') === 'Due parole');
ok('parti multiple nella stessa riga',
   decodeHeader('=?UTF-8?B?Q2lhbw==?= Luca') === 'Ciao Luca',
   decodeHeader('=?UTF-8?B?Q2lhbw==?= Luca'));
ok('valore vuoto non rompe', decodeHeader('') === '' && decodeHeader(undefined) === '');
ok('codifica non valida non rompe', typeof decodeHeader('=?UTF-8?B?!!!non-base64!!!?=') === 'string');

// ─────────────────────────────────────────
section('Anteprima del corpo');
// ─────────────────────────────────────────
ok('rimuove i tag HTML',
   bodyPreview('<p>Ciao <b>Luca</b></p>') === 'Ciao Luca',
   bodyPreview('<p>Ciao <b>Luca</b></p>'));
ok('rimuove style e script',
   !/colore|alert/.test(bodyPreview('<style>.x{colore:red}</style><script>alert(1)</script>Testo')),
   bodyPreview('<style>.x{colore:red}</style><script>alert(1)</script>Testo'));
ok('decodifica entita HTML',
   bodyPreview('Costi &amp; tempi &quot;urgenti&quot;') === 'Costi & tempi "urgenti"',
   bodyPreview('Costi &amp; tempi &quot;urgenti&quot;'));
ok('decodifica quoted-printable',
   bodyPreview('Perch=C3=A9 no') === 'Perché no',
   bodyPreview('Perch=C3=A9 no'));
ok('decodifica un corpo interamente base64',
   bodyPreview(Buffer.from('Contenuto del messaggio di prova').toString('base64')) === 'Contenuto del messaggio di prova',
   bodyPreview(Buffer.from('Contenuto del messaggio di prova').toString('base64')));
ok('rispetta la lunghezza massima', bodyPreview('x'.repeat(1000), 50).length === 50);
ok('corpo vuoto non rompe', bodyPreview('') === '' && bodyPreview(null) === '');

// ─────────────────────────────────────────
section('Analisi della risposta FETCH');
// ─────────────────────────────────────────
const RISPOSTA = [
  '* 12 FETCH (FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {120}',
  'From: Acme Logistica <ordini@acme.it>',
  'Subject: =?UTF-8?B?UmljaGllc3RhIHByZXZlbnRpdm8=?=',
  'Date: Mon, 04 Aug 2026 09:12:00 +0200',
  '',
  ' BODY[TEXT]<0> {45}',
  'Buongiorno, avremmo bisogno di un preventivo.',
  ')',
  '* 13 FETCH (FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {90}',
  'From: Mario Rossi <mario@example.com>',
  'Subject: Conferma ritiro',
  'Date: Mon, 04 Aug 2026 08:00:00 +0200',
  '',
  ' BODY[TEXT]<0> {30}',
  '<p>Ritiro confermato</p>',
  ')',
].join('\r\n');

const msgs = analizzaFetch(RISPOSTA);
ok('trova due messaggi', msgs.length === 2, `trovati ${msgs.length}`);
ok('estrae il mittente', msgs[0].da === 'Acme Logistica <ordini@acme.it>', msgs[0].da);
ok('decodifica l oggetto codificato', msgs[0].oggetto === 'Richiesta preventivo', msgs[0].oggetto);
ok('estrae la data', /04 Aug 2026/.test(msgs[0].data), msgs[0].data);
ok('riconosce il messaggio non letto', msgs[0].letta === false);
ok('riconosce il messaggio gia letto', msgs[1].letta === true);
ok('estrae l anteprima', /preventivo/i.test(msgs[0].anteprima), msgs[0].anteprima);
ok('ripulisce l HTML nell anteprima', msgs[1].anteprima === 'Ritiro confermato', msgs[1].anteprima);
ok('oggetto semplice invariato', msgs[1].oggetto === 'Conferma ritiro', msgs[1].oggetto);

ok('risposta vuota non rompe', analizzaFetch('').length === 0);
ok('risposta malformata non rompe', Array.isArray(analizzaFetch('spazzatura senza struttura')));

// ─────────────────────────────────────────
section('Certificato intestato a un altro dominio');
// ─────────────────────────────────────────
{
  // Caso reale: mail.tmwe.it ospitato su macchine intestate a *.vmteca.net
  const errore = "Hostname/IP does not match certificate's altnames: "
    + "Host: mail.tmwe.it. is not in the cert's altnames: DNS:*.vmteca.net, DNS:vmteca.net";
  const nomi = nomiDalCertificato(errore);
  ok('estrae i nomi validi del certificato',
     nomi.includes('*.vmteca.net') && nomi.includes('vmteca.net'), nomi.join(' | '));
  ok('non confonde le due occorrenze di "altnames"',
     !nomi.some(n => /Host:|is not/.test(n)), nomi.join(' | '));

  const alt = alternativeDaCertificato(nomi);
  ok('propone gli host IMAP del provider', alt.includes('imap.vmteca.net'), alt.join(' | '));
  ok('propone anche la variante mail.', alt.includes('mail.vmteca.net'));
  ok('non propone duplicati', alt.length === new Set(alt).size);

  ok('messaggio senza certificato non produce nulla',
     nomiDalCertificato('errore generico').length === 0);
  ok('nomi non wildcard senza prefisso non generano proposte',
     alternativeDaCertificato(['esempio.it']).length === 0);
  ok('nomi gia specifici vengono mantenuti',
     alternativeDaCertificato(['imap.esempio.it']).includes('imap.esempio.it'));
}

// ─────────────────────────────────────────
section('Controlli sulla configurazione');
// ─────────────────────────────────────────
(async () => {
  for (const [nome, cfg] of [
    ['configurazione vuota', {}],
    ['host mancante', { user: 'a', pass: 'b' }],
    ['utente mancante', { host: 'imap.x.it', pass: 'b' }],
    ['password mancante', { host: 'imap.x.it', user: 'a' }],
  ]) {
    let errore = null;
    try { await leggiPosta(cfg); } catch (e) { errore = e.message; }
    ok(`${nome}: errore chiaro senza connettersi`,
       !!errore && /incompleta/i.test(errore), errore || 'nessun errore');
  }

  // Host inesistente: deve fallire con un messaggio comprensibile, non bloccarsi
  let erroreRete = null;
  const t0 = Date.now();
  try {
    await leggiPosta(
      { host: 'imap-che-non-esiste.invalid', user: 'a', pass: 'b' },
      { timeoutMs: 4000 }
    );
  } catch (e) { erroreRete = e.message; }
  const durata = Date.now() - t0;
  ok('host irraggiungibile: errore invece di blocco', !!erroreRete, 'nessun errore');
  ok('fallisce entro il timeout', durata < 8000, `${durata}ms`);
  ok('il messaggio spiega il problema',
     /fallita|timeout|chiusa/i.test(erroreRete || ''), erroreRete);

  console.log('');
  console.log(FAIL === 0
    ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
    : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
  process.exit(FAIL > 0 ? 1 : 0);
})();
