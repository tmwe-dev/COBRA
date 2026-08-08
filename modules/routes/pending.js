// modules/routes/pending.js — /api/pending-actions/* (Security Runtime)
// Source: server.js lines 8556-8587

function register(router, ctx) {
  // ── GET /api/pending-actions ──
  router.get('/api/pending-actions', (body, res) => {
    const pending = ctx.getActivePendingActions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending_actions: pending }));
  });

  // ── POST /api/pending-actions/:id/approve ──
  //
  // APPROVARE DEVE FAR SUCCEDERE LA COSA
  //
  // L'8 agosto, richiesta di collegamento a Brandon Dvorak: lo strumento e'
  // stato chiamato, intercettato come "send", il riquadro e' comparso, Luca
  // ha premuto approva — e non e' successo niente. Il gettone finiva in
  // sessione, il riquadro spariva, e la richiesta di collegamento non
  // partiva. Il turno era gia' chiuso: non c'era piu' nessuno a rifare la
  // chiamata.
  //
  // Scrivere "procedi" in chat invece funzionava, perche' li' parte un turno
  // nuovo e il modello richiama lo strumento col gettone in mano. Due strade
  // per la stessa cosa, e quella col pulsante era senza uscita.
  //
  // L'azione in attesa conserva strumento e argomenti: dopo l'approvazione
  // si riesegue quella, esattamente com'era. Non si ricostruisce niente e
  // non si chiede al modello di ripensarci — l'unica cosa che mancava era
  // il permesso, e adesso c'e'.
  router.post('/api/pending-actions/*/approve', async (body, res, url) => {
    const id = url.split('/')[3];
    const inAttesa = (ctx.getActivePendingActions('default') || []).find(a => a.id === id);
    const result = ctx.approvePendingAction(id, 'operator');

    if (!result.ok) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    ctx.session.currentApprovalToken = result.approval_token;
    ctx.wsBroadcast({ type: 'pending_action_approved', id, approval_token: result.approval_token });
    ctx.log(`[Security] Pending action ${id} APPROVED`);

    // La risposta parte subito: l'azione puo' durare mezzo minuto e il
    // pulsante non deve restare a girare.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result, eseguo: !!(inAttesa && inAttesa.tool_name) }));

    if (!inAttesa || !inAttesa.tool_name) return;

    try {
      ctx.wsBroadcast({ type: 'ai_reasoning', text: `Approvato: eseguo ${inAttesa.tool_name}`, icon: '🔓' });
      const grezzo = await ctx.executeTool(inAttesa.tool_name, inAttesa.tool_args || {});
      let esito = {}; try { esito = JSON.parse(grezzo || '{}'); } catch (_) { esito = {}; }
      const riuscito = esito.ok !== false && !esito.error && !esito.errore;
      ctx.log(`[Security] Azione approvata eseguita: ${inAttesa.tool_name} — ${riuscito ? 'fatta' : 'non riuscita'}`);
      ctx.wsBroadcast({ type: 'tool_done', tool: inAttesa.tool_name, ok: riuscito });
      ctx.wsBroadcast({
        type: 'ai_response',
        text: riuscito
          ? `Fatto: ${inAttesa.summary || inAttesa.tool_name}.`
          : `Non riuscita: ${esito.motivo || esito.error || esito.errore || 'senza motivo'}.`,
      });
    } catch (e) {
      ctx.log(`[Security] Azione approvata NON eseguita: ${e.message}`);
      ctx.wsBroadcast({ type: 'ai_response', text: `Non riuscita: ${e.message}` });
    }
  });

  // ── POST /api/pending-actions/:id/reject ──
  router.post('/api/pending-actions/*/reject', (body, res, url) => {
    const id = url.split('/')[3];
    const result = ctx.rejectPendingAction(id, 'operator');
    if (result.ok) {
      ctx.wsBroadcast({ type: 'pending_action_rejected', id });
      ctx.log(`[Security] Pending action ${id} REJECTED`);
    }
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
}

module.exports = { register };
