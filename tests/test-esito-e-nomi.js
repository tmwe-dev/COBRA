// Due difetti trovati l'8 agosto durante gli auguri su LinkedIn.
const { esitoRiuscito } = require('../modules/utils/esito');
const { certezzaDestinatario, eUnNumero } = require('../modules/security/regole-invio');

let ok = 0, ko = 0;
const t = (nome, vero) => { if (vero) { ok++; } else { ko++; console.log('  FALLITO: ' + nome); } };

// ── 1. Uno strumento che rifiuta non e' uno strumento riuscito ──
t('ok:false = fallito', esitoRiuscito('{"ok":false,"motivo":"non so chi sia"}') === false);
t('serveConferma = fallito', esitoRiuscito('{"ok":false,"serveConferma":true}') === false);
t('bloccato = fallito', esitoRiuscito('{"ok":false,"bloccato":true,"motivo":"x"}') === false);
t('ok:true = riuscito', esitoRiuscito('{"ok":true,"inviato":1}') === true);
t('error = fallito', esitoRiuscito('{"error":"boom"}') === false);
t('errore = fallito', esitoRiuscito('{"errore":"boom"}') === false);
t('in attesa di conferma = non riuscito', esitoRiuscito('{"status":"pending_confirmation","pending_action_id":"x"}') === false);
t('testo libero = riuscito', esitoRiuscito('ho letto la pagina') === true);
t('vuoto = riuscito', esitoRiuscito('') === true);
t('lista = riuscito', esitoRiuscito('[{"nome":"Sara"}]') === true);
t('senza ok = riuscito', esitoRiuscito('{"messaggi":[]}') === true);
t('non-stringa = non esplode', esitoRiuscito(null) === true);

// ── 2. Lo stesso nome scritto in due modi non e' due persone ──
const chat = ['Andrea Anastasi', 'Sara Triassi', 'Gianfranco Cristiano', 'Samuel Chen'];
t('slug col trattino', certezzaDestinatario('andrea-anastasi', chat).destinatario === 'Andrea Anastasi');
t('slug con underscore', certezzaDestinatario('sara_triassi', chat).destinatario === 'Sara Triassi');
t('indirizzo di profilo', certezzaDestinatario('https://www.linkedin.com/in/gianfranco-cristiano/', chat).destinatario === 'Gianfranco Cristiano');
t('nome normale', certezzaDestinatario('Sara Triassi', chat).destinatario === 'Sara Triassi');
t('minuscolo', certezzaDestinatario('samuel chen', chat).destinatario === 'Samuel Chen');
t('solo cognome', certezzaDestinatario('Triassi', chat).certo === true);

// ── E il criterio NON si e' allentato ──
t('sconosciuto resta no', certezzaDestinatario('Mario Rossi', chat).certo === false);
t('senza elenco resta no', certezzaDestinatario('Sara Triassi', null).certo === false);
t('omonimi restano no', certezzaDestinatario('Anna', ['Anna Bianchi', 'Anna Verdi']).certo === false);
t('omonimi elencano i nomi', (certezzaDestinatario('Anna', ['Anna Bianchi', 'Anna Verdi']).candidati || []).length === 2);
t('vuoto resta no', certezzaDestinatario('', chat).certo === false);
t('solo punteggiatura resta no', certezzaDestinatario('---', chat).certo === false);
t('numero passa', certezzaDestinatario('+393331234567', chat).come === 'numero');

// La coda dello slug LinkedIn
t('slug con coda id', certezzaDestinatario('andrea-anastasi-8732001b2', chat).destinatario === 'Andrea Anastasi');
t('url completo con coda', certezzaDestinatario('https://www.linkedin.com/in/andrea-anastasi-8732001b2/', chat).destinatario === 'Andrea Anastasi');
t('cifra a meta non si tocca', certezzaDestinatario('sara-triassi', chat).destinatario === 'Sara Triassi');
t('nome tutto cifre resta no', certezzaDestinatario('12345678901', chat).come === 'numero');

t('slug non e un numero', certezzaDestinatario('andrea-anastasi-8732001b2', chat).come !== 'numero');
t('numero vero passa', eUnNumero('+39 333 123 4567') === true);
t('numero con parentesi passa', eUnNumero('(02) 1234567') === true);
t('slug non e numero', eUnNumero('andrea-anastasi-8732001b2') === false);
t('nome corto non e numero', eUnNumero('Sara') === false);


// ── 3. L'invito LinkedIn passa dalle regole, come il messaggio ──
const fs = require('fs'), os = require('os'), path = require('path');
const handlers = require('../modules/tools/handlers');
const { TOOL_SCOPES } = require('../modules/supermario');

t('linkedin_connect e nello scope communicate', (TOOL_SCOPES.communicate || []).includes('linkedin_connect'));
t('google_search e nello scope communicate', (TOOL_SCOPES.communicate || []).includes('google_search'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cobra-'));
  // Il ponte vero: bridgeCommand, non piu' extRelay.
  let chiamate = 0, registrato = null; const tutte = [];
  const ctx = {
    dataDir: tmp, session: {},
    emitReasoning() {}, log() {}, wsBroadcast() {},
    isBridgeReady: () => true,
    // Si annotano TUTTE le chiamate: dopo l'invito parte anche lo screenshot,
    // e tenendo solo l'ultima si finirebbe a controllare quello.
    bridgeCommand: async (comando, args) => {
      chiamate++; tutte.push({ comando, args });
      if (comando === 'linkedin_collegati') registrato = { comando, args };
      return { result: { ok: true, a: 'Brandon Dvorak', url: args.url, confermato: true } };
    },
  };

  const senzaUrl = JSON.parse(await handlers.linkedin_connect({}, ctx));
  t('invito senza destinatario = rifiutato', senzaUrl.ok === false && chiamate === 0);

  const esito = JSON.parse(await handlers.linkedin_connect(
    { url: 'https://www.linkedin.com/in/brandon-dvorak/', note: 'ciao boss' }, ctx));
  t('invito valido parte', esito.ok === true);
  t('passa dal ponte giusto', registrato && registrato.comando === 'linkedin_collegati');
  t('la nota arriva all estensione', registrato && registrato.args.nota === 'ciao boss');

  const reg = path.join(tmp, 'invii_linkedin.json');
  t('l invito finisce nel registro', fs.existsSync(reg) && /brandon/i.test(JSON.stringify(require(reg))));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`test-esito-e-nomi: ${ok} passati, ${ko} falliti`);
  process.exit(ko ? 1 : 0);
})();
