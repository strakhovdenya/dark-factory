#!/usr/bin/env node
'use strict';

// Moves the factory to a published release tag in one command. Before any file is written it checks
// that the tag exists on origin at a commit of origin/main, that the working tree is clean and contains
// origin/main, and that every wrapper carries one consistent pin. Then it changes exactly what belongs
// to the pin: devDependencies["dark-factory"] and the lock (npm install), the full commit SHA in `uses`
// and `with.factory-sha` of the wrappers, and runs the setup of the new installed release and doctor.
// It does not commit, push or open a pull request, and it never creates or moves a tag. Run it in an
// ordinary terminal, on a clean, up-to-date main:
//   node .claude/scripts/pin-release.js vX.Y.Z [--dry-run]

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { TAG_PATTERN } = require('./release-check');
const { npmCli } = require('../../test/helpers/npm');

const REMOTE = 'origin';
const BRANCH = 'main';
const PACKAGE_NAME = 'dark-factory';
const WORKFLOWS_DIR = '.github/workflows';
// The wrappers the factory must have; any other workflow that calls the factory release is moved too.
const WRAPPERS = ['.github/workflows/verifier-wrapper.yml', '.github/workflows/spec-approval-wrapper.yml'];
const ROOT = path.resolve(__dirname, '..', '..');
const USAGE = 'usage: node .claude/scripts/pin-release.js vX.Y.Z [--dry-run]';
const FULL_SHA = /^[0-9a-f]{40}$/;
const SPEC = /^(github:([\w.-]+\/[\w.-]+))#(v\d+\.\d+\.\d+)$/;
// `uses: owner/name/.github/workflows/x.yml@<sha>` and `factory-sha: <sha>`, plain or quoted, with an optional comment.
const USES_LINE = /^\s*uses:\s*["']?([\w.-]+\/[\w.-]+)\/\.github\/workflows\/[\w.-]+\.yml@([0-9a-f]{40})["']?\s*(?:#.*)?$/gm;
const SHA_LINE = /^\s*factory-sha:\s*["']?([0-9a-f]{40})["']?\s*(?:#.*)?$/gm;
const LOCK_COMMIT = /#([0-9a-f]{40})$/;

class PinReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PinReleaseError';
  }
}

const parseArgs = (argv) => {
  const options = { tag: undefined, isDryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.isDryRun = true;
    else if (arg.startsWith('-') || options.tag !== undefined) throw new PinReleaseError(`unknown argument "${arg}"; ${USAGE}`);
    else options.tag = arg;
  }
  if (options.tag === undefined) throw new PinReleaseError(USAGE);
  if (!TAG_PATTERN.test(options.tag)) throw new PinReleaseError(`tag "${options.tag}" must have the form vX.Y.Z; nothing changed`);
  return options;
};

