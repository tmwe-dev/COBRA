// modules/memory/tira-lezioni.js — Chi guarda com'è andata e ne trae qualcosa.
//
// Le lezioni non si scrivono da sole. Serviva qualcuno che, finito il lavoro,
// guardasse com'è andata e ne tirasse fuori le poche cose che varrà la pena
// sapere domani.
//
// Lo fa il CODICE, non un modello. Motivo: le cose che contano qui sono
// fatti misurabili — questa pagina ha reso 267 caratteri, quel banner si è
// tolto cliccando quel bottone, questa strada ha portato al file e quella no.
// Chiedere a un modello di dedurle costerebbe una chiamata e introdurrebbe
// la possibilità di inventarle. Qui non serve fantasia: serve un registro.

const { Lezioni } = require('./lezioni');

function dominioDi(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Che tipo di lavoro era, in due parole, per ritrovare la strada domani. */
function tipoDiLavoro(obiettivo) {
  const t = String(obiettivo || '').toLowerCase();
  if (/aziend|fornitor|client|contatt|email/.test(t)) return 'raccogliere aziende';
  if (/volo|voli|aere/.test(t)) return 'cercare voli';
  if (/hotel|albergo|soggiorn/.test(t)) return 'cercare hotel';
  if (/prezz|tariff|costo|costi|listin/.test(t)) return 'cercare prezzi';
  if (/articol|notizi|rassegna|stampa/.test(t)) return 'rassegna articoli';
  if (/modulo|compila|form/.test(t)) return 'compilare moduli';
  return '';
}

/**
 * Guarda com'è andato il turno e scrive quello che vale la pena ricordare.
 *
 * @param {object} ctx        il contesto del turno
 * @param {object} esito      { obiettivo, riuscito, pagine, ostacoli, moduli }
 * @returns {object}          quante lezioni nuove e quante confermate
 */
function tiraLezioni(ctx, esito = {}) {
  if (!ctx || !ctx.dataDir) return { nuove: 0, confermate: 0 };
  const L = ctx._lezioni || (ctx._lezioni = new Lezioni(ctx.dataDir));

  let nuove = 0, confermate = 0;
  const conta = (r) => { if (r && r.ok) { if (r.nuova) nuove++; else confermate++; } };

  // ── 1. Le pagine che hanno reso e quelle che hanno fatto perdere tempo ──
  for (const p of (esito.pagine || [])) {
    const dom = dominioDi(p.url || p);
    if (!dom) continue;
    const car = Number(p.caratteri || 0);

    if (p.bloccata) {
      conta(L.impara('ostacolo', dom, 'risponde con una schermata di blocco anti-bot: non insistere, cerca un\'altra fonte'));
    } else if (car > 0 && car < 400) {
      conta(L.impara('ostacolo', dom, `torna quasi vuoto (${car} caratteri): si disegna in JavaScript, allo scraper non arriva niente`));
    } else if (p.secondi && p.secondi > 15 && car > 2000) {
      conta(L.impara('tempo', dom, `i dati compaiono dopo ${Math.round(p.secondi)} secondi: aspettare meno significa leggere il guscio`));
    }
  }

  // ── 2. Gli ostacoli superati: come, esattamente ──
  for (const o of (esito.ostacoli || [])) {
    const dom = dominioDi(o.url || '');
    if (!dom || !o.azioni || !o.azioni.length) continue;
    const cliccato = o.azioni.find(a => /^cliccato:/.test(a));
    if (cliccato) {
      conta(L.impara('ostacolo', dom, `il banner si toglie cliccando "${cliccato.replace('cliccato:', '').trim()}"`));
    }
  }

  // ── 3. I moduli già visti: che campi hanno ──
  for (const m of (esito.moduli || [])) {
    const dom = dominioDi(m.url || '');
    if (!dom || !m.campi || !m.campi.length) continue;
    const nomi = m.campi.slice(0, 8).map(c => c.etichetta || c.selettore).filter(Boolean);
    if (nomi.length) conta(L.impara('modulo', dom, `il modulo ha: ${nomi.join(', ')}`));
  }

  // ── 4. La strada: quella che ha portato al risultato ──
  //
  // È la lezione più preziosa e la più difficile da ricavare, quindi si
  // registra solo quando il lavoro è RIUSCITO: una strada che non ha portato
  // da nessuna parte non è una strada da consigliare.
  const tipo = tipoDiLavoro(esito.obiettivo);
  if (tipo && esito.riuscito) {
    const buone = (esito.pagine || [])
      .filter(p => Number(p.caratteri || 0) > 1500 && !p.bloccata)
      .map(p => dominioDi(p.url || p))
      .filter(Boolean);
    const uniche = [...new Set(buone)].slice(0, 4);
    if (uniche.length) {
      conta(L.impara('strada', tipo, `ha funzionato passando da: ${uniche.join(', ')}`));
    }
  }

  if (nuove || confermate) {
    ctx.log(`[Lezioni] Imparato dal lavoro: ${nuove} nuove, ${confermate} confermate `
      + `(${L.riepilogo().totale} in archivio)`);
  }
  return { nuove, confermate, archivio: L.riepilogo() };
}

module.exports = { tiraLezioni, tipoDiLavoro };
