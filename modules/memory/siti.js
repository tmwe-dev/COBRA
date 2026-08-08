// modules/memory/siti.js — Quello che si è imparato su un sito, usandolo.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE, E PERCHÉ È IL VANTAGGIO VERO
//
// Un agente generalista arriva su booking.com per la millesima volta e non sa
// niente più della prima. Ogni volta riscopre dov'è il campo destinazione, che
// c'è un banner cookie, che il calendario si comporta in un certo modo.
//
// COBRA lavora sempre sugli stessi venti portali: TMWE, DHL, UPS, LinkedIn,
// WhatsApp, i siti dei vettori. Su quelli può sapere delle cose che nessun
// modello generico sa — non perché sia più intelligente, ma perché ci è già
// stato.
//
// ── COSA SI RICORDA ──
//
// Non i selettori: quelli li tiene già mappa.js, ed è giusto lì. Qui si
// ricorda l'ESPERIENZA:
//
//   quali strategie hanno funzionato e quali no, su questo sito
//   quanto ci mette una pagina a diventare utilizzabile
//   che tipo di ostacoli mette (banner, login, paywall)
//   quali guasti si ripetono, e cosa li ha risolti
//
// ── LA PARTE CHE CONTA: IMPARARE DAI FALLIMENTI ──
//
// Quando il metodo A fallisce e il metodo B riesce, questo non è un dettaglio
// del turno: è un'informazione che vale per tutte le volte dopo. Senza
// registrarla, al prossimo giro si riprova A — e su un sito che si usa ogni
// giorno significa perdere gli stessi trenta secondi per sempre.
//
// L'8 agosto: quattro tentativi identici di mandare una richiesta di
// collegamento, quattro "Extension timeout". Ognuno dei quattro sapeva quanto
// il primo. Se il primo fallimento fosse rimasto scritto, il secondo tentativo
// sarebbe partito da un'altra parte.
//
// ── COSA NON FA ──
//
// Non decide. Non è un motore, non ha stati, non dice cosa fare: annota fatti
// e li restituisce a chi deve scegliere. Le decisioni restano dove sono già —
// nel Collega, nel recupero, nel cancello.
//
// E non ricorda per sempre: un'esperienza di tre mesi fa su un sito che nel
// frattempo è stato rifatto è peggio di nessuna esperienza. Le cose vecchie
// scadono.
// ══════════════════════════════════════════════════════════════════════

const path = require('path');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

const SCADENZA_GIORNI = 30;
const MASSIMO_SITI = 200;
const MASSIME_NOTE_PER_SITO = 40;

/** Il dominio, senza www e senza rumore: è la chiave giusta. */
function dominioDi(url) {
  try {
    const u = new URL(String(url));
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    // Se non è un indirizzo, magari è già un dominio.
    const t = String(url || '').trim().toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(t) ? t : '';
  }
}

class MemoriaSiti {
  constructor(dataDir) {
    this.file = path.join(dataDir || './data', 'memoria_siti.json');
    this.siti = readJsonSafeSync(this.file, {}) || {};
    this._pulisci();
  }

  /** Le cose vecchie se ne vanno: un sito rifatto rende bugiarda l'esperienza. */
  _pulisci() {
    const limite = Date.now() - SCADENZA_GIORNI * 24 * 60 * 60 * 1000;
    for (const [dominio, s] of Object.entries(this.siti)) {
      s.note = (s.note || []).filter(n => (n.quando || 0) > limite);
      if (!s.note.length) delete this.siti[dominio];
    }
    // Se sono troppi si tengono i più usati di recente: la memoria serve sui
    // siti di tutti i giorni, non su quello aperto una volta a marzo.
    const nomi = Object.keys(this.siti);
    if (nomi.length > MASSIMO_SITI) {
      nomi.sort((a, b) => (this.siti[b].ultimoUso || 0) - (this.siti[a].ultimoUso || 0));
      for (const n of nomi.slice(MASSIMO_SITI)) delete this.siti[n];
    }
  }

  _salva() {
    try { writeJsonAtomicSync(this.file, this.siti); } catch (_) { /* la memoria non blocca il lavoro */ }
  }

  _sito(dominio) {
    if (!this.siti[dominio]) {
      this.siti[dominio] = { dominio, note: [], visite: 0, ultimoUso: 0 };
    }
    return this.siti[dominio];
  }

  /**
   * Si annota un fatto osservato su un sito.
   *
   * I fatti si FONDONO per soggetto, non si accumulano: venti volte "il banner
   * cookie c'è" sono una nota con conferme: 20, non venti note. Senza questo la
   * memoria diventa un registro illeggibile, ed è già successo con le lezioni.
   */
  annota(url, { cosa, tipo = 'osservazione', esito = null, dettaglio = '' } = {}) {
    const dominio = dominioDi(url);
    if (!dominio || !cosa) return { ok: false, motivo: 'serve il sito e cosa si è visto' };

    const s = this._sito(dominio);
    s.ultimoUso = Date.now();
    s.visite = (s.visite || 0) + 1;

    const chiave = `${tipo}|${String(cosa).toLowerCase().slice(0, 60)}`;
    const gia = s.note.find(n => n.chiave === chiave);
    if (gia) {
      gia.conferme = (gia.conferme || 1) + 1;
      gia.quando = Date.now();
      if (esito !== null) gia.esito = esito;
      if (dettaglio) gia.dettaglio = dettaglio;
    } else {
      s.note.push({ chiave, tipo, cosa: String(cosa).slice(0, 120), esito,
        dettaglio: String(dettaglio || '').slice(0, 200), conferme: 1, quando: Date.now() });
      if (s.note.length > MASSIME_NOTE_PER_SITO) {
        s.note.sort((a, b) => (b.conferme - a.conferme) || (b.quando - a.quando));
        s.note = s.note.slice(0, MASSIME_NOTE_PER_SITO);
      }
    }
    this._salva();
    return { ok: true, dominio, note: s.note.length };
  }

