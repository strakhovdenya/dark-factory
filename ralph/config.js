'use strict';

// Ralph's own bookkeeping: core constants, the personal local run config (outside Git), the state
// snapshot and the run lock. Nothing here depends on the process's current directory: every path
// comes from the consumer root or the resolved runs root.

const fs = require('node:fs');
const path = require('node:path');

// Set on an issue by every BLOCKED outcome, so a later run does not pick it again. A core service
// label, not a profile field; a human removes it after resolving the cause. The human-needed
// verdict sets the profile's labels.humanNeeded in addition.
const BLOCK_LABEL = 'ralph-blocked';

// Protected in every project on top of the profile's protectedPaths: the agent's own permission
// files and the repository metadata. A profile can add entries, never remove these.
const CORE_PROTECTED_PATHS = Object.freeze(['.git/', '.claude/']);

// Fallback when the local config has no `reviewMaxTurns`: the reviewer only reads a diff and runs
// read-only checks, so it needs far fewer turns than the implementer.
const DEFAULT_REVIEW_MAX_TURNS = 40;

// Budgets (the local config may override each). A single agent call is stopped after
// agentTimeoutMinutes; all calls of one issue together stop at taskMaxMinutes / taskMaxUsd.
const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_TASK_MAX_MINUTES = 240;
const DEFAULT_TASK_MAX_USD = 30;

// The personal run config of the operator, relative to the consumer root. It must stay out of Git
// (listed in the consumer's .gitignore): it holds the issue queue, budgets and the runs root.
const LOCAL_CONFIG_RELATIVE_PATH = path.join('.ralph', 'config.json');

const POSITIVE_NUMBER_FIELDS = ['maxIterations', 'maxTurns', 'reviewMaxTurns', 'agentTimeoutMinutes', 'taskMaxMinutes', 'taskMaxUsd'];
const LOCAL_CONFIG_FIELDS = ['issues', 'agentModel', 'runsRoot', ...POSITIVE_NUMBER_FIELDS];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIssueNumber = (value) => Number.isInteger(value) && value >= 1;

const issueProblems = (issues) => {
  if (!Array.isArray(issues)) return ['issues: must be an array of { id, dependsOn }'];
  const problems = [];
  issues.forEach((entry, index) => {
    if (!isPlainObject(entry) || !isIssueNumber(entry.id)) {
      problems.push(`issues[${index}].id: must be an issue number`);
      return;
    }
    const deps = entry.dependsOn === undefined ? [] : entry.dependsOn;
    if (!Array.isArray(deps) || !deps.every(isIssueNumber)) problems.push(`issues[${index}].dependsOn: must be an array of issue numbers`);
  });
  return problems;
};

/**
 * Checks the local run config and returns it with `dependsOn` filled in. Every problem is named
 * by field; `branchPrefix` points at the profile's `branchTemplate`, which replaced it.
 * @param {unknown} config
 */
function validateLocalConfig(config) {
  if (!isPlainObject(config)) throw new Error('Invalid local run config: must be a JSON object');
  const section = /** @type {Record<string, any>} */ (config);
  const problems = [];
  for (const name of Object.keys(section)) {
    if (name === 'branchPrefix') {
      problems.push('branchPrefix: no longer supported; task branches are named by branchTemplate in .factory/profile.json');
    } else if (!LOCAL_CONFIG_FIELDS.includes(name)) {
      problems.push(`${name}: unknown field`);
    }
  }
  problems.push(...issueProblems(section.issues));
  for (const name of POSITIVE_NUMBER_FIELDS) {
    const value = section[name];
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      problems.push(`${name}: must be a positive number`);
    }
  }
  if (problems.length > 0) throw new Error(`Invalid local run config:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  const issues = section.issues.map((entry) => ({ id: entry.id, dependsOn: [...(entry.dependsOn || [])] }));
  return { ...section, issues };
}

function loadLocalConfig(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the local run config ${configPath}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`Local run config ${configPath} is not valid JSON: ${error.message}`, { cause: error });
  }
}

/** Core protections first, then the profile's own entries. */
const protectedPatternsFor = (profile) => [...CORE_PROTECTED_PATHS, ...(profile.protectedPaths || [])];

// Lock and state live in the runs root of the consumer, never in the installed package.
const lockPathFor = (runsRoot) => path.join(runsRoot, 'run.lock');
const statePathFor = (runsRoot) => path.join(runsRoot, 'state.json');

function writeState(statePath, patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    // no prior state, start fresh
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ ...current, ...patch }, null, 2) + '\n');
}

// --- lock: refuse to run two controllers against the same runs root at once ---

// EPERM means the process exists but belongs to someone else — alive. Only ESRCH is "gone".
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    const prior = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number.isInteger(prior?.pid) ? prior : null;
  } catch {
    return null;
  }
}

const FRESH_LOCK_MS = 10000;

const isFresh = (lockPath) => {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs < FRESH_LOCK_MS;
  } catch {
    return false;
  }
};

// The lock file is created exclusively (`wx`), so two starters cannot both win. An existing lock
// is taken over only when it is unreadable/corrupt or its process is gone; the takeover removes
// the file and retries the exclusive create once, so a racing starter still loses cleanly.
function acquireLock(lockPath, isAlive = isProcessAlive) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, content, { flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const prior = readLock(lockPath);
    if (prior && isAlive(prior.pid)) {
      throw new Error(`Another Ralph run is already active (PID ${prior.pid}, started ${prior.startedAt}). Refusing to start a second one.`);
    }
    // An unreadable lock this fresh is most likely another starter between its exclusive create
    // and its write: it is not taken over.
    if (!prior && isFresh(lockPath)) {
      throw new Error('Another Ralph run is starting (its lock file was just created). Refusing to start a second one.');
    }
    console.log(prior ? `⚠️ Stale lock from PID ${prior.pid} (no longer running) — taking over.` : '⚠️ Corrupt lock file — taking over.');
    fs.rmSync(lockPath, { force: true });
  }
  throw new Error('Could not acquire the Ralph lock: another starter won the race.');
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone, fine
  }
}

module.exports = {
  BLOCK_LABEL,
  CORE_PROTECTED_PATHS,
  DEFAULT_REVIEW_MAX_TURNS,
  DEFAULT_AGENT_TIMEOUT_MINUTES,
  DEFAULT_TASK_MAX_MINUTES,
  DEFAULT_TASK_MAX_USD,
  LOCAL_CONFIG_RELATIVE_PATH,
  validateLocalConfig,
  loadLocalConfig,
  protectedPatternsFor,
  lockPathFor,
  statePathFor,
  writeState,
  acquireLock,
  releaseLock,
};
