// modules/ricerca/indagine.js — Cercare, leggere, capire cosa manca, ricercare.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Trentuno ricerche di voli in cinque giorni, fino a 618 secondi l'una, e
// quasi sempre lo stesso esito: "non sono riuscito a ottenere i prezzi".
//
// Guardando le sequenze, il difetto non e' in nessuno dei passi: e' che non
// c'e' un CICLO. COBRA cerca, legge, non trova, e poi... cerca di nuovo, spesso
// la stessa cosa con parole leggermente diverse. Non confronta mai quello che
// ha raccolto con quello che gli era stato chiesto, quindi non sa mai cosa gli
// manca, quindi la ricerca successiva non punta da nessuna parte.
//
// Il ciclo che serve e' quello che fa una persona competente:
//
//     cerca → leggi → confronta con quello che ti serviva
//           → vedi cosa manca → cerca QUELLA cosa → verifica
//
// ── PERCHE' NON E' UNO STRUMENTO NUOVO ──
//
// La tentazione era aggiungere `indaga` all'elenco. Non l'ho fatto, e il
// motivo sta nei numeri: degli 83 strumenti dichiarati, 40 non sono MAI stati
// chiamati in 132 turni. Aggiungerne uno che chiede al modello di ricordarsi
// di usarlo significa, con ottima probabilita', costruire il quarantunesimo
// strumento orfano — e sapendolo in anticipo.
//
// E' la stessa lezione di `annota`: 5 chiamate su 880.
//
// Quindi qui non c'e' niente da chiamare. Il modulo:
//   - REGISTRA da solo ogni ricerca e ogni fonte letta, dall'esecutore;
//   - CALCOLA da solo cosa manca, confrontando i requisiti col cantiere;
//   - SCRIVE nel prompt la prossima mossa concreta, a ogni giro.
//
// Il modello non deve ricordarsi di niente. Trova la lacuna gia' scritta
// davanti, insieme alla ricerca che la chiuderebbe.
//
// ── COSA RESTA AL MODELLO ──
//
// Capire il contenuto di una pagina. Quello non si automatizza, ed e' giusto
// che sia suo: qui si automatizza la contabilita' — cosa ho chiesto, cosa ho
// trovato, cosa manca — che e' esattamente la parte che un modello perde per
// strada quando il contesto si riempie.
// ══════════════════════════════════════════════════════════════════════

/**
 * Quanto vale una fonte.
 *
 * Non e' una classifica di qualita' giornalistica: e' "chi ha il dato di
 * prima mano". Per un prezzo di volo la fonte primaria e' il vettore, perche'
 * quel prezzo lo decide lui; un aggregatore lo riporta, e un blog lo ricorda.
 */
const FORZA = {
  primaria: { punti: 3, dice: 'il dato lo produce chi lo pubblica' },
  secondaria: { punti: 2, dice: 'lo riporta, non lo produce' },
  debole: { punti: 1, dice: 'opinioni, forum, contenuti vecchi o senza data' },
};

/** I domini di cui si sa gia' che natura hanno, nel lavoro di Luca. */
const NATURA_NOTA = [
  { dice: /(^|\.)(ita-airways|lufthansa|airfrance|klm|emirates|qatarairways|turkishairlines|ryanair|easyjet|wizzair|vueling|iberia|britishairways|swiss|aegeanair|aireuropa|ana|jal|singaporeair)\./i, forza: 'primaria' },
  { dice: /(^|\.)(dhl|ups|fedex|tnt|gls-group|brt|poste)\./i, forza: 'primaria' },
  { dice: /(^|\.)(iata|icao|enac|easa|eurocontrol|istat|europa\.eu|gov\.|\w+\.gov)\b/i, forza: 'primaria' },
  { dice: /(^|\.)(skyscanner|kayak|momondo|expedia|edreams|booking|trivago|google)\./i, forza: 'secondaria' },
  { dice: /(^|\.)(wikipedia|reuters|ansa|ilsole24ore|corriere)\./i, forza: 'secondaria' },
  { dice: /(^|\.)(reddit|quora|tripadvisor|forum|blogspot|medium|wordpress)\./i, forza: 'debole' },
];

