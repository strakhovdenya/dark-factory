'use strict';

// Test support for the package setup (bin/setup.js): an "installed" copy of the factory package
// laid out under a consumer's node_modules, and the real setup executed against a consumer. The
// copy is made from this repository's package directories, so the setup that runs is the real one.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const baseSet = require('../../skills/base-set.json');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_ENTRIES = ['bin', 'skills', 'agents', 'hooks', 'profile', 'verifier', 'judge', 'ralph', 'package.json'];
// Real child_process functions, taken before a test replaces them at the process boundary.
const realSpawnSync = childProcess.spawnSync;

const skillNames = () => [...baseSet.processSkills, ...baseSet.jsMetaskills].map((entry) => entry.name);
const agentNames = () => baseSet.agents.map((entry) => entry.name);

/** Named .gitignore entries for the whole base set, the extra skills and the list of copies. */
const gitignoreText = (extraSkills = []) =>
  [
    'node_modules/',
    '.claude/settings.local.json',
    '.claude/.factory-installed.json',
    ...[...skillNames(), ...extraSkills].map((name) => `.claude/skills/${name}`),
    ...agentNames().map((name) => `.claude/agents/${name}.md`),
    '',
  ].join('\n');

/** Destinations of the whole base set (plus extra skills), sorted like the list of copies. */
const baseDestinations = (extraSkills = []) =>
  [...skillNames(), ...extraSkills].map((name) => `.claude/skills/${name}`).concat(agentNames().map((name) => `.claude/agents/${name}.md`)).sort();

const copyFiltered = (from, to) =>
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules' && !source.endsWith('.test.js'),
  });

/** Copies the package directories of this repository (without tests) into `target`. */
const copyPackageEntries = (target) => {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of PACKAGE_ENTRIES) copyFiltered(path.join(REPO_ROOT, entry), path.join(target, entry));
};

/**
 * Lays out the factory package at `<nodeModules>/dark-factory` and, by default, the pinned
 * metaskills next to it (hoisted). `metaskills: 'nested'` puts it inside the package, 'none' omits it.
 * @returns {{ packageRoot: string, setupScript: string }}
 */
const installFactoryPackage = (nodeModules, { metaskills = 'hoisted' } = {}) => {
  const packageRoot = path.join(nodeModules, 'dark-factory');
  copyPackageEntries(packageRoot);
  if (metaskills !== 'none') {
    const target = metaskills === 'nested' ? path.join(packageRoot, 'node_modules', 'metaskills') : path.join(nodeModules, 'metaskills');
    copyFiltered(path.join(REPO_ROOT, 'node_modules', 'metaskills'), target);
  }
  return { packageRoot, setupScript: path.join(packageRoot, 'bin', 'setup.js') };
};

/** Package paths (`node_modules/<name>`) of the runtime dependencies in the lock file; a nested one comes with its parent. */
const runtimeDependencyPaths = () => {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !key.includes('/node_modules/') && !entry.dev && !entry.devOptional)
    .map(([key]) => key);
};

/**
 * The factory as `npm install` leaves it, offline: the package at `<nodeModules>/dark-factory` and
 * every runtime dependency of the lock file copied from this repository's node_modules. Nothing is
 * downloaded; a dependency missing locally is an error.
 * @returns {{ packageRoot: string, dependencies: string[] }}
 */
const installFactoryRuntime = (nodeModules) => {
  const packageRoot = path.join(nodeModules, 'dark-factory');
  copyPackageEntries(packageRoot);
  const dependencies = runtimeDependencyPaths();
  for (const dependency of dependencies) {
    const source = path.join(REPO_ROOT, dependency);
    if (!fs.existsSync(source)) throw new Error(`runtime dependency ${dependency} is not installed; run npm ci first`);
    fs.cpSync(source, path.join(nodeModules, dependency.slice('node_modules/'.length)), { recursive: true });
  }
  return { packageRoot, dependencies };
};

/** Runs a setup script as a separate Node process; ajv and minimatch come from this repository. */
/** @type {(...args: any[]) => any} */
const runSetupScript = (setupScript, { args = [], cwd, env = {} } = {}) => {
  const nodePath = [path.join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const result = realSpawnSync(process.execPath, [setupScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, INIT_CWD: '', ...env, NODE_PATH: nodePath },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

module.exports = {
  REPO_ROOT,
  copyPackageEntries,
  skillNames,
  agentNames,
  gitignoreText,
  baseDestinations,
  installFactoryPackage,
  runtimeDependencyPaths,
  installFactoryRuntime,
  runSetupScript,
};
