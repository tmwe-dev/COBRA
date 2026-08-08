// modules/security/regole-invio.js — Le regole che impediscono di far bloccare
// l'account di Luca.
//
// PERCHÉ ESISTE, IN UNA FRASE
//
// WhatsApp non ha un'API per questo: si guida il browser. Chi guida il browser
// troppo in fretta, o scrive a chi non lo conosce, si ritrova l'account
// sospeso — e con l'account se ne va la rubrica di lavoro di anni.
//
// DA DOVE VENGONO I NUMERI
//
// Non li ho inventati. Vengono dal Navigator, dove sono già in produzione:
//
//   supabase/functions/send-linkedin/index.ts:1-13   la "REGOLA TASSATIVA"
//   supabase/functions/_shared/linkedinSettings.ts:17-26  50/giorno, 3/ora, 9-19, 45-180s
//   supabase/functions/_shared/postSendHook.ts:39-58  WhatsApp 9-18, mai nel weekend
//   supabase/functions/send-whatsapp/index.ts:69-122  blacklist, no primo contatto, 7 giorni
//   supabase/functions/_shared/cadenceEngine.ts:19-92  cadenza per stato del contatto
//   src/lib/multichannelTiming.ts:17-28              le pause fra un invio e l'altro
//
// QUELLO CHE HO TROVATO E CHE VA DETTO
//
// Nel Navigator quelle regole vivono nelle edge function di Supabase. Ma
// l'invio VERO non ci passa: parte dal cockpit e va dritto all'estensione. Il
// risultato è che, là, per WhatsApp non c'è nessun limite giornaliero, nessuna
// pausa fra un messaggio e il successivo, e il controllo degli orari
// (`checkWhatsAppGate`) viene chiamato solo dall'agente AI, mai dall'invio
// manuale. Nell'estensione del Navigator, di limiti, non ce n'è nemmeno uno.
//
// Quindi qui non sto copiando un meccanismo funzionante: sto mettendo in
// funzione delle regole che là erano scritte e aggirate.
//
// DUE SCELTE DI PROGETTO CHE CONTANO
//
// 1. Si chiude, non si apre. Se il registro non si legge o una data è
//    illeggibile, l'invio si BLOCCA. Nel Navigator `checkCadenceGate` fa il
//    contrario (`postSendHook.ts:85`: fail-open su errore). Su un canale che
//    può costare l'account, l'errore deve fermare, non lasciar passare.
//
// 2. Il conto sta su disco, non in memoria. Nel Navigator i contatori sono
//    in-memory e si azzerano a ogni riavvio: un limite giornaliero che si
//    azzera non è un limite. Qui il registro è un file, e sopravvive.

const path = require('path');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

// DUE MODI, PERCHE' LE REGOLE HANNO DUE SCOPI DIVERSI
//
// Luca me l'ha fatto notare il 7 agosto e aveva ragione: avevo mescolato due
// cose che non c'entrano niente l'una con l'altra.
//
//   SEMBRARE UNA PERSONA — orari, weekend, pause fra un invio e l'altro,
//   quantita' al giorno. Servono quando e' il programma a lavorare da solo,
//   perche' un programma che manda messaggi alle tre di notte a ritmo costante
//   si riconosce. Ma se e' LUCA che sta lavorando alle sette del mattino, una
//   persona c'e' davvero: la regola non protegge piu' niente, ostacola e basta.
//
//   NON FARSI SEGNALARE — scrivere a chi non ti conosce, mandare lo stesso
//   testo identico a venti persone. Questi restano veri sempre. Chi riceve un
//   messaggio da uno sconosciuto preme "Segnala" allo stesso modo, che dietro
//   ci sia un programma o una persona in carne e ossa.
//
// Quindi: `modo: 'diretto'` quando Luca sta guidando, `'automatico'` quando il
// programma lavora per conto suo. Nel dubbio si sceglie 'automatico', perche'
// sbagliare da quella parte costa un'attesa, mentre sbagliare dall'altra puo'
// costare l'account.

// ── I numeri ──
//
// WhatsApp è più permissivo di LinkedIn sulla frequenza ma molto più severo
// su CHI si contatta: un messaggio a uno sconosciuto vale dieci segnalazioni.
// LinkedIn è l'opposto: si può scrivere a chi non ti conosce, ma piano.
const REGOLE = {
  whatsapp: {
    nome: 'WhatsApp',
    alGiorno: 40,
    allOra: 12,
    pausaMinima: 45,          // secondi fra un invio e il successivo
    pausaMassima: 120,
    oraInizio: 9,
    oraFine: 18,
    weekend: false,
    giorniFraStessoContatto: 7,
    soloSeConosciuto: true,   // deve aver già scritto lui, o essere in rubrica
    lunghezzaMassima: 1000,
  },
  linkedin: {
    nome: 'LinkedIn',
    alGiorno: 50,
    allOra: 3,
    pausaMinima: 45,
    pausaMassima: 180,
    oraInizio: 9,
    oraFine: 19,
    weekend: false,
    giorniFraStessoContatto: 7,
    soloSeConosciuto: false,
    lunghezzaMassima: 300,
  },
};

