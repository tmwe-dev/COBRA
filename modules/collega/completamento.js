// modules/collega/completamento.js — Chi ha il diritto di dire "fatto".
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// L'8 agosto COBRA ha dichiarato riuscite quattro cose che non erano
// successe. Non per un difetto solo: per quattro difetti diversi, in quattro
// file diversi, tutti della stessa forma — qualcuno decideva che una cosa era
// andata bene guardando qualcosa che non era il risultato.
//
//   `!rawResult.includes('"error"')`   uno strumento che risponde {"ok":false}
//                                      non contiene la parola "error"
//   `task.status = 'completed'`        scritto dopo il ciclo, comunque vada
//   `ok: true` fisso in fill_form      tre campi su cinque = "riuscito"
//   step senza strumento = ok: true    un job di sole frasi risulta fatto
//
// Ogni volta la correzione e' stata giusta e locale. Ma la quinta volta
// succedera' in un quinto posto, perche' il problema non e' nessuno di quei
// quattro punti: e' che il diritto di dichiarare finito un lavoro era sparso
// ovunque.
//
// ── LA REGOLA ──
//
// L'Esecutore puo' dire "io credo di aver finito". Non puo' dire "finito".
// La differenza non e' formale: la prima e' un'osservazione, la seconda e' un
// verdetto — e un verdetto lo emette chi ha guardato le prove.
//
// Qui non si guarda cosa dice il modello. Si guardano:
//
//   i criteri      cosa il Collega aveva stabilito che dovesse esistere
//   il cantiere    cosa e' stato davvero raccolto
//   i file         cosa e' stato davvero prodotto
//   i passi        cosa e' stato davvero eseguito, con la prova
//
// La frase dell'Esecutore entra come UN dato fra gli altri, e vale zero
// quando gli altri dicono il contrario.
//
// ── PERCHÉ NON È UN SESTO MOTORE ──
//
// In COBRA esistono gia' cinque strutture che seguono un lavoro: Processo,
// Cantiere, Incarico, missioni, tasks. Aggiungerne una sesta sarebbe
// esattamente la malattia che abbiamo passato la giornata a curare — due
// implementazioni della stessa cosa, e vince sempre la piu' comoda.
//
// Questo NON e' un motore. Non ha stato, non ricorda niente, non decide cosa
// fare dopo. E' una funzione pura: prende le prove che gli altri hanno gia'
// raccolto e restituisce un verdetto. Chi vuole dire "fatto" passa di qui, e
// non c'e' un secondo modo di dirlo.
// ══════════════════════════════════════════════════════════════════════

/** Gli unici esiti possibili. Non ce ne sono altri, e non se ne aggiungono. */
const STATI = {
  COMPLETO: 'completo',        // i criteri sono soddisfatti: si consegna
  MANCA: 'manca',              // manca qualcosa di recuperabile: si riprende
  SERVE_LUCA: 'serve_luca',    // serve una persona: password, conferma, scelta
  IMPOSSIBILE: 'impossibile',  // il dato non esiste: si chiude dicendolo
};

/**
 * Una dichiarazione di successo che non poggia su niente.
 *
 * "Ho completato la ricerca", "Operazione completata", "Fatto": frasi che il
 * modello produce per abitudine linguistica, non perche' abbia guardato.
 * Entrano qui come indizio, mai come prova.
 */
// I verbi che dichiarano un'azione COMPIUTA. Al participio passato, perche' e'
// li' che sta la differenza: "ho inviato" e' un fatto, "posso inviare" no,
// "non sono riuscito a inviare" nemmeno.
//
// "inviato" e "mandato" mancavano, e sono le due parole esatte con cui l'8
// agosto e' stato annunciato un messaggio mai partito: "La richiesta di
// collegamento e' stata inviata correttamente".
const _SI_DICHIARA_FATTO = new RegExp([
  '\\b(?:completat|terminat|finit|conclus|eseguit|effettuat)[oaie]\\b',
  '\\b(?:inviat|mandat|spedit|trasmess|consegnat)[oaie]\\b',
  '\\b(?:creat|prodott|generat|salvat|scritt|aggiunt)[oaie]\\b',
  '\\bfatto\\b', '\\bpronto\\b', '\\be\\W? partit[oa]\\b',
  '\\b(?:done|completed|sent|created|saved)\\b',
].join('|'), 'i');

function _dichiaraDiAverFinito(testo) {
  return _SI_DICHIARA_FATTO.test(String(testo || ''));
}

