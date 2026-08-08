// modules/process/engine.js — Motore di processi a passi verificati
//
// Il modello è quello della coda di importazione di SwiftPack Studio: ogni
// unità di lavoro ha uno stato esplicito, si verifica prima di consolidare, e
// il fallimento di un elemento non travolge gli altri.
//
// Qui è generalizzato a qualunque attività: i passi li dichiara l'AI, le regole
// le fa rispettare il codice. Questa separazione è il punto centrale — un
// modello linguistico può convincersi di aver fatto una cosa che non ha fatto,
// quindi le condizioni di completamento non possono essere affidate alla sua
// interpretazione.
//
// REGOLE ASSOLUTE (applicate qui, non suggerite altrove):
//   R1. Un passo non può risultare completato senza una prova, cioè il
//       risultato di uno strumento realmente eseguito.
//   R2. Un passo non può essere saltato in silenzio: o si completa, o si
//       dichiara fallito con un motivo.
//   R3. Un passo bloccante fallito interrompe il processo; uno non bloccante
//       lo lascia proseguire.
//   R4. Un passo dipendente non parte finché le sue dipendenze non sono chiuse.
//   R5. Il processo è concluso solo quando ogni passo è completato, fallito o
//       dichiarato impossibile. Non esistono altre uscite.
//   R6. Nessuno stato può tornare indietro se non passando da un annullamento
//       esplicito.

const STATI = ['attesa', 'in_corso', 'verifica', 'completato', 'fallito', 'impossibile'];

// Transizioni ammesse. Ciò che non è elencato è vietato.
const TRANSIZIONI = {
  attesa:      ['in_corso', 'impossibile'],
  in_corso:    ['verifica', 'fallito', 'impossibile'],
  verifica:    ['completato', 'fallito'],
  completato:  [],
  fallito:     ['attesa'],          // solo per un nuovo tentativo esplicito
  impossibile: [],
};

const STATI_CHIUSI = new Set(['completato', 'fallito', 'impossibile']);

let _contatore = 0;

class Processo {
  /**
   * @param {string} obiettivo  cosa si deve ottenere, in una frase
   * @param {Array} passi       [{ titolo, bloccante?, dipendeDa?[] }]
   */
  constructor(obiettivo, passi = []) {
    this.id = 'p' + (++_contatore) + '_' + Date.now().toString(36);
    this.obiettivo = String(obiettivo || '').trim();
    this.creatoIl = new Date().toISOString();
    this.chiusoIl = null;
    this.avvisi = [];
    const totale = passi.length;

    this.passi = passi.map((p, i) => {
      const n = i + 1;
      // Le dipendenze vanno ripulite subito: un piano con un riferimento
      // impossibile non si completerà MAI, e il blocco arriverebbe solo a
      // metà lavoro. È già successo: il modello ha numerato i passi da zero,
      // il passo 2 dipendeva dal passo 0 che non esiste, e il processo si è
      // fermato lì.
      const grezze = Array.isArray(p.dipendeDa) ? p.dipendeDa : [];
      const valide = [];
      for (const d of grezze) {
        const num = Number(d);
        if (!Number.isInteger(num)) { this.avvisi.push(`passo ${n}: dipendenza "${d}" non è un numero, ignorata`); continue; }
        if (num === 0) { this.avvisi.push(`passo ${n}: i passi si contano da 1, la dipendenza 0 è stata ignorata`); continue; }
        if (num < 1 || num > totale) { this.avvisi.push(`passo ${n}: il passo ${num} non esiste, dipendenza ignorata`); continue; }
        if (num >= n) { this.avvisi.push(`passo ${n}: non può dipendere dal passo ${num} che viene dopo, dipendenza ignorata`); continue; }
        valide.push(num);
      }

      return {
        n,
        titolo: String(p.titolo || p.title || `passo ${n}`).trim(),
        stato: 'attesa',
        bloccante: p.bloccante !== false,      // per difetto un passo è necessario
        dipendeDa: [...new Set(valide)],
        prova: null,
        motivo: null,
        iniziatoIl: null,
        chiusoIl: null,
        tentativi: 0,
      };
    });
  }

