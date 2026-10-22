'use strict';

// The Ralph step registry and the pipeline a profile selects from it.
//
// A step is data the controller runs (ralph/core.js never imports a step module):
//   { name, kind, skipOnDocOnly, label?, blockedStatus?, failedStatus? } plus, by kind,
//   agent: { mode: 'read-only' | 'writes', permissions, buildPrompt(ctx), parseOutput(output, ctx),
//            fix? } — `fix` only on a read-only step: { pass, permissions, budget, buildPrompt(ctx,
//            findings), parseOutput(output, ctx) }, a separate write call after a fixable failure;
//   check: { run(ctx) } — deterministic code, no prompt and no model.
// `permissions` names a controller permission profile; a step never supplies raw rules. Every
// parser and `run` returns an outcome { kind, reason?, type?, summary? } with a kind of
// STEP_OUTCOMES; `type`/`summary` come with a passed write call.
//
// The profile only names registered steps (`ralph.enabledSteps`, `ralph.stepBudgets`); no code is
// loaded from the profile or from a path. A caller can pass its own registry (`deps.stepRegistry`
// of runRalph), e.g. the default steps plus an extension.

const { PERMISSION_PROFILES } = require('../workspace');
const { implement } = require('./implement');
const { selfReview } = require('./self-review');
const { codeReview } = require('./code-review');
const { finalGate } = require('./final-gate');

const FIRST_STEP = 'implement';
const LAST_STEP = 'final-gate';
const BASELINE_PIPELINE = Object.freeze([FIRST_STEP, 'self-review', 'code-review', LAST_STEP]);
// Optional base steps whose relative order an explicit list must keep.
const ORDERED_REVIEWS = Object.freeze(['self-review', 'code-review']);

const STEP_OUTCOMES = Object.freeze(['passed', 'passed-out-of-scope', 'failed', 'blocked', 'human-needed', 'error', 'unparseable']);
const STEP_KINDS = Object.freeze(['agent', 'check']);
const AGENT_MODES = Object.freeze(['read-only', 'writes']);

/** A registry: step name -> step. Two steps with one name are a programming error. */
function createRegistry(steps) {
  const registry = new Map();
  for (const step of steps) {
    if (registry.has(step.name)) throw new Error(`step "${step.name}" is registered twice`);
    registry.set(step.name, step);
  }
  return registry;
}

const DEFAULT_REGISTRY = createRegistry([implement, selfReview, codeReview, finalGate]);

/** The step names of the profile's pipeline: the explicit list, or the baseline when absent. */
const enabledStepNames = (profile) => profile.ralph?.enabledSteps ?? BASELINE_PIPELINE;

/**
 * Structural problems of `ralph.enabledSteps`, independent of any registry: the mandatory steps
 * on their positions and the order of the reviews. Unknown names are not restricted here.
 * @returns {{ path: string, message: string }[]}
 */
function pipelineStructureProblems(ralph) {
  const names = ralph?.enabledSteps;
  if (!Array.isArray(names)) return [];
  const problems = [];
  const at = (message) => problems.push({ path: 'ralph.enabledSteps', message });
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  for (const name of new Set(repeated)) at(`step "${name}" is listed more than once`);
  if (!names.includes(FIRST_STEP)) at(`mandatory step "${FIRST_STEP}" is missing`);
  else if (names[0] !== FIRST_STEP || names.lastIndexOf(FIRST_STEP) !== 0) at(`"${FIRST_STEP}" must be the first step, exactly once`);
  if (!names.includes(LAST_STEP)) at(`mandatory step "${LAST_STEP}" is missing`);
  else if (names.indexOf(LAST_STEP) !== names.length - 1) at(`"${LAST_STEP}" must be the last step, exactly once`);
  const reviews = ORDERED_REVIEWS.map((name) => names.indexOf(name));
  if (reviews.every((index) => index !== -1) && reviews[0] > reviews[1]) at(`"${ORDERED_REVIEWS[0]}" must come before "${ORDERED_REVIEWS[1]}"`);
  return problems;
}

