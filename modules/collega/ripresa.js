// modules/collega/ripresa.js — Riprendere un lavoro rimasto a metà, senza
// farselo riscrivere.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// Adesso il lavoro sopravvive al turno: il cantiere dice cosa è stato
// raccolto, il piano dice dove si è arrivati, i criteri dicono quando sarà
// finito. Ma sopravvivere non basta — bisogna che qualcuno lo riprenda.
//
// Finora la ripresa dipendeva da Luca: doveva riscrivere la richiesta, e
// riscrivendola otteneva un incarico nuovo, un piano nuovo, e un modello che
// ricominciava. Il lavoro c'era su disco e nessuno lo guardava.
//
// ── COSA FA, E COSA NON FA ──
//
// NON è un secondo agente. Non chiama nessun modello, non decide strategie,
// non riformula niente. È codice deterministico che risponde a tre domande:
//
//   1. c'è un lavoro aperto che non è finito?      → il cancello lo dice
//   2. questo messaggio riguarda quel lavoro?      → si confrontano le parole
//   3. cosa deve sapere chi riprende?              → il pacchetto qui sotto
//
// Il modello riceve un foglio con: l'obiettivo, i criteri, cosa è già fatto,
// cosa manca esattamente, e il prossimo passo che può partire. Non la
// cronologia: quella è lunga, costosa e piena di tentativi falliti che non
// servono più.
//
// ── LA RIGA PIÙ IMPORTANTE DEL PACCHETTO ──
//
//     NON RICOMINCIARE DA CAPO
//
// Non è enfasi. Senza quella riga il modello, vedendo un obiettivo e una lista
// di cose mancanti, rifà il lavoro dall'inizio — ed è quello che è successo
// per quattro tentativi di fila su otto aziende. Con otto soggetti da
// raccogliere, ricominciare significa non arrivare mai in fondo.
// ══════════════════════════════════════════════════════════════════════

const { decidi, STATI } = require('./completamento');

/** Le parole con cui una persona dice "vai avanti con quella cosa di prima". */
const _RIPRENDI = /^\s*(vai|continua|prosegui|riprendi|avanti|va bene|procedi|finisci|completa|dai)\b/i;

/**
 * Parole che contano di una frase: le stesse dell'archivio, perché la domanda
 * è la stessa — stiamo parlando dello stesso lavoro?
 */
const PAROLINE = new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da',
  'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'del', 'della', 'dei', 'delle', 'al', 'alla', 'ai',
  'che', 'non', 'piu', 'mi', 'ti', 'ci', 'si', 'come', 'anche', 'sono', 'ho', 'hai']);

function _parole(t) {
  return new Set(String(t || '').toLowerCase().replace(/[^a-zà-ù0-9\s]/g, ' ')
    .split(/\s+/).filter(p => p.length > 2 && !PAROLINE.has(p)));
}

function _quantoSiSomigliano(a, b) {
  const A = _parole(a), B = _parole(b);
  if (!A.size || !B.size) return 0;
  let comuni = 0;
  for (const p of A) if (B.has(p)) comuni++;
  return comuni / Math.min(A.size, B.size);
}

/**
 * Va ripreso il lavoro aperto, oppure questa è un'altra cosa?
 *
 * Tre casi, e l'ordine conta:
 *
 *   "vai" / "continua"        → sì, e non serve altro: sta rispondendo a noi.
 *   frase che parla di quello → sì: ha riformulato invece di dire "vai".
 *   qualunque altra cosa      → no: si lascia il lavoro dov'è e si fa questo.
 *
 * Il terzo caso è quello che protegge: se Luca cambia argomento, riprendere il
 * lavoro vecchio significherebbe ignorare quello che ha appena chiesto.
 */
function dovrebbeRiprendere(messaggio, lavoro) {
  if (!lavoro || (!lavoro.processo && !lavoro.cantiere)) {
    return { si: false, perche: 'non c\'è nessun lavoro aperto' };
  }
  const m = String(messaggio || '').trim();

  if (_RIPRENDI.test(m) && m.length < 40) {
    return { si: true, come: 'me lo ha detto', perche: `"${m}" risponde a un lavoro lasciato aperto` };
  }

  const obiettivo = lavoro.obiettivo || (lavoro.processo && lavoro.processo.obiettivo) || '';
  const somiglianza = _quantoSiSomigliano(obiettivo, m);
  if (somiglianza >= 0.5) {
    return { si: true, come: 'parla della stessa cosa',
      perche: `la richiesta somiglia al lavoro aperto (${Math.round(somiglianza * 100)}%)` };
  }

  return { si: false, perche: 'la richiesta parla d\'altro: il lavoro aperto resta dov\'è' };
}

/**
 * Il foglio che riceve chi riprende.
 *
 * Corto per scelta. La cronologia completa costa molto e contiene i tentativi
 * falliti, che sono proprio le strade da non ripercorrere. Qui c'è lo stato,
 * non la storia.
 */
