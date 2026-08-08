// modules/collega/incarico.js — L'incarico che il Collega consegna all'Esecutore
//
// PERCHÉ ESISTE
//
// Finora il messaggio dell'utente arrivava grezzo al motore, e "fatto" era un
// giudizio che dava il modello su sé stesso. I guasti osservati il 5 agosto 2026
// vengono tutti da lì:
//
//   - richiesta di tre tratte (Milano, Madrid, Barcellona): l'Esecutore ha letto
//     davvero Barcellona e ha ricopiato quel blocco anche sotto Milano. Nessuno
//     aveva stabilito PRIMA che "tre tratte" significa tre letture distinte.
//   - la resa dopo pochi tentativi veniva riconosciuta solo dal tono della
//     risposta, e concedeva un secondo tentativo cieco: "riprova", senza sapere
//     cosa mancasse.
//
// Un incarico con criteri verificabili sposta il giudizio dal modello al codice:
// non "ho finito" ma "questi tre criteri su quattro sono soddisfatti, il quarto
// no, e manca esattamente questo".
//
// REGOLA DI FONDO
//
// I criteri sono generici e non sanno nulla del dominio. Non esiste un criterio
// "volo" o "azienda": esistono "almeno N elementi", "questi campi compilati",
// "questi soggetti coperti", "importi che risultano da una pagina letta". Il
// Collega li riempie leggendo la conversazione; il codice li verifica sempre
// allo stesso modo, che si parli di voli, fornitori o normative.

const { importiSenzaFonte, blocchiDuplicati, fontiDelTurno } = require('../security/verifica-dati');
const { verificaFormato } = require('../output/consegna');

// I formati che il sistema sa davvero produrre: html da crea_report,
// xlsx da create_file, e i formati di testo. Tutto il resto uscirebbe come
// testo grezzo con l'estensione sbagliata — un file che non si apre.
const PRODUCIBILI = ['html', 'xlsx', 'csv', 'txt', 'json', 'md'];

const TIPI = ['elementi_minimi', 'campi_obbligatori', 'soggetti_coperti', 'origine_verificabile', 'file_atteso', 'nessun_duplicato', 'formato_consegna'];

/** Righe di una tabella, o righe di testo: si valuta ciò che c'è. */
function righeDi(esito) {
  if (Array.isArray(esito?.righe) && esito.righe.length) return esito.righe;
  const testo = String(esito?.testo || '');
  return testo.split('\n').map(r => r.trim()).filter(Boolean).map(r => [r]);
}

function testoDi(esito) {
  if (esito?.testo) return String(esito.testo);
  return righeDi(esito).map(r => r.join(' ')).join('\n');
}

