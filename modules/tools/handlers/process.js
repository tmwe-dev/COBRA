// modules/tools/handlers/process.js — Strumenti per condurre un processo a passi
//
// L'AI dichiara il piano e aggiorna i passi; il motore fa rispettare le regole.
// Nessuna delle condizioni di completamento passa da qui: se il motore rifiuta,
// il messaggio d'errore spiega perché, e quello diventa il vincolo.

const { Processo } = require('../../process/engine');

function trasmetti(ctx) {
  const p = ctx.session.processo;
  if (!p) return;
  ctx.wsBroadcast({ type: 'processo', ...p.riepilogo() });
}

// Due obiettivi sono lo stesso obiettivo se dicono le stesse cose: si
// confrontano le parole che contano, non la punteggiatura o l'ordine.
// "Organizzare viaggio a Tokyo per 8 persone con voli e hotel" e
// "Organizzare un viaggio a Tokyo per 8 persone con dettagli sui voli"
// sono lo stesso lavoro visto due volte.
const _PAROLINE = new Set(['il','lo','la','i','gli','le','un','uno','una','di','a','da','in','con','su','per','tra','fra','e','del','della','dei','delle','al','alla','ai','sul','che','non','piu']);
function _paroleUtili(testo) {
  return new Set(String(testo || '').toLowerCase()
    .replace(/[^a-zà-ù0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 2 && !_PAROLINE.has(p)));
}
function _stessoObiettivo(a, b) {
  const A = _paroleUtili(a), B = _paroleUtili(b);
  if (A.size === 0 || B.size === 0) return false;
  let comuni = 0;
  for (const p of A) if (B.has(p)) comuni++;
  // Rispetto al piu' piccolo dei due: un obiettivo piu' lungo che contiene
  // tutto il precedente sta comunque rifacendo lo stesso lavoro.
  return comuni / Math.min(A.size, B.size) >= 0.7;
}

async function avvia(args, ctx) {
  const obiettivo = String(args.obiettivo || '').trim();
  const passi = Array.isArray(args.passi) ? args.passi : [];
  if (obiettivo.length < 5) return JSON.stringify({ error: 'Serve un obiettivo comprensibile in una frase' });
  if (passi.length < 2) return JSON.stringify({ error: 'Un processo ha senso da due passi in su. Per un\'azione singola usa direttamente lo strumento.' });
  if (passi.length > 15) return JSON.stringify({ error: 'Troppi passi: raggruppali, il massimo è 15' });

  // ── Un piano non si riscrive da capo mentre lo si sta eseguendo ──
  //
  // Prova fisica del 6 agosto, richiesta Tokyo: CINQUE piani avviati nello
  // stesso turno, quattro dei quali con l'obiettivo praticamente identico.
  // Ogni piano nuovo azzerava i progressi del precedente, quindi non si
  // arrivava mai in fondo a nessuno, e sullo schermo si accatastavano
  // pannelli che dicevano tutti "0/3 in corso".
  //
  // Rifare lo stesso piano non è ripianificare: è ricominciare. Se invece
  // l'obiettivo è davvero un altro — dopo un cambio di strada, per esempio —
  // il piano nuovo ci sta, ma si dice che il vecchio viene abbandonato.
  const inCorso = ctx.session.processo;
  if (inCorso && !inCorso.concluso() && !inCorso.interrotto()) {
    if (_stessoObiettivo(inCorso.obiettivo, obiettivo)) {
      ctx.log(`[Processo] Piano già in corso sullo stesso obiettivo: non lo rifaccio da capo`);
      return JSON.stringify({
        ok: true,
        giaAvviato: true,
        ...inCorso.riepilogo(),
        promemoria: 'Questo piano è già avviato e i passi già chiusi restano chiusi. '
          + 'Non riavviarlo: riprendi dal primo passo non ancora completato.',
      });
    }
    const r = inCorso.riepilogo();
    ctx.log(`[Processo] Abbandono il piano "${inCorso.obiettivo}" (${r.completati || 0}/${r.totale || 0}) per uno nuovo`);
  }

  const normalizzati = passi.map(p => (typeof p === 'string' ? { titolo: p } : p));
  ctx.session.processo = new Processo(obiettivo, normalizzati);
  ctx.log(`[Processo] Avviato: "${obiettivo}" con ${normalizzati.length} passi`);
  trasmetti(ctx);
  const p = ctx.session.processo;
  const risposta = {
    ok: true,
    ...p.riepilogo(),
    promemoria: 'Esegui i passi uno per volta. Ogni passo si chiude allegando il risultato dello strumento usato.',
  };
  // Le dipendenze scartate vanno segnalate: il modello deve sapere che il
  // piano che ha in mente non è quello che il motore ha registrato.
  if (p.avvisi.length > 0) {
    risposta.avvisi = p.avvisi;
    ctx.log(`[Processo] Piano corretto: ${p.avvisi.join('; ')}`);
  }
  return JSON.stringify(risposta);
}

async function iniziaPasso(args, ctx) {
  const p = ctx.session.processo;
  if (!p) return JSON.stringify({ error: 'Nessun processo in corso: avvialo con processo_avvia' });
  const esito = p.iniziaPasso(args.passo);
  trasmetti(ctx);
  if (!esito.ok) return JSON.stringify({ error: esito.motivo });
  ctx.emitReasoning(`Passo ${esito.passo.n}: ${esito.passo.titolo}`, '▶');
  return JSON.stringify({ ok: true, passo: esito.passo.n, titolo: esito.passo.titolo });
}

async function completaPasso(args, ctx) {
  const p = ctx.session.processo;
  if (!p) return JSON.stringify({ error: 'Nessun processo in corso' });
  const esito = p.completaPasso(args.passo, args.prova);
  trasmetti(ctx);
  if (!esito.ok) return JSON.stringify({ error: esito.motivo });
  ctx.emitReasoning(`Passo ${esito.passo.n} completato`, '☑');
  const r = p.riepilogo();
  return JSON.stringify({
    ok: true, completati: r.completati, totale: r.totale,
    prossimo: p.prossimoPasso()?.titolo || null,
    concluso: r.concluso,
  });
}

async function falliscePasso(args, ctx) {
  const p = ctx.session.processo;
  if (!p) return JSON.stringify({ error: 'Nessun processo in corso' });
  const esito = p.falliscePasso(args.passo, args.motivo);
  trasmetti(ctx);
  if (!esito.ok) return JSON.stringify({ error: esito.motivo });
  ctx.log(`[Processo] Passo ${args.passo} fallito: ${args.motivo}`);
  return JSON.stringify({
    ok: true,
    processoInterrotto: esito.bloccaTutto,
    nota: esito.bloccaTutto
      ? 'Questo passo era necessario: il processo non può proseguire. Riferisci cosa si è bloccato.'
      : 'Passo non necessario: prosegui con gli altri.',
  });
}

async function statoProcesso(args, ctx) {
  const p = ctx.session.processo;
  if (!p) return JSON.stringify({ info: 'Nessun processo in corso' });
  return JSON.stringify(p.riepilogo());
}

module.exports = {
  processo_avvia: avvia,
  processo_inizia_passo: iniziaPasso,
  processo_completa_passo: completaPasso,
  processo_fallisci_passo: falliscePasso,
  processo_stato: statoProcesso,
};
