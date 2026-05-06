/**
 * lib/research-strategy.js
 * Research task management and cross-reference validation
 * ~60 lines
 */

const ResearchStrategy = {
  rules: {
    minSources: 3,
    minSourcesRead: 2,
    maxRetries: 3,
    maxQueryVariations: 3,
    crossReferenceMin: 2,
    maxTotalPages: 25,
    freshnessMaxDays: 365,
  },
  _sources: [],
  _currentTask: null,

  startTask(taskId, type = 'general') {
    this._currentTask = {
      id: taskId || `research_${Date.now()}`,
      type,
      startTime: Date.now(),
      sources: [],
      queries: [],
      findings: [],
      confidence: 0,
      status: 'in_progress',
    };
    return this._currentTask;
  },

  registerSource(source) {
    const entry = {
      url: source.url,
      title: source.title || '',
      readAt: new Date().toISOString(),
      relevance: source.relevance || 'medium',
    };
    this._sources.push(entry);
    if (this._currentTask) this._currentTask.sources.push(entry);
    return entry;
  },

  registerQuery(query, engine = 'google', resultsCount = 0) {
    const entry = { query, engine, resultsCount, timestamp: new Date().toISOString() };
    if (this._currentTask) this._currentTask.queries.push(entry);
    return entry;
  },

  registerFinding(finding) {
    const entry = {
      fact: finding.fact,
      confidence: finding.confidence || 0.5,
      sources: finding.sources || [],
      crossReferenced: (finding.sources || []).length >= this.rules.crossReferenceMin,
    };
    if (this._currentTask) this._currentTask.findings.push(entry);
    return entry;
  },

  evaluate() {
    if (!this._currentTask) return { ok: false };
    const task = this._currentTask;
    const sourcesScore = Math.min(1, task.sources.length / this.rules.minSources);
    const crossCount = task.findings.filter(f => f.crossReferenced).length;
    const crossScore = task.findings.length > 0 ? crossCount / task.findings.length : 0;
    const score = sourcesScore * 0.5 + crossScore * 0.5;
    return {
      ok: true,
      score: Math.round(score * 100) / 100,
      sufficient: score >= 0.6,
      sources: task.sources.length,
      findings: task.findings.length,
    };
  },

  shouldContinue() {
    if (!this._currentTask) return { continue: false };
    const task = this._currentTask;
    if (task.sources.length >= this.rules.maxTotalPages) return { continue: false, action: 'synthesize' };
    const eval_ = this.evaluate();
    if (eval_.sufficient) return { continue: false, action: 'synthesize' };
    return { continue: true, action: eval_.score >= 0.3 ? 'search_more' : 'rephrase_query' };
  },

  completeTask(summary = '') {
    if (!this._currentTask) return null;
    const task = this._currentTask;
    const eval_ = this.evaluate();
    task.status = 'completed';
    task.duration = Date.now() - task.startTime;
    task.summary = summary;
    task.evaluation = eval_;
    const report = {
      taskId: task.id,
      duration: `${Math.round(task.duration / 1000)}s`,
      sources: task.sources.length,
      confidence: Math.round(eval_.score * 100) + '%',
    };
    this._currentTask = null;
    return report;
  },
};

module.exports = { ResearchStrategy };
