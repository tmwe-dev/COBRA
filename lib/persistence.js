/**
 * lib/persistence.js
 * JSON file loading/saving and file path constants
 * ~30 lines
 */

const fs = require('fs');
const path = require('path');

const TASKS_FILE = path.join(__dirname, '..', 'data', 'cobra_tasks.json');
const MEMORIES_FILE = path.join(__dirname, '..', 'data', 'cobra_memories.json');
const PAYWALL_FILE = path.join(__dirname, '..', 'data', 'cobra_paywalls.json');

function loadJSON(filePath, fallback = []) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function saveJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function persistTasks(tasks) { saveJSON(TASKS_FILE, tasks); }
function persistMemories(memories) { saveJSON(MEMORIES_FILE, memories); }
function savePaywallDomains(domains) { saveJSON(PAYWALL_FILE, [...domains]); }

module.exports = {
  TASKS_FILE, MEMORIES_FILE, PAYWALL_FILE,
  loadJSON, saveJSON,
  persistTasks, persistMemories, savePaywallDomains,
};
