#!/usr/bin/env node
'use strict';

// Lays out the factory's skills and agents in a consumer repository as plain copies, keeps a list
// of the copies it owns (.claude/.factory-installed.json) and updates or removes only those.
// Public command: `dark-factory-setup --consumer-root <path>`; the package's postinstall runs the
// same file with no argument and the consumer is found from INIT_CWD.
//
// The whole plan (profile, sources, list of copies, tracked files, Git exclusions, conflicts) is
// checked before the first write. Setup never creates, changes or deletes a tracked file, never
// adopts a path it does not own and never downloads anything: sources are the executing package
// and its runtime dependencies.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadProfile } = require('../profile/load');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const OWN_PACKAGE_NAME = 'dark-factory';
const MANIFEST_PATH = '.claude/.factory-installed.json';
const MANIFEST_FORMAT_VERSION = 1;
const SKILLS_DIR = '.claude/skills';
const AGENTS_DIR = '.claude/agents';
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const COPY_PATH = /^\.claude\/(?:skills\/[A-Za-z0-9_][A-Za-z0-9._-]*|agents\/[A-Za-z0-9_][A-Za-z0-9._-]*\.md)$/;
const GIT_ENV_DROPPED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

const isSafeName = (name) => typeof name === 'string' && SAFE_NAME.test(name);

const gitEnv = () => {
  const env = { ...process.env };
  for (const name of GIT_ENV_DROPPED) delete env[name];
  return env;
};

const runGit = (cwd, args, input) => childProcess.spawnSync('git', args, { cwd, input, encoding: 'utf8', env: gitEnv(), maxBuffer: 1 << 28 });

const gitOutput = (cwd, args) => {
  const result = runGit(cwd, args);
  if (result.error) throw new SetupError(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) throw new SetupError(`git ${args.join(' ')} failed in ${cwd}: ${String(result.stderr).trim()}`);
  return result.stdout;
};

const realPath = (target) => fs.realpathSync.native(target);

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// --- consumer root ---

const parseArgs = (argv) => {
  let consumerRoot;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--consumer-root') {
      consumerRoot = argv[++index];
    } else if (arg.startsWith('--consumer-root=')) {
      consumerRoot = arg.slice('--consumer-root='.length);
    } else {
      throw new SetupError(`unknown argument "${arg}"; usage: dark-factory-setup --consumer-root <path>`);
    }
    if (!consumerRoot) throw new SetupError('--consumer-root needs a path');
  }
  return { consumerRoot };
};

// The git root of the consumer. An explicit path must be that root itself; without it the root is
// found from INIT_CWD (the directory npm was started in). The package directory is never a default.
const resolveConsumerRoot = ({ consumerRoot, env }) => {
  const isExplicit = consumerRoot !== undefined;
  const start = isExplicit ? path.resolve(consumerRoot) : env.INIT_CWD;
  const origin = isExplicit ? '--consumer-root' : 'INIT_CWD';
  if (!start) throw new SetupError('no consumer repository: pass --consumer-root <path> (INIT_CWD is not set)');
  let real;
  try {
    real = realPath(start);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SetupError(`${origin} "${start}" is not an existing directory`);
  }
  const result = runGit(real, ['rev-parse', '--show-toplevel']);
  if (result.error) throw new SetupError(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) throw new SetupError(`${origin} "${start}" is not inside a git repository`);
  const top = realPath(result.stdout.trim());
  if (isExplicit && top !== real) {
    throw new SetupError(`--consumer-root "${start}" is not the git root of its repository (the root is ${top})`);
  }
  return top;
};

// --- sources ---

const readJson = (file, label) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SetupError(`cannot read ${label} (${file}): ${error.message}`);
  }
};

// First `<dir>/node_modules/<name>` going up from the package, like the standard resolution of a
// dependency of that package (nested first, then hoisted).
const findDependency = (packageRoot, name) => {
  for (let dir = packageRoot; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    if (path.dirname(dir) === dir) return null;
  }
};

const dependencyRoot = (packageRoot, name, version) => {
  const found = findDependency(packageRoot, name);
  if (!found) throw new SetupError(`source package "${name}" is not installed for ${packageRoot}`);
  const actual = readJson(path.join(found, 'package.json'), `${name}/package.json`).version;
  if (actual !== version) {
    throw new SetupError(`source package "${name}" is ${actual}, the base set pins ${version} (${found})`);
  }
  return found;
};

