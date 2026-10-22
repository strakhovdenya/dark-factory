'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../profile/load');
const { validateSandboxConfig } = require('../../ralph/sandbox');
const { CORE_CHECK_NAMES } = require('../../verifier/checks');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'profiles');
const monorepoRoot = path.join(FIXTURES, 'monorepo');
const singlePackageRoot = path.join(FIXTURES, 'single-package');
const jobflowRoot = path.join(__dirname, 'jobflow');
const cardsRoot = path.join(__dirname, 'cards');

test('fixture profiles are valid and have expected shape', () => {
  const monorepo = loadProfile(monorepoRoot);
  assert.equal(monorepo.apps.length, 2);
  for (const app of monorepo.apps) {
    assert.ok(app.install.length > 0, `${app.name} has install steps`);
    assert.ok(app.gate.length > 0, `${app.name} has gate commands`);
  }

  const single = loadProfile(singlePackageRoot);
  assert.equal(single.apps.length, 1);
  assert.equal(single.apps[0].path, '.');
});

test('example profiles of jobflow and cards are valid', () => {
  assert.doesNotThrow(() => loadProfile(jobflowRoot));
  assert.doesNotThrow(() => loadProfile(cardsRoot));
});

test('jobflow profile keeps current project values', () => {
  const profile = loadProfile(jobflowRoot);
  assert.equal(profile.ralph.techDebtTrackerIssue, 334);
  assert.equal(profile.labels.humanNeeded, 'ralph-needs-prompt-change');
  assert.equal(profile.labels.calibration, 'calibrate');
  assert.deepEqual(profile.judge, { enabled: true });
  assert.equal(profile.protectedPaths.length, 7);
  assert.equal(profile.skillRules.length, 2);
  assert.deepEqual(
    profile.skillRules.map((rule) => rule.path),
    ['apps/api', 'apps/web'],
  );
  assert.equal(profile.verifier.goldenDir, '.github/verifier/golden');
  assert.equal(profile.docs.adr, 'project-management/DECISIONS.md');
  // Every check the verifier ran before checks became modules stays on, so
  // the project's verdicts do not change.
  assert.deepEqual(profile.verifier.checks, CORE_CHECK_NAMES);
  assert.deepEqual(profile.apps.map((app) => app.path), ['apps/api', 'apps/web']);
});

test('cards profile keeps current project values', () => {
  const profile = loadProfile(cardsRoot);
  assert.equal(profile.ralph.techDebtTrackerIssue, 1);
  assert.equal(profile.labels.humanNeeded, 'ralph-needs-db-change');
  assert.equal(profile.judge, undefined, 'Judge stays off for a project that does not enable it');
  assert.equal(profile.apps.length, 1);
  const { gate } = profile.apps[0];
  assert.equal(gate.length, 4);
  for (const command of gate) {
    assert.equal(command.argv[0], 'node', 'gate runs binaries through node');
    assert.notEqual(command.argv[0], 'npm');
    assert.ok(!command.argv.includes('run'), 'no npm run in the gate');
  }
  assert.deepEqual(
    gate.map((command) => path.basename(command.argv[1])),
    ['eslint.js', 'prettier.cjs', 'tsc', 'next'],
  );
  assert.ok(profile.protectedPaths.includes('docs/'));
  assert.equal(profile.verifier?.goldenDir, undefined);
});

test('example profile without tech debt tracker is rejected', () => {
  const profile = JSON.parse(
    fs.readFileSync(path.join(jobflowRoot, '.factory', 'profile.json'), 'utf8'),
  );
  delete profile.ralph.techDebtTrackerIssue;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-example-'));
  try {
    fs.mkdirSync(path.join(root, '.factory'));
    fs.writeFileSync(path.join(root, '.factory', 'profile.json'), JSON.stringify(profile));
    assert.throws(() => loadProfile(root), /ralph\.techDebtTrackerIssue/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixture profiles do not name consumer projects', () => {
  const literals = ['jobflow', 'cards', 'supabase', 'prisma', 'strakhovdenya', 'apps/api', 'apps/web'];
  for (const root of [monorepoRoot, singlePackageRoot]) {
    const text = fs.readFileSync(path.join(root, '.factory', 'profile.json'), 'utf8').toLowerCase();
    for (const literal of literals) {
      assert.ok(!text.includes(literal), `${path.basename(root)} contains "${literal}"`);
    }
  }
});

test('example profiles keep blocking verdict', () => {
  assert.equal(loadProfile(jobflowRoot).ralph.humanNeededVerdict, 'BLOCKED-PROMPT-CHANGE');
  assert.equal(loadProfile(cardsRoot).ralph.humanNeededVerdict, 'BLOCKED-DB-CHANGE');
});

test('jobflow root install is a project-level step', () => {
  const profile = loadProfile(jobflowRoot);
  assert.deepEqual(profile.install, [{ argv: ['npm', 'install', '--ignore-scripts'], cwd: '.' }]);
  assert.deepEqual(
    profile.apps.map((app) => app.install),
    [
      [{ argv: ['npm', 'install'], cwd: 'apps/api' }],
      [{ argv: ['npm', 'install'], cwd: 'apps/web' }],
    ],
  );
});

test('cards vitest rule targets test files', () => {
  const rules = loadProfile(cardsRoot).skillRules.filter((rule) => rule.skills.includes('vitest'));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].path, 'src');
  assert.deepEqual(rules[0].extensions, ['.test.ts']);
});

