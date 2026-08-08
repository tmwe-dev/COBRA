// modules/collega/cantiere.js — Dove si posa il lavoro finché non è finito.
//
// IL PROBLEMA CHE RISOLVE
//
// Prova fisica del 6 agosto 2026. Richiesta: otto aziende di packaging con
// nome, città, sito e una email presa dal loro sito, in un Excel.
// Esito: 2 criteri su 6, nessun file. Sette pagine aperte in quattro minuti
// e mezzo, e alla fine niente in mano.
//
// La causa non era la lettura né la scrittura: era che NON C'ERA UN POSTO
// DOVE POSARE QUELLO CHE SI TROVAVA. Il turno conservava le pagine viste e il
// loro testo grezzo, ma non i risultati. A ogni insistenza il modello riceveva
// solo la propria ultima risposta e doveva ricavare tutto daccapo dal testo —
// e il testo delle pagine precedenti nel frattempo era uscito dal contesto.
//
// È il muratore che a ogni giro ributta giù il muro perché nessuno gli ha dato
// un ponteggio dove appoggiare i mattoni.
//
// COME LAVORA
//
// Il cantiere accumula VOCI: una per soggetto trovato, con i campi che via via
// si riempiono. Sopravvive alle insistenze e ai cambi di strada, e a ogni giro
// dice al modello due cose che da solo non saprebbe:
//
//   - cosa ha GIÀ trovato, così non lo ricerca;
//   - cosa MANCA ancora, così sa esattamente dove andare.
//
// Vive finche' il LAVORO non e' finito, non finche' non finisce il turno.
//
// All'inizio l'avevo fatto morire a fine turno, per paura di servire dati
// vecchi. Ma un lavoro da otto aziende non sta in un turno, e buttare il
// cantiere ogni volta significa non arrivare mai in fondo — che e' esattamente
// quello che e' successo per quattro tentativi di fila.
//
// Il compromesso: il cantiere resta finche' il lavoro e' aperto, e su disco,
// cosi' sopravvive anche a un riavvio del server. Quando il lavoro e' finito,
// o quando ne comincia un altro, si chiude. I dati raccolti portano con se'
// la fonte e il momento: chi li usa sa quanto sono freschi.

// ── "Non specificata" non e' un valore: e' un buco travestito ──
//
// Visto nel cantiere del 7 agosto: Gruppo Pluricart aveva
// "citta: Non specificata". Il campo risultava pieno, la voce risultava
// completa, e nessuno andava piu' a cercare quella citta'. Un buco che
// sparisce dai radar e' peggio di un buco: nessuno lo chiudera' mai.
const NON_E_UN_VALORE = /^(?:n\/?[ad]|nd|na|-{1,3}|—|non\s+(?:specificat[oa]|disponibile|indicat[oa]|present[ei]|trovat[oa]|rilevat[oa])|sconosciut[oa]|ignot[oa]|assente|vuoto|null|undefined|\?+)$/i;

function valoreVero(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  return NON_E_UN_VALORE.test(t) ? '' : t;
}

/** Una voce vale se ha almeno un campo con dentro qualcosa di vero. */
function haSostanza(campi) {
  return Object.values(campi || {}).some(v => valoreVero(v).length > 0);
}