class Incarico {
  /**
   * @param {object} spec
   * @param {string} spec.obiettivo   cosa si deve ottenere, in una frase
   * @param {Array}  spec.criteri     [{ tipo, ...parametri }]
   * @param {Array}  spec.vincoli     cose da rispettare, in parole
   * @param {Array}  spec.fuoriAmbito cose da NON fare
   */
  constructor(spec = {}) {
    this.obiettivo = String(spec.obiettivo || '').trim();
    this.vincoli = Array.isArray(spec.vincoli) ? spec.vincoli.map(String) : [];
    this.fuoriAmbito = Array.isArray(spec.fuoriAmbito) ? spec.fuoriAmbito.map(String) : [];
    this.avvisi = [];
    this.criteri = [];

    for (const c of (Array.isArray(spec.criteri) ? spec.criteri : [])) {
      if (!c || !TIPI.includes(c.tipo)) {
        this.avvisi.push(`criterio "${c && c.tipo}" non riconosciuto, ignorato`);
        continue;
      }
      // Un criterio senza il suo parametro non e' verificabile: tenerlo
      // significherebbe far credere di controllare qualcosa che non si controlla.
      if (c.tipo === 'elementi_minimi' && !(Number(c.quanti) > 0)) {
        this.avvisi.push('elementi_minimi senza "quanti": ignorato'); continue;
      }
      if (c.tipo === 'campi_obbligatori' && !(Array.isArray(c.campi) && c.campi.length)) {
        this.avvisi.push('campi_obbligatori senza "campi": ignorato'); continue;
      }
      if (c.tipo === 'soggetti_coperti' && !(Array.isArray(c.soggetti) && c.soggetti.length)) {
        this.avvisi.push('soggetti_coperti senza "soggetti": ignorato'); continue;
      }
      if (c.tipo === 'file_atteso' && !c.estensione) {
        this.avvisi.push('file_atteso senza "estensione": ignorato'); continue;
      }
      // Promettere un formato che il sistema non sa produrre è una promessa
      // che nessuno può mantenere: l'Esecutore girerebbe due insistenze e un
      // cambio di strada per un .pdf che non uscirà mai. Meglio consegnare
      // l'html, che dall'anteprima diventa PDF con Stampa → Salva come PDF.
      if (c.tipo === 'file_atteso') {
        const est = String(c.estensione).replace(/^\./, '').toLowerCase();
        if (!PRODUCIBILI.includes(est)) {
          this.avvisi.push(`file_atteso ".${est}": non è un formato producibile, chiedo un .html`);
          this.criteri.push({ tipo: 'file_atteso', estensione: 'html' });
          continue;
        }
      }
      // ── Un invio non si verifica contando parole in una frase ──
      //
      // Il 7 agosto, per "manda un messaggio WhatsApp a Jose", il Collega ha
      // scritto il criterio { campi_obbligatori: [numero_telefono,
      // testo_messaggio] }. Quel criterio controlla se quelle parole
      // COMPAIONO nel testo della risposta — e in un "fatto, mandato" non
      // compariranno mai. Quindi bocciava, insisteva, e per due giri diceva
      // all'Esecutore che gli mancava un numero di telefono.
      //
      // Da li' e' venuto tutto il resto: il modello ha smesso di usare
      // whatsapp_scrivi (che il numero non lo vuole, gli basta il nome), si e'
      // messo a cercare un numero, ed e' ripiegato sul vecchio whatsapp_send.
      // Per ore ho creduto che fosse il modello a rifiutare: era il suo
      // supervisore a dirgli che il lavoro non era finito.
      //
      // Su un invio l'unica domanda vera e' "il messaggio e' partito?", e la
      // risposta sta nel registro degli invii, non nella prosa.
      if (c.tipo === 'campi_obbligatori' && this._eUnInvio()) {
        this.avvisi.push('campi_obbligatori non si applica a un invio: '
          + 'un messaggio o parte o non parte, non ha "campi" nella risposta');
        continue;
      }
      this.criteri.push({ ...c });
    }

    // Un invio senza criteri resta un incarico valido: il criterio e' l'invio.
    if (this.criteri.length === 0 && this._eUnInvio()) {
      this.criteri.push({ tipo: 'elementi_minimi', quanti: 1 });
    }
  }

  /** L'obiettivo e' mandare un messaggio a una persona? */
  _eUnInvio() {
    return /\b(manda|mandare|invia|inviare|scriv[ie]|contatta|contattare|rispondi)\b/i.test(this.obiettivo)
      && /\b(whatsapp|linkedin|messaggio|mail|email)\b/i.test(this.obiettivo);
  }

  /** Un incarico senza obiettivo o senza criteri non e' un incarico. */
  valido() {
    return this.obiettivo.length >= 5 && this.criteri.length > 0;
  }