  // ── Il piano deve sopravvivere al turno ──
  //
  // Il Processo era l'unico dei cinque a non avere disco: Cantiere ha
  // l'archivio, missioni ha il suo file, i tasks pure. Il piano dei passi
  // moriva a fine turno.
  //
  // Il risultato pratico: un lavoro da otto soggetti veniva ripianificato da
  // zero a ogni ripresa. Il Cantiere ricordava COSA era stato raccolto, ma
  // nessuno ricordava DOVE si era arrivati nel piano — quindi il modello
  // rifaceva il piano, e con un piano nuovo i passi gia' fatti tornavano
  // "in attesa".
  //
  // Qui non si aggiunge un motore: si aggiunge una porta sul disco a quello
  // che c'e' gia'. Lo stato resta questo oggetto, le regole restano le sue.

  /** Tutto quello che serve per ricostruirsi identico. */
  perIlDisco() {
    return {
      id: this.id,
      obiettivo: this.obiettivo,
      creatoIl: this.creatoIl,
      chiusoIl: this.chiusoIl,
      avvisi: this.avvisi,
      passi: this.passi,
    };
  }

  /**
   * Si ricostruisce da quello che c'era scritto.
   *
   * I passi si rimettono com'erano SENZA ripassare dal costruttore: quello
   * ripulisce le dipendenze e rimette tutto in "attesa", e ricostruire un
   * piano a meta' azzerandolo sarebbe peggio che non averlo salvato.
   */
  static daDisco(dati) {
    if (!dati || !Array.isArray(dati.passi)) return null;
    const p = new Processo(dati.obiettivo || '', []);
    p.id = dati.id || p.id;
    p.creatoIl = dati.creatoIl || p.creatoIl;
    p.chiusoIl = dati.chiusoIl || null;
    p.avvisi = Array.isArray(dati.avvisi) ? dati.avvisi : [];
    p.passi = dati.passi.map(x => ({
      n: Number(x.n),
      titolo: String(x.titolo || ''),
      stato: STATI.includes(x.stato) ? x.stato : 'attesa',
      bloccante: x.bloccante !== false,
      dipendeDa: Array.isArray(x.dipendeDa) ? x.dipendeDa.map(Number) : [],
      prova: x.prova || null,
      motivo: x.motivo || null,
      iniziatoIl: x.iniziatoIl || null,
      chiusoIl: x.chiusoIl || null,
      tentativi: Number(x.tentativi) || 0,
    }));
    // Un passo lasciato "in corso" da un turno morto non e' in corso: non c'e'
    // piu' nessuno che lo sta facendo. Torna in attesa, con il conto dei
    // tentativi intatto — cosi' si vede che ci si era gia' provati.
    for (const x of p.passi) {
      if (x.stato === 'in_corso' || x.stato === 'verifica') {
        x.stato = 'attesa';
        x.iniziatoIl = null;
      }
    }
    return p;
  }

  passo(n) { return this.passi.find(p => p.n === Number(n)) || null; }

  /** R6 — nessuna transizione fuori da quelle dichiarate. */
  _transizioneValida(da, a) {
    return (TRANSIZIONI[da] || []).includes(a);
  }

  /** R4 — le dipendenze devono essere chiuse con successo. */
  _dipendenzeSoddisfatte(p) {
    for (const n of p.dipendeDa) {
      const d = this.passo(n);
      if (!d || d.stato !== 'completato') return false;
    }
    return true;
  }

  iniziaPasso(n) {
    const p = this.passo(n);
    if (!p) return { ok: false, motivo: `Il passo ${n} non esiste` };
    if (!this._transizioneValida(p.stato, 'in_corso')) {
      return { ok: false, motivo: `Il passo ${n} è in stato "${p.stato}": non può essere avviato` };
    }
    if (!this._dipendenzeSoddisfatte(p)) {
      const mancanti = p.dipendeDa.filter(d => this.passo(d)?.stato !== 'completato');
      return { ok: false, motivo: `Il passo ${n} dipende da ${mancanti.join(', ')}, non ancora completati` };
    }
    p.stato = 'in_corso';
    p.iniziatoIl = new Date().toISOString();
    p.tentativi++;
    return { ok: true, passo: p };
  }

