'use strict';

// Test support for the portable Ralph controller tests: neutral consumer repositories made with a
// real local git (no network), a profile copy with the settings an enabled controller needs, and
// replacements at the process boundary — gh through child_process, Docker through the sandbox
// runtime. Nothing here reaches GitHub, Docker or a model.

const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { loadProfile } = require('../../profile/load');
const { profileCopy } = require('./profiles');
const sandbox = require('../../ralph/sandbox');
const { gitignoreText, installFactoryPackage, runSetupScript } = require('./factory-package');
const { freezeSnapshot } = require('../../ralph/trusted-profile');

const HUMAN_VERDICT = 'NEEDS.HUMAN+';
const HUMAN_LABEL = 'needs-human';

/** A temporary directory removed when the test ends (real path, so links do not confuse paths). */
/** @type {(...args: any[]) => any} */
const tempDir = (t, prefix = 'ralph-') => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Git without the operator's global or system config, with a fixed identity, for this test. */
const isolateGit = (t) => {
  const dir = tempDir(t, 'ralph-gitcfg-');
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const values = {
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

const realExecFileSync = childProcess.execFileSync;
const gitIn = (cwd, ...args) => String(realExecFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

const writeFiles = (root, files) => {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
};

// Named entries for every copy the package setup lays out, as the setup requires.
const IGNORED = gitignoreText();

/** The text of a profile committed into a fixture repository: an object is serialized, a string is kept as is. */
const profileText = (profile) => (typeof profile === 'string' ? profile : JSON.stringify(profile));

/**
 * A bare origin with one commit on `defaultBranch` and a consumer root cloned from it. `profile`
 * (an object, or raw text) is committed as the project profile; without it the repository has none.
 * @returns {{ origin: string, consumerRoot: string, scratch: string }}
 */
/** @type {(...args: any[]) => any} */
const makeConsumer = (t, { files = {}, defaultBranch = 'trunk', profile } = {}) => {
  const scratch = tempDir(t, 'ralph-consumer-');
  const seed = path.join(scratch, 'seed');
  fs.mkdirSync(seed);
  gitIn(seed, 'init', '-q', '-b', defaultBranch);
  writeFiles(seed, { '.gitignore': IGNORED, 'README.md': 'neutral\n', ...(profile === undefined ? {} : { '.factory/profile.json': profileText(profile) }), ...files });
  gitIn(seed, 'add', '-A');
  gitIn(seed, 'commit', '-qm', 'init');
  const origin = path.join(scratch, 'origin.git');
  gitIn(scratch, 'clone', '-q', '--bare', seed, origin);
  const consumerRoot = path.join(scratch, 'consumer');
  gitIn(scratch, 'clone', '-q', origin, consumerRoot);
  return { origin, consumerRoot, scratch };
};

/** Pushes a branch of `origin` (from its default branch) whose files are `files`; for stacked-base scenarios. */
const pushBranch = (t, origin, branch, files) => {
  const work = path.join(tempDir(t, 'ralph-branch-'), 'work');
  gitIn(path.dirname(work), 'clone', '-q', origin, work);
  gitIn(work, 'checkout', '-q', '-b', branch);
  writeFiles(work, files);
  gitIn(work, 'add', '-A');
  gitIn(work, 'commit', '-qm', `work on ${branch}`);
  gitIn(work, 'push', '-q', 'origin', branch);
};

/** Makes Ralph's controller settings complete on a fixture profile copy. */
const enableController = (profile) => {
  profile.ralph = { ...profile.ralph, enabled: true, techDebtTrackerIssue: profile.ralph?.techDebtTrackerIssue ?? 5, humanNeededVerdict: HUMAN_VERDICT };
  profile.labels = { ...profile.labels, humanNeeded: HUMAN_LABEL };
};

/** A loaded profile: a fixture copy with complete controller settings, then `mutate`. */
/** @type {(...args: any[]) => any} */
const controllerProfile = (t, fixture, mutate = (_profile) => {}) =>
  loadProfile(
    profileCopy(t, fixture, (profile) => {
      enableController(profile);
      mutate(profile);
    }),
  );

/**
 * Replaces child_process.execFileSync for gh (answered by `onGh`) and forbids Docker or any other
 * program but git, which runs for real. Every call is recorded with its cwd.
 */
/** @type {(...args: any[]) => any} */
const mockGh = (t, onGh = () => '') => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args = [], options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === 'git') return realExecFileSync(file, args, options);
    if (file === 'gh') {
      const out = onGh(args, options);
      return options.encoding ? String(out ?? '') : Buffer.from(String(out ?? ''));
    }
    throw new Error(`unexpected host process ${file}`);
  });
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork']) {
    t.mock.method(childProcess, name, (file) => {
      throw new Error(`a host process was started through ${name}: ${file}`);
    });
  }
  return calls;
};

