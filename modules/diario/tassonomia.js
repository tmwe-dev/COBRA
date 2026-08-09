// modules/diario/tassonomia.js — Perche' una cosa non e' riuscita.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Misura del 9 agosto: negli handler ci sono 56 punti che restituiscono
// `ok:false`. Di questi, quanti dicono con un codice PERCHE' e' fallito: zero.
// Trentaquattro hanno un motivo scritto a mano, in italiano, ognuno con parole
// sue. Gli altri ventidue non dicono niente.
//
// Nel registro di produzione, 880 chiamate e 67 fallimenti: di nessuno dei 67
// si sa il motivo. Resta `ok:false`.
//
// Cosa e' costato, in concreto: `guarda_pagina` e' fallito tre volte su tre
// alla sua prima uscita vera. Per capire perche' ho dovuto incrociare quattro
// file e due endpoint — e alla fine la causa e' rimasta un sospetto. Nel
// frattempo COBRA ci aveva speso 121 secondi e Luca guardava una pagina di
// Google Voli compilata mentre gli veniva detto che non si riusciva a leggerla.
//
// ── COSA FA ──
//
// Trasforma qualunque cosa un handler restituisca in un esito con una FORMA
// SOLA, e soprattutto con un CODICE. Il codice non e' burocrazia: e' l'unica
// cosa che permette di rispondere a "questo strumento fallisce sempre allo
// stesso modo?" senza rileggere il codice.
//
// ── PERCHE' NON RISCRIVO I 56 PUNTI ──
//
// Perche' riscrivere 56 ritorni in una volta, in un sistema che oggi sbaglia
// il 19% delle chiamate, e' il modo piu' affidabile per rompere quello che
// funziona. Qui si CLASSIFICA quello che arriva, com'e' fatto adesso: gli
// handler continuano a rispondere come sanno, e il codice si deduce dalle loro
// parole. Chi vuole essere preciso puo' dichiarare `code` da subito e vince
// sulla deduzione — e' cosi' che si migra, uno alla volta, senza fermarsi.
//
// La deduzione e' una rete di sicurezza, non l'obiettivo. Ogni volta che un
// fallimento finisce in SCONOSCIUTO, e' un handler da sistemare: il numero di
// SCONOSCIUTO e' la misura di quanto siamo lontani.
// ══════════════════════════════════════════════════════════════════════

const { esitoRiuscito } = require('../utils/esito');

/**
 * Le cinque famiglie. Non sono gradi di gravita': sono CHI DEVE FARE la
 * prossima mossa, che e' l'unica cosa che serve sapere subito dopo.
 */
const FAMIGLIE = {
  TRANSIENT:  { chiFa: 'lo stesso passo',     riprovabile: true,  tipoRiprova: 'uguale',
                dice: 'è andata storta per un motivo che può passare da solo' },
  STRATEGY:   { chiFa: 'l\'Esecutore',        riprovabile: true,  tipoRiprova: 'strategia',
                dice: 'la strada era sbagliata: va cambiata, non ripetuta' },
  DEPENDENCY: { chiFa: 'un passo prima',      riprovabile: true,  tipoRiprova: 'prerequisito',
                dice: 'manca qualcosa che doveva esserci già' },
  PERMISSION: { chiFa: 'Luca',                riprovabile: false, tipoRiprova: 'nessuna',
                dice: 'serve una decisione o una credenziale di una persona' },
  IMPOSSIBLE: { chiFa: 'nessuno',             riprovabile: false, tipoRiprova: 'nessuna',
                dice: 'la cosa chiesta non si può ottenere così' },
  SCONOSCIUTO:{ chiFa: 'da capire',           riprovabile: true,  tipoRiprova: 'strategia',
                dice: 'non so dire perché: è un handler da sistemare' },
};

/**
 * I codici, con come si riconoscono dalle parole che gli handler usano oggi.
 *
 * L'ordine conta: si prende il PRIMO che corrisponde, quindi i piu' specifici
 * stanno sopra. "non ti ha mai scritto" deve vincere su "non": una regola
 * d'invio non e' un errore di rete.
 */
