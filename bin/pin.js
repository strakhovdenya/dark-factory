#!/usr/bin/env node
'use strict';

// Moves a project to a published release of the factory in one command:
//   node node_modules/dark-factory/bin/pin.js vX.Y.Z [--dry-run] [--base <branch>] [--allow-older]
// (also `dark-factory-pin`). It is never run by an install, by setup, by doctor or by a hook.
//
// The preconditions are checked before the first write: the tag is published in the repository named
// by the project's own pin, the working tree is clean and contains the default branch of the project,
// and every workflow that calls the factory release carries one consistent pin (`uses` and
// `factory-sha` the same full commit). Then it changes exactly what belongs to the pin: the dependency
// and the lock (npm install), the commit SHA in those workflows and the missing `.gitignore` lines of
// the new base set (lines are only added), and it runs the setup and doctor of the newly installed
// release. It does not commit, push, open a pull request or create or move a tag.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAME = 'dark-factory';
const REMOTE = 'origin';
const WORKFLOWS_DIR = '.github/workflows';
const USAGE = 'usage: node node_modules/dark-factory/bin/pin.js vX.Y.Z [--dry-run] [--base <branch>] [--allow-older]';
const TAG_PATTERN = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SPEC = /^github:([\w.-]+\/[\w.-]+)#(v\d+\.\d+\.\d+)$/;
// Every call of a reusable workflow of the factory repository, whatever its ref; and the pins we move.
const CALL_LINE = /^\s*uses:\s*["']?([\w.-]+\/[\w.-]+)\/\.github\/workflows\/[\w.-]+\.yml@([^\s"'#]+)["']?\s*(?:#.*)?$/gm;
const SHA_LINE = /^\s*factory-sha:\s*["']?([0-9a-f]{40})["']?\s*(?:#.*)?$/gm;
const LOCK_COMMIT = /#([0-9a-f]{40})$/;

class PinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PinError';
  }
}

const parseArgs = (argv) => {
  const options = { tag: undefined, isDryRun: false, isOlderAllowed: false, base: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.isDryRun = true;
    else if (arg === '--allow-older') options.isOlderAllowed = true;
    else if (arg === '--base' || arg.startsWith('--base=')) {
      const value = arg === '--base' ? argv[++index] : arg.slice('--base='.length);
      if (!value || value.startsWith('-')) throw new PinError(`--base needs a branch name; ${USAGE}`);
      options.base = value;
    } else if (arg.startsWith('-') || options.tag !== undefined) throw new PinError(`unknown argument "${arg}"; ${USAGE}`);
    else options.tag = arg;
  }
  if (options.tag === undefined) throw new PinError(USAGE);
  if (!TAG_PATTERN.test(options.tag)) throw new PinError(`tag "${options.tag}" must have the form vX.Y.Z; nothing changed`);
  return options;
};

const versionOf = (tag) => TAG_PATTERN.exec(tag)[1].split('.').map(Number);
const isOlder = (tag, than) => {
  const [a, b] = [versionOf(tag), versionOf(than)];
  const index = a.findIndex((part, position) => part !== b[position]);
  return index !== -1 && a[index] < b[index];
};

/** The npm-cli.js of the running Node, so that npm runs the same way on every platform. */
const npmCli = () => {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((file) => file && path.basename(file) === 'npm-cli.js' && fs.existsSync(file));
  if (!found) throw new PinError('npm-cli.js of the running Node is not found; npm cannot run');
  return found;
};

