'use strict';

// Entry point of the Ralph controller. It works in the consumer repository, with that repository's
// validated profile and the operator's local run config (outside Git). The consumer root is the
// explicit `--consumer-root` or, without it, the top of the git repository of the current
// directory (the current directory is only the starting point of that search). Nothing is taken
// from the directory of the installed package.
//
// Order of a run: readiness checks without side effects (profile settings the enabled controller
// needs, the step pipeline against the step registry, local config, runs root, consumer repository and origin, block labels) -> lock in the
// runs root -> sandbox startup (Docker engine, leftovers, image) -> the issue loop.

const fs = require('node:fs');
const path = require('node:path');
const {
  BLOCK_LABEL,
  LOCAL_CONFIG_RELATIVE_PATH,
  validateLocalConfig,
  loadLocalConfig,
  lockPathFor,
  statePathFor,
  writeState,
  acquireLock,
  releaseLock,
} = require('./config');
const github = require('./github');
const { runIssue } = require('./core');
const { resolveAgentModel } = require('./agent');
const sandbox = require('./sandbox');
const { branchNameFor } = require('../profile/branch');
const { DEFAULT_REGISTRY, resolvePipeline } = require('./steps/registry');
const { freezeSnapshot } = require('./trusted-profile');
const { loadProfile } = require('../profile/load');

