'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../profile/load');
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
  assert.equal(profile.skillRules.length, 4);
  assert.deepEqual(
    profile.skillRules.map((rule) => rule.path),
    ['apps/api', 'apps/web', 'scripts', '.claude/ralph'],
  );
  assert.equal(profile.verifier.goldenDir, '.github/verifier/golden');
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
