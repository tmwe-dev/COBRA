// modules/collega/sorveglianza.js — Il Collega guarda mentre si lavora
//
// PERCHÉ NON BASTA UN LIMITE DI TEMPO
//
// La prima versione metteva un tetto fisso: venticinque secondi e poi via,
// qualunque cosa stesse succedendo. È una regola cieca, e sbaglia in tutti e
// due i modi. Una ricerca che sta caricando bene viene troncata a metà; una
// che è morta da dieci secondi continua ad aspettare fino allo scadere.
//
// Il punto non è quanto tempo è passato: è se si sta ancora andando avanti.
// Una pagina che cresce di duemila caratteri ogni due secondi può prendersi
// un minuto — sta lavorando. Una che non cresce da tre letture consecutive è
// ferma, e insistere non la sveglia.
//
// COSA FA IL COLLEGA MENTRE SI LAVORA
//
// Riceve i segnali di avanzamento e, in ogni momento, sa dire: si sta
// procedendo, si è fermi, o è successo qualcosa che va detto a Luca. E decide
// di conseguenza — continuare, cambiare strada, o chiamare in causa l'utente.
//
// Non è un guardiano che conta i secondi: è qualcuno che sta nella stanza.

/** Cosa si può decidere di fare. Nient'altro. */
const DECISIONI = ['procedi', 'concluso', 'cambia_strada', 'chiedi_a_luca'];

class Sorveglianza {
  /**
   * @param {object} opzioni
   * @param {function} opzioni.avvisa   (messaggio, icona) => void — parla a Luca
   * @param {function} opzioni.log
   * @param {number} opzioni.fermoMax   quante letture ferme prima di dire "è fermo"
   * @param {number} opzioni.silenzioMs quanto silenzio prima di avvisare Luca
   */
  constructor({ avvisa = () => {}, log = () => {}, fermoMax = 3, silenzioMs = 20000, minimoPerVuoto = 12000, minimoPerConcludere = 12000 } = {}) {
    this.avvisa = avvisa;
    this.log = log;
    this.fermoMax = fermoMax;
    this.silenzioMs = silenzioMs;
    // Una pagina non ancora disegnata legge zero: prima di dichiararla vuota
    // le si danno almeno questi secondi.
    this.minimoPerVuoto = minimoPerVuoto;
    // Su Google Voli i prezzi arrivano al nono secondo: sotto questa soglia
    // "fermo" significa ancora "non ha finito".
    this.minimoPerConcludere = minimoPerConcludere;
    this.reset();
  }

  reset() {
    this.iniziato = Date.now();
    this.ultimoProgresso = Date.now();
    this.letture = 0;
    this.ferme = 0;
    this.misuraPrecedente = 0;
    this.guasti = [];
    this.ultimoAvviso = 0;
    this.storia = [];
  }

  /**
   * Un segnale dal lavoro in corso.
   * @param {object} e
   * @param {number} e.misura    quanto contenuto si ha adesso (caratteri, righe...)
   * @param {boolean} e.attesa   la pagina dichiara di stare ancora caricando
   * @param {string} e.guasto    messaggio d'errore, se qualcosa è andato storto
   * @param {string} e.cosa      descrizione leggibile di cosa si sta facendo
   */
  segnala(e = {}) {
    this.letture++;
    const misura = Number(e.misura) || 0;
    const cresciuto = misura > this.misuraPrecedente;

    if (e.guasto) {
      this.guasti.push(String(e.guasto));
      this.storia.push({ t: Date.now() - this.iniziato, guasto: String(e.guasto).substring(0, 120) });
    } else if (cresciuto) {
      // Si sta andando avanti: il cronometro riparte. Non c'è un tetto al
      // tempo di un lavoro che progredisce.
      this.ultimoProgresso = Date.now();
      this.ferme = 0;
      this.storia.push({ t: Date.now() - this.iniziato, misura, delta: misura - this.misuraPrecedente });
      this.misuraPrecedente = misura;
    } else {
      this.ferme++;
      this.storia.push({ t: Date.now() - this.iniziato, misura, delta: 0 });
    }

    this.ultimaAttesaDichiarata = !!e.attesa;
    this.ultimoCosa = e.cosa || this.ultimoCosa;

    // Se sta prendendo tempo, Luca deve saperlo mentre succede, non dopo.
    // È la differenza fra "sembra bloccato" e "sta caricando i risultati".
    const zitti = Date.now() - this.ultimoAvviso;
    if (Date.now() - this.iniziato > this.silenzioMs && zitti > this.silenzioMs) {
      this.ultimoAvviso = Date.now();
      const secondi = Math.round((Date.now() - this.iniziato) / 1000);
      this.avvisa(cresciuto || e.attesa
        ? `Sto ancora leggendo ${this.ultimoCosa || 'la pagina'} — ${secondi}s, i dati stanno arrivando`
        : `${this.ultimoCosa || 'La pagina'} non risponde da ${secondi}s: valuto se cambiare strada`,
      cresciuto || e.attesa ? '⏳' : '⚠️');
    }

    return this.decidi();
  }

