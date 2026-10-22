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
  sandbox: {
    image: 'unit-sandbox:test',
    nodeVersion: '22',
    claudeCodeVersion: '1.2.3',
    allowedHosts: ['registry.example.org'],
  },
  ralph: { enabled: true, techDebtTrackerIssue: 12 },
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

test('rejects enabled ralph without tech-debt tracker', () => {
  const message = loadError({ ...SINGLE_PACKAGE, ralph: { enabled: true } });
  assert.match(message, /ralph\.techDebtTrackerIssue/);
  assert.doesNotMatch(message, /ralph\.enabledSteps/, 'an absent step list is the baseline pipeline');
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

const ENABLED_RALPH = { enabled: true, techDebtTrackerIssue: 1 };
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

const withSandbox = (extra) => (profile) => {
  profile.sandbox = { ...profile.sandbox, ...extra };
};

test('rejects enabled controller without sandbox', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const childProcess = require('node:child_process');
  const started = [];
  for (const name of /** @type {('spawn' | 'spawnSync' | 'exec' | 'execSync' | 'execFile' | 'execFileSync' | 'fork')[]} */ ([
    'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
  ])) {
    t.mock.method(childProcess, name, (...args) => {
      started.push([name, args[0]]);
      throw new Error('a process was started');
    });
  }
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, (profile) => {
      profile.ralph = { ...ENABLED_RALPH };
      delete profile.sandbox;
    });
    assert.throws(() => loadProfile(root), /profile\.json[\s\S]*sandbox: required field is missing/, fixture);
    const empty = profileCopy(t, fixture, (profile) => {
      profile.ralph = { ...ENABLED_RALPH };
      profile.sandbox = {};
    });
    assert.throws(() => loadProfile(empty), /sandbox\.image: required field is missing/, fixture);
  }
  assert.deepEqual(started, []);
});

test('keeps sandbox and judge schema conditions independent', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const ralphStates = { absent: undefined, disabled: { enabled: false }, enabled: ENABLED_RALPH };
  const judgeStates = { absent: undefined, disabled: { enabled: false }, enabled: { enabled: true } };
  for (const fixture of FIXTURE_PROFILES) {
    for (const [ralphName, ralph] of Object.entries(ralphStates)) {
      for (const [judgeName, judge] of Object.entries(judgeStates)) {
        for (const hasSandbox of [false, true]) {
          for (const hasLabel of [false, true]) {
            const root = profileCopy(t, fixture, (profile) => {
              const base = profile.sandbox;
              delete profile.ralph;
              delete profile.judge;
              delete profile.sandbox;
              delete profile.labels;
              if (ralph) profile.ralph = { ...ralph };
              if (judge) profile.judge = { ...judge };
              if (hasSandbox) profile.sandbox = base;
              if (hasLabel) profile.labels = { calibration: 'mark-for-analysis' };
            });
            const name = `${fixture}: ralph ${ralphName}, judge ${judgeName}, sandbox ${hasSandbox}, label ${hasLabel}`;
            const needsSandbox = ralphName === 'enabled' && !hasSandbox;
            const needsLabel = judgeName === 'enabled' && !hasLabel;
            if (!needsSandbox && !needsLabel) {
              assert.equal(loadProfile(root).sandbox !== undefined, hasSandbox, name);
              continue;
            }
            let message = '';
            try {
              loadProfile(root);
            } catch (error) {
              message = error.message;
            }
            assert.equal(/sandbox: required field is missing/.test(message), needsSandbox, name);
            assert.equal(/labels\.calibration/.test(message), needsLabel, name);
          }
        }
      }
    }
  }
});