function normalizza(nome) {
  return String(nome || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

class Cantiere {
  /**
   * @param {object} opz
   * @param {string[]} opz.campiAttesi  i campi che ogni voce dovrebbe avere
   * @param {number}   opz.quanteVoci   quante voci servono in tutto
   */
  constructor({ campiAttesi = [], quanteVoci = 0 } = {}) {
    this.voci = new Map();          // nome normalizzato → { nome, campi, fonte }
    this.campiAttesi = campiAttesi.map(c => String(c).trim()).filter(Boolean);
    this.quanteVoci = quanteVoci;
    this.note = [];                 // cose imparate che non sono voci
  }

  /**
   * Si posa quello che si è trovato. Chiamarlo due volte sullo stesso
   * soggetto NON crea un doppione: completa la voce che c'è già — che è il
   * caso normale, perché il nome si trova sull'elenco e la email sul sito.
   */
  annota(nome, campi = {}, fonte = '') {
    const chiave = normalizza(nome);
    if (!chiave) return { ok: false, motivo: 'serve un nome per posare qualcosa' };
    if (!haSostanza(campi) && !this.voci.has(chiave)) {
      return { ok: false, motivo: 'nessun campo con un valore: non c\'è niente da posare' };
    }

    const esistente = this.voci.get(chiave) || { nome: String(nome).trim(), campi: {}, fonti: [] };
    for (const [k, v] of Object.entries(campi)) {
      // Un "non specificato" NON entra: lascia il campo vuoto, cosi' resta
      // fra i buchi e qualcuno tornera' a cercarlo.
      const valore = valoreVero(v);
      if (!valore) continue;
      // Non si sovrascrive un valore già buono con uno peggiore: il primo che
      // arriva viene da chi l'ha letto, e chi arriva dopo spesso tira a indovinare.
      if (!esistente.campi[k]) esistente.campi[k] = valore;
    }
    if (fonte && !esistente.fonti.includes(fonte)) esistente.fonti.push(fonte);

    this.voci.set(chiave, esistente);
    return { ok: true, voce: esistente, quante: this.voci.size };
  }

  ricorda(nota) {
    const t = String(nota || '').trim();
    if (t && !this.note.includes(t)) this.note.push(t);
  }

  elenco() {
    return [...this.voci.values()];
  }

  /** Cosa manca ancora, voce per voce. */
  buchi() {
    const mancanti = [];
    for (const v of this.voci.values()) {
      const vuoti = this.campiAttesi.filter(c => !v.campi[c]);
      if (vuoti.length) mancanti.push({ nome: v.nome, campiMancanti: vuoti });
    }
    return mancanti;
  }

  /** Quante voci sono complete davvero. */
  complete() {
    if (!this.campiAttesi.length) return this.voci.size;
    return this.elenco().filter(v => this.campiAttesi.every(c => v.campi[c])).length;
  }

  finito() {
    if (this.quanteVoci > 0 && this.complete() < this.quanteVoci) return false;
    return this.buchi().length === 0 && this.voci.size > 0;
  }

  /**
   * Il blocco da mettere davanti al modello al giro successivo.
   *
   * È la parte che conta: senza, l'insistenza dice solo "manca questo" a
   * qualcuno che non ricorda più cosa aveva già fatto, e che quindi ricomincia.
   */
  perIlPrompt() {
    // Anche a cantiere vuoto si parla: verificato il 6 agosto, il modello ha
    // visitato DIECI aziende senza annotarne una. Lo strumento c'era e la
    // regola pure — sepolta a meta' di undicimila caratteri di prompt. Una
    // regola che non si vede non esiste: quando c'e' un cantiere aperto, deve
    // essere la prima cosa che si legge.
    if (this.voci.size === 0 && this.note.length === 0) {
      return ['# PRIMA DI TUTTO: QUESTO È UN LAVORO DA POSARE MENTRE LO FAI', '',
        `Devi raccogliere ${this.quanteVoci || 'piu\''} soggetti`
          + (this.campiAttesi.length ? `, ognuno con: ${this.campiAttesi.join(', ')}.` : '.'),
        '',
        'Appena trovi UN soggetto — anche solo il nome — chiamalo con annota.',
        'Poi vai al successivo. Non tenere niente in testa per scriverlo alla fine:',
        'quando arrivi in fondo, le prime pagine che hai letto non sono più nel tuo',
        'contesto, e quello che non hai annotato è perso.',
        '',
        'Alla fine il file lo scrivi con scrivi_raccolta, non con create_file.',
      ].join('\n');
    }
    const righe = ['# IL LAVORO CHE HAI GIÀ IN MANO', ''];

    if (this.voci.size > 0) {
      righe.push(`Hai già raccolto ${this.voci.size} voci${this.quanteVoci ? ` su ${this.quanteVoci}` : ''}. `
        + 'Queste NON vanno ricercate: usale così come sono.');
      righe.push('');
      for (const v of this.elenco()) {
        const pezzi = Object.entries(v.campi).map(([k, x]) => `${k}: ${x}`).join(' · ');
        righe.push(`- ${v.nome} — ${pezzi || '(ancora senza dati)'}`);
      }
    }

    const buchi = this.buchi();
    if (buchi.length) {
      righe.push('', 'Di queste manca ancora qualcosa:');
      for (const b of buchi.slice(0, 15)) {
        righe.push(`- ${b.nome}: manca ${b.campiMancanti.join(', ')}`);
      }
    }

    if (this.quanteVoci > 0 && this.voci.size < this.quanteVoci) {
      righe.push('', `Servono ancora ${this.quanteVoci - this.voci.size} soggetti nuovi, oltre a quelli sopra.`);
    }

    if (this.note.length) {
      righe.push('', 'Cose che hai già imparato e che non vale la pena riscoprire:');
      for (const n of this.note.slice(0, 10)) righe.push(`- ${n}`);
    }

    righe.push('', 'Posa ogni cosa che trovi con lo strumento annota, appena la trovi: '
      + 'se il lavoro si interrompe, quello che è posato resta, quello che è solo in testa si perde.');
    return righe.join('\n');
  }

  /** Le righe pronte per un foglio o un report. */
  perIlFile() {
    const colonne = ['nome', ...this.campiAttesi.filter(c => c !== 'nome')];
    const righe = [colonne];
    for (const v of this.elenco()) {
      righe.push(colonne.map(c => (c === 'nome' ? v.nome : (v.campi[c] || ''))));
    }
    return righe;
  }

  /** Il cantiere in una forma che si puo' scrivere su disco. */
  perIlDisco() {
    return {
      obiettivo: this.obiettivo || '',
      campiAttesi: this.campiAttesi,
      quanteVoci: this.quanteVoci,
      aperto: this.aperto || Date.now(),
      note: this.note,
      voci: [...this.voci.entries()].map(([k, v]) => [k, v]),
    };
  }

  /** Riapre un cantiere lasciato a meta', anche dopo un riavvio. */
  static daDisco(dati) {
    if (!dati || !Array.isArray(dati.voci)) return null;
    const c = new Cantiere({ campiAttesi: dati.campiAttesi || [], quanteVoci: dati.quanteVoci || 0 });
    c.obiettivo = dati.obiettivo || '';
    c.aperto = dati.aperto || Date.now();
    c.note = Array.isArray(dati.note) ? dati.note : [];
    for (const [k, v] of dati.voci) c.voci.set(k, v);
    return c;
  }

  riepilogo() {
    return {
      voci: this.voci.size,
      complete: this.complete(),
      attese: this.quanteVoci,
      campiAttesi: this.campiAttesi,
      buchi: this.buchi().length,
      finito: this.finito(),
    };
  }
}

module.exports = { Cantiere, valoreVero, NON_E_UN_VALORE };