  /**
   * Cosa fare adesso. Il criterio è il progresso, non l'orologio.
   * @returns {{decisione:string, motivo:string, dettagli:object}}
   */
  decidi() {
    const fermoDa = Date.now() - this.ultimoProgresso;
    const durata = Date.now() - this.iniziato;
    const base = { fermoDa, durata, letture: this.letture, guasti: this.guasti.length };

    // Un guasto ripetuto non è lentezza: lo strumento non risponde più, e
    // insistere aggiunge solo attesa a vuoto.
    if (this.guasti.length >= 2) {
      return { decisione: 'cambia_strada', motivo: `lo strumento non risponde (${this.guasti[this.guasti.length - 1]})`, dettagli: base };
    }

    // Finché la pagina dichiara di stare caricando, si aspetta: è lei a dire
    // che il lavoro non è finito.
    if (this.ultimaAttesaDichiarata) {
      return { decisione: 'procedi', motivo: 'la pagina dichiara di stare ancora caricando', dettagli: base };
    }

    // Ferma da abbastanza letture consecutive: ha finito, o non ha niente.
    //
    // Ma "zero contenuto" va trattato diversamente da "contenuto stabile":
    // una pagina vuota può non aver ancora finito di disegnarsi. Su
    // emirates.com si è mollato dopo QUATTRO secondi e tre letture rapide,
    // mentre la pagina aveva 8.578 caratteri che stavano solo arrivando
    // tardi. Prima di dire "qui non c'è niente" bisogna darle il tempo di
    // esistere.
    if (this.ferme >= this.fermoMax) {
      if (this.misuraPrecedente > 0) {
        // Stabile non vuol dire finito, se è passato pochissimo tempo.
        // Misurato su Google Voli: l'intestazione e i filtri arrivano in due
        // secondi e restano fermi; i prezzi compaiono verso il nono. Chiudere
        // a sei secondi significa leggere il guscio e credere che il sito non
        // abbia dati — che è esattamente l'errore da cui siamo partiti.
        if (durata < this.minimoPerConcludere) {
          return { decisione: 'procedi', motivo: `ferma da ${this.ferme} letture ma sono passati solo ${Math.round(durata / 1000)}s: aspetto i dati`, dettagli: base };
        }
        return { decisione: 'concluso', motivo: `contenuto stabile da ${this.ferme} letture dopo ${Math.round(durata / 1000)}s`, dettagli: base };
      }
      if (durata < this.minimoPerVuoto) {
        return { decisione: 'procedi', motivo: `ancora vuota dopo ${Math.round(durata / 1000)}s: le do tempo di caricare`, dettagli: base };
      }
      return { decisione: 'cambia_strada', motivo: `nessun contenuto dopo ${this.letture} letture in ${Math.round(durata / 1000)}s`, dettagli: base };
    }

    // Lavoro lungo ma vivo: si continua. Se però è lungo E fermo da parecchio,
    // la decisione torna a Luca invece di consumare tempo in silenzio.
    if (durata > this.silenzioMs * 3 && fermoDa > this.silenzioMs) {
      return { decisione: 'chiedi_a_luca', motivo: `fermo da ${Math.round(fermoDa / 1000)}s dopo ${Math.round(durata / 1000)}s di lavoro`, dettagli: base };
    }

    return { decisione: 'procedi', motivo: 'si sta ancora andando avanti', dettagli: base };
  }

  /** Il racconto di com'è andata, per il registro e per Luca. */
  riepilogo() {
    return {
      durataMs: Date.now() - this.iniziato,
      letture: this.letture,
      misuraFinale: this.misuraPrecedente,
      guasti: this.guasti,
      progressi: this.storia.filter(s => s.delta > 0).length,
    };
  }
}

module.exports = { Sorveglianza, DECISIONI };