test('rejects invalid sandbox fields through shared validation', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const { collectSandboxProblems, validateSandboxConfig } = require('../ralph/sandbox');
  const cases = [
    { field: 'sandbox.image', change: { image: 'untagged-image' } },
    { field: 'sandbox.image', change: { image: 'bad image:tag' } },
    { field: 'sandbox.nodeVersion', change: { nodeVersion: '22.x' } },
    { field: 'sandbox.claudeCodeVersion', change: { claudeCodeVersion: '^2.1.0' } },
    { field: 'sandbox.claudeCodeVersion', change: { claudeCodeVersion: 'latest' } },
    { field: 'sandbox.allowedHosts', change: { allowedHosts: [] } },
    { field: 'sandbox.allowedHosts[1]', change: { allowedHosts: ['registry.example.org', 'https://registry.example.org'] } },
    { field: 'sandbox.allowedHosts[0]', change: { allowedHosts: ['10.0.0.1'] } },
    { field: 'sandbox.installEnv.HTTPS_PROXY', change: { installEnv: { HTTPS_PROXY: 'x' } } },
    { field: 'sandbox.installEnv.GIT_DIR', change: { installEnv: { GIT_DIR: 'x' } } },
    { field: 'sandbox.installEnv.1BAD', change: { installEnv: { '1BAD': 'x' } } },
    { field: 'sandbox.installEnv.FLAG', change: { installEnv: { FLAG: 1 } } },
    { field: 'sandbox.extra', change: { extra: true } },
  ];
  for (const fixture of FIXTURE_PROFILES) {
    for (const { field, change } of cases) {
      const root = profileCopy(t, fixture, withSandbox(change));
      const name = `${fixture}: ${field}`;
      assert.throws(
        () => loadProfile(root),
        (/** @type {Error} */ error) => error.message.includes('profile.json') && error.message.includes(`  - ${field}: `),
        name,
      );
      const { sandbox } = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'profile.json'), 'utf8'));
      assert.throws(() => validateSandboxConfig(sandbox), (/** @type {Error} */ error) => error.message.includes(field), name);
      assert.ok(collectSandboxProblems(sandbox).length > 0, name);
    }
  }
});

test('rejects invalid sandbox even when ralph is not enabled', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  for (const fixture of FIXTURE_PROFILES) {
    for (const ralph of [undefined, { enabled: false }]) {
      const root = profileCopy(t, fixture, (profile) => {
        delete profile.ralph;
        if (ralph) profile.ralph = ralph;
        profile.sandbox = { ...profile.sandbox, image: 'untagged-image' };
      });
      assert.throws(() => loadProfile(root), /sandbox\.image/, fixture);
    }
    const absent = profileCopy(t, fixture, (profile) => {
      profile.ralph = { enabled: false };
      delete profile.sandbox;
    });
    assert.equal(loadProfile(absent).sandbox, undefined, fixture);
  }
});

test('rejects local runs root in project profile', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  for (const fixture of FIXTURE_PROFILES) {
    const atRoot = profileCopy(t, fixture, (profile) => {
      profile.runsRoot = '/data/runs';
    });
    assert.throws(() => loadProfile(atRoot), /runsRoot: unknown field/, fixture);
    const inSandbox = profileCopy(t, fixture, withSandbox({ runsRoot: '/data/runs' }));
    assert.throws(() => loadProfile(inSandbox), /sandbox\.runsRoot: unknown field/, fixture);
  }
});

test('dependency sync of root and apps uses shared command contract', (t) => {
  const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
  const sync = [{ argv: ['npm', 'install', '--ignore-scripts', '{file}'], cwd: '.' }];
  for (const fixture of FIXTURE_PROFILES) {
    assert.equal(loadProfile(profileCopy(t, fixture)).dependencySync, undefined, fixture);
    const root = profileCopy(t, fixture, (profile) => {
      profile.dependencySync = sync;
      profile.apps[0].dependencySync = sync;
    });
    const loaded = loadProfile(root);
    assert.deepEqual(loaded.dependencySync, sync, fixture);
    assert.deepEqual(loaded.apps[0].dependencySync, sync, fixture);
    assert.equal(loaded.apps[0].dependencySync[0].argv[3], '{file}', 'file token stays literal');

    for (const { mutate, pattern } of [
      { mutate: (profile) => (profile.dependencySync = [{ argv: [], cwd: '.' }]), pattern: /dependencySync\[0\]\.argv/ },
      { mutate: (profile) => (profile.apps[0].dependencySync = [{ argv: ['npm'] }]), pattern: /apps\[0\]\.dependencySync\[0\]\.cwd/ },
      { mutate: (profile) => (profile.dependencySync = 'npm install'), pattern: /dependencySync/ },
    ]) {
      assert.throws(() => loadProfile(profileCopy(t, fixture, mutate)), pattern, fixture);
    }
  }
});