// A relative source path that stays inside its root.
const insidePath = (root, relative, label) => {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative)) {
    throw new SetupError(`${label}: invalid source path "${relative}"`);
  }
  const resolved = path.resolve(root, relative);
  if (!isInside(root, resolved)) throw new SetupError(`${label}: source path "${relative}" leaves its package`);
  return resolved;
};

const resolveSource = (packageRoot, source, label) => {
  if (!source || typeof source !== 'object') throw new SetupError(`${label}: the base set has no source`);
  if (source.kind === 'package-dir') return insidePath(packageRoot, source.path, label);
  if (source.kind === 'npm') {
    return insidePath(dependencyRoot(packageRoot, source.package, source.version), source.path, label);
  }
  throw new SetupError(`${label}: unsupported source kind "${source.kind}"`);
};

// Every entry of a source tree with links followed. A dangling link, a link cycle or a special
// file stops setup before any copy is touched.
const listTree = (root, label) => {
  const entries = [];
  const walk = (dir, relative, ancestors) => {
    const real = realPath(dir);
    if (ancestors.includes(real)) throw new SetupError(`${label}: source "${root}" has a link cycle at ${dir}`);
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (error) {
        throw new SetupError(`${label}: unreadable source entry ${full}: ${error.message}`);
      }
      if (stat.isDirectory()) {
        entries.push({ rel, abs: full, isDirectory: true });
        walk(full, rel, [...ancestors, real]);
      } else if (stat.isFile()) {
        entries.push({ rel, abs: full, isDirectory: false });
      } else {
        throw new SetupError(`${label}: source entry ${full} is not a file or directory`);
      }
    }
  };
  walk(root, '', []);
  return entries;
};

const loadBaseSet = (packageRoot) => {
  const baseSet = readJson(path.join(packageRoot, 'skills', 'base-set.json'), 'skills/base-set.json');
  const lists = ['processSkills', 'jsMetaskills', 'agents'];
  const broken = lists.filter((field) => !Array.isArray(baseSet[field]));
  if (broken.length > 0) throw new SetupError(`skills/base-set.json is invalid: ${broken.join(', ')} must be lists`);
  return baseSet;
};

// The copies the base set and the profile ask for: skills are directories, agents are files.
const buildWanted = ({ packageRoot, profile }) => {
  const baseSet = loadBaseSet(packageRoot);
  const wanted = new Map();
  const add = (name, kind, destination, source) => {
    if (!wanted.has(destination)) wanted.set(destination, { name, kind, destination, source, tree: null });
  };

  const skillEntries = [...baseSet.processSkills, ...baseSet.jsMetaskills];
  for (const entry of skillEntries) {
    const name = entry && entry.name;
    if (!isSafeName(name)) throw new SetupError(`invalid skill name "${name}" in skills/base-set.json`);
    add(name, 'skill', `${SKILLS_DIR}/${name}`, resolveSource(packageRoot, entry.source, `skill ${name}`));
  }
  for (const entry of baseSet.agents) {
    const name = entry && entry.name;
    if (!isSafeName(name)) throw new SetupError(`invalid agent name "${name}" in skills/base-set.json`);
    add(name, 'agent', `${AGENTS_DIR}/${name}.md`, insidePath(packageRoot, entry.path, `agent ${name}`));
  }

  const metaskills = skillEntries.map((entry) => entry.source).find((source) => source.kind === 'npm' && source.package === 'metaskills');
  for (const name of profile.extraMetaskills || []) {
    if (!isSafeName(name)) throw new SetupError(`extraMetaskills: invalid name "${name}"`);
    if (wanted.has(`${SKILLS_DIR}/${name}`)) continue;
    if (!metaskills) throw new SetupError(`extraMetaskills: "${name}" is unknown, the base set has no metaskills source`);
    const dir = path.join(dependencyRoot(packageRoot, metaskills.package, metaskills.version), 'skills', name);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new SetupError(`extraMetaskills: "${name}" is not a skill of the installed metaskills`);
    }
    add(name, 'skill', `${SKILLS_DIR}/${name}`, dir);
  }

  for (const item of wanted.values()) {
    const stat = fs.statSync(item.source, { throwIfNoEntry: false });
    if (!stat) throw new SetupError(`source of "${item.name}" is missing: ${item.source}`);
    if (item.kind === 'skill') {
      if (!stat.isDirectory()) throw new SetupError(`source of skill "${item.name}" is not a directory: ${item.source}`);
      item.tree = listTree(item.source, `skill ${item.name}`);
    } else if (!stat.isFile()) {
      throw new SetupError(`source of agent "${item.name}" is not a file: ${item.source}`);
    }
  }
  return [...wanted.values()];
};

