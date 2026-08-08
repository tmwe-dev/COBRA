// modules/security/rubrica.js — Chi ha gia' scritto a Luca.
//
// PERCHE' ESISTE
//
// Il 7 agosto, per mandare due parole a Jose, COBRA ha dovuto leggere l'intero
// elenco delle chat di WhatsApp, ha trovato venti contatti che contengono
// "Jose", e si e' fermato. Giusto fermarsi — un messaggio alla persona
// sbagliata non si richiama — ma quella lettura ricominciava da zero ogni
// volta, e ogni volta finiva nello stesso vicolo.
//
// Il punto e' che l'informazione l'aveva gia' avuta. Ogni volta che legge i
// messaggi non letti, o apre una conversazione, o guarda la posta di LinkedIn,
// passa davanti a nomi e numeri veri. Li leggeva e li buttava.
//
// Qui vengono tenuti. Non e' una copia della rubrica del telefono: e' l'elenco
// di chi ha davvero scambiato messaggi con Luca, con il nome come compare
// nella chat e il numero quando si riesce a vederlo.
//
// A cosa serve, in concreto:
//
//   1. "manda un messaggio a Jose" → si guarda qui prima di leggere tutto
//      WhatsApp. Se qui c'e' un solo Jose che ha scritto davvero, e' lui.
//   2. Fra venti omonimi, quello che ha scritto la settimana scorsa vale piu'
//      di uno visto una volta a gennaio. L'ultimo contatto ordina i candidati.
//   3. `soloSeConosciuto` — la regola che salva il numero da una sospensione —
//      finora si fidava di quello che diceva il modello. Adesso ha un fatto:
//      se una persona e' qui, ha scritto per prima, ed e' conosciuta davvero.
//
// COSA NON FA
//
// Non indovina. Se due Jose hanno entrambi scritto, restano due: si chiede a
// Luca. Serve a rendere la domanda rara, non a saltarla.

const fs = require('fs');
const path = require('path');

const NOME_FILE = 'rubrica.json';

// Sopra questo numero si buttano i piu' vecchi. Non e' un archivio storico:
// e' una scorciatoia, e una scorciatoia lunga non serve a niente.
const MASSIMO = 2000;

class Rubrica {
  constructor(cartellaDati) {
    this.percorso = path.join(cartellaDati, NOME_FILE);
    this._voci = this._leggi();
  }

  _leggi() {
    try {
      const d = JSON.parse(fs.readFileSync(this.percorso, 'utf8'));
      return Array.isArray(d.voci) ? d.voci : [];
    } catch (_) {
      return [];   // non esiste ancora: si parte vuoti, non e' un errore
    }
  }

  _scrivi() {
    try {
      fs.mkdirSync(path.dirname(this.percorso), { recursive: true });
      fs.writeFileSync(this.percorso,
        JSON.stringify({ aggiornata: new Date().toISOString(), voci: this._voci }, null, 2));
    } catch (e) {
      // Se non si riesce a scrivere si continua lo stesso: la rubrica e' una
      // comodita', non una condizione per lavorare.
    }
  }

