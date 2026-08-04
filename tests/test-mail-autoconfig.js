#!/usr/bin/env node
// tests/test-mail-autoconfig.js — Rilevamento automatico dei server di posta.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { trovaServerPosta, dominioDi, leggiAutoconfig, PROVIDER_NOTI } =
  require('../modules/utils/mail-autoconfig');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${name}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

(async () => {
  console.log('\n=== RILEVAMENTO SERVER DI POSTA ===');

  // ─────────────────────────────────────────
  section('Estrazione del dominio');
  // ─────────────────────────────────────────
  ok('indirizzo normale', dominioDi('luca@tmwe.it') === 'tmwe.it');
  ok('maiuscole e spazi', dominioDi('  Luca@TMWE.IT  ') === 'tmwe.it');
  ok('sottodominio', dominioDi('a@mail.azienda.co.uk') === 'mail.azienda.co.uk');
  ok('senza chiocciola', dominioDi('nonvalido') === null);
  ok('vuoto', dominioDi('') === null && dominioDi(null) === null);

  // ─────────────────────────────────────────
  section('Provider noti (nessuna rete)');
  // ─────────────────────────────────────────
  const casi = [
    ['lucaarcana@gmail.com', 'imap.gmail.com', true],
    ['tizio@outlook.com', 'outlook.office365.com', true],
    ['tizio@hotmail.it', 'outlook.office365.com', true],
    ['tizio@icloud.com', 'imap.mail.me.com', true],
    ['tizio@libero.it', 'imapmail.libero.it', false],
    ['tizio@aruba.it', 'imaps.aruba.it', false],
    ['tizio@tiscali.it', 'imap.tiscali.it', false],
    ['tizio@virgilio.it', 'in.virgilio.it', false],
  ];
  for (const [email, atteso, passwordApp] of casi) {
    const r = await trovaServerPosta(email, { provaConnessione: false });
    ok(`${email} → ${atteso}`, r.trovato && r.imapHost === atteso,
       `ottenuto ${r.imapHost}`);
    if (passwordApp) {
      ok(`  segnala che serve la password per le app`, r.richiedePasswordApp === true);
    }
  }

  {
    const r = await trovaServerPosta('lucaarcana@gmail.com', { provaConnessione: false });
    ok('riconosce il provider per nome', r.provider === 'Gmail', r.provider);
    ok('indica la porta IMAP cifrata', r.imapPort === 993);
    ok('indica anche il server di invio', r.smtpHost === 'smtp.gmail.com', r.smtpHost);
    ok('la fonte e dichiarata', r.fonte === 'provider noto', r.fonte);
    ok('la nota spiega la password per le app', /password per le app/i.test(r.nota || ''), r.nota);
  }

  // ─────────────────────────────────────────
  section('Lettura di un autoconfig XML');
  // ─────────────────────────────────────────
  const XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
 <emailProvider id="esempio.it">
  <incomingServer type="pop3">
   <hostname>pop.esempio.it</hostname><port>995</port>
  </incomingServer>
  <incomingServer type="imap">
   <hostname>imap.esempio.it</hostname><port>993</port>
   <socketType>SSL</socketType>
  </incomingServer>
  <outgoingServer type="smtp">
   <hostname>smtp.esempio.it</hostname><port>465</port>
  </outgoingServer>
 </emailProvider>
</clientConfig>`;
  const cfg = leggiAutoconfig(XML);
  ok('estrae l host IMAP', cfg && cfg.imap === 'imap.esempio.it', JSON.stringify(cfg));
  ok('ignora il server POP3', cfg && cfg.imap !== 'pop.esempio.it');
  ok('estrae la porta IMAP', cfg && cfg.imapPort === 993, String(cfg && cfg.imapPort));
  ok('estrae il server SMTP', cfg && cfg.smtp === 'smtp.esempio.it', String(cfg && cfg.smtp));
  ok('estrae la porta SMTP', cfg && cfg.smtpPort === 465, String(cfg && cfg.smtpPort));
  ok('XML senza IMAP restituisce nulla', leggiAutoconfig('<clientConfig/>') === null);
  ok('XML malformato non rompe', leggiAutoconfig('non xml') === null);

  // ─────────────────────────────────────────
  section('Dominio sconosciuto: ipotesi dichiarata');
  // ─────────────────────────────────────────
  {
    const r = await trovaServerPosta('tizio@dominio-che-non-esiste-12345.invalid', { provaConnessione: false });
    ok('non dichiara falsamente di aver trovato', r.trovato === false, JSON.stringify(r));
    ok('propone comunque un valore plausibile',
       r.imapHost === 'imap.dominio-che-non-esiste-12345.invalid', r.imapHost);
    ok('segnala che va confermato', r.daConfermare === true);
    ok('spiega cosa fare', /verificali|fornitore/i.test(r.nota || ''), r.nota);
  }

  // ─────────────────────────────────────────
  section('Ingressi non validi');
  // ─────────────────────────────────────────
  for (const cattivo of ['', null, undefined, 'senza-chiocciola', '@', 'a@']) {
    const r = await trovaServerPosta(cattivo, { provaConnessione: false });
    ok(`"${String(cattivo)}" gestito senza eccezioni`, r && typeof r.trovato === 'boolean');
  }

  // ─────────────────────────────────────────
  section('Copertura dell elenco');
  // ─────────────────────────────────────────
  const domini = Object.keys(PROVIDER_NOTI);
  ok('almeno 20 provider coperti', domini.length >= 20, `${domini.length}`);
  ok('tutti hanno host IMAP e SMTP',
     domini.every(d => PROVIDER_NOTI[d].imap && PROVIDER_NOTI[d].smtp));
  ok('tutti hanno un nome leggibile', domini.every(d => !!PROVIDER_NOTI[d].nome));
  ok('include i principali provider italiani',
     ['libero.it', 'virgilio.it', 'aruba.it', 'tiscali.it'].every(d => !!PROVIDER_NOTI[d]));

  console.log('');
  console.log(FAIL === 0
    ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
    : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
  process.exit(FAIL > 0 ? 1 : 0);
})();
