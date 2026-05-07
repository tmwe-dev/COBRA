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
  router.post('/api/pending-actions/*/approve', (body, res, url) => {
    const id = url.split('/')[3];
    const result = ctx.approvePendingAction(id, 'operator');
    if (result.ok) {
      ctx.session.currentApprovalToken = result.approval_token;
      ctx.wsBroadcast({ type: 'pending_action_approved', id, approval_token: result.approval_token });
      ctx.log(`[Security] Pending action ${id} APPROVED`);
    }
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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