// --- list of installed copies ---

const readManifest = (root) => {
  const file = path.join(root, MANIFEST_PATH);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile()) throw new SetupError(`${MANIFEST_PATH} is not a regular file`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SetupError(`${MANIFEST_PATH} is not valid JSON: ${error.message}`);
  }
  const isObject = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest);
  if (!isObject || manifest.format_version !== MANIFEST_FORMAT_VERSION) {
    throw new SetupError(`${MANIFEST_PATH} has an unknown format (expected format_version ${MANIFEST_FORMAT_VERSION})`);
  }
  if (!Array.isArray(manifest.copies)) throw new SetupError(`${MANIFEST_PATH}: "copies" is not a list`);
  const seen = new Set();
  for (const copy of manifest.copies) {
    if (typeof copy !== 'string' || !COPY_PATH.test(copy)) {
      throw new SetupError(`${MANIFEST_PATH}: invalid copy path ${JSON.stringify(copy)}`);
    }
    if (seen.has(copy)) throw new SetupError(`${MANIFEST_PATH}: duplicate copy path "${copy}"`);
    seen.add(copy);
  }
  return manifest.copies;
};

// --- Git and file system checks ---

const readIgnoreEntries = (root) => {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return new Set();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim());
  return new Set(lines.filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!')));
};

