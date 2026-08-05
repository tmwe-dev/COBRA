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
    this.passi = passi.map((p, i) => ({
      n: i + 1,
      titolo: String(p.titolo || p.title || `passo ${i + 1}`).trim(),
      stato: 'attesa',
      bloccante: p.bloccante !== false,      // per difetto un passo è necessario
      dipendeDa: Array.isArray(p.dipendeDa) ? p.dipendeDa : [],
      prova: null,
      motivo: null,
      iniziatoIl: null,
      chiusoIl: null,
      tentativi: 0,
    }));
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
        : 'Nessun passo eseguibile: alcuni attendono dipendenze non soddisfatte.';

    return `# PROCESSO IN CORSO — ${this.obiettivo}\n${righe}\n\n${chiusura}\n`
      + 'Un passo si chiude SOLO con "processo_completa_passo" allegando il risultato dello strumento usato, '
      + 'oppure con "processo_fallisci_passo" indicando il motivo. Non dichiarare a parole che un passo è fatto.';
  }
}

module.exports = { Processo, STATI, TRANSIZIONI, STATI_CHIUSI };
