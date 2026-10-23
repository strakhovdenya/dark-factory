'use strict';

// The packed factory in two consumer repositories (a monorepo and a single package). The tarball is
// the real `npm pack` of this checkout; it is installed offline with the full runtime closure of
// its `dependencies`, outside the checkout, both in the consumer (the controller) and in the run
// clone (the factory and its setup). The installed CLI runs as its own Node process without
// NODE_PATH; the fixture boundary (test/fixtures/installed-ralph/boundary.js) replaces gh, Docker
// and the agent at the child_process boundary, and the clone's setup runs for real. No network,
// no Docker, no model.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hash } = require('../verifier/spec-hash');
const { tarballFiles, packedManifest, extractTarball, installPackage, runtimeClosure } = require('./fixtures/installed-ralph/package');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'installed-ralph');
const BOUNDARY = path.join(FIXTURE_DIR, 'boundary.js');
const PROFILES_DIR = path.join(__dirname, 'fixtures', 'profiles');
const ISSUE_ID = 7;
const PR_URL = 'https://example.invalid/pull/1';
const BLOCK_LABEL = 'ralph-blocked';
const HUMAN_LABEL = 'needs-human';
const EXTRA_SKILL = 'metautil-data-structures';
const MISSING_FILE = 'ralph/steps/code-review.js';
const DROPPED_ENV = /^(node_path|node_options|node_test_context|init_cwd|npm_.*|home|userprofile|git_.*)$/i;

const LAYOUTS = {
  monorepo: {
    appFile: 'packages/billing/src/a.ts',
    appPath: 'packages/billing',
    nested: 'packages/billing/src',
    files: { 'packages/billing/src/a.ts': 'export const a = 0;\n', 'packages/storefront/src/b.ts': 'export const b = 0;\n' },
    profile: (profile) => profile,
  },
  'single-package': {
    appFile: 'src/a.ts',
    appPath: 'src',
    nested: 'src',
    files: { 'src/a.ts': 'export const a = 0;\n' },
    profile: (profile) => ({ ...profile, branchTemplate: 'ralph/{issue}-{slug}' }),
  },
};

