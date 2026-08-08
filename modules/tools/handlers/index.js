// modules/tools/handlers/index.js — Registry di tutti i tool handlers
// Ogni handler module esporta { toolName: handlerFn(args, ctx) }

const navigate = require('./navigate');
const search = require('./search');
const readScrape = require('./read-scrape');
const dom = require('./dom');
const interaction = require('./interaction');
const browserControl = require('./browser-control');
const bridgeTools = require('./bridge-tools');
const data = require('./data');
const communication = require('./communication');
const processo = require('./process');
const cantiere = require('./cantiere');
const accesso = require('./accesso');
const manualiTool = require('./manuali');

// Merge all handlers into a single map
const allHandlers = {
  ...cantiere,
  ...accesso,
  ...manualiTool,
  ...navigate,
  ...search,
  ...readScrape,
  ...dom,
  ...interaction,
  ...browserControl,
  ...bridgeTools,
  ...data,
  ...communication,
  ...processo,
};

module.exports = allHandlers;