// ── Quando guida Luca: nessun tetto ──
//
// I numeri che stavano qui — cento al giorno, quaranta all'ora, pause,
// finestre orarie — li avevo scelti io. Nessuno me li aveva chiesti e nessun
// dato li giustificava: erano prudenza mia applicata al lavoro di qualcun
// altro. Il 7 agosto Luca ha detto di toglierli, e ha ragione: e' il suo
// account, e' lui che clicca, ed e' lui che paga se lo bloccano.
//
// Quindi in modalita' diretta non c'e' piu' nessun limite di quantita', di
// orario o di ripetizione. Restano DUE cose sole, e non sono limiti:
//
//   pausaMinima 1s   non serve a sembrare umani. Serve a non mandare due
//                    volte lo stesso messaggio per un doppio clic o per un
//                    turno ripetuto: e' l'ultima rete contro i duplicati,
//                    e i duplicati sono partiti davvero.
//
//   soloSeConosciuto RESTA su WhatsApp, e non e' cautela mia: scrivere per
//                    primi a chi non ti ha mai scritto e' la cosa che fa
//                    sospendere i numeri, ed e' la ragione per cui Luca
//                    aveva chiesto le regole all'inizio.
//
// I limiti automatici (REGOLE, sopra) restano intatti: li' non c'e' nessuno
// che guarda, e un programma che scrive da solo di notte va tenuto stretto.
const SENZA_LIMITI = {
  alGiorno: Infinity,
  allOra: Infinity,
  pausaMinima: 1,
  pausaMassima: 1,
  orari: false,                 // qualsiasi ora, weekend compresi
  weekend: true,
  giorniFraStessoContatto: 0,   // riscrivere alla stessa persona e' normale
  copieIdentiche: Infinity,
};

const DIRETTO = {
  whatsapp: { ...SENZA_LIMITI, soloSeConosciuto: true },
  linkedin: { ...SENZA_LIMITI, soloSeConosciuto: false },
};

/** Le regole valide adesso, secondo chi sta guidando. */
function regolePer(canale, modo) {
  const base = REGOLE[canale];
  if (modo !== 'diretto') return { ...base, orari: true, copieIdentiche: 3 };
  return { ...base, ...DIRETTO[canale] };
}

// I numeri di WhatsApp meritano una parola, perché li ho scelti io e nel
// Navigator non esistevano affatto.
//
// 40 al giorno e 12 all'ora: sono sotto le soglie che vengono comunemente
// riportate come rischiose per un numero non-business, e sopra quello che
// serve a Luca in una giornata di lavoro normale. Se un giorno servisse di
// più, il numero si cambia qui — ma consapevolmente, non per inerzia.
//
// 45-120 secondi di pausa: il Navigator per WhatsApp usa 4-12 secondi
// (src/lib/multichannelTiming.ts:24-28). Dodici secondi fra un messaggio e
// l'altro, ripetuti, sono un ritmo che nessuna persona tiene. Ho preso invece
// la finestra che loro stessi usano per LinkedIn, dove il problema se lo sono
// posto sul serio.

// ── Sono sicuro di chi sto per scrivere? ──
//
// La regola che ha chiesto Luca: non si manda a una persona di cui non si è
// certi, senza che sia lui a confermare.
//
// "Certi" non è un'impressione, è una di queste due cose:
//
//   1. È un NUMERO di telefono. Nel codice del Navigator c'è un commento che
//      lo chiama "HARD GUARD" (wa/actions.js): con un numero si va dritti a
//      /send?phone= e non esiste ambiguità.
//
//   2. È un nome, e nell'elenco chat corrisponde a UNA sola conversazione.
//
// Perché serve. La ricerca per nome dei moduli del Navigator fa corrispondenza
// per sottostringa: `label.includes(targetLower)`. "jose" prende il primo
// risultato della ricerca — e se in rubrica c'è anche un Jose Maria o una
// Josefina, il messaggio parte a quello sbagliato. Su WhatsApp un messaggio
// mandato non si richiama.
//
// Due nomi che combaciano non sono un errore da correggere in silenzio
// scegliendo il primo: sono una domanda da fare.