const normalize = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
const isInside = (parent, file) => {
  const relative = path.relative(normalize(parent), normalize(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const realTemp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const gitIn = (cwd, ...args) => String(childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
const writeFiles = (root, files) => {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
};

/** File path -> sha256 of every file under `root`, `.git` left out. */
const treeHashes = (root) => {
  const hashes = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hashes[path.relative(root, full).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return hashes;
};

// --- the packed delivery, prepared once ---

const delivery = { scratch: '', tarball: '', runtimeDir: '', manifest: null, baseSet: null, closure: [] };

const npmCli = () => {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((file) => file && file.endsWith('.js') && fs.existsSync(file));
  if (!found) throw new Error('npm-cli.js of the running Node is not found; npm pack cannot run');
  return found;
};

const pack = (destination) => {
  const env = { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  const result = childProcess.spawnSync(process.execPath, [npmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`npm pack failed (${result.status}): ${result.stderr}`);
  const [report] = JSON.parse(result.stdout);
  return path.join(destination, report.filename);
};

// The full runtime closure of the packed `dependencies`, copied from the packages already installed
// in this checkout (no registry). The lock must agree with the packed manifest.
const prepareRuntime = (manifest, runtimeDir) => {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'package-lock.json does not match the packed dependencies');
  const closure = runtimeClosure(lock, manifest.dependencies);
  for (const key of closure) {
    const source = path.join(REPO_ROOT, key);
    if (!fs.existsSync(path.join(source, 'package.json'))) throw new Error(`runtime dependency ${key} is not installed; run npm ci first`);
    fs.cpSync(source, path.join(runtimeDir, key), { recursive: true });
  }
  return closure;
};

before(() => {
  delivery.scratch = realTemp('installed-ralph-');
  delivery.tarball = pack(delivery.scratch);
  delivery.manifest = packedManifest(delivery.tarball);
  const unpacked = path.join(delivery.scratch, 'unpacked');
  extractTarball(delivery.tarball, unpacked);
  delivery.baseSet = JSON.parse(fs.readFileSync(path.join(unpacked, 'skills', 'base-set.json'), 'utf8'));
  delivery.runtimeDir = path.join(delivery.scratch, 'runtime');
  delivery.closure = prepareRuntime(delivery.manifest, delivery.runtimeDir);
});

after(() => fs.rmSync(delivery.scratch, { recursive: true, force: true }));

const baseSkillNames = () => [...delivery.baseSet.processSkills, ...delivery.baseSet.jsMetaskills].map((entry) => entry.name);
const baseAgentNames = () => delivery.baseSet.agents.map((entry) => entry.name);

// --- consumers ---

const fixtureProfile = (layout) => {
  const profile = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, layout, '.factory', 'profile.json'), 'utf8'));
  return LAYOUTS[layout].profile({
    ...profile,
    labels: { ...profile.labels, humanNeeded: HUMAN_LABEL },
    ralph: { ...profile.ralph, enabled: true, techDebtTrackerIssue: 5, humanNeededVerdict: 'NEEDS.HUMAN+' },
  });
};

const gitignoreText = (extraSkills) =>
  [
    'node_modules/',
    '.ralph/',
    '.claude/settings.local.json',
    '.claude/.factory-installed.json',
    ...[...baseSkillNames(), ...extraSkills].map((name) => `.claude/skills/${name}`),
    ...baseAgentNames().map((name) => `.claude/agents/${name}.md`),
    '',
  ].join('\n');

const issueFor = (layout, extraAffects = []) => {
  const body = [
    '## Context',
    'Neutral change.',
    '## Affects',
    ...[LAYOUTS[layout].appFile, ...extraAffects].map((file) => `- \`${file}\``),
    '## Acceptance Criteria',
    '- [ ] AC-1 [behavior] the value exists. Verify: a.test.js "t1"',
    '- [ ] AC-2 [behavior] the value is one. Verify: a.test.js "t2"',
    '## Dependencies',
    'none',
  ].join('\n');
  return { id: ISSUE_ID, title: 'Add the value', body, approval: `<!-- spec-approved sha256=${hash(body)} -->` };
};

const SELF_REPORT = ['=== ACCEPTANCE CRITERIA SELF-REPORT ===', '1. COVERED: t1', '2. COVERED: t2', '=== END ACCEPTANCE CRITERIA SELF-REPORT ==='].join('\n');
const DONE = `${SELF_REPORT}\nDONE\nTYPE: feat\nSUMMARY: add the value`;
const implementing = (layout, files = {}) => ({ implement: { files: { [LAYOUTS[layout].appFile]: 'export const a = 1;\n', ...files }, output: DONE } });

/**
 * A bare origin and a consumer cloned from it, outside the checkout, with the packed delivery
 * installed in its node_modules and the local run config. `profile` null commits no profile.
 */
const makeConsumer = (layout, { profile = fixtureProfile(layout), extraSkills = [], exclude = [] } = {}) => {
  const dir = fs.mkdtempSync(path.join(delivery.scratch, 'consumer-'));
  const home = path.join(dir, 'home');
  const runsRoot = path.join(dir, 'runs');
  fs.mkdirSync(home);
  const gitConfig = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED_ENV.test(name)));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ANTHROPIC_API_KEY: 'sk-test-placeholder',
  });
  const git = (cwd, ...args) => String(childProcess.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'trunk');
  const profileFile = profile === null ? {} : { '.factory/profile.json': `${JSON.stringify(profile, null, 2)}\n` };
  writeFiles(seed, { '.gitignore': gitignoreText(extraSkills), 'README.md': 'neutral\n', ...profileFile, ...LAYOUTS[layout].files });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'init');
  const origin = path.join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', seed, origin);
  const consumerRoot = path.join(dir, 'consumer');
  git(dir, 'clone', '-q', origin, consumerRoot);

  installPackage(path.join(consumerRoot, 'node_modules'), { tarball: delivery.tarball, runtimeDir: delivery.runtimeDir, exclude });
  writeFiles(consumerRoot, { '.ralph/config.json': JSON.stringify({ issues: [{ id: ISSUE_ID }], runsRoot, maxIterations: 1 }) });
  return { dir, layout, profile, origin, consumerRoot, runsRoot, env, entry: path.join(consumerRoot, 'node_modules', 'dark-factory', 'ralph', 'run.js') };
};