/** git, npm and the installed release's scripts in the repository root; a spawn error is an error. */
const createTools = ({ root, spawn }) => {
  const run = (file, args, options = {}) => {
    const result = spawn(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, ...options });
    if (result.error) throw new PinReleaseError(`cannot run ${path.basename(file)}: ${result.error.message}`);
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  const strict = (file, args, label) => {
    const result = run(file, args);
    if (result.status !== 0) throw new PinReleaseError(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  };
  return {
    git: (...args) => strict('git', args, `git ${args.join(' ')}`),
    gitStatus: (...args) => run('git', args).status,
    npm: (...args) => strict(process.execPath, [npmCli(), ...args], `npm ${args.join(' ')}`),
    node: (script, ...args) => run(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
  };
};

const readText = (root, relative) => {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8');
  } catch (error) {
    throw new PinReleaseError(`${relative} is not readable: ${error.message}`);
  }
};

/** The `owner/name`, tag and dependency field of the factory pin in package.json. */
const readPin = (packageText) => {
  let manifest;
  try {
    manifest = JSON.parse(packageText);
  } catch (error) {
    throw new PinReleaseError(`package.json is not valid JSON: ${error.message}`);
  }
  const fields = ['dependencies', 'devDependencies'].filter((field) => manifest[field]?.[PACKAGE_NAME] !== undefined);
  if (fields.length !== 1) throw new PinReleaseError(`package.json must pin "${PACKAGE_NAME}" in exactly one of dependencies and devDependencies`);
  const spec = manifest[fields[0]][PACKAGE_NAME];
  const match = SPEC.exec(spec);
  if (!match) throw new PinReleaseError(`the pin "${spec}" is not github:<owner>/<name>#vX.Y.Z`);
  return { repository: match[2], tag: match[3], source: match[1], saveFlag: fields[0] === 'dependencies' ? '--save-prod' : '--save-dev' };
};

/** The one commit a wrapper pins: every `uses` call of the factory has a `factory-sha`, and all are the same. */
const readWrapperPin = (text, relative, repository) => {
  const uses = [...text.matchAll(USES_LINE)].filter((match) => match[1].toLowerCase() === repository.toLowerCase()).map((match) => match[2]);
  const shas = [...text.matchAll(SHA_LINE)].map((match) => match[1]);
  if (uses.length === 0 || uses.length !== shas.length) {
    throw new PinReleaseError(`${relative} must call ${repository} with a full commit SHA and a factory-sha for each call (found ${uses.length} calls, ${shas.length} factory-sha)`);
  }
  const all = new Set([...uses, ...shas]);
  if (all.size !== 1) throw new PinReleaseError(`${relative}: uses ${uses.join(', ')} but factory-sha is ${shas.join(', ')}`);
  return uses[0];
};

/** The wrappers: the required ones, and every other workflow that calls the factory release. */
const wrapperFiles = (root, repository) => {
  const others = [];
  try {
    for (const name of fs.readdirSync(path.join(root, ...WORKFLOWS_DIR.split('/')))) {
      const relative = `${WORKFLOWS_DIR}/${name}`;
      if (!name.endsWith('.yml') || WRAPPERS.includes(relative)) continue;
      const callsFactory = [...readText(root, relative).matchAll(USES_LINE)].some((match) => match[1].toLowerCase() === repository.toLowerCase());
      if (callsFactory) others.push(relative);
    }
  } catch (error) {
    if (error instanceof PinReleaseError) throw error;
    throw new PinReleaseError(`${WORKFLOWS_DIR} is not readable: ${error.message}`);
  }
  return [...WRAPPERS, ...others.sort()];
};

const peeledCommit = (lsRemote, tag) => {
  const rows = lsRemote.split('\n').map((line) => line.trim().split(/\s+/)).filter((row) => row.length === 2);
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const plain = rows.find(([, ref]) => ref === `refs/tags/${tag}`);
  return (peeled ?? plain)?.[0] ?? null;
};

/** Checks every precondition without writing; returns what the change needs. */
const prepare = ({ root, tag, tools }) => {
  const pin = readPin(readText(root, 'package.json'));
  if (pin.tag === tag) throw new PinReleaseError(`the factory is already pinned to ${tag}; nothing changed`);
  const wrappers = wrapperFiles(root, pin.repository).map((relative) => {
    const text = readText(root, relative);
    return { relative, text, sha: readWrapperPin(text, relative, pin.repository) };
  });
  if (new Set(wrappers.map((wrapper) => wrapper.sha)).size !== 1) {
    throw new PinReleaseError(`the wrappers pin different commits (${wrappers.map((wrapper) => `${wrapper.relative}: ${wrapper.sha}`).join(', ')}); nothing changed`);
  }
  if (tools.git('status', '--porcelain').trim() !== '') throw new PinReleaseError('the working tree is not clean; commit or stash your changes first, nothing changed');

  tools.git('fetch', '--quiet', '--no-tags', REMOTE, `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`);
  const sha = peeledCommit(tools.git('ls-remote', '--tags', REMOTE, `refs/tags/${tag}`, `refs/tags/${tag}^{}`), tag);
  if (sha === null || !FULL_SHA.test(sha)) throw new PinReleaseError(`tag ${tag} does not exist on ${REMOTE}; publish it first with release-tag.js, nothing changed`);
  if (tools.gitStatus('merge-base', '--is-ancestor', sha, `refs/remotes/${REMOTE}/${BRANCH}`) !== 0) {
    throw new PinReleaseError(`tag ${tag} (${sha}) is not a commit of ${REMOTE}/${BRANCH}; nothing changed`);
  }
  if (tools.gitStatus('merge-base', '--is-ancestor', `refs/remotes/${REMOTE}/${BRANCH}`, 'HEAD') !== 0) {
    throw new PinReleaseError(`the current branch does not contain ${REMOTE}/${BRANCH}; run this on an up-to-date ${BRANCH} (git switch ${BRANCH} && git pull), nothing changed`);
  }
  return { pin, wrappers, sha };
};

const lockCommit = (root, tag) => {
  const lock = JSON.parse(readText(root, 'package-lock.json'));
  const resolved = lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.resolved;
  const commit = typeof resolved === 'string' ? LOCK_COMMIT.exec(resolved)?.[1] : undefined;
  if (commit === undefined) throw new PinReleaseError(`package-lock.json has no resolved commit for node_modules/${PACKAGE_NAME} after the install of ${tag} (resolved: ${resolved})`);
  return commit;
};

const restore = (tools) => {
  try {
    tools.git('checkout', '--', 'package.json', 'package-lock.json');
  } catch {
    // the message of the original failure is the one that matters
  }
};

/**
 * @param {{ tag: string, isDryRun?: boolean, root: string, tools: ReturnType<typeof createTools>, log?: (line: string) => void, logError?: (line: string) => void }} options
 */
const pinRelease = ({ tag, isDryRun = false, root, tools, log = console.log, logError = console.error }) => {
  const { pin, wrappers, sha } = prepare({ root, tag, tools });
  log(`pin-release: ${pin.tag} -> ${tag} (${sha}), all checks passed`);
  if (isDryRun) {
    log('pin-release: dry run, no file changed');
    return { sha, isClean: true };
  }

  try {
    tools.npm('install', '--ignore-scripts', pin.saveFlag, `${pin.source}#${tag}`);
    const locked = lockCommit(root, tag);
    if (locked !== sha) throw new PinReleaseError(`the lock holds ${locked} for ${tag}, the tag on ${REMOTE} is ${sha}`);
  } catch (error) {
    restore(tools);
    throw new PinReleaseError(`${error.message}\npackage.json and package-lock.json were restored; node_modules may hold the other release: run npm ci`);
  }
  for (const wrapper of wrappers) {
    fs.writeFileSync(path.join(root, wrapper.relative), wrapper.text.replaceAll(wrapper.sha, sha));
  }

  const setup = tools.node(path.join(root, 'node_modules', PACKAGE_NAME, 'bin', 'setup.js'), '--consumer-root', root);
  if (setup.status !== 0) throw new PinReleaseError(`the setup of the installed ${tag} failed (files are changed, nothing is committed):\n${setup.stderr.trim()}`);
  const doctor = tools.node(path.join(root, 'node_modules', PACKAGE_NAME, 'bin', 'doctor.js'), 'doctor', root);
  if (doctor.stdout.trim() !== '') log(doctor.stdout.trim());
  if (doctor.stderr.trim() !== '') logError(doctor.stderr.trim());

  const expected = new Set(['package.json', 'package-lock.json', ...wrappers.map((wrapper) => wrapper.relative)]);
  const unexpected = tools.git('diff', '--name-only').split('\n').filter((file) => file !== '' && !expected.has(file));
  if (unexpected.length > 0) throw new PinReleaseError(`files outside the pin changed (${unexpected.join(', ')}); review "git diff" before you commit`);

  log(`pin-release: ${tag} is pinned in package.json, package-lock.json and ${wrappers.length} wrappers (${sha})`);
  log(`pin-release: next: create the branch task/ISSUE-<n>-pin-${tag}, review "git diff", commit and open the pull request; nothing is committed`);
  if (doctor.status !== 0) logError(`pin-release: doctor exited with ${doctor.status}; the files are changed, see its output above`);
  return { sha, isClean: doctor.status === 0 };
};

/** Exit code: 0 when the pin moved (or a dry run passed) and doctor is clean, 1 otherwise. */
const main = (argv = process.argv.slice(2), { root = ROOT, spawn = childProcess.spawnSync, log = console.log, logError = console.error } = {}) => {
  try {
    const options = parseArgs(argv);
    return pinRelease({ ...options, root, tools: createTools({ root, spawn }), log, logError }).isClean ? 0 : 1;
  } catch (error) {
    logError(`pin-release: ${error.message}`);
    return 1;
  }
};

if (require.main === module) process.exitCode = main();

module.exports = { main, pinRelease, parseArgs, readPin, readWrapperPin, WRAPPERS, PinReleaseError };