  /**
   * A ha fallito, B ha funzionato: la coppia vale più delle due note separate.
   *
   * È l'informazione che trasforma un errore in un vantaggio permanente. Al
   * prossimo giro su questo sito, B si prova per prima.
   */
  imparaDalFallimento(url, { fallito, riuscito, perche = '' } = {}) {
    if (!fallito) return { ok: false, motivo: 'serve almeno cosa non ha funzionato' };
    this.annota(url, { cosa: fallito, tipo: 'non_funziona', esito: false, dettaglio: perche });
    if (riuscito) {
      this.annota(url, { cosa: riuscito, tipo: 'funziona', esito: true,
        dettaglio: `ha risolto dove "${fallito}" falliva` });
    }
    return { ok: true, dominio: dominioDi(url) };
  }

  /** Quanto ci mette questa pagina a essere utilizzabile, per esperienza. */
  annotaLentezza(url, millisecondi) {
    const dominio = dominioDi(url);
    if (!dominio || !(millisecondi > 0)) return { ok: false };
    const s = this._sito(dominio);
    const v = s.tempi || { quante: 0, media: 0, massimo: 0 };
    v.quante += 1;
    v.media = Math.round(v.media + (millisecondi - v.media) / v.quante);
    v.massimo = Math.max(v.massimo, Math.round(millisecondi));
    s.tempi = v;
    s.ultimoUso = Date.now();
    this._salva();
    return { ok: true, media: v.media, massimo: v.massimo };
  }

  /** Quello che si sa di un sito. Vuoto se non ci si è mai stati. */
  cosaSoDi(url) {
    const dominio = dominioDi(url);
    const s = dominio && this.siti[dominio];
    if (!s) return { conosciuto: false, dominio };
    return {
      conosciuto: true,
      dominio,
      visite: s.visite || 0,
      tempi: s.tempi || null,
      funziona: s.note.filter(n => n.tipo === 'funziona').sort((a, b) => b.conferme - a.conferme),
      nonFunziona: s.note.filter(n => n.tipo === 'non_funziona').sort((a, b) => b.conferme - a.conferme),
      ostacoli: s.note.filter(n => n.tipo === 'ostacolo').sort((a, b) => b.conferme - a.conferme),
      altro: s.note.filter(n => !['funziona', 'non_funziona', 'ostacolo'].includes(n.tipo)),
    };
  }

  /**
   * Il blocco da mettere nel prompt prima di lavorare su un sito.
   *
   * Corto per forza: se costasse molto smetterebbe di essere conveniente, e
   * quello che serve sono tre righe — cosa ha funzionato, cosa no, cosa
   * aspettarsi.
   */
  perIlPrompt(url) {
    const s = this.cosaSoDi(url);
    if (!s.conosciuto) return '';
    const righe = [`# SU ${s.dominio.toUpperCase()} CI SEI GIÀ STATO (${s.visite} volte)`];

    if (s.funziona.length) {
      righe.push('Ha funzionato:');
      for (const n of s.funziona.slice(0, 4)) {
        righe.push(`  ✓ ${n.cosa}${n.conferme > 1 ? ` (${n.conferme} volte)` : ''}`);
      }
    }
    if (s.nonFunziona.length) {
      righe.push('NON ha funzionato — non riprovarlo:');
      for (const n of s.nonFunziona.slice(0, 4)) {
        righe.push(`  ✗ ${n.cosa}${n.dettaglio ? ` — ${n.dettaglio}` : ''}`);
      }
    }
    if (s.ostacoli.length) {
      righe.push('Cosa aspettarsi:');
      for (const n of s.ostacoli.slice(0, 3)) righe.push(`  · ${n.cosa}`);
    }
    if (s.tempi && s.tempi.quante >= 2) {
      righe.push(`Tempi: di solito ${Math.round(s.tempi.media / 1000)}s, fino a ${Math.round(s.tempi.massimo / 1000)}s.`);
    }
    return righe.length > 1 ? righe.join('\n') : '';
  }

  /** Quanti siti conosce, per il pannello e per le prove. */
  riepilogo() {
    const siti = Object.values(this.siti);
    return {
      quanti: siti.length,
      note: siti.reduce((n, s) => n + (s.note || []).length, 0),
      piuUsati: siti.sort((a, b) => (b.visite || 0) - (a.visite || 0)).slice(0, 5)
        .map(s => ({ dominio: s.dominio, visite: s.visite })),
    };
  }
}

module.exports = { MemoriaSiti, dominioDi, SCADENZA_GIORNI };