// Groups classify()'s per-issue statuses into what's ready to run vs. why everything else isn't,
// and renders the summary lines. Pure: no I/O.
function summarizeStatuses(statuses, excluded) {
  const byStatus = (status) => statuses.filter((s) => s.status === status);
  const unknown = byStatus('unknown');
  const inFlight = byStatus('in-flight');
  const blocked = byStatus('blocked');
  const blockedByDependency = byStatus('blocked-by-dependency');
  const unapproved = byStatus('unapproved');
  const notStarted = byStatus('not-started');
  const ready = notStarted.filter((s) => s.ready && !excluded.has(s.id));
  const waiting = notStarted.filter((s) => !s.ready);

  const lines = [];
  if (unknown.length > 0) {
    lines.push(`⚠️ Состояние Issue (или его PR) не удалось получить с GitHub: ${unknown.map((e) => `#${e.id}`).join(', ')}`);
  }
  if (blocked.length > 0) {
    lines.push(`🚫 Заблокированы лейблом (${BLOCK_LABEL} или human-needed): ${blocked.map((e) => `#${e.id}`).join(', ')}`);
  }
  if (blockedByDependency.length > 0) {
    lines.push(`🚫 Заблокированы транзитивно через зависимость: ${blockedByDependency.map((e) => `#${e.id}`).join(', ')}`);
  }
  if (unapproved.length > 0) {
    lines.push(`🔒 Спека не одобрена: ${unapproved.map((e) => `#${e.id} (${e.unapprovedReason})`).join(', ')}`);
  }

  if (ready.length === 0) {
    if (inFlight.length > 0) {
      lines.push(`⏳ Есть Issue с открытым PR, ждут review/merge: ${inFlight.map((e) => `#${e.id}`).join(', ')}.`);
    }
    if (waiting.length > 0) {
      lines.push(`⏳ Есть Issue, ждущие своей зависимости: ${waiting.map((e) => `#${e.id}`).join(', ')}.`);
    }
    const nothingElseOutstanding =
      inFlight.length === 0 && waiting.length === 0 && blocked.length === 0 && blockedByDependency.length === 0 && unapproved.length === 0;
    lines.push(nothingElseOutstanding ? '✅ Все Issue из конфига закрыты. Ralph loop завершён.' : '⏸️ Ничего не готово к запуску прямо сейчас. Останавливаюсь.');
  }

  return { unknown, inFlight, blocked, blockedByDependency, unapproved, notStarted, ready, waiting, lines };
}

// Profile settings an enabled controller needs beyond what loadProfile accepts. Named exactly; no
// project default is assumed for any of them.
const REQUIRED_PROFILE_SETTINGS = [
  { field: 'ralph.humanNeededVerdict', read: (profile) => profile.ralph?.humanNeededVerdict },
  { field: 'labels.humanNeeded', read: (profile) => profile.labels?.humanNeeded },
  { field: 'ralph.techDebtTrackerIssue', read: (profile) => profile.ralph?.techDebtTrackerIssue },
  { field: 'sandbox', read: (profile) => profile.sandbox },
];

function assertControllerSettings(profile) {
  if (profile?.ralph?.enabled !== true) {
    throw new Error('Ralph is not enabled in the profile (ralph.enabled is not true); the controller does not run.');
  }
  const missing = REQUIRED_PROFILE_SETTINGS.filter(({ read }) => read(profile) === undefined).map(({ field }) => field);
  if (missing.length > 0) {
    throw new Error(`Configuration error: the enabled Ralph controller needs these profile fields: ${missing.join(', ')}`);
  }
}

const samePath = (a, b) => {
  const resolve = (p) => {
    const real = fs.realpathSync.native(path.resolve(p));
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return resolve(a) === resolve(b);
};

// The consumer root must be the top of a git repository with an origin; every git/gh call of the
// controller runs there or in its clone.
function assertRepositoryTop(consumerRoot) {
  let topLevel;
  try {
    topLevel = github.git(['rev-parse', '--show-toplevel'], { cwd: consumerRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`Consumer root ${consumerRoot} is not a git repository: ${error.message}`, { cause: error });
  }
  if (!samePath(topLevel, consumerRoot)) {
    throw new Error(`Consumer root ${consumerRoot} is not the top of its git repository (${topLevel})`);
  }
}

function assertConsumerRepository(consumerRoot) {
  assertRepositoryTop(consumerRoot);
  try {
    return github.originUrlOf(consumerRoot);
  } catch (error) {
    throw new Error(`Consumer root ${consumerRoot} has no origin remote: ${error.message}`, { cause: error });
  }
}

// The controller never creates labels: both must already exist in the consumer repository, by
// exact name.
function assertBlockLabels(consumerRoot, profile) {
  const existing = new Set(github.listLabels(consumerRoot));
  const missing = [BLOCK_LABEL, profile.labels.humanNeeded].filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`Configuration error: label(s) ${missing.map((name) => `"${name}"`).join(', ')} do not exist in the consumer repository; create them (see ralph/README.md)`);
  }
}

// The explicit root wins and must be the top of a git repository; it is never replaced by a
// search. Without it the root is the top of the repository containing `cwd`.
function resolveConsumerRoot(explicitRoot, cwd) {
  if (explicitRoot !== null) {
    const root = path.resolve(cwd, explicitRoot);
    assertRepositoryTop(root);
    return root;
  }
  try {
    return path.resolve(github.git(['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    throw new Error(`No consumer root: ${cwd} is not inside a git repository; run from the consumer repository or pass --consumer-root <path>: ${error.message}`, { cause: error });
  }
}

/**
 * Everything that has to hold before the lock, the first clone and the first agent. No side
 * effects: nothing is written, cloned, locked or started. Throws with the exact reason.
 * @param {{ consumerRoot: string, profile: any, localConfig: unknown, sandboxApi?: any, env?: NodeJS.ProcessEnv, stepRegistry?: Map<string, any> }} input
 */
function prepareRun({ consumerRoot, profile, localConfig, sandboxApi = sandbox, env = process.env, stepRegistry = DEFAULT_REGISTRY }) {
  if (typeof consumerRoot !== 'string' || consumerRoot === '' || !path.isAbsolute(consumerRoot)) {
    throw new TypeError('prepareRun: consumerRoot must be an absolute path');
  }
  assertControllerSettings(profile);
  // The step pipeline and budgets against the registry in force, whatever the queue holds.
  resolvePipeline(profile, stepRegistry);
  const settings = validateLocalConfig(localConfig);
  const agentModel = resolveAgentModel(settings);
  const sandboxConfig = sandboxApi.validateSandboxConfig(profile.sandbox);
  const runsRoot = sandboxApi.resolveRunsRoot(settings, consumerRoot, env);
  try {
    branchNameFor(profile.branchTemplate, 1, 'readiness check');
  } catch (error) {
    throw new Error(`Configuration error: branchTemplate: ${error.message}`, { cause: error });
  }
  const originUrl = assertConsumerRepository(consumerRoot);
  assertBlockLabels(consumerRoot, profile);
  return { settings, agentModel, sandboxConfig, runsRoot, originUrl };
}

// The Docker side, after the lock: a reachable engine, no containers left by a killed earlier run
// of this consumer, an up-to-date image. Any failure throws, so nothing is cloned.
/**
 * @param {string} consumerRoot
 * @param {any} sandboxConfig
 * @param {{ sandboxApi?: any, docker?: string }} [options]
 */
function startSandbox(consumerRoot, sandboxConfig, { sandboxApi = sandbox, docker } = {}) {
  sandboxApi.assertAvailable({ docker });
  const rootKey = sandboxApi.rootKeyFor(consumerRoot);
  const leftovers = sandboxApi.removeLeftovers(rootKey, { docker });
  if (leftovers.containers > 0 || leftovers.networks > 0) {
    console.log(`🧹 Убраны остатки прошлого запуска: контейнеров ${leftovers.containers}, сетей ${leftovers.networks}.`);
  }
  console.log(`🐳 Сборка образа песочницы ${sandboxConfig.image} (слои из кэша, если ничего не менялось)...`);
  sandboxApi.buildImage(sandboxConfig, { docker });
  return rootKey;
}

/**
 * The whole controller run for one consumer. Dependencies are injectable so run.test.js can drive
 * it without GitHub, Docker or an agent.
 * @param {{ consumerRoot: string, profile: any, localConfig: unknown, maxIterations?: number | null, deps?: any }} input
 */
async function runRalph({ consumerRoot, profile: suppliedProfile, localConfig, maxIterations, deps = {} }) {
  // The trusted snapshot of the whole run: a frozen deep copy, so neither the caller's object nor
  // anything running later can change the settings after this point.
  const profile = freezeSnapshot(suppliedProfile);
  const { sandboxApi = sandbox, docker, env = process.env, classifyIssues = github.classify, runOneIssue = runIssue, lockIsAlive, echo, stepRegistry = DEFAULT_REGISTRY } = deps;
  const prepared = prepareRun({ consumerRoot, profile, localConfig, sandboxApi, env, stepRegistry });
  const { settings, agentModel, sandboxConfig, runsRoot, originUrl } = prepared;
  const limit = maxIterations ?? /** @type {any} */ (settings).maxIterations ?? null;
  const lockPath = lockPathFor(runsRoot);
  const statePath = statePathFor(runsRoot);
  const saveState = deps.saveState || ((patch) => writeState(statePath, patch));

  acquireLock(lockPath, lockIsAlive);
  try {
    const rootKey = startSandbox(consumerRoot, sandboxConfig, { sandboxApi, docker });
    console.log(`🤖 Модель агента: ${agentModel}`);
    const ctx = {
      consumerRoot,
      profile,
      settings,
      originUrl,
      env,
      echo,
      stepRegistry,
      sandboxEnv: { sandboxConfig, runsRoot, rootKey, agentModel, docker },
    };
    return await runLoop(ctx, { limit, classifyIssues, runOneIssue, saveState });
  } finally {
    releaseLock(lockPath);
  }
}

async function runLoop(ctx, { limit, classifyIssues, runOneIssue, saveState }) {
  const excluded = new Set(); // issues already finished this run — don't re-pick them
  let iterations = 0;
  const perIssueResults = {};

  while (true) {
    if (limit !== null && iterations >= limit) {
      console.log(`🛑 Достигнут maxIterations (${limit}). Останавливаюсь.`);
      break;
    }

    const statuses = classifyIssues({ consumerRoot: ctx.consumerRoot, profile: ctx.profile, issues: ctx.settings.issues });
    const byId = new Map(statuses.map((s) => [s.id, s]));
    const summary = summarizeStatuses(statuses, excluded);
    summary.lines.forEach((line) => console.log(line));
    if (summary.ready.length === 0) break;

    const chosen = summary.ready[0];
    console.log(`🔄 Итерация ${iterations + 1}${limit !== null ? `/${limit}` : ''}: Issue #${chosen.id}${chosen.title ? ` (${chosen.title})` : ''}.`);

    let result;
    try {
      result = await runOneIssue(ctx, byId, chosen);
    } catch (error) {
      result = { status: 'crashed', error: error.message };
    }
    iterations++;
    perIssueResults[chosen.id] = result;
    saveState({ iterations, lastResult: { issue: chosen.id, ...result }, updatedAt: new Date().toISOString() });
    excluded.add(chosen.id);

    switch (result.status) {
      case 'done':
        console.log(`✅ Issue #${chosen.id} готов, PR: ${result.pr}`);
        break;
      case 'blocked':
        console.log(`🚫 Issue #${chosen.id} заблокирован${result.humanNeeded ? ' (нужно решение человека)' : ''}: ${result.reason}`);
        break;
      case 'crashed':
        console.log(`💥 Issue #${chosen.id}: необработанное исключение — ${result.error}`);
        break;
      default:
        console.log(`⚠️ Issue #${chosen.id}: ${result.status} — ${result.error || result.reason || 'см. лог выше'}${result.runDir ? ` (оставлено для разбора: ${result.runDir})` : ''}`);
        break;
    }
  }

  saveState({ iterations, finishedAt: new Date().toISOString() });
  return perIssueResults;
}

const USAGE = 'usage: node ralph/run.js [--consumer-root <path>] [--config <local-config.json>] [--max-iterations <n>]';

function parseArgs(argv) {
  const options = { consumerRoot: null, config: null, maxIterations: null };
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (value === undefined) return null;
    if (argv[index] === '--consumer-root') options.consumerRoot = value;
    else if (argv[index] === '--config') options.config = value;
    else if (argv[index] === '--max-iterations') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) return null;
      options.maxIterations = number;
    } else return null;
  }
  return options;
}

/**
 * @param {string[]} [argv]
 * @param {{ cwd?: string, deps?: any }} [options] `cwd`: where the root search starts; `deps`: passed to runRalph.
 */
async function main(argv = process.argv.slice(2), { cwd = process.cwd(), deps } = {}) {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const consumerRoot = resolveConsumerRoot(args.consumerRoot, cwd);
  const profile = loadProfile(consumerRoot);
  const localConfig = loadLocalConfig(args.config ? path.resolve(cwd, args.config) : path.join(consumerRoot, LOCAL_CONFIG_RELATIVE_PATH));
  (deps?.sandboxApi || sandbox).installExitHandlers();
  await runRalph({ consumerRoot, profile, localConfig, maxIterations: args.maxIterations, deps });
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}

module.exports = { main, parseArgs, resolveConsumerRoot, prepareRun, startSandbox, runRalph, summarizeStatuses, REQUIRED_PROFILE_SETTINGS };
