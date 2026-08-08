// modules/tools/handlers/cantiere.js — Gli strumenti per posare il lavoro.

/**
 * Posa quello che si è appena trovato, prima di andare avanti.
 *
 * Senza questo, un lavoro su otto soggetti finiva così: si apre il primo sito,
 * si legge la email, si passa al secondo, e al terzo la prima email è già
 * uscita dal contesto. Alla fine il modello aveva sette pagine lette e niente
 * in mano — verificato il 6 agosto su una raccolta di aziende.
 */
async function annota(args, ctx) {
  const c = ctx.session.cantiere;
  if (!c) return JSON.stringify({ error: 'Nessun lavoro in corso da annotare.' });

  let campi = args.campi;
  if (typeof campi === 'string') { try { campi = JSON.parse(campi); } catch { campi = {}; } }

  const esito = c.annota(args.nome, campi || {}, args.fonte || ctx.session.lastPage?.url || '');
  if (!esito.ok) return JSON.stringify({ error: esito.motivo });

  const r = c.riepilogo();
  ctx.emitReasoning(`Annotato: ${args.nome}${r.attese ? ` (${r.complete}/${r.attese} completi)` : ''}`, '📌');
  ctx.wsBroadcast({ type: 'cantiere', ...r, elenco: c.elenco().map(v => v.nome) });

  return JSON.stringify({
    ok: true,
    annotato: args.nome,
    raccolteFinora: r.voci,
    complete: r.complete,
    ancoraDaTrovare: r.attese > r.voci ? r.attese - r.voci : 0,
    buchi: c.buchi().slice(0, 5),
    nota: r.finito ? 'Il lavoro è completo: adesso puoi produrre il file.'
      : 'Continua: posa ogni cosa appena la trovi, non aspettare la fine.',
  });
}

/** Cosa c'è già sul tavolo, senza doverselo ricordare. */
async function statoCantiere(args, ctx) {
  const c = ctx.session.cantiere;
  if (!c) return JSON.stringify({ error: 'Nessun lavoro in corso.' });
  return JSON.stringify({ ok: true, ...c.riepilogo(), raccolto: c.elenco(), buchi: c.buchi() });
}

/**
 * Il file si scrive da quello che è sul tavolo, non da quello che il modello
 * ricorda. È la differenza fra un elenco completo e uno che si ferma alle
 * prime tre voci, perché le altre erano uscite dal contesto.
 */
async function scriviDalCantiere(args, ctx) {
  const c = ctx.session.cantiere;
  if (!c || c.elenco().length === 0) {
    return JSON.stringify({ error: 'Non c\'è ancora niente sul tavolo: usa annota mentre trovi le cose.' });
  }
  const righe = c.perIlFile();
  const r = c.riepilogo();
  if (r.buchi > 0) {
    ctx.log(`[Cantiere] Scrivo il file con ${r.buchi} voci incomplete: lo dico invece di tacerlo`);
  }
  const nome = String(args.filename || 'raccolta.xlsx').replace(/[^\w.-]/g, '_');
  const handlers = require('./data');
  const esito = await handlers.create_file({ filename: nome, rows: righe }, ctx);
  const letto = JSON.parse(esito);
  return JSON.stringify({
    ...letto,
    voci: r.voci,
    complete: r.complete,
    incomplete: r.buchi,
    nota: r.buchi > 0
      ? `Attenzione: ${r.buchi} voci hanno ancora campi vuoti. Dillo a Luca invece di far finta di niente.`
      : 'Tutte le voci sono complete.',
  });
}

module.exports = { annota, stato_lavoro: statoCantiere, scrivi_raccolta: scriviDalCantiere };