  /**
   * Verifica l'esito contro i criteri. Non giudica lo stile: guarda solo se
   * quello che era stato chiesto c'e' o non c'e'.
   *
   * @param {object} esito   { testo?, righe?, file?: [{filename}] }
   * @param {object} sessione  per risalire alle pagine lette nel turno
   */
  valuta(esito = {}, sessione = {}) {
    // Il cantiere e' la verita' su cosa e' stato raccolto: senza, i criteri
    // giudicano la frase di accompagnamento invece del lavoro.
    const cantiere = sessione && sessione.cantiere;
    const righe = righeDi(esito);
    const testo = testoDi(esito);
    const testoMinuscolo = testo.toLowerCase();
    const files = Array.isArray(esito.file) ? esito.file : [];
    const esiti = [];

    for (const c of this.criteri) {
      switch (c.tipo) {
        case 'elementi_minimi': {
          // Si contano le righe che portano un contenuto, non le intestazioni
          const utili = righe.filter(r => r.join('').trim().length > 3).length;
          esiti.push({
            tipo: c.tipo, soddisfatto: utili >= c.quanti,
            dettaglio: `${utili} elementi su ${c.quanti} richiesti`,
            mancante: utili >= c.quanti ? null : `mancano ${c.quanti - utili} elementi`,
          });
          break;
        }
        case 'campi_obbligatori': {
          // ── Si giudica il LAVORO, non il messaggio in chat ──
          //
          // Il 7 agosto il verdetto diceva "non compaiono i campi: sito, email"
          // mentre nel foglio consegnato c'erano tutti e otto i siti e tutte le
          // email. Il criterio guardava la frase di accompagnamento invece dei
          // dati raccolti — e bocciava un lavoro riuscito.
          //
          // Se c'e' un cantiere, la verita' e' li': ogni voce sa quali campi ha.
          if (cantiere && cantiere.elenco().length > 0) {
            const buchi = cantiere.buchi();
            const campiMancanti = [...new Set(buchi.flatMap(b => b.campiMancanti))]
              .filter(campo => c.campi.some(x => String(x).toLowerCase() === String(campo).toLowerCase()));
            esiti.push({
              tipo: c.tipo, soddisfatto: campiMancanti.length === 0,
              dettaglio: campiMancanti.length
                ? `${buchi.length} voci su ${cantiere.elenco().length} incomplete`
                : `tutte le ${cantiere.elenco().length} voci hanno ${c.campi.join(', ')}`,
              mancante: campiMancanti.length
                ? `${buchi.length} voci senza ${campiMancanti.join(', ')}: ${buchi.slice(0, 4).map(b => b.nome).join(', ')}`
                : null,
            });
            break;
          }
          const assenti = c.campi.filter(campo => !testoMinuscolo.includes(String(campo).toLowerCase()));
          esiti.push({
            tipo: c.tipo, soddisfatto: assenti.length === 0,
            dettaglio: assenti.length ? `campi assenti: ${assenti.join(', ')}` : 'tutti i campi presenti',
            mancante: assenti.length ? `non compaiono i campi: ${assenti.join(', ')}` : null,
          });
          break;
        }
        case 'soggetti_coperti': {
          // È il criterio che avrebbe fermato il blocco di Milano copiato da
          // Barcellona: ogni soggetto chiesto deve comparire per conto suo.
          // Anche qui: se c'e' un cantiere, si guarda dentro le voci raccolte
          // e non solo la frase in chat. Il 7 agosto il verdetto diceva "non
          // hai trattato: Lombardia, Emilia" su otto aziende tutte lombarde ed
          // emiliane — perche' nel foglio c'erano le CITTA', non le regioni.
          const doveCercare = cantiere && cantiere.elenco().length
            ? (testoMinuscolo + ' ' + cantiere.elenco()
                .map(v => `${v.nome} ${Object.values(v.campi).join(' ')} ${(v.fonti || []).join(' ')}`)
                .join(' ')).toLowerCase()
            : testoMinuscolo;
          const scoperti = c.soggetti.filter(s => !doveCercare.includes(String(s).toLowerCase()));
          esiti.push({
            tipo: c.tipo, soddisfatto: scoperti.length === 0,
            dettaglio: scoperti.length ? `soggetti non trattati: ${scoperti.join(', ')}` : 'tutti i soggetti trattati',
            mancante: scoperti.length ? `non hai trattato: ${scoperti.join(', ')}` : null,
          });
          break;
        }
        case 'origine_verificabile': {
          const fonti = fontiDelTurno(sessione);
          // La domanda e' "hai aperto qualcosa?", non "quanto era lunga".
          // Con una soglia a caratteri, tre pagine di risultati di volo — che
          // sono brevi e densissime — venivano scambiate per nessuna lettura.
          if (fonti.trim().length === 0) {
            esiti.push({
              tipo: c.tipo, soddisfatto: false,
              dettaglio: 'nessuna pagina letta in questo turno',
              mancante: 'non hai aperto nessuna pagina: i dati non hanno una fonte',
            });
            break;
          }
          const { totale, mancanti } = importiSenzaFonte(testo, fonti);
          esiti.push({
            tipo: c.tipo, soddisfatto: mancanti.length === 0,
            dettaglio: `${totale - mancanti.length} valori su ${totale} risultano da una pagina letta`,
            mancante: mancanti.length ? `valori che non compaiono in nessuna pagina letta: ${mancanti.slice(0, 6).join(', ')}` : null,
          });
          break;
        }
        case 'file_atteso': {
          const atteso = String(c.estensione).replace(/^\./, '').toLowerCase();
          const trovato = files.find(f => String(f.filename || '').toLowerCase().endsWith('.' + atteso));
          esiti.push({
            tipo: c.tipo, soddisfatto: !!trovato,
            dettaglio: trovato ? `prodotto ${trovato.filename}` : `nessun file .${atteso}`,
            mancante: trovato ? null : `manca il file .${atteso} richiesto`,
          });
          break;
        }
        case 'formato_consegna': {
          // Un documento presentabile ha intestazione, contenuto e fonti in
          // calce. Senza, non e' un report: e' una bozza.
          const f = verificaFormato(righe);
          esiti.push({
            tipo: c.tipo, soddisfatto: f.conforme,
            dettaglio: f.conforme ? 'documento nello standard' : f.problemi.join('; '),
            mancante: f.conforme ? null : `il documento non e' presentabile: ${f.problemi.join('; ')}`,
          });
          break;
        }
        case 'nessun_duplicato': {
          const doppi = blocchiDuplicati(righe);
          esiti.push({
            tipo: c.tipo, soddisfatto: doppi.length === 0,
            dettaglio: doppi.length ? `righe ${doppi[0].prima} e ${doppi[0].seconda} identiche` : 'nessuna ripetizione',
            mancante: doppi.length
              ? `le righe ${doppi[0].prima}-${doppi[0].prima + doppi[0].righe - 1} sono identiche alle ${doppi[0].seconda}-${doppi[0].seconda + doppi[0].righe - 1}`
              : null,
          });
          break;
        }
      }
    }

    const mancanze = esiti.filter(e => !e.soddisfatto);
    return {
      soddisfatto: mancanze.length === 0,
      soddisfatti: esiti.length - mancanze.length,
      totale: esiti.length,
      esiti,
      mancanze: mancanze.map(m => m.mancante).filter(Boolean),
    };
  }

