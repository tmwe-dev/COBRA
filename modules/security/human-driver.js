// modules/security/human-driver.js — Anti-detection middleware for protected platforms
// Source: server.js lines 1108-1222

const HumanDriver = {
  protectedDomains: {
    'linkedin.com':  { tier: 1, delayMultiplier: 3.0, maxPerHour: 15, maxPerDay: 60,  minInterval: 10000, name: 'LinkedIn' },
    'whatsapp.com':  { tier: 1, delayMultiplier: 2.5, maxPerHour: 20, maxPerDay: 80,  minInterval: 8000,  name: 'WhatsApp' },
    'facebook.com':  { tier: 1, delayMultiplier: 2.5, maxPerHour: 20, maxPerDay: 80,  minInterval: 8000,  name: 'Facebook' },
    'instagram.com': { tier: 1, delayMultiplier: 2.5, maxPerHour: 20, maxPerDay: 80,  minInterval: 8000,  name: 'Instagram' },
    'google.com':    { tier: 2, delayMultiplier: 2.0, maxPerHour: 30, maxPerDay: 150, minInterval: 4000,  name: 'Google' },
    'bing.com':      { tier: 2, delayMultiplier: 1.5, maxPerHour: 40, maxPerDay: 200, minInterval: 3000,  name: 'Bing' },
    'twitter.com':   { tier: 2, delayMultiplier: 2.0, maxPerHour: 25, maxPerDay: 100, minInterval: 5000,  name: 'Twitter/X' },
    'x.com':         { tier: 2, delayMultiplier: 2.0, maxPerHour: 25, maxPerDay: 100, minInterval: 5000,  name: 'Twitter/X' },
    'amazon.com':    { tier: 2, delayMultiplier: 1.8, maxPerHour: 30, maxPerDay: 150, minInterval: 4000,  name: 'Amazon' },
    'amazon.it':     { tier: 2, delayMultiplier: 1.8, maxPerHour: 30, maxPerDay: 150, minInterval: 4000,  name: 'Amazon IT' },
    'github.com':    { tier: 3, delayMultiplier: 1.2, maxPerHour: 50, maxPerDay: 300, minInterval: 2000,  name: 'GitHub' },
    'reddit.com':    { tier: 3, delayMultiplier: 1.3, maxPerHour: 40, maxPerDay: 250, minInterval: 2500,  name: 'Reddit' },
    'youtube.com':   { tier: 3, delayMultiplier: 1.2, maxPerHour: 40, maxPerDay: 250, minInterval: 2000,  name: 'YouTube' },
  },
  defaultProfile: { tier: 0, delayMultiplier: 1.0, maxPerHour: 60, maxPerDay: 500, minInterval: 1000, name: 'Default' },
  _sessions: {},

  gaussianRandom(mean, stdDev) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.max(mean * 0.1, mean + z * stdDev);
  },

  getProfile(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      for (const [domain, profile] of Object.entries(this.protectedDomains)) {
        if (hostname === domain || hostname.endsWith('.' + domain)) {
          return { ...profile, domain, isProtected: true };
        }
      }
    } catch {}
    return { ...this.defaultProfile, domain: 'unknown', isProtected: false };
  },

  isProtected(url) { return this.getProfile(url).isProtected; },

  _getSession(domain) {
    if (!this._sessions[domain]) {
      this._sessions[domain] = { pages: 0, totalToday: 0, startTime: Date.now(), lastAction: 0, consecutive: 0 };
    }
    return this._sessions[domain];
  },

  async checkAndDelay(url) {
    const profile = this.getProfile(url);
    if (!profile.isProtected) return { allowed: true, delayed: false };
    const session = this._getSession(profile.domain);
    const now = Date.now();

    if (now - session.startTime > 86400000) { session.totalToday = 0; session.pages = 0; session.startTime = now; session.hourStart = now; }
    if (!session.hourStart) session.hourStart = now;
    if (now - session.hourStart > 3600000) { session.pages = 0; session.hourStart = now; }

    if (session.totalToday >= profile.maxPerDay) {
      return { allowed: false, reason: `Limite giornaliero ${profile.name}: ${profile.maxPerDay}/day` };
    }
    if (session.pages >= profile.maxPerHour) {
      const minutesLeft = Math.ceil((3600000 - (now - session.hourStart)) / 60000);
      return { allowed: false, reason: `Limite orario ${profile.name}: ${profile.maxPerHour}/h — riprova tra ${minutesLeft} min` };
    }

    const elapsed = now - session.lastAction;
    if (elapsed < profile.minInterval) await new Promise(r => setTimeout(r, profile.minInterval - elapsed));

    const baseDelay = this.gaussianRandom(1500, 500) * profile.delayMultiplier;
    const noise = (profile.tier <= 2 && Math.random() < 0.10) ? this.gaussianRandom(3000, 1000) : 0;
    const totalDelay = Math.min(baseDelay + noise, 20000);
    await new Promise(r => setTimeout(r, totalDelay));

    if (profile.tier === 1 && session.consecutive >= 15) {
      session.consecutive = 0;
      await new Promise(r => setTimeout(r, Math.min(this.gaussianRandom(180000, 60000), 300000)));
    }

    session.pages++; session.totalToday++; session.lastAction = Date.now(); session.consecutive++;
    return { allowed: true, delayed: true, delay: Math.round(totalDelay), tier: profile.tier, domain: profile.domain };
  },

  getStats() {
    const stats = {};
    for (const [domain, session] of Object.entries(this._sessions)) {
      const profile = this.protectedDomains[domain] || this.defaultProfile;
      stats[domain] = {
        tier: profile.tier, pages: session.pages, totalToday: session.totalToday,
        hourlyRemaining: profile.maxPerHour - session.pages,
        dailyRemaining: profile.maxPerDay - session.totalToday,
      };
    }
    return stats;
  },
};

module.exports = { HumanDriver };