  /**
   * Confronto fra nomi: senza accenti, senza punteggiatura, senza doppi
   * spazi, minuscolo.
   *
   * I trattini sono arrivati l'8 agosto. Andrea Anastasi era qui dentro due
   * volte — WhatsApp e LinkedIn, `haScrittoLui: true` su entrambi — e la
   * rubrica ha risposto "non lo conosco", perche' il modello aveva chiesto
   * `andrea-anastasi` e la chiave salvata era `andrea anastasi|linkedin`.
   * Un trattino fra il sistema e una cosa che sapeva gia'.
   *
   * Se arriva l'indirizzo di un profilo se ne prende lo slug: e' lo stesso
   * nome con i trattini al posto degli spazi.
   */
  static _piatto(s) {
    return String(s || '')
      .replace(/^https?:\/\/[^/]*linkedin\.com\/(?:in|pub)\/([^/?#]+).*$/i, '$1')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[-_.+]+/g, ' ')
      .toLowerCase().replace(/\s+/g, ' ').trim()
      // La coda dello slug: linkedin.com/in/andrea-anastasi-8732001b2.
      // Si tolgono i pezzi finali che contengono una cifra — nessun pezzo di
      // un nome vero ne ha. Solo in fondo: "Andrea 2" non diventa "Andrea".
      .replace(/(?:\s+\S*\d\S*)+$/, '').trim();
  }

  /**
   * Registra una persona vista in una conversazione.
   *
   * @param {object} p
   * @param {string} p.nome       come compare nella chat
   * @param {string} [p.numero]   se visibile
   * @param {string} [p.url]      per LinkedIn
   * @param {string} p.canale     'whatsapp' | 'linkedin'
   * @param {boolean} [p.haScritto] true se il messaggio veniva DA lui
   */
  vista(p = {}) {
    const nome = String(p.nome || '').trim();
    if (!nome || nome.length > 120) return null;

    // Un nome che e' solo un numero non aggiunge niente a un numero.
    const chiave = Rubrica._piatto(nome) + '|' + (p.canale || 'whatsapp');
    const adesso = Date.now();

    let v = this._voci.find(x => x.chiave === chiave);
    if (!v) {
      v = {
        chiave, nome, canale: p.canale || 'whatsapp',
        numero: null, url: null,
        vistoLa: adesso, ultimoContatto: adesso,
        volte: 0, haScrittoLui: false,
      };
      this._voci.push(v);
    }

    v.nome = nome;                       // il nome piu' recente vince
    v.ultimoContatto = adesso;
    v.volte++;
    if (p.numero) v.numero = String(p.numero).replace(/[^\d+]/g, '');
    if (p.url) v.url = String(p.url);
    // Una volta che ha scritto lui, resta conosciuto per sempre: e' un fatto
    // accaduto, non uno stato che decade.
    if (p.haScritto) v.haScrittoLui = true;

    if (this._voci.length > MASSIMO) {
      this._voci.sort((a, b) => b.ultimoContatto - a.ultimoContatto);
      this._voci = this._voci.slice(0, MASSIMO);
    }
    this._scrivi();
    return v;
  }

  /** Registra in blocco quello che torna da una lettura. Torna quante ne ha prese. */
  daLettura(elenco, canale = 'whatsapp') {
    if (!Array.isArray(elenco)) return 0;
    let n = 0;
    for (const c of elenco) {
      if (!c) continue;
      const nome = c.nome || c.name || c.contact || c.title || c.from || c.sender;
      if (!nome) continue;
      const numero = c.numero || c.phone || c.number || null;
      const url = c.url || c.profileUrl || c.link || null;
      // Da una lettura di messaggi ricevuti: se c'e' un messaggio, qualcuno
      // l'ha mandato. Non e' una deduzione azzardata, e' cosa vuol dire
      // "messaggio ricevuto".
      const haScritto = c.haScritto !== undefined ? !!c.haScritto
        : !!(c.unread || c.unreadCount || c.lastMessage || c.messages || c.preview);
      if (this.vista({ nome, numero, url, canale, haScritto })) n++;
    }
    return n;
  }

  /**
   * Chi corrisponde a questo nome. Ordinati per utilita': prima chi ha scritto
   * davvero, poi chi ha scritto piu' di recente.
   */
  cerca(chi, canale = null) {
    const c = Rubrica._piatto(chi);
    if (!c) return [];
    const dentro = this._voci.filter(v => (!canale || v.canale === canale));

    const esatti = dentro.filter(v => Rubrica._piatto(v.nome) === c);
    const trovati = esatti.length ? esatti
      : dentro.filter(v => Rubrica._piatto(v.nome).includes(c));

    return trovati.sort((a, b) =>
      (b.haScrittoLui - a.haScrittoLui) || (b.ultimoContatto - a.ultimoContatto));
  }

  /**
   * Il destinatario, se e' uno solo o se ce n'e' uno chiaramente piu' probabile
   * degli altri.
   *
   * "Chiaramente piu' probabile" ha una definizione precisa, non a sentimento:
   * uno solo fra tutti gli omonimi ha davvero scambiato messaggi con Luca. In
   * quel caso gli altri sono nomi visti di sfuggita, e non c'e' ambiguita'
   * vera. Se ne hanno scritto due, restano due.
   */
  destinatario(chi, canale = 'whatsapp') {
    const t = this.cerca(chi, canale);
    if (t.length === 0) return { trovato: false, candidati: [] };
    if (t.length === 1) {
      return { trovato: true, voce: t[0], come: 'unico in rubrica', candidati: t };
    }
    const conosciuti = t.filter(v => v.haScrittoLui);
    if (conosciuti.length === 1) {
      return { trovato: true, voce: conosciuti[0], come: 'l\'unico che ha scritto a Luca', candidati: t };
    }
    return { trovato: false, candidati: t.slice(0, 10) };
  }

  /** Ha gia' scritto lui per primo? E' la domanda di `soloSeConosciuto`. */
  conosciuto(chi, canale = 'whatsapp') {
    return this.cerca(chi, canale).some(v => v.haScrittoLui);
  }

  quante() { return this._voci.length; }

  elenco(quanti = 50) {
    return [...this._voci]
      .sort((a, b) => b.ultimoContatto - a.ultimoContatto)
      .slice(0, quanti);
  }
}

module.exports = { Rubrica };
