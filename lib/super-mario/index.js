// ══════════════════════════════════════════════════════════════
// lib/super-mario/index.js — Main export & assembly
// ══════════════════════════════════════════════════════════════

const createRouteIntent = require('./route-intent');
const createResolveAgent = require('./resolve-agent');
const createToolSelector = require('./tool-selector');
const createDecompose = require('./decompose');
const createAssemble = require('./assemble');
const createAudit = require('./audit');
const createMemory = require('./memory');
const createLogging = require('./logging');
const createModelRouter = require('./model-router');
const createContextBuilder = require('./context-builder');

module.exports = function createSuperMario(deps) {
  // Create sub-modules with dependencies
  const routeIntentModule = createRouteIntent(deps);
  const resolveAgentModule = createResolveAgent(deps);
  const toolSelectorModule = createToolSelector(deps);
  const decomposeModule = createDecompose(deps);
  const auditModule = createAudit(deps);
  const memoryModule = createMemory(deps);
  const loggingModule = createLogging(deps);
  const modelRouterModule = createModelRouter(deps);
  const contextBuilderModule = createContextBuilder(deps);

  // Assemble needs other modules as deps
  const assembleModule = createAssemble({
    ...deps,
    selectTools: toolSelectorModule.selectTools,
    preflightAudit: auditModule.preflightAudit,
    resolveAgent: resolveAgentModule.resolveAgent,
    buildMemoryBlock: memoryModule.buildMemoryBlock,
    buildContextParts: contextBuilderModule.buildContextParts,
    buildToolContext: contextBuilderModule.buildToolContext,
  });

  // Return merged SuperMario object
  return {
    // From route-intent
    routeIntent: routeIntentModule.routeIntent,
    clarifyIntentWithLLM: routeIntentModule.clarifyIntentWithLLM,
    setIntent: routeIntentModule.setIntent,

    // From resolve-agent
    resolveAgent: resolveAgentModule.resolveAgent,

    // From tool-selector
    selectTools: toolSelectorModule.selectTools,
    validateToolCall: toolSelectorModule.validateToolCall,
    RUNTIME_CONTRACT: toolSelectorModule.RUNTIME_CONTRACT,
    TOOL_SCOPES: toolSelectorModule.TOOL_SCOPES,
    TOOL_RISK_REGISTRY: toolSelectorModule.TOOL_RISK_REGISTRY,

    // From decompose
    decompose: decomposeModule.decompose,
    buildPlanPrompt: decomposeModule.buildPlanPrompt,
    savePlanTemplate: decomposeModule.savePlanTemplate,

    // From assemble
    assemble: assembleModule.assemble,

    // From audit
    preflightAudit: auditModule.preflightAudit,
    postflightAudit: auditModule.postflightAudit,

    // From logging
    complete: loggingModule.complete,
    logInvocation: loggingModule.logInvocation,
    logToolExecution: loggingModule.logToolExecution,
    getInvocationLog: loggingModule.getInvocationLog,

    // From memory
    buildMemoryBlock: memoryModule.buildMemoryBlock,
    updateNarrativeSummary: memoryModule.updateNarrativeSummary,
    clearSummaryCache: memoryModule.clearSummaryCache,

    // From model-router
    selectModel: modelRouterModule.selectModel,
    getModelForProvider: modelRouterModule.getModelForProvider,
    MODEL_TIERS: modelRouterModule.MODEL_TIERS,

    // Utilities
    getRuntimeContract: () => toolSelectorModule.RUNTIME_CONTRACT,
    getToolRisk: (name) => toolSelectorModule.TOOL_RISK_REGISTRY[name] || { level: 'unknown', confirm: true },
  };
};