/** A gh stand-in that answers the calls of one controller run and records the mutations. */
/** @type {(...args: any[]) => any} */
const fakeGitHub = ({ body = '', labels = ['ralph-blocked', HUMAN_LABEL], prUrl = 'https://example.invalid/pr/1' } = {}) => {
  const mutations = [];
  const onGh = (args) => {
    const [group, action] = args;
    if (group === 'label' && action === 'list') return JSON.stringify(labels.map((name) => ({ name })));
    if (group === 'issue' && action === 'view') return body;
    if (group === 'api') return '';
    if (group === 'pr' && action === 'create') {
      mutations.push({ kind: 'pr', args });
      return prUrl;
    }
    if (group === 'issue' && action === 'comment') {
      mutations.push({ kind: 'comment', issue: args[2], body: args[args.indexOf('--body') + 1] });
      return '';
    }
    if (group === 'issue' && action === 'edit') {
      const labelIndex = args.indexOf('--add-label');
      mutations.push(labelIndex === -1 ? { kind: 'edit', issue: args[2], args } : { kind: 'label', issue: args[2], label: args[labelIndex + 1] });
      return '';
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { onGh, mutations };
};

const okResult = (name = 'container') => ({ status: 0, stdout: 'ok', stderr: '', error: null, name });

/**
 * Replaces the sandbox runtime. `onAgent({ pass, prompt, spec, runDir })` returns the agent's text
 * (after changing files if it likes); `onRun(spec)` answers sync runs (installs, sync, gate).
 */
/** @type {(...args: any[]) => any} */
const mockSandbox = (t, { onAgent = () => 'DONE', onRun = () => okResult(), proxy = true } = {}) => {
  const runs = [];
  const agents = [];
  const proxies = [];
  t.mock.method(sandbox, 'startProxy', (spec) => {
    if (!proxy) throw new Error('Docker is not available, the Ralph sandbox needs a running Docker engine');
    proxies.push(spec);
    return { name: 'proxy', network: 'run-net', proxyUrl: 'http://proxy:3128', stop: () => proxies.push('stopped') };
  });
  t.mock.method(sandbox, 'runInSandboxSync', (spec, options) => {
    runs.push({ spec, options });
    return onRun(spec);
  });
  t.mock.method(sandbox, 'spawnInSandbox', (spec) => {
    const pass = path.basename(spec.sessionsDir || '').replace(/^\d+-/, '');
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let prompt = '';
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += chunk;
        callback();
      },
      final(callback) {
        callback();
        setImmediate(() => {
          agents.push({ pass, prompt, spec });
          const text = onAgent({ pass, prompt, spec, runDir: spec.runDir });
          stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`);
          stdout.write(`${JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01 })}\n`);
          stdout.end();
          stderr.end();
          setImmediate(() => child.emit('close', 0));
        });
      },
    });
    Object.assign(child, { stdin, stdout, stderr, kill: () => {} });
    return { child, name: `agent-${agents.length}`, stop: () => {} };
  });
  return { runs, agents, proxies };
};

/** Marks the package installed in a clone, so its set is distinguishable from the controller's own. */
const CLONE_MARKER = { file: 'skills/issues/CLONE-MARKER.md', text: 'installed in the clone\n' };

let installedTemplate = null;

/** What `npm install` of the factory leaves in the clone's node_modules: the package and its pinned metaskills. */
const installFactoryInClone = (runDir) => {
  const target = path.join(runDir, 'node_modules');
  if (fs.existsSync(path.join(target, 'dark-factory'))) return;
  if (!installedTemplate) {
    installedTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-installed-package-'));
    process.on('exit', () => fs.rmSync(installedTemplate, { recursive: true, force: true }));
    installFactoryPackage(installedTemplate);
    writeFiles(path.join(installedTemplate, 'dark-factory'), { [CLONE_MARKER.file]: CLONE_MARKER.text });
  }
  fs.cpSync(installedTemplate, target, { recursive: true });
};

const isFactorySetup = (spec) => String(spec.command[1] || '').endsWith('node_modules/dark-factory/bin/setup.js');

/** The sandbox step replaced by a local Node process: the real setup script of the clone's installed package. */
const runSetupLocally = (spec) => {
  const toHost = (arg) => (arg.startsWith(sandbox.CONTAINER_WORKDIR) ? path.join(spec.runDir, arg.slice(sandbox.CONTAINER_WORKDIR.length)) : arg);
  const [, script, ...args] = spec.command.map(toHost);
  const result = runSetupScript(script, { args, cwd: spec.runDir });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: null, name: 'setup' };
};

const SELF_REPORT_FULL = (count) =>
  ['=== ACCEPTANCE CRITERIA SELF-REPORT ===', ...Array.from({ length: count }, (_, i) => `${i + 1}. COVERED: test ${i + 1}`), '=== END ACCEPTANCE CRITERIA SELF-REPORT ==='].join('\n');

const done = (type, summary, report = '') => `${report}\nDONE\nTYPE: ${type}\nSUMMARY: ${summary}`;

/** An issue whose Affects names `paths`. */
/** @type {(...args: any[]) => any} */
const issueWith = (id, paths, { title = 'Neutral change', acCount = 2 } = {}) => ({
  id,
  title,
  dependsOn: [],
  body: [
    '## Context',
    'x',
    '## Affects',
    ...paths.map((p) => `- \`${p}\``),
    '## Acceptance Criteria',
    ...Array.from({ length: acCount }, (_, i) => `- [ ] AC-${i + 1} [behavior] item ${i + 1}. Verify: a.test.js "t${i + 1}"`),
    '## Dependencies',
    'none',
  ].join('\n'),
});

/** The run context the controller builds after its readiness checks. */
/** @type {(...args: any[]) => any} */
const runContext = (t, { consumerRoot, origin, profile, settings = {}, stepRegistry }) => ({
  consumerRoot,
  profile,
  settings: { issues: [], maxTurns: 20, ...settings },
  originUrl: origin,
  env: { ANTHROPIC_API_KEY: 'sk-test-placeholder' },
  echo: { out: () => {}, err: () => {} },
  stepRegistry,
  sandboxEnv: {
    sandboxConfig: sandbox.validateSandboxConfig(profile.sandbox),
    runsRoot: path.join(tempDir(t, 'ralph-runs-'), 'runs'),
    rootKey: 'testkey',
    agentModel: 'test-model',
  },
});

// --- one issue end to end on a neutral consumer ---

/** The application file the default agent changes in each fixture profile. */
const APP_FILE = { monorepo: 'packages/billing/src/a.ts', 'single-package': 'src/a.ts' };

/** Sandbox runs: an install (networked run) leaves the factory package in the clone, the setup run executes its real script; the gate (no network) passes. */
const defaultRun = (spec) => {
  if (isFactorySetup(spec)) return runSetupLocally(spec);
  if (spec.network !== 'none') installFactoryInClone(spec.runDir);
  return okResult();
};

/** Both reviews pass; `implement` (or the given function) changes the app file and says DONE. */
/** @type {(...args: any[]) => any} */
const defaultAgent = (fixture, { implement } = {}) => ({ pass, runDir }) => {
  if (pass === 'self-review') return 'REVIEW: PASS';
  if (pass === 'code-review') return 'CODEREVIEW: PASS';
  if (implement) return implement({ pass, runDir });
  writeFiles(runDir, { [APP_FILE[fixture]]: 'export const value = 1;\n' });
  return done('feat', 'add the value', SELF_REPORT_FULL(2));
};

/**
 * runIssue for one issue on a fresh neutral consumer with gh and the sandbox replaced. Returns the
 * result with the recorded agent calls, sandbox runs and GitHub mutations.
 */
/** @type {(...args: any[]) => any} */
const scenario = async (t, fixture, { mutate, files = {}, baseProfile, entries = [], prepareOrigin, issue = issueWith(7, [APP_FILE[fixture]]), onAgent, onRun = defaultRun, labels, proxy = true, settings, stepRegistry } = {}) => {
  const { runIssue } = require('../../ralph/core');
  isolateGit(t);
  const profile = controllerProfile(t, fixture, mutate);
  // The selected base carries the host's profile unless a scenario says otherwise (null: none).
  const { origin, consumerRoot } = makeConsumer(t, { files, profile: baseProfile === undefined ? profile : (baseProfile ?? undefined) });
  if (prepareOrigin) prepareOrigin(origin);
  const gh = fakeGitHub({ body: issue.body, labels });
  const calls = mockGh(t, gh.onGh);
  const box = mockSandbox(t, { onAgent: onAgent || defaultAgent(fixture), onRun, proxy });
  const ctx = runContext(t, { consumerRoot, origin, profile: freezeSnapshot(profile), settings, stepRegistry });
  const result = await runIssue(ctx, new Map([...entries.map((entry) => [entry.id, entry]), [issue.id, { ...issue, status: 'not-started' }]]), issue);
  const labelsSet = gh.mutations.filter((m) => m.kind === 'label').map((m) => m.label);
  const comments = gh.mutations.filter((m) => m.kind === 'comment');
  const prs = gh.mutations.filter((m) => m.kind === 'pr');
  return { result, gh, calls, box, ctx, origin, consumerRoot, profile, labelsSet, comments, prs };
};

const originBranches = (origin) =>
  gitIn(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean);

module.exports = {
  HUMAN_VERDICT,
  HUMAN_LABEL,
  tempDir,
  isolateGit,
  gitIn,
  writeFiles,
  makeConsumer,
  pushBranch,
  enableController,
  controllerProfile,
  mockGh,
  fakeGitHub,
  okResult,
  mockSandbox,
  CLONE_MARKER,
  installFactoryInClone,
  isFactorySetup,
  runSetupLocally,
  SELF_REPORT_FULL,
  done,
  issueWith,
  runContext,
  APP_FILE,
  defaultRun,
  defaultAgent,
  scenario,
  originBranches,
};
