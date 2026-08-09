// modules/ricerca/fonti-preferite.js — Da dove si comincia, e chi lo decide.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Prova voli del 9 agosto: COBRA ha aperto ITA Airways, poi Expedia, poi
// TripAdvisor, e solo alla fine Google Voli — che e' quello che ha funzionato.
// Tre tentativi e due minuti per arrivare al posto giusto, ogni volta da capo.
//
// Non sapeva da dove cominciare perche' nessuno gliel'aveva detto, e perche'
// quello che imparava non restava.
//
// ── IL SEME E' LA CONOSCENZA DI LUCA ──
//
// Luca, 9 agosto: «google voli è molto efficiente, poi booking, expedia per
// voli e hotel, penso skyscanner. Poi potrebbe verificare anche direttamente
// nelle compagnie aeree ma non in prima battuta, a meno di compagnie cinesi o
// asiatiche non presenti su google.»
//
// Sono quindici anni di mestiere in tre righe, e valgono piu' di qualunque
// euristica: si parte da li'.
//
// ── MA L'ORDINE LO AGGIORNA COBRA ──
//
// Un elenco scritto una volta invecchia: un sito cambia, comincia a bloccare,
// smette di dare prezzi. Quindi l'ordine iniziale e' il SEME, e la posizione
// vera si guadagna sul campo — quante volte quel dominio ha davvero prodotto
// un dato, e quanto ci ha messo.
//
// Il punteggio si muove piano: un fallimento isolato non retrocede un sito che
// ha funzionato venti volte, e un colpo di fortuna non promuove un sito che
// non ha mai reso. Servono prove ripetute, come per le persone.
//
// ── NON E' UN RECINTO ──
//
// E' un ORDINE DI PARTENZA, non un elenco chiuso. Se i primi tre non danno
// niente, COBRA deve poter andare altrove e scoprire un posto nuovo — e se
// quel posto funziona, si guadagna la sua riga qui dentro. Un elenco rigido
// impedirebbe esattamente la cosa che lo tiene aggiornato.
// ══════════════════════════════════════════════════════════════════════

const path = require('path');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

/**
 * Il seme: da dove si comincia, per tipo di lavoro.
 *
 * `nota` non e' decorazione: entra nel prompt e spiega al modello PERCHE'
 * quel posto viene prima. "Vai su Google Voli" e' un ordine; "Google Voli
 * accetta la ricerca nell'indirizzo, quindi non devi compilare niente" e' una
 * ragione, e una ragione regge anche nei casi che non avevamo previsto.
 */
const SEME = {
  voli: [
    { dominio: 'google.com/travel/flights', nota: 'accetta la ricerca nell\'indirizzo: nessun modulo da compilare' },
    { dominio: 'skyscanner.it', nota: 'buona copertura, ma i prezzi arrivano dopo aver compilato il modulo' },
    { dominio: 'booking.com', nota: 'voli e hotel insieme, comodo quando servono entrambi' },
    { dominio: 'expedia.it', nota: 'alternativa quando i primi non danno prezzi' },
    { dominio: 'kayak.it', nota: 'ultima scelta fra gli aggregatori' },
  ],
  hotel: [
    { dominio: 'booking.com', nota: 'il piu' + ' ' + 'completo su disponibilita\' e prezzo a notte' },
    { dominio: 'google.com/travel/hotels', nota: 'buono per il confronto rapido fra catene' },
    { dominio: 'expedia.it', nota: 'alternativa' },
    { dominio: 'marriott.com', nota: 'sito della catena: usalo quando Luca chiede una catena precisa' },
    { dominio: 'fourseasons.com', nota: 'idem' },
    { dominio: 'hilton.com', nota: 'idem' },
  ],
  informazioni: [
    { dominio: 'wikipedia.org', nota: 'inquadramento e fatti stabili' },
    { dominio: 'iata.org', nota: 'regole e codici del trasporto aereo: fonte primaria' },
    { dominio: 'europa.eu', nota: 'normativa europea: fonte primaria' },
  ],
  spedizioni: [
    { dominio: 'dhl.com', nota: 'tariffe e tempi: fonte primaria, ma il preventivo va compilato' },
    { dominio: 'ups.com', nota: 'idem' },
    { dominio: 'fedex.com', nota: 'idem' },
  ],
};