const CODICI = [
  // ── PERMISSION — decide una persona, non il programma ──
  { code: 'CONFERMA_RICHIESTA',  famiglia: 'PERMISSION', dove: 'sicurezza',
    dice: /pending_confirmation|serveConferma|in attesa di conferma|azione intercettata/i,
    poi: 'aspetta la risposta di Luca: non richiamare lo stesso strumento' },
  { code: 'DESTINATARIO_NON_SICURO', famiglia: 'PERMISSION', dove: 'sicurezza',
    dice: /non ti ha mai scritto|non risulta in rubrica|chi sia il destinatario|piu' di un|più di un/i,
    poi: 'chiedi a Luca quale delle persone trovate, poi riprova con quella' },
  { code: 'AZIONE_RIFIUTATA',    famiglia: 'PERMISSION', dove: 'sicurezza',
    // "non consentito" senza l'articolo: la prima versione pretendeva
    // "non è consentito" e si perdeva "Hostname o protocollo non consentito",
    // che e' esattamente come parla la whitelist.
    dice: /azione rifiutata|rejected|non consentit|url bloccato|dominio non|non autorizzato|blocked/i,
    poi: 'non insistere: riferisci a Luca cosa era bloccato e perché' },
  { code: 'CREDENZIALE_MANCANTE', famiglia: 'PERMISSION', dove: 'sicurezza',
    dice: /password|credenzial|non ho l'accesso|login richiesto|devi accedere/i,
    poi: 'chiedi a Luca di accedere: le credenziali non le maneggia COBRA' },

  // ── DEPENDENCY — manca un pezzo che doveva esserci ──
  { code: 'PONTE_ASSENTE',       famiglia: 'DEPENDENCY', dove: 'ponte',
    dice: /bridge not ready|il browser non e' collegato|il browser non è collegato|estensione non connessa/i,
    poi: 'il Chrome con l\'estensione non è agganciato: dillo a Luca, non riprovare' },
  { code: 'COMANDO_ASSENTE',     famiglia: 'DEPENDENCY', dove: 'estensione',
    dice: /unknown command|comando sconosciuto|non definit|is not defined|non implementato/i,
    poi: 'la capacità non esiste davvero nell\'estensione che gira: va segnalata, non aggirata' },
  { code: 'NON_AUTENTICATO',     famiglia: 'DEPENDENCY', dove: 'sito',
    dice: /non sei collegato|sessione scaduta|accedi a|not logged|sign in/i,
    poi: 'serve la sessione aperta sul sito: chiedi a Luca di accedere' },
  { code: 'PREREQUISITO_MANCANTE', famiglia: 'DEPENDENCY', dove: 'esecutore',
    // "Nessuna pagina caricata. Usa navigate prima." e' la frase piu' frequente
    // di tutte, e la prima versione non la vedeva: cercavo le parole che avrei
    // scritto io invece di quelle che gli handler scrivono davvero.
    dice: /nessuna pagina (caricata|attiva|aperta)|usa \w+ prima|non ho ancora guardato|non (e'|è) stato letto|prima devi|richiede che/i,
    poi: 'esegui prima il passo che manca — il motivo dice quale' },
  { code: 'FILE_ASSENTE',        famiglia: 'DEPENDENCY', dove: 'disco',
    dice: /enoent|file non trovato|no such file|non esiste il file/i,
    poi: 'il file non c\'è: controlla il percorso o crealo prima' },

  // ── TRANSIENT — può passare da sé ──
  { code: 'TEMPO_SCADUTO',       famiglia: 'TRANSIENT',  dove: 'rete',
    dice: /timeout|timed out|tempo scaduto|troppo tempo|aborted/i,
    poi: 'riprova una volta sola; se scade ancora è STRATEGY, non rete' },
  { code: 'RETE_CADUTA',         famiglia: 'TRANSIENT',  dove: 'rete',
    dice: /fetch failed|econnrefused|enotfound|network|socket hang up|econnreset/i,
    poi: 'riprova fra poco; se insiste, il sito è irraggiungibile da qui' },
  { code: 'PAGINA_NON_PRONTA',   famiglia: 'TRANSIENT',  dove: 'pagina',
    dice: /non ha finito di caricare|ancora in caricamento|still loading|not ready/i,
    poi: 'aspetta che la pagina finisca (wait_network_idle), poi riguarda' },
  { code: 'LIMITE_RAGGIUNTO',    famiglia: 'TRANSIENT',  dove: 'servizio',
    dice: /rate limit|429|quota|too many requests/i,
    poi: 'aspetta prima di ripetere, oppure cambia fonte' },

  // ── STRATEGY — la strada era sbagliata ──
  { code: 'ELEMENTO_NON_TROVATO', famiglia: 'STRATEGY',  dove: 'pagina',
    dice: /non trovato|not found|nessun elemento|zero element|selettore|selector|no match/i,
    poi: 'non ripetere lo stesso selettore: guarda la pagina e scegli fra ciò che esiste' },
  { code: 'PAGINA_VUOTA',        famiglia: 'STRATEGY',   dove: 'pagina',
    dice: /pagina vuota|nessun contenuto|contenuto vuoto|javascript|non ha caricato i prezzi|empty/i,
    poi: 'la pagina si costruisce col javascript: compila il modulo invece di leggere l\'html' },
  { code: 'BLOCCO_ANTI_ROBOT',   famiglia: 'STRATEGY',   dove: 'sito',
    dice: /captcha|anti-bot|anti bot|cloudflare|403|access denied|blocco/i,
    poi: 'il sito blocca: cambia sito, non insistere su questo' },
  { code: 'DATO_ASSENTE',        famiglia: 'STRATEGY',   dove: 'dati',
    dice: /nessun risultato|nessun dato|non ho trovato|almeno due risultati|niente da/i,
    poi: 'la fonte non aveva il dato: cambia fonte, non riformulare la stessa' },
  { code: 'STRUMENTO_SBAGLIATO', famiglia: 'STRATEGY',   dove: 'esecutore',
    // "inspect_dom_js e' read-only. Per modifiche usa mutate_dom_js" — visto
    // nella prova voli del 9 agosto. Non e' un guasto: e' lo strumento
    // sbagliato per il lavoro, e il messaggio dice gia' quale sia quello
    // giusto. Metterlo fra gli SCONOSCIUTO sarebbe sprecare un suggerimento
    // che l'handler aveva gia' scritto.
    dice: /e' read-only|è read-only|per modifiche usa|usa invece|strumento sbagliato|non e' lo strumento/i,
    poi: 'lo strumento giusto e\' quello che ti ha nominato il messaggio: chiama quello' },
  { code: 'ELEMENTO_NON_VISTO',  famiglia: 'STRATEGY',   dove: 'pagina',
    // L'estensione risponde cosi' quando l'id non e' fra quelli dell'ultimo
    // sguardo, e insieme elenca quelli che ci sono: e' un fallimento che
    // porta gia' la soluzione con se'.
    dice: /non e' fra gli elementi|non è fra gli elementi|gli elementi sono altri/i,
    poi: 'guarda di nuovo la pagina e scegli un id fra quelli che ti elenca' },
  { code: 'ARGOMENTO_SBAGLIATO', famiglia: 'STRATEGY',   dove: 'esecutore',
    dice: /manca il|non mi hai detto|argomento|parametro|richiesto:|obbligatorio/i,
    poi: 'rileggi cosa vuole lo strumento e richiamalo con l\'argomento giusto' },

  // ── IMPOSSIBLE — non si ottiene, punto ──
  { code: 'NON_OTTENIBILE',      famiglia: 'IMPOSSIBLE', dove: 'mondo',
    dice: /non e' possibile|non è possibile|impossibile|non supportat|non esiste un modo/i,
    poi: 'fermati e riferisci: continuare non cambia il risultato' },
];

/** Il testo su cui cercare: quello che l'handler ha detto, comunque l'abbia detto. */
function _parole(grezzo, eccezione) {
  const pezzi = [];
  if (eccezione) pezzi.push(String(eccezione.message || eccezione));
  if (typeof grezzo === 'string') pezzi.push(grezzo);
  else if (grezzo) { try { pezzi.push(JSON.stringify(grezzo)); } catch (_) { /* oggetto ostile */ } }
  return pezzi.join(' ⋮ ');
}

/** L'oggetto dentro il risultato, se c'era. */
function _oggetto(grezzo) {
  if (grezzo && typeof grezzo === 'object') return grezzo;
  try { const d = JSON.parse(String(grezzo || '')); return (d && typeof d === 'object') ? d : null; }
  catch (_) { return null; }
}

/**
 * Classifica un esito.
 *
 * @param {string|object} grezzo      quello che l'handler ha restituito
 * @param {Error} [eccezione]         se invece ha lanciato
 * @returns {{ok, code, reason, famiglia, layer, retryable, retry_type, suggested_next}}
 */
function classifica(grezzo, eccezione) {
  if (!eccezione && esitoRiuscito(grezzo)) {
    return { ok: true, code: 'OK', famiglia: null, retryable: false };
  }

  const d = _oggetto(grezzo);
  const testo = _parole(grezzo, eccezione);

  // Un handler che dichiara il proprio codice vince sulla deduzione: e' il
  // verso in cui vogliamo andare, e va premiato.
  if (d && d.code && typeof d.code === 'string') {
    const noto = CODICI.find((c) => c.code === d.code);
    const fam = FAMIGLIE[d.famiglia || (noto && noto.famiglia) || 'SCONOSCIUTO'] || FAMIGLIE.SCONOSCIUTO;
    return {
      ok: false, code: d.code, famiglia: d.famiglia || (noto && noto.famiglia) || 'SCONOSCIUTO',
      reason: d.reason || d.motivo || (noto && noto.dice) || '',
      layer: d.layer || (noto && noto.dove) || 'sconosciuto',
      retryable: d.retryable !== undefined ? d.retryable : fam.riprovabile,
      retry_type: d.retry_type || fam.tipoRiprova,
      suggested_next: d.suggested_next || d.cosaFare || (noto && noto.poi) || '',
      dichiarato: true,
    };
  }

  const trovato = CODICI.find((c) => c.dice.test(testo));
  const codice = trovato || { code: 'SCONOSCIUTO', famiglia: 'SCONOSCIUTO', dove: 'sconosciuto',
    poi: 'non so dire perché: guarda il diario e dai un motivo a questo handler' };
  const fam = FAMIGLIE[codice.famiglia];

  return {
    ok: false,
    code: codice.code,
    famiglia: codice.famiglia,
    // Il motivo dell'handler se c'e', altrimenti le prime parole di quello che
    // ha detto: meglio una frase grezza che nessuna frase.
    reason: (d && (d.motivo || d.reason || d.error || d.errore))
      || (eccezione && eccezione.message)
      || String(testo).replace(/\s+/g, ' ').slice(0, 200),
    layer: codice.dove,
    retryable: fam.riprovabile,
    retry_type: fam.tipoRiprova,
    suggested_next: (d && d.cosaFare) || codice.poi,
    dichiarato: false,
  };
}

module.exports = { classifica, CODICI, FAMIGLIE };
