// ══════════════════════════════════════════════════════════════
// lib/super-mario/context-builder.js — Prompt context assembly
// ══════════════════════════════════════════════════════════════

module.exports = function createContextBuilder(deps) {
  const { log, SUPABASE_URL, SUPABASE_ANON_KEY, VOICE_RULES, loadPersonaFromKB } = deps;

  async function buildContextParts(session, scopes, selectedToolNames, TOOL_RISK) {
    const contextParts = [];

    if (session.lastPage && scopes.some(s => ['browse', 'interact', 'search', 'data'].includes(s))) {
      const pageText = (session.lastPage.markdown || '').substring(0, 3000);
      contextParts.push(`# PAGINA CORRENTE\nURL: ${session.lastPage.url}\nTitolo: ${session.lastPage.title}\n${pageText}`);
    }

    if (session._tasks && session._tasks.length > 0) {
      const jobList = session._tasks.map(t => {
        const tags = t.tags ? ` [${t.tags}]` : '';
        const runs = t.runs ? ` (eseguito ${t.runs}x)` : '';
        const desc = t.description ? ` — ${t.description.substring(0, 80)}` : '';
        return `- [ID:${t.id}] "${t.name}" (${t.steps.length} step)${tags}${runs}${desc}`;
      }).join('\n');
      contextParts.push(`# JOB DISPONIBILI (${session._tasks.length})\n${jobList}\nPer eseguire: chiama run_task con task_id o task_name.\nSe l'utente chiede qualcosa di correlato a un job → PROPONI di eseguirlo.`);
    }

    if (session.operatorConfig?.operator_name) {
      const ops = [`Nome: ${session.operatorConfig.operator_name}`];
      if (session.operatorConfig.email_address) ops.push(`Email: ${session.operatorConfig.email_address}`);
      contextParts.push(`# OPERATORE\n${ops.join('\n')}`);
    }

    try {
      const contextTags = ['always'];
      if (scopes.includes('search')) contextTags.push('search', 'web', 'navigate');
      if (scopes.includes('browse')) contextTags.push('browse', 'web', 'navigate', 'browser', 'navigation');
      if (scopes.includes('interact')) contextTags.push('interact', 'browser', 'form', 'workflow', 'datepicker', 'calendar', 'dropdown', 'widget', 'modal', 'ui');
      if (scopes.includes('data')) contextTags.push('data', 'extract', 'analysis');
      if (scopes.includes('communicate')) contextTags.push('email', 'communication', 'whatsapp', 'linkedin', 'channel_selection');
      if (scopes.includes('file')) contextTags.push('file', 'filesystem');
      if (scopes.includes('admin')) contextTags.push('admin', 'kb', 'job');
      if (scopes.includes('sales')) contextTags.push('sales', 'outreach', 'b2b', 'wca', 'partner', 'template', 'followup', 'objections', 'communication');
      if (scopes.includes('tmwe')) contextTags.push('tmwe', 'company', 'truth', 'capabilities');
      if (scopes.includes('findair')) contextTags.push('findair', 'platform', 'pitch', 'forbidden_claims');
      if (scopes.includes('memory')) contextTags.push('memory', 'save', 'correction', 'learning', 'priority');
      if (scopes.includes('logistics')) contextTags.push('tmwe', 'findair', 'logistics');
      const kbEntries = await loadPersonaFromKB(contextTags);
      const nonIdentity = kbEntries.filter(e => e.rule_type !== 'identity');
      if (nonIdentity.length > 0) {
        const kbText = nonIdentity.map(e => `[${e.title}] ${e.content.substring(0, 1200)}`).join('\n\n');
        contextParts.push(`# KNOWLEDGE BASE\n${kbText}`);
      }
    } catch (e) { /* silent */ }

    return contextParts;
  }

  function buildToolContext(selectedToolNames, scopes, intent, TOOL_RISK) {
    if (selectedToolNames.length === 0) return '';

    const toolGroups = {};
    for (const name of selectedToolNames) {
      const risk = TOOL_RISK[name] || { level: 'unknown' };
      if (!toolGroups[risk.level]) toolGroups[risk.level] = [];
      toolGroups[risk.level].push(name);
    }
    const groupText = Object.entries(toolGroups)
      .map(([level, tools]) => `  ${level.toUpperCase()}: ${tools.join(', ')}`)
      .join('\n');
    return `# TOOL IN QUESTO TURNO (${selectedToolNames.length})\nScope attivi: [${scopes.join(', ')}]\nOperation level: ${intent === 'chat' ? 'read' : 'standard'}\n${groupText}`;
  }

  return {
    buildContextParts,
    buildToolContext,
  };
};
