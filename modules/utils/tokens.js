// Utils - Token estimation and management
function estimateTokens(text) {
  if (!text) return 0;
  // Rough estimate: 4 chars ≈ 1 token
  return Math.ceil(text.length / 4);
}

const TokenMeter = {
  _log: [],
  MAX_LOG_SIZE: 1000,
  // P0.4: Budget cap enforcement
  _budgetCap: parseInt(process.env.COBRA_TOKEN_BUDGET_CAP, 10) || 0, // 0 = unlimited
  _totalConsumed: 0,
  _budgetExceeded: false,

  track(entry) {
    const rec = {
      provider: entry.provider,
      model: entry.model,
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      totalTokens: (entry.promptTokens || 0) + (entry.completionTokens || 0),
      intent: entry.intent || 'unknown',
      systemPromptTokens: entry.systemPromptTokens || 0,
      timestamp: new Date().toISOString(),
    };
    this._log.push(rec);
    this._totalConsumed += rec.totalTokens;
    if (this._log.length > this.MAX_LOG_SIZE) {
      this._log.shift();
    }
    // Check budget cap
    if (this._budgetCap > 0 && this._totalConsumed >= this._budgetCap) {
      this._budgetExceeded = true;
      console.log(`[TokenMeter] BUDGET CAP EXCEEDED: ${this._totalConsumed} >= ${this._budgetCap}`);
    }
  },

  /**
   * checkBudget() — Returns { allowed: bool, remaining: number, consumed: number, cap: number }
   * Call BEFORE making an AI call. If allowed=false, block the call.
   */
  checkBudget() {
    if (this._budgetCap <= 0) return { allowed: true, remaining: Infinity, consumed: this._totalConsumed, cap: 0 };
    const remaining = Math.max(0, this._budgetCap - this._totalConsumed);
    return {
      allowed: !this._budgetExceeded,
      remaining,
      consumed: this._totalConsumed,
      cap: this._budgetCap,
    };
  },

  /**
   * setBudgetCap(cap) — Set or update the budget cap at runtime.
   */
  setBudgetCap(cap) {
    this._budgetCap = cap;
    this._budgetExceeded = cap > 0 && this._totalConsumed >= cap;
  },

  getStats() {
    if (this._log.length === 0) return { total: 0, byProvider: {}, budget: this.checkBudget() };
    const byProvider = {};
    let total = 0;
    for (const rec of this._log) {
      if (!byProvider[rec.provider]) byProvider[rec.provider] = { tokens: 0, calls: 0 };
      byProvider[rec.provider].tokens += rec.totalTokens;
      byProvider[rec.provider].calls++;
      total += rec.totalTokens;
    }
    return { total, byProvider, calls: this._log.length, budget: this.checkBudget() };
  },

  clear() {
    this._log = [];
    this._totalConsumed = 0;
    this._budgetExceeded = false;
  },

  log() {
    return [...this._log];
  },
};

module.exports = {
  estimateTokens,
  TokenMeter,
};
