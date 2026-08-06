// modules/collega/collega.js — Il Collega: parla con Luca, consegna gli
// incarichi all'Esecutore, giudica quello che torna indietro.
//
// IL CICLO
//
//   Luca → Collega → (basta lui?) → risposta
//                  → (serve lavoro?) → INCARICO → Esecutore
//                                          ↓
//                                    risultato + prove
//                                          ↓
//                              verdetto automatico sui criteri
//                                          ↓
//                     Collega: accetta / insiste sul buco / torna da Luca
//
// COSA FA RISPETTARE IL CODICE (non il modello)
//
//   - il numero di insistenze ha un tetto: dopo, si torna da Luca. Un collega
//     che riprova all'infinito senza dire niente è peggio di uno che ammette.
//   - l'insistenza deve nominare il buco, e il buco lo calcola l'Incarico
//     confrontando il risultato coi criteri: non è il modello a decidere se
//     ha lavorato bene.
//   - se il Collega propone un incarico non verificabile, si lavora lo stesso
//     ma senza fingere che ci sia un controllo: l'assenza viene registrata.

const { Incarico } = require('./incarico');
const { promptIncarico, promptValutazione } = require('./prompt');

// Due giri di insistenza. Al terzo buco identico non è più un intoppo: è un
// limite reale, e va detto invece di essere ritentato.
const MASSIME_INSISTENZE = 2;

/**
 * Estrae l'oggetto JSON da una risposta del modello.
 * I modelli infilano volentieri i delimitatori di codice o una frase prima:
 * pretendere JSON puro e fallire su una virgoletta significa buttare via un
 * lavoro corretto per un dettaglio di forma.
 */
