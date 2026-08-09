#!/usr/bin/env node
// tests/test-voce-e-ostacoli.js — Due capacità che c'erano e non si potevano usare.
//
// Prova fisica del 6 agosto 2026 sull'interfaccia:
//
//   1. LE VOCI. Il server conosce 250 voci in 16 lingue (/api/tts/voices) e
//      accetta già un parametro "voce" nella sintesi. Nell'interfaccia
//      c'erano solo un interruttore e un cursore per la velocità: nessun
//      modo di sceglierne una. Duecentocinquanta voci irraggiungibili.
//
//   2. IL BANNER DEI COOKIE. Su tmwe.it è rimasto a schermo dopo TRE
//      tentativi di rimozione, e nel registro si leggeva tre volte "Tolgo di
//      mezzo quello che copre la pagina" mentre non veniva tolto niente.
//      Causa: la ricerca del pulsante saltava gli elementi con
//      offsetParent === null considerandoli invisibili. Ma un elemento
//      position:fixed ha SEMPRE offsetParent nullo — è così che funziona il
//      posizionamento fisso — e i banner dei cookie sono fissi per
//      definizione. Il controllo escludeva esattamente i pulsanti da premere.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const ui = fs.readFileSync('public/index.html', 'utf8');
const ext = require('./_estensione').sorgenteEstensione();

console.log('\n=== LE VOCI SI SCELGONO, I BANNER SI TOLGONO ===');

// ── Qui c'erano due sezioni che difendevano il menu delle 250 voci ──
//
// Erano verdi, e proteggevano la causa vera della voce sbagliata: la scelta
// finiva in localStorage e il client la rimandava al server a OGNI sintesi,
// scavalcando la voce dell'agente. Bastava aver toccato quel menu una volta
// per sentire per sempre una voce che non e' quella di COBRA, e nessuna
// correzione lato server poteva rimediare — il client sovrascriveva dopo.
//
// Seconda volta oggi che un test verde difende un comportamento sbagliato.
// La verifica di adesso sta in tests/test-una-voce-sola.js e difende la regola
// giusta: un controllo solo, e la voce appartiene all'agente.

sezione('Una voce sola, e appartiene all agente');
{
  ok('il menu delle 250 voci non c e piu', !/id="sceltaVoce"/.test(ui));
  ok('e non le chiede piu al server', !/api\/tts\/voices/.test(ui));
  ok('la scelta vecchia viene ripulita', /removeItem\('cobra_voce'\)/.test(ui));
  ok('chi parla si sceglie dal menu degli agenti', /api\/agenti\/scegli/.test(ui));
  ok('ogni lingua ha il suo fondo', /\.agente-voce\[data-lingua="es"\]/.test(ui));
}

sezione('Il difetto che lasciava i banner a schermo');
{
  // Il difetto non era in un punto solo: lo stesso controllo sbagliato stava
  // in SETTE posti — il risolutore degli elementi, l'elenco dei link, quello
  // dei pulsanti, i campi dei moduli, i cliccabili, l'attesa di scomparsa e
  // la rimozione degli ostacoli. Cioè COBRA non vedeva NIENTE dentro
  // un'intestazione fissa, un modale o un widget flottante.
  const usi = (ext.match(/offsetParent/g) || []).length;
  const inCommento = (ext.match(/\/\/[^\n]*offsetParent/g) || []).length;
  ok('offsetParent non decide piu la visibilita in nessun punto',
     usi === inCommento, `${usi} usi, ${inCommento} nei commenti`);
  ok('la misura e lo spazio occupato', /getBoundingClientRect\(\)\.width \|\| 0\) >= 2/.test(ext));
  ok('si guarda se occupa spazio davvero', /r\.width < 2 \|\| r\.height < 2/.test(ext));
  ok('e se e nascosto per stile', /st\.display !== 'none' && st\.visibility !== 'hidden'/.test(ext));
  ok('anche l opacita zero conta come invisibile', /Number\(st\.opacity\) !== 0/.test(ext));
  ok('il motivo resta scritto per chi legge domani', /position:fixed ha SEMPRE offsetParent nullo/.test(ext));

  // La regola vera, eseguita su un elemento fisso come quelli dei banner
  // L'estrazione si ferma sulla FINE della funzione, non su una certa
  // indentazione: la regola vive in piu' punti dell'estensione (il risolutore
  // degli elementi, il pulsante "Collegati", il riquadro della nota) e non
  // tutti stanno annidati allo stesso livello. Legandosi agli spazi, la prova
  // si portava dentro mezzo file e falliva per un motivo che non c'entrava.
  const corpo = ext.match(/const siVede = \(el\) => \{[\s\S]*?catch \(_\) \{ return false; \}\s*\};/)[0];
  const siVede = new Function('getComputedStyle', corpo + ' return siVede;')(
    (el) => el._stile || { display: 'block', visibility: 'visible', opacity: '1' });
  const bottoneFisso = { offsetParent: null, getBoundingClientRect: () => ({ width: 90, height: 32 }) };
  ok('un pulsante dentro un banner fisso ora si vede', siVede(bottoneFisso) === true);
  const nascosto = { _stile: { display: 'none', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 90, height: 32 }) };
  ok('ma quello davvero nascosto no', siVede(nascosto) === false);
  const senzaSpazio = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  ok('e nemmeno quello che non occupa spazio', siVede(senzaSpazio) === false);
}

sezione('Un banner d angolo non deve coprire mezzo schermo per essere tolto');
{
  ok('chi si dichiara cookie o consenso ha una soglia bassa',
     /cookie\|consent\|gdpr\|privacy\|onetrust\|cookiebot\|iubenda\|didomi\|quantcast/.test(ext));
  ok('due per cento invece di venticinque', /siDichiara \? 0\.02 : 0\.25/.test(ext));
  ok('e il caso vero e citato', /tmwe\.it sta in basso a destra/.test(ext));
}

sezione('Anche i banner dentro un riquadro annidato');
{
  ok('si prova a entrare negli iframe', /fr\.contentDocument/.test(ext));
  ok('sapendo che da un altro dominio non si puo', /altro dominio: non si entra/.test(ext));
  ok('e le parole riconosciute sono piu di prima', /'accetta tutti','accept all','accetta tutto'/.test(ext));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