  /**
   * R1 — Completare richiede una prova: il risultato di uno strumento eseguito.
   * Senza prova il passo resta aperto, qualunque cosa dichiari il modello.
   */
  completaPasso(n, prova) {
    const p = this.passo(n);
    if (!p) return { ok: false, motivo: `Il passo ${n} non esiste` };

    const testoProva = typeof prova === 'string' ? prova : JSON.stringify(prova || '');
    if (!testoProva || testoProva.length < 10) {
      return { ok: false, motivo: `Il passo ${n} non può essere completato senza una prova: allega il risultato dello strumento che hai usato` };
    }
    // Una prova che dichiara un errore non è una prova di successo
    if (/"error"|"blocked"\s*:\s*true|"rejected"\s*:\s*true/i.test(testoProva)) {
      return { ok: false, motivo: `La prova del passo ${n} contiene un errore: usa "fallisci" invece di "completa"` };
    }

    if (p.stato === 'in_corso') p.stato = 'verifica';

    // Un passo mai aperto formalmente, ma con la prova in mano, è un passo
    // fatto. Prima veniva rifiutato per contabilità — e il modello, non
    // sapendo che fare del rifiuto, lo dichiarava FALLITO: nel log del 6
    // agosto si legge "Passo 1 fallito: Il passo è in stato di attesa e non
    // può essere completato", che descrive un problema di registro, non un
    // lavoro andato male. Chi legge crede che la ricerca sia fallita.
    if (p.stato === 'attesa') {
      p.stato = 'verifica';
      this.avvisi.push(`Passo ${n} chiuso senza essere stato aperto: la prova c'era`);
    }

    if (!this._transizioneValida(p.stato, 'completato')) {
      return { ok: false, motivo: `Il passo ${n} è in stato "${p.stato}": non può essere completato` };
    }
    p.stato = 'completato';
    p.prova = testoProva.substring(0, 800);
    p.chiusoIl = new Date().toISOString();
    return { ok: true, passo: p };
  }

  /** R2/R3 — il fallimento va dichiarato con un motivo. */
  falliscePasso(n, motivo) {
    const p = this.passo(n);
    if (!p) return { ok: false, motivo: `Il passo ${n} non esiste` };
    const testo = String(motivo || '').trim();
    if (testo.length < 5) {
      return { ok: false, motivo: `Per dichiarare fallito il passo ${n} serve un motivo comprensibile` };
    }
    // "Non sono riuscito a completare il passo 1" non è un motivo: è la
    // ripetizione del fallimento con altre parole. Passava il controllo sulla
    // lunghezza e lasciava l'utente davanti a un passo rosso senza sapere
    // perché. Un motivo deve dire cosa si è opposto: quale pagina, quale
    // errore, cosa mancava.
    const vuoto = /^(non (sono|ci sono) riuscit|non riesco|non . stato possibile|fallit|errore)[a-z\s]*(a|nel|per)?\s*(completare|eseguire|fare|portare a termine)?\s*(il\s*)?(passo|step)?\s*\d*\.?$/i.test(testo);
    if (vuoto) {
      return { ok: false, motivo: `"${testo}" non spiega niente: ripete solo che non ce l'hai fatta. `
        + 'Scrivi cosa te lo ha impedito — quale pagina non ha risposto, quale dato mancava, quale errore hai visto.' };
    }
    if (p.stato === 'attesa') p.stato = 'in_corso';
    if (!this._transizioneValida(p.stato, 'fallito')) {
      return { ok: false, motivo: `Il passo ${n} è in stato "${p.stato}": non può essere dichiarato fallito` };
    }
    p.stato = 'fallito';
    p.motivo = testo.substring(0, 400);
    p.chiusoIl = new Date().toISOString();
    return { ok: true, passo: p, bloccaTutto: p.bloccante };
  }

