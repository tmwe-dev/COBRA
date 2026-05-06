// lib/persona.js — CobraPersona 5-layer prompt system + PersonaLearner
// Extracted from server.js lines 1543-1766

const fs = require('fs');
const path = require('path');

function createCobraPersona(deps) {
  const { log, COBRA_CORE } = deps;
  let _version = 1;
  const _layers = {
    identity: '',
    style: '',
    rules: '',
    context: '',
    override: '',
  };

  function getLayer(id) { return _layers[id] || ''; }

  function setLayer(id, text, reason = 'manual') {
    if (!_layers.hasOwnProperty(id)) { log(`[Persona] Unknown layer: ${id}`); return; }
    _layers[id] = text;
    _version++;
    log(`[Persona] Layer "${id}" updated (v${_version}) — reason: ${reason}`);
  }

  function resetLayer(id) {
    if (_layers.hasOwnProperty(id)) { _layers[id] = ''; _version++; }
  }

  function resetAll() {
    for (const k of Object.keys(_layers)) _layers[k] = '';
    _version++;
  }

  function compose(options = {}) {
    const parts = [COBRA_CORE || ''];
    for (const [id, content] of Object.entries(_layers)) {
      if (content) parts.push(`\n\n--- ${id.toUpperCase()} ---\n${content}`);
    }
    if (options.voiceMode) {
      parts.push('\n\n--- VOICE MODE ---\nRispondi in modo conciso, adatto alla lettura vocale. Frasi brevi, max 15-18 parole.');
    }
    return parts.join('');
  }

  function getAllLayers() { return { ..._layers }; }
  function getVersion() { return _version; }

  async function proposeImprovement({ layer, evidence, rationale }) {
    if (!_layers.hasOwnProperty(layer)) return { accepted: false, reason: 'Unknown layer' };
    log(`[Persona] Improvement proposed for "${layer}": ${rationale}`);
    return { accepted: false, reason: 'Requires operator approval', proposed: { layer, evidence, rationale } };
  }

  return { getLayer, setLayer, resetLayer, resetAll, compose, getAllLayers, getVersion, proposeImprovement };
}

function createCobraPersonaLearner(deps) {
  const { log, CobraPersona } = deps;
  const dataDir = path.join(__dirname, '..', 'data');

  function _loadAudit() {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'persona_audit.json'), 'utf8')); }
    catch { return []; }
  }
  function _saveAudit(audit) {
    try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, 'persona_audit.json'), JSON.stringify(audit.slice(-200))); } catch {}
  }

  function detectCorrection(messageText) {
    const patterns = [
      { re: /non\s+(dire|usare|fare|scrivere)\s+"?([^"]+)"?/i, type: 'forbidden', layer: 'style' },
      { re: /d'ora in poi\s+(.+)/i, type: 'rule_change', layer: 'rules' },
      { re: /ricordati\s+(che|di)\s+(.+)/i, type: 'context', layer: 'context' },
      { re: /sei\s+(troppo|poco)\s+(\w+)/i, type: 'style_adjust', layer: 'style' },
    ];
    for (const p of patterns) {
      const m = messageText.match(p.re);
      if (m) return { ...p, match: m };
    }
    return null;
  }

  async function onOperatorMessage(messageText) {
    const correction = detectCorrection(messageText);
    if (!correction) return;
    const audit = _loadAudit();
    audit.push({ ts: new Date().toISOString(), type: correction.type, layer: correction.layer, text: messageText.substring(0, 200) });
    _saveAudit(audit);
    log(`[PersonaLearner] Correction detected: ${correction.type} on layer ${correction.layer}`);
  }

  function getAuditTrail(limit = 50) {
    return _loadAudit().slice(-limit);
  }

  return { detectCorrection, onOperatorMessage, getAuditTrail };
}

module.exports = { createCobraPersona, createCobraPersonaLearner };