const isFunction = (value) => typeof value === 'function';
const isName = (value) => typeof value === 'string' && value !== '';
const isPermissionProfile = (name) => typeof name === 'string' && Object.hasOwn(PERMISSION_PROFILES, name);

function fixProblems(step) {
  const { fix } = step;
  if (step.mode !== 'read-only') return ['only a read-only step can have a fix'];
  const problems = [];
  if (!isName(fix.pass)) problems.push('fix.pass must be a non-empty string');
  if (!isPermissionProfile(fix.permissions)) problems.push(`fix: unknown permission profile "${fix.permissions}"`);
  if (!Number.isInteger(fix.budget) || fix.budget < 1) problems.push('fix.budget must be an integer >= 1');
  if (!isFunction(fix.buildPrompt) || !isFunction(fix.parseOutput)) problems.push('fix needs buildPrompt and parseOutput');
  return problems;
}

function stepProblems(name, step) {
  if (step === null || typeof step !== 'object') return ['is not a step object'];
  const problems = [];
  if (step.name !== name) problems.push(`is registered under another name than its own ("${step.name}")`);
  if (typeof step.skipOnDocOnly !== 'boolean') problems.push('skipOnDocOnly must be a boolean');
  if (!STEP_KINDS.includes(step.kind)) return [...problems, `unknown kind "${step.kind}"`];
  if (step.kind === 'check') {
    if (!isFunction(step.run)) problems.push('a check step needs run()');
    if (step.fix !== undefined) problems.push('a check step has no fix');
    return problems;
  }
  if (!AGENT_MODES.includes(step.mode)) problems.push(`unknown mode "${step.mode}"`);
  if (!isPermissionProfile(step.permissions)) problems.push(`unknown permission profile "${step.permissions}"`);
  if (!isFunction(step.buildPrompt) || !isFunction(step.parseOutput)) problems.push('an agent step needs buildPrompt and parseOutput');
  if (step.fix !== undefined) problems.push(...fixProblems(step));
  return problems;
}

function budgetProblems(budgets, registry) {
  if (budgets === undefined) return [];
  const problems = [];
  for (const name of Object.keys(budgets)) {
    const step = registry.get(name);
    if (!step) problems.push(`ralph.stepBudgets.${name}: step "${name}" is not registered`);
    else if (step.fix === undefined) problems.push(`ralph.stepBudgets.${name}: step "${name}" has no fix to budget`);
  }
  return problems;
}

/**
 * The pipeline the profile selects from `registry`, checked against it: every registered step is
 * well formed and names known permission profiles, every enabled name is registered, every budget
 * key is a registered step with a fix. Throws a configuration error naming each problem.
 * @returns {{ steps: any[], budgets: Map<string, number> }}
 */
function resolvePipeline(profile, registry = DEFAULT_REGISTRY) {
  if (!(registry instanceof Map)) throw new TypeError('the step registry must be a Map of step name -> step');
  const problems = [];
  for (const [name, step] of registry) {
    for (const problem of stepProblems(name, step)) problems.push(`step "${name}": ${problem}`);
  }
  problems.push(...pipelineStructureProblems(profile.ralph).map(({ path, message }) => `${path}: ${message}`));
  const names = enabledStepNames(profile);
  for (const name of names) {
    if (!registry.has(name)) problems.push(`ralph.enabledSteps: step "${name}" is not registered`);
  }
  problems.push(...budgetProblems(profile.ralph?.stepBudgets, registry));
  if (problems.length > 0) throw new Error(`Configuration error: Ralph step pipeline:\n${problems.map((p) => `- ${p}`).join('\n')}`);

  const budgets = new Map();
  for (const [name, step] of registry) {
    if (step.fix !== undefined) budgets.set(name, profile.ralph?.stepBudgets?.[name] ?? step.fix.budget);
  }
  return { steps: names.map((name) => registry.get(name)), budgets };
}

module.exports = {
  FIRST_STEP,
  LAST_STEP,
  BASELINE_PIPELINE,
  STEP_OUTCOMES,
  DEFAULT_REGISTRY,
  createRegistry,
  enabledStepNames,
  pipelineStructureProblems,
  resolvePipeline,
};