/**
 * Le regole che non sono un ordine di partenza ma un'eccezione.
 *
 * Anche questa e' di Luca: i vettori diretti NON in prima battuta, tranne
 * quando l'aggregatore non li copre. Cercare su Google Voli una compagnia
 * cinese che li' non c'e' e' una ricerca persa in partenza.
 */
const ECCEZIONI = [
  {
    quando: /\b(cina|cinese|cinesi|china|asia|asiatic|giappone|corea|vietnam|taiwan|hong kong|shanghai|pechino|beijing|canton|shenzhen)\b/i,
    dice: 'Per le compagnie cinesi e asiatiche gli aggregatori sono incompleti: '
      + 'vai DIRETTO al sito del vettore (Air China, China Eastern, China Southern, '
      + 'Hainan, Cathay, ANA, JAL, Korean Air, Singapore Airlines).',
  },
  {
    quando: /\b(charter|cargo|merci|freight|awb|airway bill)\b/i,
    dice: 'Per il cargo gli aggregatori passeggeri non servono: vai sui siti cargo '
      + 'dei vettori o su IATA.',
  },
];

/** Di che lavoro si tratta, dalle parole della richiesta. */
const DI_CHE_SI_TRATTA = [
  { tipo: 'voli', dice: /\b(vol[oi]|volare|aereo|aerei|business class|economy|andata|ritorno|scalo|aeroport)\w*/i },
  { tipo: 'hotel', dice: /\b(hotel|alberg|resort|stelle|pernott|camera|camere|soggiorno|notte)\w*/i },
  { tipo: 'spedizioni', dice: /\b(spedizion|corriere|tariff|dhl|ups|fedex|pacco|collo|dogana)\w*/i },
  { tipo: 'informazioni', dice: /\b(cos'?e|chi e|storia|normativ|regolament|documenti|requisit)\w*/i },
];

function tipoDiLavoro(testo) {
  const t = String(testo || '');
  const trovati = DI_CHE_SI_TRATTA.filter((d) => d.dice.test(t)).map((d) => d.tipo);
  return trovati.length ? trovati : [];
}

/**
 * La chiave con cui si tiene il conto: SOLO il nome del sito.
 *
 * La prima versione teneva anche il percorso, e cosi' kayak.it/a, kayak.it/b e
 * kayak.it/c risultavano tre siti diversi: nessuno raggiungeva mai i tre
 * tentativi che servono per giudicarlo, e un sito che non rende mai non veniva
 * segnalato nemmeno dopo venti pagine.
 *
 * Il percorso resta nel seme, perche' li' serve a dire DOVE andare
 * (google.com/travel/flights, non google.com). Ma la resa si conta per sito:
 * e' il sito che rende o non rende, non la singola pagina.
 */
function _dominio(url) {
  try {
    const u = new URL(String(url).startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch (_) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

/** Il conto di un sito vale per tutte le sue pagine, seme compreso. */
function _corrisponde(dominioVisto, vocePreferita) {
  return _dominio(dominioVisto) === _dominio(vocePreferita);
}

class FontiPreferite {
  constructor(cartellaDati) {
    this.file = path.join(cartellaDati || './data', 'fonti_preferite.json');
    const d = readJsonSafeSync(this.file, null);
    // { "voli": { "kayak.it": { tentativi, riuscite, msTotali } } }
    this.esiti = (d && typeof d === 'object') ? d : {};
  }

  _salva() {
    try { writeJsonAtomicSync(this.file, this.esiti); } catch (_) { /* non blocca il lavoro */ }
  }

  /**
   * Com'e' andata su questo sito, per questo tipo di lavoro.
   *
   * Lo chiama l'esecutore, con quello che gia' sa: la fonte ha prodotto voci
   * oppure no. Nessuno deve ricordarsi di dichiararlo.
   */
  comeEAndata(tipo, url, haDato, durataMs = 0) {
    const t = String(tipo || 'generico');
    const d = _dominio(url);
    if (!d) return;
    const per = (this.esiti[t] = this.esiti[t] || {});
    const v = (per[d] = per[d] || { tentativi: 0, riuscite: 0, msTotali: 0 });
    v.tentativi++;
    if (haDato) v.riuscite++;
    v.msTotali += Number(durataMs) || 0;
    v.ultimo = Date.now();
    this._salva();
  }

  /**
   * L'ordine con cui provare, per questo tipo di lavoro.
   *
   * Parte dal seme e lo riordina con quello che si e' visto sul campo. Il
   * punteggio si muove piano: servono almeno tre tentativi perche' un sito
   * cambi posizione, altrimenti un fallimento isolato retrocederebbe un posto
   * che ha sempre funzionato.
   */
  ordine(tipo) {
    const semi = SEME[tipo] || [];
    const per = this.esiti[tipo] || {};

    const conPunteggio = semi.map((s, i) => {
      const v = Object.entries(per).find(([d]) => _corrisponde(d, s.dominio));
      const e = v ? v[1] : null;
      // La posizione nel seme vale come punto di partenza; la resa sul campo
      // la corregge, ma solo con abbastanza prove.
      let punti = (semi.length - i) * 10;
      if (e && e.tentativi >= 3) {
        const resa = e.riuscite / e.tentativi;
        punti += Math.round(resa * 60) - 30;      // da -30 (mai) a +30 (sempre)
        const mediaSec = e.msTotali / e.tentativi / 1000;
        if (mediaSec > 60) punti -= 10;            // lento: scende un po'
      }
      return { ...s, punti, prove: e ? e.tentativi : 0, riuscite: e ? e.riuscite : 0 };
    });

    // I posti scoperti sul campo che non erano nel seme: se rendono, entrano.
    for (const [d, e] of Object.entries(per)) {
      if (semi.some((s) => _corrisponde(d, s.dominio))) continue;
      if (e.tentativi >= 3 && e.riuscite / e.tentativi >= 0.5) {
        conPunteggio.push({ dominio: d, nota: 'trovato sul campo: ha reso '
          + `${e.riuscite} volte su ${e.tentativi}`, punti: Math.round((e.riuscite / e.tentativi) * 40),
        prove: e.tentativi, riuscite: e.riuscite });
      }
    }

    return conPunteggio.sort((a, b) => b.punti - a.punti);
  }

  /** I posti che, per questo lavoro, non hanno mai reso: si dicono per saltarli. */
  daEvitare(tipo) {
    const per = this.esiti[tipo] || {};
    return Object.entries(per)
      .filter(([, e]) => e.tentativi >= 3 && e.riuscite === 0)
      .map(([d, e]) => ({ dominio: d, prove: e.tentativi }));
  }

  /**
   * Il blocco per il prompt. Solo se il lavoro e' di un tipo che conosciamo.
   *
   * Dice da dove cominciare e PERCHE', dice cosa saltare, e dice esplicitamente
   * che non e' un recinto — altrimenti il modello si ferma ai tre nomi anche
   * quando non danno niente, che e' il difetto opposto.
   */
  perIlPrompt(richiesta) {
    const tipi = tipoDiLavoro(richiesta);
    if (!tipi.length) return '';

    const righe = ['# DA DOVE CONVIENE COMINCIARE', ''];
    for (const tipo of tipi.slice(0, 2)) {
      const ord = this.ordine(tipo).slice(0, 4);
      if (!ord.length) continue;
      righe.push(`Per ${tipo}, in quest'ordine:`);
      for (const o of ord) {
        const storia = o.prove >= 3 ? ` [${o.riuscite}/${o.prove} sul campo]` : '';
        righe.push(`  ${o.dominio} — ${o.nota}${storia}`);
      }
      const evita = this.daEvitare(tipo);
      if (evita.length) {
        righe.push(`  Da saltare: ${evita.map((e) => `${e.dominio} (${e.prove} tentativi, zero risultati)`).join(', ')}`);
      }
      righe.push('');
    }

    for (const e of ECCEZIONI) if (e.quando.test(String(richiesta || ''))) righe.push(e.dice, '');

    righe.push('Questo e\' un ordine di partenza, non un elenco chiuso: se i primi non',
      'danno niente vai altrove: quello che funziona se lo ricorda.');
    return righe.join('\n');
  }

  riepilogo() {
    const fuori = {};
    for (const [tipo, per] of Object.entries(this.esiti)) {
      fuori[tipo] = Object.entries(per)
        .sort((a, b) => b[1].tentativi - a[1].tentativi)
        .map(([d, e]) => ({ dominio: d, prove: e.tentativi, riuscite: e.riuscite,
          resa: e.tentativi ? Math.round((100 * e.riuscite) / e.tentativi) + '%' : '—',
          secondiMedi: e.tentativi ? Math.round(e.msTotali / e.tentativi / 1000) : 0 }));
    }
    return fuori;
  }
}

module.exports = { FontiPreferite, tipoDiLavoro, SEME, ECCEZIONI };