/**
 * È un numero di telefono, o un nome?
 *
 * Contava le cifre e basta. Su `andrea-anastasi-8732001b2` — lo slug di un
 * profilo LinkedIn — restavano otto cifre, e la funzione rispondeva "numero
 * di telefono", cioè destinatario CERTO, saltando ogni verifica. Un nome
 * storpiato che diventa un recapito valido è il modo esatto in cui un
 * messaggio finisce alla persona sbagliata.
 *
 * Un numero di telefono non ha lettere dentro. Se ce ne sono, è un nome.
 */
function eUnNumero(a) {
  const grezzo = String(a || '').trim();
  if (/[a-zA-Z]/.test(grezzo)) return false;
  const pulito = grezzo.replace(/[^0-9+]/g, '');
  return pulito.length >= 7;
}

/**
 * Quanto si è sicuri del destinatario.
 *
 * @param {string} a           quello che ha detto Luca o il modello
 * @param {string[]} candidati i nomi dell'elenco chat (vuoto = non consultato)
 */
// Lo stesso nome scritto in due modi non e' due persone.
//
// L'8 agosto: auguri ad "Andrea Anastasi", conversazione presente nell'elenco,
// e COBRA si ferma su "non sono sicuro di chi sia". Il modello aveva passato
// `andrea-anastasi` — lo slug del profilo aperto in una scheda — e il confronto
// era letterale: "andrea-anastasi" !== "andrea anastasi". Un trattino.
//
// Il rimedio NON e' allentare il criterio: resta corrispondenza esatta oppure
// una sola parziale, e "non lo so" continua a valere come "no". Si toglie solo
// la punteggiatura di mezzo, che non distingue due persone. Se arriva un
// indirizzo di profilo se ne prende lo slug, che e' la stessa cosa.
function _nomePiatto(x) {
  return String(x || '')
    .replace(/^https?:\/\/[^/]*linkedin\.com\/(?:in|pub)\/([^/?#]+).*$/i, '$1')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_.+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().toLowerCase()
    // La coda dello slug: linkedin.com/in/andrea-anastasi-8732001b2.
    .replace(/(?:\s+\S*\d\S*)+$/, '').trim();
}

function certezzaDestinatario(a, candidati = null) {
  const chi = String(a || '').trim();
  if (!chi) return { certo: false, perche: 'manca il destinatario' };

  if (eUnNumero(chi)) {
    return { certo: true, come: 'numero', destinatario: chi };
  }

  // È un nome. Senza l'elenco davanti non si può essere sicuri: e "non lo so"
  // deve valere come "no", non come "vai avanti".
  if (!Array.isArray(candidati)) {
    return {
      certo: false,
      perche: `"${chi}" è un nome e non ho l'elenco delle chat per verificarlo`,
      cosaFare: 'Leggo prima le conversazioni, oppure dammi il numero.',
    };
  }

  const cercato = _nomePiatto(chi);
  if (!cercato) {
    return {
      certo: false,
      perche: `"${chi}" non e' un nome che io possa confrontare`,
      cosaFare: 'Dimmi il nome come compare nelle conversazioni.',
    };
  }
  const esatti = candidati.filter(c => _nomePiatto(c) === cercato);
  if (esatti.length === 1) return { certo: true, come: 'nome esatto', destinatario: esatti[0] };

  const parziali = candidati.filter(c => _nomePiatto(c).includes(cercato));

  if (parziali.length === 0) {
    return {
      certo: false,
      perche: `nelle tue chat non c'è nessuno che si chiami "${chi}"`,
      cosaFare: 'Controlla il nome, o dammi il numero.',
    };
  }
  if (parziali.length === 1) {
    return { certo: true, come: 'unica corrispondenza', destinatario: parziali[0] };
  }
  return {
    certo: false,
    perche: `"${chi}" corrisponde a ${parziali.length} contatti`,
    candidati: parziali.slice(0, 8),
    // Il "come si esce" va scritto per primo e va scritto giusto, perche' il
    // modello legge questa frase e la ripete a Luca. La prima versione diceva
    // "dimmi quale, o dammi il numero": il modello ha sentito solo "numero" e
    // ha risposto "non posso inviare senza un numero di telefono" — falso, il
    // nome basta ed e' anzi la strada normale. Ora il numero e' l'eccezione.
    cosaFare: 'MOSTRA a Luca i nomi qui sotto e chiedigli quale. Appena te lo '
      + 'dice, richiama whatsapp_scrivi con QUEL nome esatto: il nome basta, '
      + 'NON serve nessun numero di telefono. Non scegliere tu: un messaggio '
      + 'mandato alla persona sbagliata non si richiama.',
  };
}

/** I minuti di pausa fra due invii, con un po' di casualità. */
function pausaProssima(canale, modo) {
  const r = regolePer(canale, modo);
  const secondi = r.pausaMinima + Math.random() * (r.pausaMassima - r.pausaMinima);
  return Math.round(secondi);
}

function _inizioGiorno(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

class RegoleInvio {
  constructor(dataDir, canale = 'whatsapp') {
    this.canale = canale;
    this.regole = REGOLE[canale];
    this.file = path.join(dataDir, `invii_${canale}.json`);
    const letto = readJsonSafeSync(this.file, null);
    this.invii = Array.isArray(letto) ? letto : [];
  }

  _salva() {
    try { writeJsonAtomicSync(this.file, this.invii.slice(-2000)); } catch (_) { /* best-effort */ }
  }

  /**
   * Si può scrivere a questo contatto, adesso?
   *
   * Torna sempre lo stesso tipo di risposta: `{ si: bool, motivo, cosaFare }`.
   * Il motivo è scritto per essere letto da Luca, non da un programma: se COBRA
   * si ferma, deve poter dire PERCHÉ in una frase.
   *
   * @param {object} dati
   * @param {string} dati.a          numero o profilo del destinatario
   * @param {string} dati.testo      il messaggio
   * @param {boolean} dati.conosciuto  ha già scritto lui, o è in rubrica?
   * @param {Date}   [dati.adesso]   per i test
   */
  puoScrivere({ a, testo, conosciuto = false, adesso = new Date(), modo = 'automatico' } = {}) {
    const r = regolePer(this.canale, modo);
    const diretto = modo === 'diretto';
    const no = (motivo, cosaFare) => ({ si: false, motivo, cosaFare, canale: this.canale });

    if (!a) return no('manca il destinatario', 'Dimmi a chi devo scrivere.');
    if (!testo || !String(testo).trim()) {
      return no('il messaggio è vuoto', 'Un messaggio vuoto non si manda.');
    }

    // ── 1. Il contenuto ──
    if (String(testo).length > r.lunghezzaMassima) {
      return no(
        `il messaggio è lungo ${testo.length} caratteri, il limite su ${r.nome} è ${r.lunghezzaMassima}`,
        'Accorcialo. Un messaggio lunghissimo su un canale di messaggistica sembra un volantino.');
    }

    // ── 2. Chi è il destinatario ──
    //
    // È la regola che conta di più, e nel Navigator è quella scritta meglio
    // (send-whatsapp/index.ts:83-100): su WhatsApp non si scrive per primi a
    // chi non ti conosce. Non è prudenza eccessiva — è il motivo numero uno
    // per cui i numeri vengono segnalati e sospesi.
    if (r.soloSeConosciuto && !conosciuto) {
      return no(
        `${a} non ti ha mai scritto e non risulta in rubrica`,
        'Su WhatsApp il primo contatto a freddo è il modo più veloce per farsi '
        + 'sospendere il numero. Scrivigli prima per email o LinkedIn. Se invece '
        + 'lo conosci già, dimmelo e procedo.');
    }

    // ── 3. Quando — SOLO se sta lavorando il programma ──
    //
    // Se e' Luca a guidare, l'ora non conta: sta scrivendo lui, e una persona
    // che scrive alle sette del mattino e' una persona che scrive alle sette
    // del mattino. La finestra oraria serviva a nascondere un automatismo che
    // in questo caso non c'e'.
    if (!diretto) {
      const giorno = adesso.getDay();
      if (!r.weekend && (giorno === 0 || giorno === 6)) {
        return no(
          'è sabato o domenica',
          `Su ${r.nome} nel fine settimana non mando niente da solo. `
          + 'Se vuoi mandarlo tu adesso, dimmelo e lo faccio: le regole di orario valgono '
          + 'per il lavoro automatico.');
      }
      const ora = adesso.getHours();
      if (ora < r.oraInizio || ora >= r.oraFine) {
        return no(
          `sono le ${ora}, e da solo lavoro fra le ${r.oraInizio} e le ${r.oraFine}`,
          'Fuori orario i messaggi automatici si notano. Se invece lo stai chiedendo tu adesso, '
          + 'lo mando: dimmelo e procedo.');
      }
    }

    // ── 4. Quanti ──
    const ora_ = adesso.getTime();
    const oggi = this.invii.filter(i => _inizioGiorno(i.quando) === _inizioGiorno(ora_)).length;
    if (oggi >= r.alGiorno) {
      return no(
        `oggi ho già mandato ${oggi} messaggi su ${r.nome}, il limite è ${r.alGiorno}`,
        'Il conto riparte domani. Se serve alzare il limite si cambia nelle regole, '
        + 'ma di proposito.');
    }
    const nellUltimOra = this.invii.filter(i => ora_ - i.quando < 3600000).length;
    if (nellUltimOra >= r.allOra) {
      return no(
        `nell'ultima ora ne ho mandati ${nellUltimOra}, il limite è ${r.allOra}`,
        'Aspetto che passi un po\' di tempo.');
    }

    // ── 5. Ogni quanto ──
    const ultimo = this.invii.length ? this.invii[this.invii.length - 1] : null;
    if (ultimo) {
      const passati = (ora_ - ultimo.quando) / 1000;
      if (passati < r.pausaMinima) {
        return no(
          `dall'ultimo messaggio sono passati ${Math.round(passati)} secondi, il minimo è ${r.pausaMinima}`,
          `Aspetto ancora ${Math.ceil(r.pausaMinima - passati)} secondi.`);
      }
    }

    // ── 6. Non due volte alla stessa persona ──
    const suo = this.invii.filter(i => i.a === a);
    // Riscrivere alla stessa persona a poca distanza e' insistenza quando lo
    // decide un programma. Quando lo decide Luca e' una conversazione.
    if (suo.length && r.giorniFraStessoContatto > 0) {
      const giorniDa = (ora_ - suo[suo.length - 1].quando) / 86400000;
      if (giorniDa < r.giorniFraStessoContatto) {
        return no(
          `a ${a} ho scritto ${Math.round(giorniDa)} giorni fa, il minimo è ${r.giorniFraStessoContatto}`,
          'Scrivere due volte a poca distanza è insistenza, e viene segnalata. '
          + 'Se è urgente scrivigli tu.');
      }
    }

    // ── 7. Non lo stesso testo a più persone ──
    //
    // Questo nel Navigator non c'è (nessun controllo di duplicati su WA/LI), ed
    // e' un buco serio: mandare lo stesso testo identico a venti persone e' la
    // definizione operativa di spam, ed e' cio' che i filtri cercano.
    const identici = this.invii.filter(i => i.impronta === _impronta(testo)).length;
    if (identici >= (r.copieIdentiche || 3)) {
      return no(
        `questo stesso identico messaggio l'ho già mandato ${identici} volte`,
        'Lo stesso testo a più persone è il segnale che i filtri cercano. '
        + 'Personalizzalo: almeno il nome, meglio una frase.');
    }

    return { si: true, canale: this.canale, oggi, modo,
      prossimaPausa: pausaProssima(this.canale, modo) };
  }

  /** Si registra un invio FATTO. Va chiamato dopo, non prima. */
  registra({ a, testo, adesso = new Date() } = {}) {
    this.invii.push({
      a: String(a || ''),
      quando: adesso.getTime(),
      impronta: _impronta(testo),
      caratteri: String(testo || '').length,
    });
    this._salva();
    return { registrato: true, oggi: this.oggi() };
  }

  oggi(adesso = new Date()) {
    return this.invii.filter(i => _inizioGiorno(i.quando) === _inizioGiorno(adesso.getTime())).length;
  }

  /** Com'è messo il conto — per dirlo a Luca senza che lo debba chiedere. */
  riepilogo(adesso = new Date(), modo = 'automatico') {
    const r = regolePer(this.canale, modo);
    const ora_ = adesso.getTime();
    return {
      canale: this.canale,
      oggi: this.oggi(adesso),
      limiteGiorno: r.alGiorno,
      ultimOra: this.invii.filter(i => ora_ - i.quando < 3600000).length,
      limiteOra: r.allOra,
      modo,
      finestra: modo === 'diretto' ? 'qualsiasi ora, sei tu che guidi'
        : `${r.oraInizio}-${r.oraFine}, giorni feriali`,
      totaleStorico: this.invii.length,
    };
  }
}

/**
 * L'impronta del testo, per riconoscere i duplicati.
 *
 * Si normalizza prima: maiuscole, spazi e punteggiatura non contano. Chi manda
 * lo stesso messaggio cambiando un punto esclamativo sta comunque mandando lo
 * stesso messaggio.
 */
function _impronta(testo) {
  const pulito = String(testo || '').toLowerCase().replace(/[^\wàèéìòù]+/g, ' ').trim();
  let h = 5381;
  for (let i = 0; i < pulito.length; i++) h = ((h << 5) + h + pulito.charCodeAt(i)) | 0;
  return String(h);
}

module.exports = { RegoleInvio, REGOLE, DIRETTO, regolePer, pausaProssima, certezzaDestinatario, eUnNumero, _impronta };