function _dominio(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

/** Che tipo di fonte e'. In dubbio: secondaria — non si promuove per fiducia. */
function forzaDi(url) {
  const d = _dominio(url);
  if (!d) return 'debole';
  for (const n of NATURA_NOTA) if (n.dice.test(d)) return n.forza;
  return 'secondaria';
}

/** Due ricerche sono la stessa se chiedono la stessa cosa con altre parole. */
function _stessaDomanda(a, b) {
  const pulisci = (q) => String(q || '').toLowerCase()
    .replace(/[^a-zà-ù0-9\s]/g, ' ')
    .split(/\s+/).filter((p) => p.length > 2 && !/^(the|and|per|con|del|dei|una|uno|come|dove|quale|quali|site)$/.test(p))
    .sort().join(' ');
  return pulisci(a) === pulisci(b);
}

class Indagine {
  constructor() {
    this.ricerche = [];      // { query, quando, risultati }
    this.fonti = new Map();  // url → { forza, quando, haDato, dominio }
    this.strategieFallite = []; // { cosa, dove, code, volte }
  }

  // ── Quello che si registra da solo, dall'esecutore ──────────────────────

  /** Una ricerca e' stata fatta. Torna false se era gia' stata fatta uguale. */
  cercato(query, quantiRisultati = 0) {
    const q = String(query || '').trim();
    if (!q) return { nuova: false };
    const gemella = this.ricerche.find((r) => _stessaDomanda(r.query, q));
    this.ricerche.push({ query: q, quando: Date.now(), risultati: quantiRisultati });
    if (this.ricerche.length > 100) this.ricerche.shift();
    return { nuova: !gemella, gemella: gemella ? gemella.query : null };
  }

  /** Una fonte e' stata letta, e ha dato qualcosa oppure no. */
  letta(url, haDato) {
    const u = String(url || '').split('?')[0];
    if (!u || !/^https?:/i.test(u)) return;
    this.fonti.set(u, { forza: forzaDi(u), dominio: _dominio(u), quando: Date.now(), haDato: !!haDato });
    if (this.fonti.size > 200) this.fonti.delete(this.fonti.keys().next().value);
  }

  /**
   * Una strategia non ha funzionato.
   *
   * Si registra PRIMA di cambiarla, perche' altrimenti fra due giri la si
   * riprova identica: e' successo per cinque giorni con "leggi la pagina di
   * Skyscanner", trentuno volte.
   */
  fallita(cosa, dove, code) {
    const chiave = `${cosa}@${_dominio(dove) || dove}`;
    const g = this.strategieFallite.find((s) => s.chiave === chiave);
    if (g) { g.volte++; g.code = code || g.code; return g; }
    const s = { chiave, cosa, dove: _dominio(dove) || dove, code, volte: 1 };
    this.strategieFallite.push(s);
    if (this.strategieFallite.length > 40) this.strategieFallite.shift();
    return s;
  }

  // ── Quello che si calcola ──────────────────────────────────────────────

  /**
   * Le lacune: cosa era stato chiesto e non c'e' ancora.
   *
   * Si confronta la checklist dei requisiti col cantiere. Non si chiede a
   * nessuno "cosa manca?": si sottrae.
   */
  lacune(cantiere, soggettiAttesi = [], campiAttesi = []) {
    const fuori = [];
    if (!cantiere) return fuori;

    const presenti = new Map();
    for (const v of cantiere.elenco()) presenti.set(String(v.nome).toLowerCase(), v);

    // Soggetti nominati nella richiesta e mai comparsi.
    for (const s of soggettiAttesi) {
      const chiave = String(s).toLowerCase();
      const trovato = [...presenti.keys()].some((k) => k.includes(chiave) || chiave.includes(k));
      if (!trovato) fuori.push({ tipo: 'soggetto', cosa: s, perche: 'nominato nella richiesta, mai trovato' });
    }

    // Campi vuoti su soggetti che invece ci sono.
    for (const v of cantiere.elenco()) {
      for (const c of campiAttesi) {
        if (!v.campi || !v.campi[c]) {
          fuori.push({ tipo: 'campo', cosa: c, soggetto: v.nome, perche: `manca a ${v.nome}` });
        }
      }
    }
    return fuori;
  }

  /**
   * La prossima ricerca, mirata a UNA lacuna concreta.
   *
   * Non "cerca ancora": cerca QUESTA cosa. E se una ricerca equivalente e'
   * gia' stata fatta, lo dice invece di riproporla — ripetere la stessa
   * domanda a Google non produce risposte diverse.
   */
  prossimeRicerche(lacune, contesto = '') {
    const fuori = [];
    for (const l of lacune.slice(0, 5)) {
      const q = l.tipo === 'soggetto'
        ? `${l.cosa} ${contesto}`.trim()
        : `${l.soggetto} ${l.cosa} ${contesto}`.trim();
      const gia = this.ricerche.find((r) => _stessaDomanda(r.query, q));
      fuori.push({ query: q, per: l, giaFatta: !!gia });
    }
    return fuori;
  }

  /** I domini che non hanno mai reso niente: non vale la pena tornarci. */
  fontiCheNonRendono() {
    const per = new Map();
    for (const [, f] of this.fonti) {
      const d = per.get(f.dominio) || { dominio: f.dominio, lette: 0, conDato: 0, forza: f.forza };
      d.lette++; if (f.haDato) d.conDato++;
      per.set(f.dominio, d);
    }
    return [...per.values()].filter((d) => d.lette >= 2 && d.conDato === 0);
  }

  /**
   * Il blocco da mettere davanti al modello. Poche righe, e solo se c'e'
   * qualcosa di concreto da dire: un avviso che compare sempre non si legge.
   */
  perIlPrompt(cantiere, soggettiAttesi = [], campiAttesi = [], contesto = '') {
    const righe = [];
    const lacune = this.lacune(cantiere, soggettiAttesi, campiAttesi);

    const ripetute = this.ricerche.filter((r, i) =>
      this.ricerche.slice(0, i).some((p) => _stessaDomanda(p.query, r.query)));
    if (ripetute.length >= 2) {
      righe.push(`Hai gia' ripetuto ${ripetute.length} ricerche equivalenti. `
        + 'Riformulare la stessa domanda non cambia la risposta: il dato non e\' nei risultati '
        + 'di ricerca, va preso dal sito compilando il suo modulo.');
    }

    const inutili = this.fontiCheNonRendono();
    if (inutili.length) {
      righe.push(`Questi non hanno mai dato niente: ${inutili.map((d) => d.dominio).join(', ')}. Non tornarci.`);
    }

    const insistite = this.strategieFallite.filter((s) => s.volte >= 2);
    if (insistite.length) {
      righe.push('Gia\' provato e fallito piu\' volte: '
        + insistite.map((s) => `${s.cosa} su ${s.dove} (${s.volte}×, ${s.code || 'senza motivo noto'})`).join(' · '));
    }

    if (lacune.length) {
      const prossime = this.prossimeRicerche(lacune, contesto).filter((p) => !p.giaFatta);
      righe.push('', `Manca ancora: ${lacune.slice(0, 6).map((l) => l.tipo === 'soggetto' ? l.cosa : `${l.cosa} di ${l.soggetto}`).join(', ')}`);
      if (prossime.length) {
        righe.push('Ricerche che chiuderebbero una di queste, mai fatte finora:');
        for (const p of prossime.slice(0, 3)) righe.push(`  - "${p.query}"`);
      }
    }

    if (!righe.length) return '';
    return ['# LA RICERCA, FINORA', '', ...righe].join('\n');
  }

  riepilogo() {
    return {
      ricerche: this.ricerche.length,
      ricercheRipetute: this.ricerche.filter((r, i) =>
        this.ricerche.slice(0, i).some((p) => _stessaDomanda(p.query, r.query))).length,
      fonti: this.fonti.size,
      fontiConDato: [...this.fonti.values()].filter((f) => f.haDato).length,
      perForza: ['primaria', 'secondaria', 'debole'].reduce((a, f) => {
        a[f] = [...this.fonti.values()].filter((x) => x.forza === f).length; return a;
      }, {}),
      strategieFallite: this.strategieFallite.length,
    };
  }

  perIlDisco() {
    return { ricerche: this.ricerche, fonti: [...this.fonti.entries()], strategieFallite: this.strategieFallite };
  }

  static daDisco(d) {
    const i = new Indagine();
    if (!d) return i;
    i.ricerche = Array.isArray(d.ricerche) ? d.ricerche : [];
    i.strategieFallite = Array.isArray(d.strategieFallite) ? d.strategieFallite : [];
    if (Array.isArray(d.fonti)) for (const [k, v] of d.fonti) i.fonti.set(k, v);
    return i;
  }
}

module.exports = { Indagine, forzaDi, FORZA };