// Every recipient needs its own entry in .gitignore, and git must really exclude it.
const gitIgnoreProblems = (root, required) => {
  const problems = [];
  const listed = readIgnoreEntries(root);
  const named = [];
  for (const { destination, isDirectory } of required) {
    const forms = isDirectory ? [destination, `${destination}/`] : [destination];
    if (forms.some((form) => listed.has(form) || listed.has(`/${form}`))) named.push({ destination, probe: isDirectory ? `${destination}/` : destination });
    else problems.push(`.gitignore has no entry for "${destination}": add the line "${destination}"`);
  }
  if (named.length === 0) return problems;
  const input = named.map(({ probe }) => `${probe}\0`).join('');
  const result = runGit(root, ['check-ignore', '--no-index', '-z', '--stdin'], input);
  if (result.error) throw new SetupError(`cannot run git: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) throw new SetupError(`git check-ignore failed: ${String(result.stderr).trim()}`);
  const ignored = new Set(result.stdout.split('\0').filter(Boolean));
  for (const { destination, probe } of named) {
    if (!ignored.has(probe)) {
      problems.push(`git does not ignore "${destination}" despite its .gitignore entry (a later rule or a negation re-includes it)`);
    }
  }
  return problems;
};

// The directories above the recipients must be real directories inside the consumer.
const directoryProblems = (root) => {
  const problems = [];
  for (const relative of ['.claude', SKILLS_DIR, AGENTS_DIR]) {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      problems.push(`"${relative}" is a link or a file; recipients must stay inside the consumer`);
    } else if (!isInside(root, realPath(full))) {
      problems.push(`"${relative}" resolves outside the consumer`);
    }
  }
  return problems;
};

const ownedCopyProblem = (root, destination, isDirectory) => {
  const stat = fs.lstatSync(path.join(root, destination), { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `"${destination}" is a link, setup owns plain copies only`;
  const isExpected = isDirectory ? stat.isDirectory() : stat.isFile();
  return isExpected ? null : `"${destination}" is not a ${isDirectory ? 'directory' : 'file'} as setup expects`;
};

// --- plan and apply ---

const buildPlan = ({ root, packageRoot }) => {
  const profile = loadProfile(root);
  const wanted = buildWanted({ packageRoot, profile });
  const listed = readManifest(root);

  const wantedPaths = new Set(wanted.map((item) => item.destination));
  const owned = new Set(listed);
  const retired = listed.filter((destination) => !wantedPaths.has(destination));
  const problems = directoryProblems(root);

  const tracked = gitOutput(root, ['ls-files', '-z']).split('\0').filter(Boolean).map((file) => file.toLowerCase());
  const trackedUnder = (target) => tracked.find((file) => file === target.toLowerCase() || file.startsWith(`${target.toLowerCase()}/`));
  for (const destination of [...wantedPaths, ...retired]) {
    const file = trackedUnder(destination);
    if (file) problems.push(`conflict: "${destination}" has tracked files (${file}); setup does not touch tracked paths`);
  }
  if (trackedUnder(MANIFEST_PATH)) problems.push(`conflict: ${MANIFEST_PATH} is tracked; the list of installed copies must be untracked`);

  for (const item of wanted) {
    if (owned.has(item.destination)) {
      const problem = ownedCopyProblem(root, item.destination, item.kind === 'skill');
      if (problem) problems.push(`conflict: ${problem}`);
    } else if (fs.lstatSync(path.join(root, item.destination), { throwIfNoEntry: false })) {
      problems.push(`conflict: "${item.destination}" exists and is not listed in ${MANIFEST_PATH}; setup does not overwrite or adopt it`);
    }
  }
  for (const destination of retired) {
    const problem = ownedCopyProblem(root, destination, destination.startsWith(`${SKILLS_DIR}/`));
    if (problem) problems.push(`conflict: ${problem}`);
  }

  const required = wanted.map((item) => ({ destination: item.destination, isDirectory: item.kind === 'skill' }));
  required.push({ destination: MANIFEST_PATH, isDirectory: false });
  problems.push(...gitIgnoreProblems(root, required));
  if (problems.length > 0) throw new SetupError(`setup stopped before any change:\n- ${problems.join('\n- ')}`);
  return { wanted, retired, listed };
};

const writeManifest = (root, copies) => {
  const file = path.join(root, MANIFEST_PATH);
  const manifest = { format_version: MANIFEST_FORMAT_VERSION, copies: [...copies].sort() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
};

const copyItem = (root, item) => {
  const target = path.join(root, item.destination);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (item.kind === 'agent') {
    fs.copyFileSync(item.source, target);
    return;
  }
  fs.mkdirSync(target);
  for (const entry of item.tree) {
    const to = path.join(target, ...entry.rel.split('/'));
    if (entry.isDirectory) fs.mkdirSync(to, { recursive: true });
    else fs.copyFileSync(entry.abs, to);
  }
};

const applyPlan = (root, { wanted, retired, listed }) => {
  const finalCopies = wanted.map((item) => item.destination);
  // A run killed in the middle leaves every copy it may have started listed as owned.
  writeManifest(root, new Set([...listed, ...finalCopies]));
  for (const destination of retired) fs.rmSync(path.join(root, destination), { recursive: true, force: true });
  for (const item of wanted) copyItem(root, item);
  writeManifest(root, finalCopies);
};

// The factory's own repository keeps its bootstrap until it runs on a release: copies of the
// working sources of skills/ and agents/ are never laid out there.
const isOwnRepository = (root, packageRoot) => {
  if (root !== realPath(packageRoot)) return false;
  return readJson(path.join(packageRoot, 'package.json'), 'package.json').name === OWN_PACKAGE_NAME;
};

/**
 * @param {{ consumerRoot?: string, env?: NodeJS.ProcessEnv, packageRoot?: string, log?: (line: string) => void }} [options]
 */
const runSetup = ({ consumerRoot, env = process.env, packageRoot = PACKAGE_ROOT, log = console.log } = {}) => {
  const root = resolveConsumerRoot({ consumerRoot, env });
  if (isOwnRepository(root, packageRoot)) {
    const script = path.join(packageRoot, '.claude', 'scripts', 'setup-metaskills.js');
    childProcess.execFileSync(process.execPath, [script, root], { stdio: 'inherit' });
    return { isBootstrap: true, root, installed: [], removed: [] };
  }
  const plan = buildPlan({ root, packageRoot });
  applyPlan(root, plan);
  const installed = plan.wanted.map((item) => item.destination);
  log(`dark-factory-setup: ${installed.length} copies installed, ${plan.retired.length} removed (${root})`);
  return { isBootstrap: false, root, installed, removed: plan.retired };
};

const main = (argv = process.argv.slice(2), env = process.env) => {
  try {
    runSetup({ ...parseArgs(argv), env });
    return 0;
  } catch (error) {
    console.error(`dark-factory-setup: ${error.message}`);
    return 1;
  }
};

if (require.main === module) process.exitCode = main();

module.exports = { runSetup, main, parseArgs, SetupError, MANIFEST_PATH };
