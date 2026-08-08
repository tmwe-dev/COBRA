// modules/memory/missioni.js — Il diario: cosa è stato chiesto, cosa è stato
// fatto, cosa è andato storto.
//
// PERCHÉ ESISTE
//
// Il 7 agosto Luca ha chiesto tre volte, in tre modi diversi: "si ricorda
// quando ha sbagliato?". La risposta era no, e per rispondergli ho dovuto
// ricostruire la giornata a mano leggendo response_log.jsonl riga per riga.
//
// Quello che c'era prima non bastava, e vale la pena essere precisi sul perché:
//
//   memories.json      70 voci, fatti sparsi senza un lavoro attorno
//   learned_facts.json 15 fatti su Luca — utili, ma non sulle attività
//   lezioni.json       8 righe, di cui CINQUE identiche:
//                        "i dati compaiono dopo 79 secondi"
//                        "i dati compaiono dopo 25 secondi"
//                        "i dati compaiono dopo 80 secondi"  ...
//                      Non è imparare: è accumulare. La lezione vera —
//                      "su questo tipo di pagina aspetta prima di leggere" —
//                      è dentro cinque volte e non emerge mai.
//   response_log       tutto, ma illeggibile: un JSON da 300 KB al giorno
//
// Mancava la cosa più semplice: UNA RIGA PER LAVORO. Cosa mi hai chiesto, cosa
// ho aperto, cosa ho prodotto, cosa non ha funzionato, com'è finita.
//
// A COSA SERVE, IN CONCRETO
//
//   1. Non ripetere lo stesso errore. Prima di partire si guarda se un lavoro
//      simile è già stato fatto e cosa era andato storto.
//   2. Sapere in anticipo cosa fare. "Questo l'abbiamo già fatto il 3 agosto,
//      ci vollero quattro passaggi e il file è questo."
//   3. Rispondere a Luca quando chiede conto. Senza doverlo ricostruire.
//
// COSA NON È
//
// Non è un registro di tutto. Una missione è un LAVORO — una richiesta che ha
// prodotto qualcosa o è fallita. "Ciao" non è una missione. Se si registrasse
// ogni turno si tornerebbe al response_log: completo e inutile.

const fs = require('fs');
const path = require('path');

const NOME_FILE = 'missioni.json';

// Oltre questo si buttano le più vecchie. Non è un archivio storico: è la
// memoria di lavoro, e una memoria di lavoro lunga non si consulta.
const MASSIME = 300;

class Missioni {
  constructor(cartellaDati) {
    this.percorso = path.join(cartellaDati, NOME_FILE);
    this._voci = this._leggi();
  }

  _leggi() {
    try {
      const d = JSON.parse(fs.readFileSync(this.percorso, 'utf8'));
      return Array.isArray(d.missioni) ? d.missioni : [];
    } catch (_) { return []; }
  }

  _scrivi() {
    try {
      fs.mkdirSync(path.dirname(this.percorso), { recursive: true });
      fs.writeFileSync(this.percorso, JSON.stringify({
        aggiornato: new Date().toISOString(),
        missioni: this._voci,
      }, null, 2));
    } catch (_) { /* il diario è una comodità, non una condizione per lavorare */ }
  }

