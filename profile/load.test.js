'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('./load');

const SINGLE_PACKAGE = {
  branchTemplate: 'task/ISSUE-{issue}-{slug}',
  apps: [{ name: 'main', path: '.', gate: [{ argv: ['npm', 'test'], cwd: '.' }] }],
};

const MONOREPO = {
  branchTemplate: 'feature/{issue}-{slug}',
  githubProject: 3,
  apps: [
    { name: 'api', path: 'packages/api', install: [{ argv: ['npm', 'ci'], cwd: 'packages/api' }] },
    { name: 'web', path: 'packages/web' },
  ],
  skillRules: [{ path: 'packages/web', extensions: ['.tsx'], label: 'web UI', skills: ['ui'] }],
  ralph: { enabled: true, techDebtTrackerIssue: 12, enabledSteps: [] },
};

function makeProject(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(root, '.factory'));
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    fs.writeFileSync(path.join(root, '.factory', 'profile.json'), text);
  }
  return root;
}

function loadError(content) {
  const root = makeProject(content);
  try {
    loadProfile(root);
  } catch (error) {
    return error.message;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.fail('loadProfile did not throw');
}

test('loads valid profile from project root', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-cwd-'));
  const previous = process.cwd();
  try {
    process.chdir(elsewhere);
    for (const profile of [SINGLE_PACKAGE, MONOREPO]) {
      const root = makeProject(profile);
      try {
        assert.deepEqual(loadProfile(root), profile);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    process.chdir(previous);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('rejects profile missing required field naming it', () => {
  for (const base of [SINGLE_PACKAGE, MONOREPO]) {
    const profile = { ...base };
    delete profile.branchTemplate;
    assert.match(loadError(profile), /branchTemplate/);
  }
});

test('rejects wrong field type naming its path', () => {
  const profile = { ...MONOREPO, ralph: { ...MONOREPO.ralph, techDebtTrackerIssue: '334' } };
  assert.match(loadError(profile), /ralph\.techDebtTrackerIssue/);
});

test('rejects unknown field excludeSkills', () => {
  for (const base of [SINGLE_PACKAGE, MONOREPO]) {
    assert.match(loadError({ ...base, excludeSkills: ['x'] }), /excludeSkills/);
  }
});

test('fails with path when profile file is missing', () => {
  const root = makeProject();
  try {
    assert.throws(
      () => loadProfile(root),
      (/** @type {Error} */ error) => error.message.includes(path.join(root, '.factory', 'profile.json')),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts profile with ralph disabled', () => {
  for (const base of [SINGLE_PACKAGE, MONOREPO]) {
    const profile = { ...base, ralph: { enabled: false } };
    const root = makeProject(profile);
    try {
      assert.deepEqual(loadProfile(root), profile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects malformed json naming the profile file', () => {
  const message = loadError('{ "branchTemplate": ');
  assert.match(message, /profile\.json/);
  assert.match(message, /not valid JSON/);
});

test('rejects skill rule entry without skills', () => {
  const rule = { path: 'src', extensions: ['.js'], label: 'src' };
  assert.match(loadError({ ...SINGLE_PACKAGE, skillRules: [rule] }), /skillRules\[0\]\.skills/);
});

test('rejects unknown nested field naming its path', () => {
  const rule = { path: 'src', extensions: ['.js'], label: 'src', skills: ['a'], exclude: true };
  assert.match(loadError({ ...SINGLE_PACKAGE, skillRules: [rule] }), /skillRules\[0\]\.exclude/);
});

test('rejects enabled ralph without step settings', () => {
  const message = loadError({ ...SINGLE_PACKAGE, ralph: { enabled: true } });
  assert.match(message, /ralph\.techDebtTrackerIssue/);
  assert.match(message, /ralph\.enabledSteps/);
});

test('rejects duplicate app names', () => {
  const apps = [{ name: 'web', path: 'a' }, { name: 'web', path: 'b' }];
  assert.match(loadError({ ...SINGLE_PACKAGE, apps }), /apps\[1\]\.name/);
});

test('validates judge settings in both fixture profiles', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const labelled = (profile) => {
    profile.labels = { ...profile.labels, calibration: 'mark-for-analysis' };
  };
  for (const fixture of FIXTURE_PROFILES) {
    const variants = {
      'no judge section': (_profile) => {},
      'judge disabled': (profile) => {
        profile.judge = { enabled: false };
      },
      'judge disabled with a label': (profile) => {
        profile.judge = { enabled: false };
        labelled(profile);
      },
      'judge enabled with a label': (profile) => {
        profile.judge = { enabled: true };
        labelled(profile);
      },
    };
    for (const [name, mutate] of Object.entries(variants)) {
      const profile = loadProfile(profileCopy(t, fixture, mutate));
      assert.ok(profile.apps.length > 0, `${fixture}: ${name}`);
    }

    const enabledWithoutLabel = (profile) => {
      profile.judge = { enabled: true };
    };
    assert.throws(
      () => loadProfile(profileCopy(t, fixture, enabledWithoutLabel)),
      /labels\.calibration/,
      fixture,
    );
    const emptyLabels = (profile) => {
      profile.judge = { enabled: true };
      profile.labels = { humanNeeded: 'needs-human' };
    };
    assert.throws(
      () => loadProfile(profileCopy(t, fixture, emptyLabels)),
      /labels\.calibration/,
      fixture,
    );
    const unknownField = (profile) => {
      profile.judge = { enabled: true, label: 'x' };
      labelled(profile);
    };
    assert.throws(() => loadProfile(profileCopy(t, fixture, unknownField)), /judge\.label: unknown field/);
  }
});

const ENABLED_RALPH = { enabled: true, techDebtTrackerIssue: 1, enabledSteps: [] };
const withRalph = (extra = {}) => (profile) => {
  profile.ralph = { ...ENABLED_RALPH, ...extra };
};

test('skill rule accepts compound extension', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  for (const fixture of FIXTURE_PROFILES) {
    const extensions = ['.ts', '.test.ts', '.d.ts'];
    const root = profileCopy(t, fixture, (profile) => {
      profile.skillRules = [{ path: '.', extensions, label: 'x', skills: ['s'] }];
    });
    assert.deepEqual(loadProfile(root).skillRules[0].extensions, extensions, fixture);
  }
});

test('rejects malformed skill rule extensions', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const bad = ['ts', '', '.', '.test.', '..ts', '.a..b', '.ts.', '. ts', '.ts\n', '.a b', '.a/b', '.a\\b', '/.ts'];
  for (const fixture of FIXTURE_PROFILES) {
    for (const extension of bad) {
      const root = profileCopy(t, fixture, (profile) => {
        profile.skillRules = [{ path: '.', extensions: ['.ts', extension], label: 'x', skills: ['s'] }];
      });
      assert.throws(
        () => loadProfile(root),
        /skillRules\[0\]\.extensions\[1\]/,
        `${fixture}: ${JSON.stringify(extension)}`,
      );
    }
  }
});

test('project install uses shared command contract', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const install = [
    { argv: ['npm', 'install', '--ignore-scripts'], cwd: '.' },
    { argv: ['node', 'scripts/prepare.js'], cwd: 'tools' },
  ];
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, (profile) => {
      profile.install = install;
    });
    assert.deepEqual(loadProfile(root).install, install, fixture);
  }
});

test('project install is optional without implicit commands', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  for (const fixture of FIXTURE_PROFILES) {
    assert.equal(loadProfile(profileCopy(t, fixture)).install, undefined, fixture);
    const root = profileCopy(t, fixture, (profile) => {
      profile.install = [];
    });
    assert.deepEqual(loadProfile(root).install, [], fixture);
  }
});

test('rejects invalid project install command', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const cases = [
    [{ argv: [], cwd: '.' }, /install\[1\]\.argv/],
    [{ argv: ['npm', 'install'] }, /install\[1\]\.cwd/],
  ];
  for (const fixture of FIXTURE_PROFILES) {
    for (const [command, pattern] of cases) {
      const root = profileCopy(t, fixture, (profile) => {
        profile.install = [{ argv: ['npm', 'install'], cwd: '.' }, command];
      });
      assert.throws(() => loadProfile(root), pattern, fixture);
    }
  }
});

test('new fields are optional', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  for (const fixture of FIXTURE_PROFILES) {
    for (const ralph of [{ enabled: false }, ENABLED_RALPH]) {
      const root = profileCopy(t, fixture, (profile) => {
        profile.ralph = ralph;
      });
      const profile = loadProfile(root);
      assert.deepEqual(profile.ralph, ralph, fixture);
      assert.equal(profile.install, undefined, fixture);
      assert.equal(profile.hooks, undefined, fixture);
    }
  }
});

test('validates human needed verdict token', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const rejected = ['', 'a b', 'A:B', 'A\n', 'BLOCKED-X\n', ' X', 5, null, 'DONE', 'BLOCKED', 'TYPE', 'SUMMARY', 'REVIEW', 'CODEREVIEW'];
  const accepted = ['BLOCKED-PROMPT-CHANGE', 'BLOCKED-.*', 'BLOCKED-[A-Z]+|X', 'DONE-1', 'blocked', 'TYPES'];
  for (const fixture of FIXTURE_PROFILES) {
    for (const value of rejected) {
      const root = profileCopy(t, fixture, withRalph({ humanNeededVerdict: value }));
      assert.throws(() => loadProfile(root), /ralph\.humanNeededVerdict/, `${fixture}: ${JSON.stringify(value)}`);
    }
    for (const value of accepted) {
      const root = profileCopy(t, fixture, withRalph({ humanNeededVerdict: value }));
      assert.equal(loadProfile(root).ralph.humanNeededVerdict, value, `${fixture}: ${value}`);
    }
  }
});

test('keeps file token literal outside hooks', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const command = { argv: ['tool', '--file={file}', '{file}'], cwd: '.' };
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, (profile) => {
      profile.install = [command];
      profile.apps[0].install = [command];
      profile.apps[0].gate = [command];
    });
    const profile = loadProfile(root);
    assert.deepEqual(profile.install, [command], fixture);
    assert.deepEqual(profile.apps[0].install, [command], fixture);
    assert.deepEqual(profile.apps[0].gate, [command], fixture);
  }
});

test('loads extended settings in both fixture profiles', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const hooks = {
    lint: [{ paths: ['**/*.{ts,tsx}'], command: { argv: ['lint', '--file={file}', '{file}'], cwd: '.' } }],
    typecheck: [{ paths: ['**/*.ts'], command: { argv: ['tsc', '--noEmit'], cwd: '.' } }],
  };
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, (profile) => {
      withRalph({ humanNeededVerdict: 'BLOCKED-X' })(profile);
      profile.hooks = hooks;
    });
    const profile = loadProfile(root);
    assert.equal(profile.ralph.humanNeededVerdict, 'BLOCKED-X', fixture);
    assert.deepEqual(profile.hooks, hooks, fixture);
  }
});
