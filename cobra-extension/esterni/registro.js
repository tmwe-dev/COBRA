// cobra-extension/esterni/registro.js — Dove i comandi si dichiarano.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// background.js era 146 KB, e dentro c'era un `switch` di 3.804 righe con
// novantanove `case`. Non è un problema estetico: è il motivo per cui l'8
// agosto ho scritto `linkedin_collegati` senza accorgermi che
// `esterni/li/actions.js` — caricato nello stesso service worker — aveva già
// un `sendConnectionRequest`. In un file di quelle dimensioni non vedi cosa
// c'è già, e la duplicazione nasce da sola.
//
// Lo stesso file conteneva anche il difetto opposto: comandi scritti e mai
// collegati, che nessuno poteva chiamare. Da fuori le due cose sono
// indistinguibili — silenzio in tutti e due i casi.
//
// ── COME FUNZIONA ──
//
// Ogni area dichiara i suoi comandi:
//
//     Registro.comando('whatsapp_rispondi', async (args) => { … });
//
// e background.js smette di sapere cosa fanno: chiede al registro chi
// risponde a quel nome. Diventa un centralinista invece di un archivio.
//
// ── DUE COSE CHE IL REGISTRO IMPEDISCE ──
//
// 1. Registrare due volte lo stesso nome è un ERRORE, non un caso: significa
//    che due file fanno la stessa cosa, e vince l'ultimo caricato — che è
//    esattamente il guasto del ponte fantasma, in un'altra stanza.
//
// 2. Chi c'è si può contare e confrontare con gli schemi del server. Uno
//    strumento dichiarato al modello e non registrato qui non è un bug
//    silenzioso: è un test rosso.
//
// ── PERCHÉ NON UNA CLASSE ──
//
// Gira in un service worker, caricato con importScripts, che condivide un solo
// spazio globale. Meno cerimonie ci sono, meno cose possono rompersi al
// risveglio del worker — che si spegne e si riaccende da solo, spesso.
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const _comandi = new Map();     // nome -> { fn, area }
  const _doppioni = [];           // chi ha provato a registrare due volte

  /**
   * Dichiara un comando.
   *
   * @param {string} nome  il nome con cui il server lo chiama
   * @param {function} fn  async (args, contesto) => risultato
   * @param {string} area  a cosa appartiene, per il riepilogo
   */
  function comando(nome, fn, area = 'senza area') {
    const n = String(nome || '').trim();
    if (!n || typeof fn !== 'function') {
      console.error('[Registro] comando non valido:', nome);
      return false;
    }
    if (_comandi.has(n)) {
      // Non si sovrascrive in silenzio. Due implementazioni dello stesso
      // comando significano che una delle due e' morta senza saperlo, e
      // scoprirlo fra un mese costa quanto e' costato oggi.
      const gia = _comandi.get(n);
      _doppioni.push({ nome: n, primo: gia.area, secondo: area });
      console.error(`[Registro] "${n}" registrato due volte: ${gia.area} e ${area}. Tengo il primo.`);
      return false;
    }
    _comandi.set(n, { fn, area });
    return true;
  }

  /** Registra tutti i comandi di un'area in una volta. */
  function area(nome, mappa) {
    let quanti = 0;
    for (const [k, fn] of Object.entries(mappa || {})) {
      if (comando(k, fn, nome)) quanti++;
    }
    return quanti;
  }

  function ha(nome) { return _comandi.has(String(nome || '')); }

  /** Esegue, se c'e'. Chi chiama deve aver gia' controllato con ha(). */
  async function esegui(nome, args, contesto) {
    const v = _comandi.get(String(nome || ''));
    if (!v) return { ok: false, motivo: `comando sconosciuto: ${nome}` };
    return await v.fn(args || {}, contesto || {});
  }

  /** Chi c'e', per la diagnosi e per le prove. */
  function elenco() {
    const per = {};
    for (const [nome, v] of _comandi) {
      (per[v.area] = per[v.area] || []).push(nome);
    }
    return {
      quanti: _comandi.size,
      aree: Object.keys(per).sort(),
      per,
      doppioni: _doppioni,
      nomi: [..._comandi.keys()].sort(),
    };
  }

  globalThis.Registro = { comando, area, ha, esegui, elenco };
})();
