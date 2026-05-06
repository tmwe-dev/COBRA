// modules/config/constants.js — Risk levels, risk confirmation, TTL
// Source: server.js lines 74-88

const RISK_LEVELS = [
  'read', 'inspect', 'prepare', 'write_local', 'write_form',
  'interact', 'write_kb', 'send_prepare', 'send', 'destructive',
];

function maxRisk(a, b) {
  return RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b;
}

const RISK_REQUIRES_CONFIRMATION = {
  read: false, inspect: false, prepare: false,
  write_local: false, write_form: false, interact: false,
  write_kb: true, send_prepare: true, send: true, destructive: true,
};

const RISK_DEFAULT_TTL = {
  read: null, inspect: null, prepare: null,
  write_local: null, write_form: null, interact: null,
  write_kb: 600, send_prepare: 300, send: 600, destructive: 60,
};

module.exports = {
  RISK_LEVELS, maxRisk,
  RISK_REQUIRES_CONFIRMATION, RISK_DEFAULT_TTL,
};
