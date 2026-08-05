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

async function avvia(args, ctx) {
  const obiettivo = String(args.obiettivo || '').trim();
  const passi = Array.isArray(args.passi) ? args.passi : [];
  if (obiettivo.length < 5) return JSON.stringify({ error: 'Serve un obiettivo comprensibile in una frase' });
  if (passi.length < 2) return JSON.stringify({ error: 'Un processo ha senso da due passi in su. Per un\'azione singola usa direttamente lo strumento.' });
  if (passi.length > 15) return JSON.stringify({ error: 'Troppi passi: raggruppali, il massimo è 15' });

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