/**
 * Il verdetto.
 *
 * @param {object} p
 * @param {object} p.incarico      l'incarico del Collega (puo' mancare)
 * @param {object} p.valutazione   l'esito di Incarico.valuta(): { soddisfatto, esiti[] }
 * @param {object} p.cantiere      cosa e' stato raccolto
 * @param {array}  p.files         i file prodotti nel turno
 * @param {array}  p.passi         i passi eseguiti, con il loro esito
 * @param {string} p.dettoDalModello  quello che l'Esecutore afferma
 * @returns {{stato, perche, mancano, cosaFare, dichiarazioneSmentita}}
 */
function decidi({
  incarico = null,
  valutazione = null,
  cantiere = null,
  files = [],
  passi = [],
  dettoDalModello = '',
} = {}) {
  const mancano = [];

  // ── 1. I passi con una prova ──
  //
  // Un passo senza prova non e' un passo eseguito: e' un'intenzione. E' la
  // regola del motore Processo, applicata a chiunque passi di qui.
  const passiFalliti = (passi || []).filter(p => p && p.ok === false);
  const passiSenzaProva = (passi || []).filter(p => p && p.senzaProva === true);
  for (const p of passiFalliti) {
    mancano.push(`passo ${p.step || p.id || '?'} non riuscito: ${p.motivo || p.error || p.tool || 'senza motivo'}`);
  }
  for (const p of passiSenzaProva) {
    mancano.push(`passo ${p.step || p.id || '?'} non ha prodotto nessuna prova: descrive un lavoro, non lo fa`);
  }

  // ── 2. I criteri del Collega ──
  //
  // Questi non sono un'opinione: li ha stabiliti il Collega PRIMA che il
  // lavoro cominciasse, e li verifica il codice confrontandoli col cantiere.
  const esiti = (valutazione && valutazione.esiti) || [];
  for (const e of esiti) {
    if (e && e.soddisfatto === false) {
      mancano.push(e.mancante || e.dettaglio || `criterio non soddisfatto: ${e.tipo}`);
    }
  }

  // ── 3. Un lavoro che doveva produrre qualcosa, e non ha prodotto niente ──
  //
  // Il caso limite che passava da tutte le maglie: nessun criterio verificabile,
  // nessun passo fallito, e nemmeno un file o una riga raccolta. Formalmente
  // niente e' andato storto. Sostanzialmente non e' successo niente.
  const righeRaccolte = cantiere && typeof cantiere.quante === 'function'
    ? cantiere.quante() : (cantiere && Array.isArray(cantiere.voci) ? cantiere.voci.length : 0);
  const haProdotto = (files && files.length > 0) || righeRaccolte > 0
    || (passi || []).some(p => p && p.ok === true);

  const eraUnLavoro = !!(incarico && (incarico.criteri || []).length) || (passi || []).length > 0;
  if (eraUnLavoro && !haProdotto) {
    mancano.push('non risulta prodotto niente: nessun file, nessuna riga raccolta, nessun passo riuscito');
  }

  // ── 4. Il verdetto ──
  //
  // Quello che dice il modello si guarda SOLO qui, e solo per registrare che
  // e' stato smentito: serve a Luca per capire che non e' stato ingannato per
  // caso, ed e' il segnale piu' utile che questo modulo produce.
  const diceDiAverFinito = _dichiaraDiAverFinito(dettoDalModello);

  if (mancano.length === 0) {
    return {
      stato: STATI.COMPLETO,
      perche: esiti.length
        ? `${esiti.length} criteri soddisfatti`
        : 'nessun criterio da verificare, e qualcosa e\' stato prodotto',
      mancano: [],
      cosaFare: null,
      dichiarazioneSmentita: false,
    };
  }

  return {
    stato: STATI.MANCA,
    perche: mancano.length === 1
      ? `manca una cosa: ${mancano[0]}`
      : `mancano ${mancano.length} cose`,
    mancano,
    // La frase che va all'Esecutore quando riprende. "NON ricominciare" e' la
    // parte che conta: senza, rifa' tutto da capo e con otto soggetti da
    // raccogliere non arriva mai in fondo.
    cosaFare: 'NON ricominciare da capo: quello che c\'e\' resta. '
      + 'Completa SOLO queste cose:\n' + mancano.map(m => `- ${m}`).join('\n'),
    dichiarazioneSmentita: diceDiAverFinito,
  };
}

/**
 * L'unica porta per dire "fatto".
 *
 * Chi vuole scrivere `status = 'completed'` chiama questa e ubbidisce. Non
 * esiste un secondo modo, ed e' il punto: il diritto di dichiarare finito un
 * lavoro sta in una funzione sola, che si puo' leggere in due minuti.
 */
function puoDirsiFatto(prove) {
  return decidi(prove).stato === STATI.COMPLETO;
}

module.exports = { decidi, puoDirsiFatto, STATI, _dichiaraDiAverFinito };