  /** Un passo che non si può fare per ragioni esterne, dichiarato apertamente. */
  dichiaraImpossibile(n, motivo) {
    const p = this.passo(n);
    if (!p) return { ok: false, motivo: `Il passo ${n} non esiste` };
    const testo = String(motivo || '').trim();
    if (testo.length < 5) return { ok: false, motivo: 'Serve un motivo comprensibile' };
    if (!this._transizioneValida(p.stato, 'impossibile')) {
      return { ok: false, motivo: `Il passo ${n} è in stato "${p.stato}"` };
    }
    p.stato = 'impossibile';
    p.motivo = testo.substring(0, 400);
    p.chiusoIl = new Date().toISOString();
    return { ok: true, passo: p };
  }

  /** R5 — il processo è concluso solo se ogni passo è chiuso. */
  concluso() {
    return this.passi.every(p => STATI_CHIUSI.has(p.stato));
  }

  /** R3 — un bloccante fallito ferma tutto. */
  interrotto() {
    return this.passi.some(p => p.stato === 'fallito' && p.bloccante);
  }

  /** Il prossimo passo eseguibile, o null se non ce ne sono. */
  prossimoPasso() {
    return this.passi.find(p => p.stato === 'attesa' && this._dipendenzeSoddisfatte(p)) || null;
  }

  /**
   * Stallo: restano passi aperti ma nessuno è eseguibile.
   * Va riconosciuto e detto, altrimenti si continua a riprovare all'infinito
   * un passo che non partirà mai.
   */
  inStallo() {
    if (this.concluso()) return false;
    if (this.prossimoPasso()) return false;
    return !this.passi.some(p => p.stato === 'in_corso' || p.stato === 'verifica');
  }

  riepilogo() {
    const conteggi = {};
    for (const s of STATI) conteggi[s] = this.passi.filter(p => p.stato === s).length;
    return {
      id: this.id,
      obiettivo: this.obiettivo,
      passi: this.passi.map(p => ({
        n: p.n, titolo: p.titolo, stato: p.stato,
        bloccante: p.bloccante, motivo: p.motivo,
        haProva: !!p.prova,
      })),
      conteggi,
      concluso: this.concluso(),
      interrotto: this.interrotto(),
      completati: conteggi.completato,
      totale: this.passi.length,
    };
  }

  /** Testo per il prompt: dice all'AI dove si trova, senza margini di lettura. */
  perIlPrompt() {
    const righe = this.passi.map(p => {
      const segno = { attesa: '☐', in_corso: '▶', verifica: '?', completato: '☑', fallito: '✗', impossibile: '⊘' }[p.stato];
      const coda = p.motivo ? ` — ${p.motivo}` : '';
      return `${segno} ${p.n}. ${p.titolo} [${p.stato}]${coda}`;
    }).join('\n');

    const prossimo = this.prossimoPasso();
    const chiusura = this.concluso()
      ? 'Tutti i passi sono chiusi: puoi consegnare il risultato.'
      : prossimo
        ? `Prossimo passo da eseguire: ${prossimo.n}. ${prossimo.titolo}`
        : this.inStallo()
          ? 'PROCESSO IN STALLO: nessun passo è eseguibile. Chiudi i passi rimasti '
            + 'con processo_fallisci_passo indicando il motivo, poi consegna quello che hai.'
          : 'Un passo è in corso: portalo a termine.';

    return `# PROCESSO IN CORSO — ${this.obiettivo}\n${righe}\n\n${chiusura}\n`
      + 'Un passo si chiude SOLO con "processo_completa_passo" allegando il risultato dello strumento usato, '
      + 'oppure con "processo_fallisci_passo" indicando il motivo. Non dichiarare a parole che un passo è fatto.';
  }
}

module.exports = { Processo, STATI, TRANSIZIONI, STATI_CHIUSI };