/**
 * Runs the installed CLI by the absolute path of its entry point, without --consumer-root, from
 * `cwd` (the consumer root by default). Returns the exit, the event log and the snapshots of the
 * consumer before and after.
 */
const runCli = (consumer, { cwd = consumer.consumerRoot, issue = issueFor(consumer.layout), agent = implementing(consumer.layout), cloneOmit = [] } = {}) => {
  const log = path.join(consumer.dir, 'events.jsonl');
  const scenarioFile = path.join(consumer.dir, 'scenario.json');
  fs.rmSync(log, { force: true });
  const scenario = { issue, labels: [BLOCK_LABEL, HUMAN_LABEL], prUrl: PR_URL, tarball: delivery.tarball, runtimeDir: delivery.runtimeDir, cloneOmit, agent };
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  const before = treeHashes(consumer.consumerRoot);
  const result = childProcess.spawnSync(process.execPath, ['--require', BOUNDARY, consumer.entry], {
    cwd,
    env: { ...consumer.env, INSTALLED_RALPH_LOG: log, INSTALLED_RALPH_SCENARIO: scenarioFile },
    encoding: 'utf8',
    timeout: 120000,
  });
  const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const statePath = path.join(consumer.runsRoot, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  return { ...result, events, state, before, after: treeHashes(consumer.consumerRoot), runDir: path.join(consumer.runsRoot, `issue-${ISSUE_ID}`) };
};

const eventsOf = (run, name) => run.events.filter((event) => event.event === name);
const ghCalls = (run, group, action) => eventsOf(run, 'gh').filter((event) => event.args[0] === group && event.args[1] === action);
const passesOf = (run) => eventsOf(run, 'agent').map((event) => event.pass);
const stepsOf = (run) => run.state.lastResult.steps.map((step) => `${step.name}:${step.outcome}`);
const sandboxOf = (run, kind) => eventsOf(run, 'sandbox').filter((event) => event.kind === kind);
const modulesOf = (run, role) => eventsOf(run, 'modules').filter((event) => event.role === role);
const originBranches = (consumer) => gitIn(consumer.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
const packageOf = (run) => Object.fromEntries(Object.entries(run.before).filter(([file]) => file.startsWith('node_modules/dark-factory/')));

const assertDone = (run) => {
  assert.equal(run.status, 0, run.stderr);
  const { issue, status, pr } = run.state.lastResult;
  assert.deepEqual({ issue, status, pr }, { issue: ISSUE_ID, status: 'done', pr: PR_URL }, run.stdout);
};

const assertBlocked = (run, reasonPattern) => {
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.state.lastResult.status, 'blocked', run.stdout);
  assert.match(run.state.lastResult.reason, reasonPattern);
  assert.deepEqual(ghCalls(run, 'pr', 'create'), []);
  assert.ok(ghCalls(run, 'issue', 'edit').some((event) => event.args.includes(BLOCK_LABEL)), 'the issue gets the block label');
};

// Every file a process loaded comes from the fixture boundary or from `root` (an installed node_modules).
const assertLoadedFrom = (modules, root) => {
  assert.equal(modules.length, 1, 'the process recorded its modules');
  const foreign = modules[0].files.filter((file) => !isInside(FIXTURE_DIR, file) && !isInside(root, file));
  assert.deepEqual(foreign, [], `modules loaded from outside ${root}`);
};

// Runs shared by several tests, made once.
const shared = new Map();
const sharedRun = (key, make) => {
  if (!shared.has(key)) shared.set(key, make());
  return shared.get(key);
};

// The baseline run of a layout, started from a nested directory of the consumer.
const baseline = (layout) =>
  sharedRun(`baseline:${layout}`, () => {
    const consumer = makeConsumer(layout);
    return { consumer, run: runCli(consumer, { cwd: path.join(consumer.consumerRoot, LAYOUTS[layout].nested) }) };
  });

const extendedProfile = (layout) => {
  const profile = fixtureProfile(layout);
  const { appPath } = LAYOUTS[layout];
  return {
    ...profile,
    extraMetaskills: [EXTRA_SKILL],
    skillRules: [...(profile.skillRules || []), { path: appPath, extensions: ['.ts'], label: 'consumer data', skills: [EXTRA_SKILL] }],
    protectedPaths: [...profile.protectedPaths, 'contracts/'],
    ralph: { ...profile.ralph, enabledSteps: ['implement', 'self-review', 'final-gate'] },
  };
};

const extended = (layout, violate) =>
  sharedRun(`extended:${layout}:${violate}`, () => {
    const consumer = makeConsumer(layout, { profile: extendedProfile(layout), extraSkills: [EXTRA_SKILL] });
    const agent = implementing(layout, violate ? { 'contracts/api.json': '{}\n' } : {});
    return { consumer, run: runCli(consumer, { agent }) };
  });

describe('installed Ralph from the packed tarball', () => {
  it('ships complete runtime payload', () => {
    const files = tarballFiles(delivery.tarball);
    const own = [
      'package.json',
      'bin/setup.js',
      'ralph/run.js',
      'ralph/core.js',
      'ralph/prompts.js',
      'ralph/parsing.js',
      'ralph/boundary.js',
      'ralph/workspace.js',
      'ralph/sandbox.js',
      'ralph/sandbox/Dockerfile',
      'ralph/sandbox/proxy.js',
      'ralph/steps/registry.js',
      'ralph/steps/implement.js',
      'ralph/steps/self-review.js',
      'ralph/steps/code-review.js',
      'ralph/steps/final-gate.js',
      'hooks/skill-gate.js',
      'hooks/closure-gate.js',
      'hooks/lint.js',
      'hooks/typecheck.js',
      'profile/load.js',
      'profile/schema.json',
      'verifier/schema.json',
      'verifier/spec-hash.js',
      'skills/base-set.json',
    ];
    for (const file of own) assert.ok(files.includes(file), `${file} is in the tarball`);
    const packageDirs = [...delivery.baseSet.processSkills, ...delivery.baseSet.jsMetaskills].map((entry) => entry.source).filter((source) => source.kind === 'package-dir');
    for (const source of packageDirs) assert.ok(files.includes(`${source.path}/SKILL.md`), `${source.path} is in the tarball`);
    for (const agent of delivery.baseSet.agents) assert.ok(files.includes(agent.path), `${agent.path} is in the tarball`);
    assert.deepEqual(files.filter((file) => file.startsWith('.claude/') || file.startsWith('.factory/')), []);
    assert.ok(!files.some((file) => file.startsWith('node_modules/')), 'dependencies are not bundled');

    // npm sources of the base set come from the prepared runtime closure, at the pinned version.
    const npmSources = [...delivery.baseSet.processSkills, ...delivery.baseSet.jsMetaskills].map((entry) => entry.source).filter((source) => source.kind === 'npm');
    assert.ok(npmSources.length > 0);
    for (const source of npmSources) {
      const root = path.join(delivery.runtimeDir, 'node_modules', source.package);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, source.version);
      assert.ok(fs.existsSync(path.join(root, source.path, 'SKILL.md')), `${source.package}/${source.path}`);
    }
    // The closure is exactly the lock's non-dev packages, and every declared dependency is in it.
    const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
    const runtimeEntries = Object.entries(lock.packages).filter(([key, entry]) => key !== '' && !entry.dev && !entry.devOptional).map(([key]) => key).sort();
    assert.deepEqual(delivery.closure, runtimeEntries);
    for (const name of Object.keys(delivery.manifest.dependencies)) assert.ok(delivery.closure.includes(`node_modules/${name}`), name);
  });

  it('runs packed controller in both consumer layouts', () => {
    for (const layout of Object.keys(LAYOUTS)) {
      const { consumer, run } = baseline(layout);
      assertDone(run);
      const [pr] = ghCalls(run, 'pr', 'create');
      assert.ok(pr, `${layout}: the controller prepared the PR`);
      const head = pr.args[pr.args.indexOf('--head') + 1];
      const expectedBranch = layout === 'monorepo' ? `task/ISSUE-${ISSUE_ID}-add-the-value` : `ralph/${ISSUE_ID}-add-the-value`;
      assert.equal(head, expectedBranch);
      assert.equal(pr.args[pr.args.indexOf('--base') + 1], 'trunk');
      assert.equal(normalize(pr.cwd), normalize(consumer.consumerRoot));
      assert.ok(originBranches(consumer).includes(expectedBranch), `${layout}: the branch was pushed to the consumer's origin`);
      // The controller and the clone's setup were loaded only from the installed copies.
      assertLoadedFrom(modulesOf(run, 'controller'), path.join(consumer.consumerRoot, 'node_modules'));
      assertLoadedFrom(modulesOf(run, 'setup'), path.join(run.runDir, 'node_modules'));
      assert.ok(modulesOf(run, 'setup')[0].files.some((file) => normalize(file) === normalize(path.join(run.runDir, 'node_modules', 'dark-factory', 'bin', 'setup.js'))));
      assert.ok(!modulesOf(run, 'controller')[0].files.some((file) => isInside(REPO_ROOT, file) && !isInside(FIXTURE_DIR, file)));
    }
  });

  it('installs complete skills before agent execution', () => {
    for (const layout of Object.keys(LAYOUTS)) {
      const { run } = baseline(layout);
      const kinds = run.events.filter((event) => event.event === 'sandbox' || event.event === 'agent').map((event) => event.kind ?? event.event);
      const setupIndex = kinds.indexOf('setup');
      assert.ok(setupIndex !== -1 && setupIndex < kinds.indexOf('agent'), `${layout}: setup runs before the first agent call`);
      assert.equal(sandboxOf(run, 'setup')[0].status, 0);
      const [first] = eventsOf(run, 'agent');
      assert.equal(first.pass, 'implement');
      for (const name of baseSkillNames()) assert.ok(first.skills.includes(name), `${layout}: skill ${name} is installed before the agent`);
      for (const name of baseAgentNames()) assert.ok(first.agents.includes(`${name}.md`), `${layout}: agent ${name} is installed before the agent`);
      assert.ok(!first.skills.includes('code-review'), 'the bundled code-review skill needs no directory of the package');
      const expected = [...baseSkillNames().map((name) => `.claude/skills/${name}`), ...baseAgentNames().map((name) => `.claude/agents/${name}.md`)].sort();
      assert.deepEqual(first.copies, expected, 'setup of the clone lists exactly the base set as its copies');
    }
  });

  it('uses consumer profile from nested working directory', () => {
    for (const layout of Object.keys(LAYOUTS)) {
      const { consumer, run } = baseline(layout);
      assertDone(run);
      const { profile } = consumer;
      const workdirOf = (cwd) => (cwd === '.' ? '/workspace' : `/workspace/${cwd}`);
      const installs = profile.apps.flatMap((app) => app.install).map((command) => ({ workdir: workdirOf(command.cwd), command: command.argv }));
      assert.deepEqual(sandboxOf(run, 'install').map((event) => ({ workdir: event.workdir, command: event.command })), installs, `${layout}: installs of its profile`);
      const touched = profile.apps.filter((app) => LAYOUTS[layout].appFile.startsWith(app.path === '.' ? '' : `${app.path}/`));
      const gates = touched.flatMap((app) => app.gate).map((command) => ({ workdir: workdirOf(command.cwd), command: command.argv }));
      assert.deepEqual(sandboxOf(run, 'gate').map((event) => ({ workdir: event.workdir, command: event.command })), gates, `${layout}: gate of its profile`);
      for (const event of eventsOf(run, 'sandbox')) assert.equal(event.image, profile.sandbox.image);
      const build = eventsOf(run, 'docker').find((event) => event.args[0] === 'build');
      assert.equal(build.args[build.args.indexOf('-t') + 1], profile.sandbox.image);
      for (const event of eventsOf(run, 'gh')) assert.equal(normalize(event.cwd), normalize(consumer.consumerRoot));
      const [implement] = eventsOf(run, 'agent');
      for (const pattern of profile.protectedPaths) assert.ok(implement.deny.some((rule) => rule.startsWith(`Edit(${pattern}`)), `${layout}: ${pattern} is denied`);
      const gateRules = [...new Set(profile.apps.flatMap((app) => app.gate).flatMap(({ argv }) => [`Bash(${argv.join(' ')})`, `Bash(${argv.join(' ')} *)`]))];
      assert.deepEqual(implement.allow.filter((rule) => rule.startsWith('Bash(node ')), gateRules, `${layout}: the gate rules of its own profile only`);
    }
  });

  it('enables baseline reviews for enabled controller', () => {
    for (const layout of Object.keys(LAYOUTS)) {
      const { consumer, run } = baseline(layout);
      assert.equal(consumer.profile.ralph.enabledSteps, undefined);
      assertDone(run);
      assert.deepEqual(passesOf(run), ['implement', 'self-review', 'code-review']);
      assert.deepEqual(stepsOf(run), ['implement:passed', 'self-review:passed', 'code-review:passed', 'final-gate:passed']);
      assert.ok(sandboxOf(run, 'gate').length > 0, `${layout}: final-gate ran`);
    }
  });

  it('supports additive consumer extensions and optional review', () => {
    for (const layout of Object.keys(LAYOUTS)) {
      const ordinary = extended(layout, false);
      assertDone(ordinary.run);
      assert.deepEqual(passesOf(ordinary.run), ['implement', 'self-review']);
      assert.deepEqual(stepsOf(ordinary.run), ['implement:passed', 'self-review:passed', 'final-gate:passed']);
      assert.ok(sandboxOf(ordinary.run, 'gate').length > 0, `${layout}: final-gate ran`);
      const [implement] = eventsOf(ordinary.run, 'agent');
      assert.ok(implement.skills.includes(EXTRA_SKILL), `${layout}: the extra skill is installed in the clone`);
      assert.ok(implement.allow.includes(`Skill(${EXTRA_SKILL})`));
      assert.match(implement.prompt, new RegExp(EXTRA_SKILL));
      assert.deepEqual(ordinary.run.after, ordinary.run.before, 'node_modules of the consumer is not edited');
      assert.ok(!fs.existsSync(path.join(ordinary.consumer.consumerRoot, 'node_modules', 'dark-factory', 'skills', EXTRA_SKILL)));

      const violation = extended(layout, true);
      assertBlocked(violation.run, /contracts\/api\.json/);
      assert.deepEqual(passesOf(violation.run), ['implement']);
      assert.deepEqual(sandboxOf(violation.run, 'gate'), []);
      const [denied] = eventsOf(violation.run, 'agent');
      for (const glob of ['.git/**', '.claude/**', '.factory/profile.json', 'contracts/**']) assert.ok(denied.deny.includes(`Edit(${glob})`), `${layout}: ${glob} stays protected`);
      assert.ok(!originBranches(violation.consumer).some((branch) => branch !== 'trunk'), 'nothing is pushed');
    }
  });

  it('keeps installed package immutable', () => {
    const runs = [...Object.keys(LAYOUTS).map((layout) => baseline(layout)), ...Object.keys(LAYOUTS).map((layout) => extended(layout, true))];
    for (const { consumer, run } of runs) {
      assert.ok(Object.keys(packageOf(run)).length > 0);
      assert.deepEqual(run.after, run.before, 'the consumer, its installed package included, is unchanged');
      const state = fs.readdirSync(consumer.runsRoot);
      assert.ok(state.includes('state.json'));
      assert.ok(!state.includes('run.lock'), 'the lock is released');
      assert.ok(!isInside(path.join(consumer.consumerRoot, 'node_modules'), consumer.runsRoot));
    }
  });

  it('rejects unusable profile before side effects', () => {
    const cases = [
      { layout: 'monorepo', profile: { ...fixtureProfile('monorepo'), ralph: { ...fixtureProfile('monorepo').ralph, enabledSteps: [] } }, reason: /enabledSteps/ },
      { layout: 'monorepo', profile: null, reason: /profile\.json/ },
      { layout: 'single-package', profile: { ...fixtureProfile('single-package'), ralph: { enabled: false } }, reason: /Ralph is not enabled/ },
    ];
    for (const { layout, profile, reason } of cases) {
      const consumer = makeConsumer(layout, { profile });
      const run = runCli(consumer);
      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, reason);
      assert.deepEqual(eventsOf(run, 'gh'), []);
      assert.deepEqual(eventsOf(run, 'docker'), []);
      assert.deepEqual(eventsOf(run, 'sandbox'), []);
      assert.deepEqual(eventsOf(run, 'agent'), []);
      assert.ok(!fs.existsSync(consumer.runsRoot), 'no lock, state or clone');
      assert.deepEqual(run.after, run.before);
    }
  });

  it('does not trust agent modified profile', () => {
    const layout = 'single-package';
    const consumer = makeConsumer(layout);
    const weakened = { ...consumer.profile, protectedPaths: [], ralph: { ...consumer.profile.ralph, enabledSteps: ['implement', 'final-gate'] } };
    const run = runCli(consumer, { agent: implementing(layout, { '.factory/profile.json': JSON.stringify(weakened) }) });
    assertBlocked(run, /\.factory\/profile\.json/);
    assert.deepEqual(passesOf(run), ['implement']);
    assert.deepEqual(sandboxOf(run, 'gate'), []);
    assert.deepEqual(originBranches(consumer), ['trunk']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(consumer.consumerRoot, '.factory', 'profile.json'), 'utf8')), consumer.profile);
    assert.deepEqual(run.after, run.before, 'the installed package is unchanged');
  });

  it('detects missing packaged runtime file', () => {
    const consumer = makeConsumer('monorepo', { exclude: [MISSING_FILE] });
    const run = runCli(consumer);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Cannot find module '\.\/code-review'/);
    assert.ok(normalize(run.stderr).includes(normalize(path.join(consumer.consumerRoot, 'node_modules', 'dark-factory', 'ralph', 'steps', 'registry.js'))));
    assertLoadedFrom(modulesOf(run, 'controller'), path.join(consumer.consumerRoot, 'node_modules'));
    assert.deepEqual(eventsOf(run, 'gh'), []);
    assert.deepEqual(eventsOf(run, 'docker'), []);
    assert.ok(!fs.existsSync(consumer.runsRoot), 'no lock, state or clone');
    assert.ok(!fs.existsSync(path.join(consumer.consumerRoot, 'node_modules', 'dark-factory', ...MISSING_FILE.split('/'))), 'the file is not restored');
    assert.deepEqual(run.after, run.before);
  });

  it('blocks clone setup without runtime dependency', () => {
    const consumer = makeConsumer('monorepo');
    const run = runCli(consumer, { cloneOmit: ['ajv'] });
    assertBlocked(run, /factory-setup failed/);
    assert.ok(fs.existsSync(path.join(consumer.consumerRoot, 'node_modules', 'ajv')), 'the controller itself has ajv');
    assert.ok(!fs.existsSync(path.join(run.runDir, 'node_modules', 'ajv')));
    const [setup] = sandboxOf(run, 'setup');
    assert.notEqual(setup.status, 0);
    const logPath = /full output: (.+)$/m.exec(run.state.lastResult.reason)[1].trim();
    assert.match(fs.readFileSync(logPath, 'utf8'), /Cannot find module 'ajv/);
    assertLoadedFrom(modulesOf(run, 'setup'), path.join(run.runDir, 'node_modules'));
    assert.deepEqual(eventsOf(run, 'agent'), []);
    assert.deepEqual(run.after, run.before);
  });
});