/** git, npm and the scripts of the installed release in the project root. */
const createTools = ({ root, spawn }) => {
  const run = (file, args, options = {}) => {
    const result = spawn(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, ...options });
    if (result.error) throw new PinError(`cannot run ${path.basename(file)}: ${result.error.message}`);
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  const strict = (file, args, label) => {
    const result = run(file, args);
    if (result.status !== 0) throw new PinError(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  };
  return {
    git: (...args) => strict('git', args, `git ${args.join(' ')}`),
    gitStatus: (...args) => run('git', args).status,
    gitOutput: (...args) => {
      const result = run('git', args);
      return result.status === 0 ? result.stdout : null;
    },
    npm: (...args) => strict(process.execPath, [npmCli(), ...args], `npm ${args.join(' ')}`),
    node: (script, ...args) => run(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
  };
};

const readText = (root, relative) => {
  try {
    return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
  } catch (error) {
    throw new PinError(`${relative} is not readable: ${error.message}`);
  }
};

/** The repository, tag and dependency field of the factory pin in package.json. */
const readPin = (packageText) => {
  let manifest;
  try {
    manifest = JSON.parse(packageText);
  } catch (error) {
    throw new PinError(`package.json is not valid JSON: ${error.message}`);
  }
  const fields = ['dependencies', 'devDependencies'].filter((field) => manifest?.[field]?.[PACKAGE_NAME] !== undefined);
  if (fields.length !== 1) throw new PinError(`package.json must pin "${PACKAGE_NAME}" in exactly one of dependencies and devDependencies`);
  const spec = manifest[fields[0]][PACKAGE_NAME];
  const match = SPEC.exec(spec);
  if (!match) throw new PinError(`the pin "${spec}" is not github:<owner>/<name>#vX.Y.Z`);
  return { repository: match[1], tag: match[2], saveFlag: fields[0] === 'dependencies' ? '--save-prod' : '--save-dev' };
};

/**
 * The one commit a workflow pins, or null when it does not call the factory release. Every call has
 * a full commit SHA (a tag, a branch or a short SHA is refused) and a `factory-sha`, all the same.
 */
const readWorkflowPin = (text, relative, repository) => {
  const calls = [...text.matchAll(CALL_LINE)].filter((match) => match[1].toLowerCase() === repository.toLowerCase());
  if (calls.length === 0) return null;
  const refs = calls.map((match) => match[2]);
  const unpinned = refs.filter((ref) => !FULL_SHA.test(ref));
  if (unpinned.length > 0) throw new PinError(`${relative} calls ${repository} at "${unpinned[0]}", which is not a full commit SHA; fix it first, nothing changed`);
  const shas = [...text.matchAll(SHA_LINE)].map((match) => match[1]);
  if (refs.length !== shas.length) throw new PinError(`${relative} calls ${repository} ${refs.length} times with ${shas.length} factory-sha; each call needs one`);
  if (new Set([...refs, ...shas]).size !== 1) throw new PinError(`${relative}: uses ${refs.join(', ')} but factory-sha is ${shas.join(', ')}`);
  return refs[0];
};

/** Every workflow that calls the factory release, with its text and its pin. */
const findWorkflows = (root, repository) => {
  let names;
  try {
    names = fs.readdirSync(path.join(root, ...WORKFLOWS_DIR.split('/'))).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch (error) {
    throw new PinError(`${WORKFLOWS_DIR} is not readable: ${error.message}`);
  }
  const found = [];
  for (const name of names) {
    const relative = `${WORKFLOWS_DIR}/${name}`;
    const text = readText(root, relative);
    const sha = readWorkflowPin(text, relative, repository);
    if (sha !== null) found.push({ relative, text, sha });
  }
  if (found.length === 0) throw new PinError(`no workflow in ${WORKFLOWS_DIR} calls ${repository}; connect the project first (docs/connecting-a-project.md)`);
  return found;
};

const peeledCommit = (lsRemote, tag) => {
  const rows = lsRemote.split('\n').map((line) => line.trim().split(/\s+/)).filter((row) => row.length === 2);
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const plain = rows.find(([, ref]) => ref === `refs/tags/${tag}`);
  return (peeled ?? plain)?.[0] ?? null;
};

/** The default branch of the project: `--base`, or what origin/HEAD says. */
const baseBranch = (tools, base) => {
  if (base !== undefined) return base;
  const head = tools.gitOutput('symbolic-ref', '--short', `refs/remotes/${REMOTE}/HEAD`);
  const branch = head === null ? '' : head.trim().replace(`${REMOTE}/`, '');
  if (branch === '') throw new PinError(`the default branch of ${REMOTE} is unknown; pass --base <branch>, nothing changed`);
  return branch;
};

/** Checks every precondition without writing a project file; returns what the change needs. */
const prepare = ({ root, tag, base, isOlderAllowed, tools }) => {
  const pin = readPin(readText(root, 'package.json'));
  if (pin.tag === tag) throw new PinError(`the project is already pinned to ${tag}; nothing changed`);
  if (isOlder(tag, pin.tag) && !isOlderAllowed) throw new PinError(`${tag} is older than the pinned ${pin.tag}; pass --allow-older to go back on purpose, nothing changed`);
  const workflows = findWorkflows(root, pin.repository);
  if (new Set(workflows.map((workflow) => workflow.sha)).size !== 1) {
    throw new PinError(`the workflows pin different commits (${workflows.map((workflow) => `${workflow.relative}: ${workflow.sha}`).join(', ')}); nothing changed`);
  }
  if (tools.git('status', '--porcelain').trim() !== '') throw new PinError('the working tree is not clean; commit or stash your changes first, nothing changed');

  const branch = baseBranch(tools, base);
  tools.git('fetch', '--quiet', '--no-tags', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`);
  if (tools.gitStatus('merge-base', '--is-ancestor', `refs/remotes/${REMOTE}/${branch}`, 'HEAD') !== 0) {
    throw new PinError(`the current branch does not contain ${REMOTE}/${branch}; run this on an up-to-date branch (git pull), nothing changed`);
  }
  const remote = `https://github.com/${pin.repository}.git`;
  const sha = peeledCommit(tools.git('ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`), tag);
  if (sha === null || !FULL_SHA.test(sha)) throw new PinError(`tag ${tag} is not published in ${pin.repository}; nothing changed`);
  return { pin, workflows, sha };
};

const lockCommit = (root, tag) => {
  const lock = JSON.parse(readText(root, 'package-lock.json'));
  const resolved = lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.resolved;
  const commit = typeof resolved === 'string' ? LOCK_COMMIT.exec(resolved)?.[1] : undefined;
  if (commit === undefined) throw new PinError(`package-lock.json has no resolved commit for node_modules/${PACKAGE_NAME} after the install of ${tag} (resolved: ${resolved})`);
  return commit;
};

/**
 * The copies the new release lays out, from its own planner (its profile and base set rules, not a
 * copy of them): `{ destination, isDirectory }` for every copy and the list file.
 */
const plannedCopies = (root) => {
  const installed = path.join(root, 'node_modules', PACKAGE_NAME);
  try {
    const setup = require(path.join(installed, 'bin', 'setup.js'));
    const plan = setup.inspectPlan({ root, packageRoot: installed });
    return [...plan.wanted.map((item) => ({ destination: item.destination, isDirectory: item.kind === 'skill' })), { destination: setup.MANIFEST_PATH, isDirectory: false }];
  } catch (error) {
    throw new PinError(`the new release cannot plan the copies of skills and agents: ${error.message}`);
  }
};

/** Adds the missing lines to .gitignore, in its own line ending; existing lines are never changed. Returns the lines added. */
const addGitignoreLines = (root, copies) => {
  const file = path.join(root, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const listed = new Set(text.split(/\r?\n|\r/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!')));
  const missing = copies
    .filter(({ destination, isDirectory }) => !(isDirectory ? [destination, `${destination}/`] : [destination]).some((form) => listed.has(form) || listed.has(`/${form}`)))
    .map(({ destination }) => destination);
  if (missing.length === 0) return [];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text === '' || /[\r\n]$/.test(text) ? '' : eol;
  fs.writeFileSync(file, `${text}${separator}${missing.join(eol)}${eol}`);
  return missing;
};

/** Puts the files of the pin back as they were (the tree was clean); returns what was restored. */
const restore = (tools, files) => {
  const restored = [];
  for (const file of files) {
    try {
      tools.git('checkout', '--', file);
      restored.push(file);
    } catch {
      // not a tracked file of this project: left as it is and not reported as restored
    }
  }
  return restored;
};

/**
 * @param {{ tag: string, isDryRun?: boolean, isOlderAllowed?: boolean, base?: string, root: string, tools: ReturnType<typeof createTools>, log?: (line: string) => void, logError?: (line: string) => void }} options
 */
const pinRelease = ({ tag, isDryRun = false, isOlderAllowed = false, base = undefined, root, tools, log = console.log, logError = console.error }) => {
  const { pin, workflows, sha } = prepare({ root, tag, base, isOlderAllowed, tools });
  log(`pin: ${pin.tag} -> ${tag} (${sha}), the preconditions hold`);
  if (isDryRun) {
    log('pin: dry run, no project file changed (npm, the lock and setup are not tried)');
    return { sha, isClean: true };
  }

  const touched = ['package.json', 'package-lock.json', '.gitignore', ...workflows.map((workflow) => workflow.relative)];
  const rollBack = (error) => {
    const restored = restore(tools, touched);
    return new PinError(`${error.message}\nrestored: ${restored.join(', ') || 'nothing'}; node_modules may hold the other release: run npm ci`);
  };

  let added = [];
  try {
    tools.npm('install', '--ignore-scripts', pin.saveFlag, `github:${pin.repository}#${tag}`);
    const locked = lockCommit(root, tag);
    if (locked !== sha) throw new PinError(`the lock holds ${locked} for ${tag}, the tag in ${pin.repository} is ${sha}`);
    added = addGitignoreLines(root, plannedCopies(root));
    for (const workflow of workflows) {
      fs.writeFileSync(path.join(root, ...workflow.relative.split('/')), workflow.text.replaceAll(workflow.sha, sha));
    }
  } catch (error) {
    throw rollBack(error instanceof PinError ? error : new PinError(error.message));
  }
  if (added.length > 0) log(`pin: added to .gitignore: ${added.join(', ')}`);

  const installed = path.join(root, 'node_modules', PACKAGE_NAME, 'bin');
  const setup = tools.node(path.join(installed, 'setup.js'), '--consumer-root', root);
  if (setup.status !== 0) throw new PinError(`the setup of the installed ${tag} failed (the files are changed, nothing is committed; fix the cause, then run node node_modules/dark-factory/bin/setup.js --consumer-root . again):\n${setup.stderr.trim()}`);
  const doctor = tools.node(path.join(installed, 'doctor.js'), 'doctor', root);
  if (doctor.stdout.trim() !== '') log(doctor.stdout.trim());
  if (doctor.stderr.trim() !== '') logError(doctor.stderr.trim());

  const expected = new Set(touched);
  const changed = tools.git('status', '--porcelain', '--untracked-files=all').split('\n').filter((line) => line.length > 3).map((line) => line.slice(3).trim());
  const unexpected = changed.filter((file) => !expected.has(file));
  if (unexpected.length > 0) throw new PinError(`files outside the pin changed (${unexpected.join(', ')}); review "git status" before you commit`);

  log(`pin: ${tag} is pinned in package.json, package-lock.json and ${workflows.length} workflow(s) (${sha})`);
  log('pin: next: create a branch, review "git diff", commit and open the pull request; nothing is committed. Apply any profile or hook change the CHANGELOG names.');
  if (doctor.status !== 0) logError(`pin: doctor exited with ${doctor.status}; the files are changed, see its output above`);
  return { sha, isClean: doctor.status === 0 };
};

/**
 * Exit code: 0 when the pin moved (or a dry run passed) and doctor is clean, 1 otherwise.
 * @param {string[]} [argv]
 * @param {{ cwd?: string, spawn?: any, log?: (line: string) => void, logError?: (line: string) => void }} [deps]
 */
const main = (argv = process.argv.slice(2), { cwd = process.cwd(), spawn = childProcess.spawnSync, log = console.log, logError = console.error } = {}) => {
  try {
    const options = parseArgs(argv);
    const top = spawn('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    if (top.error || top.status !== 0) throw new PinError(`${cwd} is not inside a git repository`);
    const root = fs.realpathSync.native(String(top.stdout).trim());
    return pinRelease({ ...options, root, tools: createTools({ root, spawn }), log, logError }).isClean ? 0 : 1;
  } catch (error) {
    logError(`pin: ${error.message}`);
    return 1;
  }
};

if (require.main === module) process.exitCode = main();

module.exports = { main, pinRelease, parseArgs, readPin, readWorkflowPin };