function pacchettoDiRipresa(lavoro, verdetto) {
  const righe = [];
  const proc = lavoro.processo;
  const cant = lavoro.cantiere;
  const obiettivo = lavoro.obiettivo || (proc && proc.obiettivo) || '';

  righe.push('# SI RIPRENDE UN LAVORO GIÀ COMINCIATO');
  righe.push('');
  righe.push('**NON RICOMINCIARE DA CAPO.** Quello che c\'è resta e vale.');
  righe.push('Completa SOLO le cose elencate sotto come mancanti.');
  righe.push('');
  if (obiettivo) righe.push(`OBIETTIVO: ${obiettivo}`);

  // ── Cosa è già fatto ──
  if (proc) {
    const chiusi = proc.passi.filter(p => p.stato === 'completato');
    const falliti = proc.passi.filter(p => p.stato === 'fallito');
    if (chiusi.length) {
      righe.push('');
      righe.push(`GIÀ FATTI (${chiusi.length} su ${proc.passi.length}) — non rifarli:`);
      for (const p of chiusi) righe.push(`  ✓ ${p.n}. ${p.titolo}`);
    }
    if (falliti.length) {
      righe.push('');
      righe.push('GIÀ PROVATI E FALLITI — cambia strada, non ripetere:');
      for (const p of falliti) righe.push(`  ✗ ${p.n}. ${p.titolo} — ${p.motivo || 'senza motivo'}`);
    }
  }

  if (cant && typeof cant.elenco === 'function') {
    const voci = cant.elenco();
    const complete = voci.filter(v => !v.incompleta);
    if (voci.length) {
      righe.push('');
      righe.push(`GIÀ RACCOLTO: ${voci.length} voci`
        + (complete.length !== voci.length ? ` (${complete.length} complete)` : ''));
      for (const v of voci.slice(0, 12)) {
        const campi = v.campi ? Object.entries(v.campi).filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join(', ') : '';
        righe.push(`  · ${v.nome}${campi ? ' — ' + campi : ' — (ancora vuota)'}`);
      }
      if (voci.length > 12) righe.push(`  · … e altre ${voci.length - 12}`);
    }
  }

  // ── Cosa manca: è la parte operativa ──
  if (verdetto && verdetto.mancano && verdetto.mancano.length) {
    righe.push('');
    righe.push('MANCA QUESTO, e solo questo:');
    for (const m of verdetto.mancano) righe.push(`  ☐ ${m}`);
  }

  // ── Da dove ripartire ──
  if (proc && typeof proc.prossimoPasso === 'function') {
    const p = proc.prossimoPasso();
    righe.push('');
    if (p) righe.push(`RIPARTI DAL PASSO ${p.n}: ${p.titolo}`);
    else if (typeof proc.inStallo === 'function' && proc.inStallo()) {
      // Lo stallo non è un dettaglio: significa che nessun passo può partire,
      // quindi insistere sul piano è inutile. Va detto, non nascosto.
      righe.push('IL PIANO È IN STALLO: nessun passo può partire, perché quelli '
        + 'da cui dipendono sono falliti. Non insistere sul piano — trova un\'altra '
        + 'strada per l\'obiettivo, oppure di\' a Luca cosa lo blocca.');
    }
  }

  if (lavoro.criteri && lavoro.criteri.length) {
    righe.push('');
    righe.push('SARÀ FINITO QUANDO: ' + lavoro.criteri.map(c => {
      if (c.tipo === 'soggetti_coperti') return `trattati tutti: ${(c.soggetti || []).join(', ')}`;
      if (c.tipo === 'campi_obbligatori') return `ogni voce ha: ${(c.campi || []).join(', ')}`;
      if (c.tipo === 'elementi_minimi') return `almeno ${c.quanti} risultati`;
      if (c.tipo === 'file_atteso') return `c'è un file .${c.estensione}`;
      if (c.tipo === 'origine_verificabile') return 'ogni numero viene da una pagina aperta';
      return c.tipo;
    }).join('; '));
  }

  return righe.join('\n');
}

/**
 * Il Supervisore: guarda un lavoro su disco e dice cosa farne.
 *
 * Deterministico per scelta. Un supervisore che chiedesse a un modello se il
 * lavoro è finito avrebbe lo stesso difetto che stiamo curando: il modello
 * direbbe di sì.
 */
function guarda(lavoro, messaggio = '') {
  const decisione = dovrebbeRiprendere(messaggio, lavoro);
  if (!decisione.si) return { riprendere: false, perche: decisione.perche };

  const verdetto = decidi({
    incarico: lavoro.criteri ? { criteri: lavoro.criteri } : null,
    cantiere: lavoro.cantiere,
    passi: lavoro.processo
      ? lavoro.processo.passi.map(p => ({
          step: p.n,
          ok: p.stato === 'completato' ? true : (p.stato === 'fallito' ? false : undefined),
          motivo: p.motivo,
          tool: p.titolo,
        })).filter(p => p.ok !== undefined)
      : [],
  });

  if (verdetto.stato === STATI.COMPLETO) {
    return { riprendere: false, perche: 'il lavoro aperto risulta già finito', verdetto };
  }

  return {
    riprendere: true,
    come: decisione.come,
    perche: decisione.perche,
    verdetto,
    pacchetto: pacchettoDiRipresa(lavoro, verdetto),
  };
}

module.exports = { guarda, dovrebbeRiprendere, pacchettoDiRipresa, _quantoSiSomigliano };