function leggiJson(testo) {
  if (!testo) return null;
  let s = String(testo).trim();
  const recinto = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (recinto) s = recinto[1].trim();
  const apre = s.indexOf('{');
  const chiude = s.lastIndexOf('}');
  if (apre === -1 || chiude <= apre) return null;
  try { return JSON.parse(s.substring(apre, chiude + 1)); } catch { /* si prova a ripulire */ }
  // Ultimo tentativo: virgole finali prima di una parentesi
  try { return JSON.parse(s.substring(apre, chiude + 1).replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

/**
 * La lingua serve alla voce: un codice sbagliato farebbe leggere la frase con
 * la fonetica di un'altra lingua, oppure fallire la sintesi mentre l'utente
 * aspetta di sentirla. Nel dubbio si torna all'italiano.
 */
function normalizzaLingua(valore) {
  const v = String(valore || '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(v) ? v : 'it';
}

class Collega {
  /**
   * @param {function} chiamaModello  async (systemPrompt, messaggi) => testo
   * @param {function} log
   */
  constructor(chiamaModello, log = () => {}) {
    this.chiamaModello = chiamaModello;
    this.log = log;
  }

  /**
   * Primo passaggio: Luca ha scritto qualcosa.
   * @returns {{modo:'conversazione'|'proposta'|'incarico', risposta:string, incarico?:Incarico, avvisi?:string[]}}
   */
  async ascolta(messaggio, { memoria = '', storico = [] } = {}) {
    const messaggi = [...storico, { role: 'user', content: String(messaggio || '') }];
    let grezzo;
    try {
      grezzo = await this.chiamaModello(promptIncarico(memoria), messaggi);
    } catch (e) {
      // Risposta vuota di proposito: chi chiama deve proseguire con
      // l'Esecutore, non consegnare all'utente il messaggio d'errore.
      this.log(`[Collega] Non ho potuto ragionare sulla richiesta: ${e.message}`);
      return { modo: 'conversazione', risposta: '', errore: e.message };
    }

    let dati = leggiJson(grezzo);
    if (!dati) {
      // Un tentativo di recupero: al modello si rimanda la sua stessa risposta
      // chiedendo di riformularla nel formato dovuto. Costa una chiamata,
      // salva il turno.
      this.log('[Collega] Risposta non strutturata: chiedo la riformulazione');
      try {
        const secondo = await this.chiamaModello(
          promptIncarico(memoria) + '\n\nATTENZIONE: la tua risposta precedente non era JSON. '
            + 'Riformula ESATTAMENTE la stessa sostanza nel formato JSON richiesto, senza testo attorno.',
          [...messaggi, { role: 'assistant', content: String(grezzo || '') },
           { role: 'user', content: 'Riformula in JSON.' }]);
        dati = leggiJson(secondo);
      } catch (_) { /* si passa oltre */ }
    }
    if (!dati) {
      // Due risposte fuori formato: il Collega si fa da parte, ma il lavoro
      // NON sparisce. È già successo: una richiesta di lavoro degradata a
      // conversazione è stata "risposta" a parole e mai eseguita — il peggior
      // esito possibile, perché sembra un rifiuto senza esserlo.
      this.log('[Collega] Formato non recuperato: mi faccio da parte, il lavoro prosegue per la via diretta');
      return { modo: 'passa_oltre', risposta: '' };
    }

    const risposta = String(dati.risposta || '').trim();
    const lingua = normalizzaLingua(dati.lingua);

    // PROPOSTA — la domanda che non butta via il lavoro.
    //
    // Prima esistevano solo due strade: chiacchierare (e perdere l'incarico
    // appena pensato) oppure partire (e rischiare dieci minuti buttati su
    // un'ipotesi sbagliata). Il modello sceglieva sempre la seconda, ed era
    // razionale: chiedere gli costava tutto il lavoro preparato. Da qui
    // l'impressione di un collega che non è un collega — esegue e basta,
    // non discute, non guida.
    //
    // Qui l'incarico c'è ma non parte: resta in sospeso. Se Luca risponde
    // — anche solo "vai" — riparte da lì con la sua risposta dentro.
    if (dati.modo === 'proposta') {
      const proposto = dati.incarico ? new Incarico(dati.incarico) : null;
      if (proposto && proposto.avvisi.length) this.log(`[Collega] Criteri scartati nella proposta: ${proposto.avvisi.join('; ')}`);
      return { modo: 'proposta', risposta, lingua, incarico: proposto || undefined };
    }

    if (dati.modo !== 'incarico' || !dati.incarico) {
      return { modo: 'conversazione', risposta, lingua };
    }

    const incarico = new Incarico(dati.incarico);
    if (incarico.avvisi.length) this.log(`[Collega] Criteri scartati: ${incarico.avvisi.join('; ')}`);

    if (!incarico.valido()) {
      // Si lavora comunque — rifiutarsi non aiuterebbe Luca — ma senza far
      // credere che ci sia una verifica che non c'è.
      this.log('[Collega] Incarico senza criteri verificabili: il risultato non sarà controllato dal codice');
      return { modo: 'incarico', risposta, lingua, incarico, senzaVerifica: true, avvisi: incarico.avvisi };
    }
    return { modo: 'incarico', risposta, lingua, incarico, senzaVerifica: false, avvisi: incarico.avvisi };
  }

  /**
   * La strada non porta da nessuna parte: se ne cerca un'altra.
   *
   * Non è arrendersi e non è consegnare meno. È tornare alla domanda di
   * partenza — cosa voleva davvero — e chiedersi come ci si arriva per un
   * altro verso: un'altra fonte, un altro tipo di soluzione, oppure la cosa
   * più vicina all'obiettivo scelta col criterio di chi paga.
   *
   * @returns {{istruzione:string, obiettivo:string, avviso:string}|null}
   */
  async ripensa(incarico, valutazione, esito = {}) {
    const sistema = [
      'Sei il capo di gabinetto di Luca. Un lavoro che avevi ordinato non è riuscito,',
      'e riprovare allo stesso modo non ha spostato niente: manca esattamente quello',
      'che mancava prima. Non è mancata fatica, è la strada.',
      '',
      'Il tuo compito adesso è UNO: trovare un altro modo di risolvere LO STESSO',
      'problema di Luca. In ordine di preferenza:',
      '  a) un\'altra via che lo risolve per intero (altra fonte, altro tipo di',
      '     soluzione, altro modo di ottenere lo stesso risultato);',
      '  b) la cosa più vicina all\'obiettivo, scelta come la sceglierebbe chi paga:',
      '     la più logica, la più economica, il miglior rapporto costo/risultato;',
      '  c) se davvero non c\'è nulla, dirlo con quello che si è raccolto.',
      '',
      'Non ripetere l\'ordine di prima con parole diverse: quello è già fallito.',
      'Sii concreto e operativo: indirizzi, fonti, mosse. Chi esegue ha un browser,',
      'può leggere pagine e scrivere file; non può prenotare, pagare, entrare in',
      'aree riservate né compilare form sui siti esterni.',
      '',
      'Rispondi SOLO con JSON, senza testo attorno:',
      '{ "istruzione": "l\'ordine operativo nuovo, concreto, per chi esegue",',
      '  "obiettivo": "l\'obiettivo riformulato in una frase",',
      '  "avviso": "una riga per Luca: perché cambi strada e cosa fai adesso" }',
    ].join('\n');

    const contesto = [
      `Obiettivo originale: ${incarico.obiettivo}`,
      `Cosa manca, dopo due tentativi: ${(valutazione.mancanze || []).join('; ')}`,
      `Pagine già aperte senza risultato: ${(esito.pagine || []).slice(0, 12).map(p => p.url || p).join(', ') || 'nessuna'}`,
      `Testo ottenuto finora (estratto): ${String(esito.testo || '').slice(0, 1200)}`,
    ].join('\n');

    let grezzo;
    try {
      grezzo = await this.chiamaModello(sistema, [{ role: 'user', content: contesto }]);
    } catch (e) {
      this.log(`[Collega] Non ho potuto cercare un'altra strada: ${e.message}`);
      return null;
    }
    const dati = leggiJson(grezzo);
    if (!dati || !dati.istruzione) {
      this.log('[Collega] La strada alternativa non è arrivata in forma usabile');
      return null;
    }
    return {
      istruzione: String(dati.istruzione).trim(),
      obiettivo: String(dati.obiettivo || incarico.obiettivo).trim(),
      avviso: String(dati.avviso || '').trim(),
    };
  }

  /**
   * Secondo passaggio: l'Esecutore ha finito. Il verdetto sui criteri lo dà
   * l'Incarico; qui si decide cosa farne.
   *
   * @returns {{decisione:'consegna'|'insisti', valutazione, istruzione?:string}}
   */
  giudica(incarico, esito, sessione = {}, insistenzeFatte = 0, mancanzePrecedenti = null, stradeCambiate = 0) {
    if (!incarico || typeof incarico.valuta !== 'function') {
      return { decisione: 'consegna', valutazione: null, motivo: 'nessun criterio da verificare' };
    }
    const valutazione = incarico.valuta(esito, sessione);

    if (valutazione.soddisfatto) {
      return { decisione: 'consegna', valutazione };
    }

    // ── FATICA o POSSIBILITÀ: la distinzione che fa risparmiare le ore ──
    //
    // Insistere serve quando è mancata la fatica: una fonte lenta, un giro
    // storto, si riprova e viene. Non serve a niente quando è mancata la
    // possibilità: la cosa com'è chiesta non esiste, o non si ottiene con
    // gli strumenti che ci sono. Lì insistere è tempo buttato, e prima si
    // buttava davvero — due giri identici e poi una consegna monca.
    //
    // Il segnale è verificabile senza chiedere niente a nessuno: se dopo un
    // tentativo manca ESATTAMENTE quello che mancava prima, non è sfortuna,
    // è la strada sbagliata.
    const stesseMancanze = Array.isArray(mancanzePrecedenti)
      && mancanzePrecedenti.length > 0
      && mancanzePrecedenti.length === valutazione.mancanze.length
      && mancanzePrecedenti.every((m, i) => m === valutazione.mancanze[i]);

    if (stesseMancanze && stradeCambiate < 1) {
      this.log('[Collega] Il tentativo non ha spostato niente: non è fatica che manca, è la strada. Ne cerco un\'altra');
      return { decisione: 'cambia_strada', valutazione };
    }

    if (insistenzeFatte >= MASSIME_INSISTENZE) {
      // Il tetto è del codice. Un modello convinto di potercela fare
      // riproverebbe all'infinito, e Luca resterebbe ad aspettare.
      this.log(`[Collega] Insistenze esaurite (${insistenzeFatte}): consegno quello che c'è e lo dico`);
      return { decisione: 'consegna', valutazione, esaurite: true };
    }
    return {
      decisione: 'insisti',
      valutazione,
      istruzione: incarico.istruzioneInsistenza(valutazione),
    };
  }

  /**
   * Terzo passaggio: raccontare a Luca com'è andata.
   * Il verdetto entra nel prompt come fatto acquisito, non come opinione da
   * discutere: così il Collega non può dichiarare riuscito ciò che non lo è.
   */
  async commenta(incarico, valutazione, esito, { memoria = '', esaurite = false } = {}) {
    const verdetto = valutazione
      ? [
        `Criteri soddisfatti: ${valutazione.soddisfatti} su ${valutazione.totale}.`,
        ...valutazione.esiti.map(e => `- ${e.soddisfatto ? 'OK' : 'MANCA'}: ${e.dettaglio}`),
        esaurite ? 'Sono già stati fatti due tentativi di completamento: non se ne fanno altri senza che Luca decida.' : '',
      ].filter(Boolean).join('\n')
      : 'Non erano stati fissati criteri verificabili: il risultato non è stato controllato dal codice.';

    const contenuto = [
      `OBIETTIVO: ${incarico?.obiettivo || '(non dichiarato)'}`,
      `\nVERDETTO AUTOMATICO (fatto, non opinione):\n${verdetto}`,
      `\nRISULTATO DELL'ESECUTORE:\n${String(esito?.testo || '').substring(0, 6000)}`,
      Array.isArray(esito?.file) && esito.file.length ? `\nFILE PRODOTTI: ${esito.file.map(f => f.filename).join(', ')}` : '',
      Array.isArray(esito?.pagine) && esito.pagine.length ? `\nPAGINE APERTE: ${esito.pagine.slice(0, 12).map(p => p.url || p).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    let grezzo;
    try {
      grezzo = await this.chiamaModello(promptValutazione(memoria), [{ role: 'user', content: contenuto }]);
    } catch (e) {
      this.log(`[Collega] Non ho potuto commentare il risultato: ${e.message}`);
      return { risposta: String(esito?.testo || ''), proposta: null, errore: e.message };
    }
    const dati = leggiJson(grezzo);
    if (!dati) return { risposta: String(grezzo || '').trim(), proposta: null, lingua: 'it' };
    return {
      risposta: String(dati.risposta || '').trim(),
      proposta: dati.proposta ? String(dati.proposta).trim() : null,
      lingua: normalizzaLingua(dati.lingua),
    };
  }
}

module.exports = { Collega, leggiJson, normalizzaLingua, MASSIME_INSISTENZE };