  /** Le parole che contano di una richiesta, per riconoscere lavori simili. */
  static _parole(testo) {
    const banali = new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'di', 'a', 'da',
      'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'che', 'mi', 'ti', 'ci',
      'del', 'della', 'dei', 'delle', 'al', 'alla', 'ai', 'nel', 'nella', 'come', 'poi',
      'anche', 'sono', 'ho', 'hai', 'fai', 'fammi', 'dammi', 'voglio', 'puoi', 'devi']);
    return [...new Set(
      String(testo || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(p => p.length > 2 && !banali.has(p))
    )];
  }

  /**
   * Apre una missione. Torna l'id con cui chiuderla.
   */
  apri(richiesta, { ambiti = [], modello = null } = {}) {
    const m = {
      id: `m${Date.now()}`,
      quando: new Date().toISOString(),
      richiesta: String(richiesta || '').slice(0, 500),
      parole: Missioni._parole(richiesta),
      ambiti,
      modello,
      pagine: [],
      file: [],
      strumenti: [],
      inciampi: [],     // cosa NON ha funzionato, con il motivo
      esito: null,      // 'consegnato' | 'incompleto' | 'fallito'
      durataSec: null,
      _inizio: Date.now(),
    };
    this._voci.push(m);
    if (this._voci.length > MASSIME) this._voci = this._voci.slice(-MASSIME);
    this._scrivi();
    return m.id;
  }

  _trova(id) { return this._voci.find(m => m.id === id) || null; }

  /**
   * Un intoppo: qualcosa non ha funzionato.
   *
   * È la parte che serve davvero. Un diario che registra solo i successi
   * racconta una giornata che non è successa — e oggi, di cose che non hanno
   * funzionato, ce n'erano parecchie.
   */
  inciampo(id, cosa, perche) {
    const m = this._trova(id);
    if (!m) return;
    m.inciampi.push({
      cosa: String(cosa || '').slice(0, 120),
      perche: String(perche || '').slice(0, 300),
      quando: new Date().toISOString(),
    });
    this._scrivi();
  }

  /** Cosa ha toccato: pagine aperte, file prodotti, strumenti usati. */
  annota(id, { pagina = null, file = null, strumento = null } = {}) {
    const m = this._trova(id);
    if (!m) return;
    if (pagina && !m.pagine.includes(pagina)) m.pagine.push(pagina);
    if (file && !m.file.includes(file)) m.file.push(file);
    if (strumento && !m.strumenti.includes(strumento)) m.strumenti.push(strumento);
    this._scrivi();
  }

  /** Chiude la missione con il verdetto. */
  chiudi(id, esito, nota = null) {
    const m = this._trova(id);
    if (!m) return;
    m.esito = esito;
    m.nota = nota ? String(nota).slice(0, 300) : null;
    m.durataSec = Math.round((Date.now() - (m._inizio || Date.now())) / 1000);
    delete m._inizio;
    this._scrivi();
  }

  /**
   * Lavori simili già fatti. È la domanda "l'abbiamo già fatto?".
   *
   * Si confrontano le parole che contano. Non è ricerca semantica — è un
   * conteggio di parole in comune — ma su richieste vere funziona: "manda un
   * messaggio a Jose" e "scrivi a Jose su WhatsApp" condividono abbastanza.
   */
  simili(richiesta, quante = 3) {
    const p = new Set(Missioni._parole(richiesta));
    if (!p.size) return [];
    return this._voci
      .filter(m => m.esito)
      .map(m => {
        const comuni = m.parole.filter(x => p.has(x)).length;
        return { m, punti: comuni / Math.max(1, Math.min(p.size, m.parole.length)) };
      })
      .filter(x => x.punti >= 0.4)
      .sort((a, b) => b.punti - a.punti)
      .slice(0, quante)
      .map(x => x.m);
  }

  /**
   * Il riassunto per il prompt: cosa sappiamo di questo tipo di lavoro.
   *
   * Corto apposta. Se occupa venti righe non lo legge nessuno — è la lezione
   * dei manuali, che sono finiti fuori dal prompt proprio per questo.
   */
  cosaSappiamoSu(richiesta) {
    const simili = this.simili(richiesta, 3);
    if (!simili.length) return '';

    const righe = [];
    for (const m of simili) {
      const quando = String(m.quando).slice(0, 10);
      const esito = m.esito === 'consegnato' ? 'riuscito'
        : m.esito === 'incompleto' ? 'a metà' : 'fallito';
      let r = `- ${quando}: "${m.richiesta.slice(0, 60)}" → ${esito}`;
      if (m.file.length) r += `, prodotto ${m.file.slice(0, 2).join(', ')}`;
      righe.push(r);
      // Gli inciampi contano più dei successi: sono la ragione del diario.
      for (const i of m.inciampi.slice(0, 2)) {
        righe.push(`     atteso: ${i.cosa} — ${i.perche.slice(0, 90)}`);
      }
    }
    return '# LAVORI SIMILI GIA\' FATTI\n'
      + 'Non ripetere gli errori qui sotto. Se un file c\'e\' gia\', guardalo prima di rifarlo.\n'
      + righe.join('\n');
  }

  /** Il quadro per Luca, quando chiede conto. */
  riepilogo(quante = 10) {
    const ultime = [...this._voci].reverse().slice(0, quante);
    const conteggio = { consegnato: 0, incompleto: 0, fallito: 0 };
    for (const m of this._voci) if (m.esito) conteggio[m.esito] = (conteggio[m.esito] || 0) + 1;

    // Gli inciampi più frequenti: se una cosa fallisce sempre, si vede qui.
    const perCosa = new Map();
    for (const m of this._voci) {
      for (const i of (m.inciampi || [])) {
        perCosa.set(i.cosa, (perCosa.get(i.cosa) || 0) + 1);
      }
    }
    const ricorrenti = [...perCosa.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cosa, n]) => ({ cosa, volte: n }));

    return {
      totale: this._voci.length,
      esiti: conteggio,
      inciampiRicorrenti: ricorrenti,
      ultime: ultime.map(m => ({
        quando: m.quando, richiesta: m.richiesta.slice(0, 80), esito: m.esito,
        durataSec: m.durataSec, file: m.file, inciampi: m.inciampi.length,
      })),
      nota: ricorrenti.length
        ? 'Le cose in "inciampiRicorrenti" sono fallite piu\' di una volta: '
          + 'sono quelle da guardare per prime.'
        : 'Nessun intoppo ripetuto.',
    };
  }

  quante() { return this._voci.length; }

  /**
   * La scrivania: cosa c'è già sul tavolo, e da quale lavoro viene.
   *
   * PERCHÉ NON BASTAVA LA CARTELLA
   *
   * I file c'erano già — sedici, veri, prodotti da lavori veri. E gli strumenti
   * per guardarli pure: list_local_files, read_local_file, search_local_files.
   * Solo che in due giorni non li ha chiamati NESSUNA volta.
   *
   * Non serviva un contenitore nuovo: serviva che COBRA sapesse che il tavolo
   * non è vuoto. Un file che esiste ma di cui nessuno sa è un file che verrà
   * rifatto da capo — che è esattamente quello che succedeva.
   *
   * Qui i file sul disco vengono uniti al lavoro che li ha prodotti, così la
   * riga dice qualcosa: non "bora_bora_vacation.xlsx", ma "questo l'hai fatto
   * il 5 agosto per la richiesta sui viaggi".
   */
  scrivania(cartellaFile, quanti = 12) {
    let file = [];
    try {
      file = fs.readdirSync(cartellaFile)
        .filter(f => !f.startsWith('.'))
        .map(f => {
          let st = null;
          try { st = fs.statSync(path.join(cartellaFile, f)); } catch (_) { /* sparito */ }
          return { nome: f, quando: st ? st.mtimeMs : 0, kb: st ? Math.round(st.size / 1024) : 0 };
        })
        .sort((a, b) => b.quando - a.quando)
        .slice(0, quanti);
    } catch (_) { return []; }

    // Ogni file col lavoro che l'ha prodotto, se lo sappiamo.
    for (const f of file) {
      const m = this._voci.find(v => (v.file || []).some(x => String(x).endsWith(f.nome)));
      if (m) { f.da = m.richiesta.slice(0, 60); f.missione = m.id; }
    }
    return file;
  }

  /** Le stesse cose, in tre righe per il prompt. */
  bloccoScrivania(cartellaFile) {
    const f = this.scrivania(cartellaFile, 8);
    if (!f.length) return '';
    const righe = f.map(x => {
      const data = x.quando ? new Date(x.quando).toISOString().slice(5, 10) : '';
      return `- ${x.nome}${x.kb ? ` (${x.kb} KB)` : ''}${data ? ` · ${data}` : ''}`
        + (x.da ? ` · da: "${x.da}"` : '');
    });
    return '# SUL TAVOLO C\'E\' GIA\'\n'
      + 'File prodotti in lavori precedenti. Prima di rifare una ricerca guarda se '
      + 'la risposta e\' gia\' qui: read_local_file per aprirli, search_local_files per cercarci dentro.\n'
      + righe.join('\n');
  }
}

module.exports = { Missioni };