  /**
   * Cosa dire all'Esecutore per farlo tornare al lavoro.
   *
   * Prima l'insistenza era una spinta generica ("prova un'altra strada"), data
   * a chi non sapeva cosa mancasse. Qui si nomina il buco.
   */
  istruzioneInsistenza(valutazione) {
    if (!valutazione || valutazione.soddisfatto) return null;

    // Dire COSA manca senza dire CON QUALE STRUMENTO si ottiene lascia il
    // modello a girare: davanti a "manca il file .html" ha chiesto
    // l'intervento umano invece di chiamare crea_report. La mancanza viene
    // quindi accompagnata dalla mossa concreta.
    const mosse = [];
    if (valutazione.mancanze.some(m => /\.html/.test(m))) {
      mosse.push('Il file .html lo produci con lo strumento crea_report: '
        + 'filename più spec JSON con titolo, raccomandazione {consiglio, perche} e sezioni con le carte dei risultati. '
        + 'Le fonti le mette il sistema da solo.');
    }
    if (valutazione.mancanze.some(m => /\.xlsx/.test(m))) {
      mosse.push('Il file .xlsx lo produci con create_file: contenuto come righe CSV con punto e virgola.');
    }
    if (valutazione.mancanze.some(m => /nessuna pagina|non compaiono in nessuna pagina/.test(m))) {
      mosse.push('I dati mancanti si leggono aprendo le pagine con navigate(), non si ricordano.');
    }

    return 'Il lavoro non è completo. Obiettivo: ' + this.obiettivo + '\n'
      + 'Manca questo:\n' + valutazione.mancanze.map(m => `- ${m}`).join('\n') + '\n'
      + (mosse.length ? 'Come si ottiene:\n' + mosse.map(m => `- ${m}`).join('\n') + '\n' : '')
      + 'Riprendi SOLO da qui: non rifare quello che hai già fatto bene, non riaprire le pagine già lette. '
      + 'Se una di queste cose è impossibile da ottenere, dillo apertamente e spiega cosa te lo ha impedito, '
      + 'invece di riempirla.';
  }

  /** Il testo che entra nel prompt dell'Esecutore. */
  perIlPrompt() {
    const righe = [`# INCARICO\n${this.obiettivo}`];
    if (this.criteri.length) {
      righe.push('\n## Sarà considerato completo quando:');
      for (const c of this.criteri) righe.push('- ' + descriviCriterio(c));
    }
    if (this.vincoli.length) righe.push('\n## Vincoli\n' + this.vincoli.map(v => `- ${v}`).join('\n'));
    if (this.fuoriAmbito.length) righe.push('\n## Fuori incarico (non farlo)\n' + this.fuoriAmbito.map(v => `- ${v}`).join('\n'));
    righe.push('\nQuesti criteri li verifica il codice sul risultato, non li valuti tu. '
      + 'Se uno non è raggiungibile, dichiaralo e spiega perché: una dichiarazione onesta vale più di una casella riempita.');
    return righe.join('\n');
  }
}

function descriviCriterio(c) {
  switch (c.tipo) {
    case 'elementi_minimi': return `ci sono almeno ${c.quanti} elementi distinti`;
    case 'campi_obbligatori': return `ogni elemento riporta: ${c.campi.join(', ')}`;
    case 'soggetti_coperti': return `sono trattati singolarmente: ${c.soggetti.join(', ')}`;
    case 'origine_verificabile': return 'ogni valore numerico compare in una pagina realmente aperta';
    case 'file_atteso': return `è stato prodotto un file .${String(c.estensione).replace(/^\./, '')}`;
    case 'nessun_duplicato': return 'nessun blocco di righe è ripetuto sotto intestazioni diverse';
    case 'formato_consegna': return 'il documento ha intestazione, contenuto e fonti in calce';
    default: return c.tipo;
  }
}

module.exports = { Incarico, TIPI, descriviCriterio };