test('example hook commands preserve source behaviour', () => {
  const node = (bin, ...args) => ['node', `node_modules/${bin}`, ...args];
  const eslint = (cwd) => ({
    paths: [`${cwd}/**/*.{ts,tsx}`],
    command: { argv: node('eslint/bin/eslint.js', '--fix', '{file}'), cwd },
  });
  const tsc = (cwd) => ({
    paths: [`${cwd}/**/*.{ts,tsx}`],
    command: { argv: node('typescript/bin/tsc', '--noEmit'), cwd },
  });
  assert.deepEqual(loadProfile(jobflowRoot).hooks, {
    lint: [eslint('apps/api'), eslint('apps/web')],
    typecheck: [tsc('apps/api'), tsc('apps/web')],
  });
  const sources = ['**/*.{ts,tsx,js,jsx}'];
  assert.deepEqual(loadProfile(cardsRoot).hooks, {
    lint: [
      { paths: sources, command: { argv: node('prettier/bin/prettier.cjs', '--write', '{file}'), cwd: '.' } },
      { paths: sources, command: { argv: node('eslint/bin/eslint.js', '--fix', '{file}'), cwd: '.' } },
    ],
    typecheck: [
      { paths: ['**/*.{ts,tsx}'], command: { argv: node('typescript/bin/tsc', '--noEmit'), cwd: '.' } },
    ],
  });
});

test('example profiles keep sandbox settings', () => {
  assert.deepEqual(loadProfile(jobflowRoot).sandbox, {
    image: 'ralph-sandbox:local',
    nodeVersion: '22',
    claudeCodeVersion: '2.1.283',
    allowedHosts: ['registry.npmjs.org', 'binaries.prisma.sh', 'api.anthropic.com'],
    installEnv: { PUPPETEER_SKIP_DOWNLOAD: 'true' },
  });
  assert.deepEqual(loadProfile(cardsRoot).sandbox, {
    image: 'cards-ralph-sandbox:local',
    nodeVersion: '22',
    claudeCodeVersion: '2.1.283',
    allowedHosts: ['registry.npmjs.org', 'api.anthropic.com'],
  });
  for (const root of [jobflowRoot, cardsRoot]) {
    const profile = loadProfile(root);
    assert.equal(profile.runsRoot, undefined);
    assert.equal(profile.sandbox.runsRoot, undefined);
    assert.doesNotThrow(() => validateSandboxConfig(profile.sandbox));
  }
});

test('example profiles declare dependency sync and doc-only globs', () => {
  const sync = (cwd) => [{ argv: ['npm', 'install', '--ignore-scripts'], cwd }];
  const jobflow = loadProfile(jobflowRoot);
  assert.deepEqual(jobflow.dependencySync, sync('.'));
  assert.deepEqual(jobflow.apps.map((app) => app.dependencySync), [sync('apps/api'), sync('apps/web')]);
  assert.deepEqual(jobflow.docOnlyPathPatterns, ['**/*.md', '**/docs/', '**/project-management/']);
  assert.deepEqual(jobflow.protectedPaths, ['.claude/', 'scripts/', '.github/', '.husky/', '.git/', 'apps/api/prisma/prompts/', 'apps/api/knowledge-sources/']);

  const cards = loadProfile(cardsRoot);
  assert.equal(cards.dependencySync, undefined);
  assert.deepEqual(cards.apps[0].dependencySync, sync('.'));
  assert.deepEqual(cards.docOnlyPathPatterns, ['**/*.md', '**/docs/']);
  assert.deepEqual(cards.protectedPaths, ['.claude/', 'scripts/', '.github/', '.husky/', '.git/', 'docs/']);

  // The reference regexes matched these paths at any depth; the globs keep that.
  const { isDocOnlyPath } = require('../../profile/path-patterns');
  for (const file of ['README.md', 'apps/web/docs/x.ts', 'project-management/plan/a.txt', 'apps/api/project-management/x']) {
    assert.ok(isDocOnlyPath(file, jobflow.docOnlyPathPatterns), file);
  }
  assert.ok(!isDocOnlyPath('apps/api/src/docs.ts', jobflow.docOnlyPathPatterns));
});
