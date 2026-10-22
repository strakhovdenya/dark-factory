'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeStatuses, runRalph, parseArgs, main } = require('./run');
const { DEFAULT_REGISTRY, createRegistry } = require('./steps/registry');
const sandbox = require('./sandbox');
const { BLOCK_LABEL, lockPathFor, statePathFor } = require('./config');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const {
  HUMAN_LABEL,
  isolateGit,
  gitIn,
  writeFiles,
  makeConsumer,
  pushBranch,
  controllerProfile,
  mockGh,
  fakeGitHub,
  okResult,
  mockSandbox,
  installBaseSkills,
  done,
  issueWith,
  tempDir,
} = require('../test/helpers/ralph');

// --- summary ---

const statusEntry = (overrides) => ({ id: 1, dependsOn: [], ...overrides });

test('summary excludes unapproved issue and reports its reason', () => {
  const statuses = [
    statusEntry({ id: 1, status: 'unapproved', unapprovedReason: 'нет лейбла spec-approved' }),
    statusEntry({ id: 2, status: 'not-started', ready: true }),
    statusEntry({ id: 3, status: 'unapproved', unapprovedReason: 'хеш одобрения не совпадает с текущим телом issue' }),
  ];
  const summary = summarizeStatuses(statuses, new Set());
  assert.deepEqual(summary.ready.map((e) => e.id), [2]);
  const line = summary.lines.find((l) => l.includes('Спека не одобрена'));
  assert.match(line, /#1 \(нет лейбла spec-approved\)/);
  assert.match(line, /#3 \(хеш одобрения/);
});

test('summary does not report everything done while an unapproved issue remains', () => {
  const summary = summarizeStatuses([statusEntry({ status: 'unapproved', unapprovedReason: 'x' })], new Set());
  assert.equal(summary.ready.length, 0);
  assert.ok(!summary.lines.some((line) => line.includes('Все Issue из конфига закрыты')));
});

// --- controlled environment ---

/** Replaces the operator HOME with an empty temporary directory for the length of the test. */
const useHome = (t) => {
  const home = tempDir(t, 'ralph-home-');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return home;
};

/** @type {(...args: any[]) => any} */
const fakeSandboxApi = (overrides = {}) => {
  const calls = [];
  const api = {
    ...sandbox,
    resolveRunsRoot: (options, root, env) => {
      calls.push({ resolveRunsRoot: [options, root] });
      return sandbox.resolveRunsRoot(options, root, env);
    },
    assertAvailable: () => calls.push('assertAvailable'),
    removeLeftovers: (rootKey) => {
      calls.push(`removeLeftovers ${rootKey}`);
      return { containers: 0, networks: 0 };
    },
    buildImage: () => calls.push('buildImage'),
    ...overrides,
  };
  return { api, calls };
};

const READY = (id = 7) => [{ id, dependsOn: [], status: 'not-started', ready: true, title: 'probe' }];

/** A consumer with a gh stand-in, a controlled HOME and runs root outside it. */
/** @type {(...args: any[]) => any} */
const setup = (t, fixture, { mutate, labels, localConfig = {}, rootProfile } = {}) => {
  useHome(t);
  isolateGit(t);
  const profile = controllerProfile(t, fixture, mutate);
  // The profile is committed to the consumer's base, so the clone of a run carries it too.
  const { origin, consumerRoot } = makeConsumer(t, { profile: rootProfile === undefined ? profile : (rootProfile ?? undefined) });
  const gh = fakeGitHub({ labels });
  const calls = mockGh(t, gh.onGh);
  const runsRoot = path.join(tempDir(t, 'ralph-runs-'), 'runs');
  return { t, origin, consumerRoot, gh, calls, runsRoot, profile, localConfig: { issues: [{ id: 7 }], runsRoot, ...localConfig } };
};

/** @type {(...args: any[]) => any} */
const drive = async (env, { runOneIssue, classifyIssues = () => READY(), maxIterations = 1, sandboxApi, processEnv } = {}) => {
  const fake = fakeSandboxApi();
  const picked = [];
  const states = [];
  let error = null;
  let results = null;
  try {
    results = await runRalph({
      consumerRoot: env.consumerRoot,
      profile: env.profile,
      localConfig: env.localConfig,
      maxIterations,
      deps: {
        sandboxApi: sandboxApi || fake.api,
        env: processEnv,
        echo: { out: () => {}, err: () => {} },
        classifyIssues,
        saveState: (patch) => states.push(patch),
        runOneIssue: runOneIssue || (async (ctx, byId, chosen) => {
          picked.push({ id: chosen.id, ctx });
          return { status: 'done', pr: 'https://example.invalid/pr/1' };
        }),
      },
    });
  } catch (caught) {
    error = caught;
  }
  return { error, picked, states, results, sandboxCalls: fake.calls };
};

const assertNoSideEffects = (env, run) => {
  assert.ok(run.error, 'readiness failed');
  assert.deepEqual(run.picked, [], 'no clone, no agent');
  assert.ok(!run.sandboxCalls.some((call) => typeof call === 'string'), 'no Docker step');
  assert.equal(fs.existsSync(lockPathFor(env.runsRoot)), false, 'no lock');
  assert.equal(env.gh.mutations.length, 0, 'no GitHub change');
};

for (const fixture of FIXTURE_PROFILES) {
  test(`rejects incomplete enabled controller settings before side effects (${fixture})`, async (t) => {
    const cases = [
      { field: 'ralph.humanNeededVerdict', mutate: (p) => delete p.ralph.humanNeededVerdict },
      { field: 'labels.humanNeeded', mutate: (p) => delete p.labels.humanNeeded },
    ];
    for (const { field, mutate } of cases) {
      const env = setup(t, fixture, { mutate });
      const run = await drive(env);
      assertNoSideEffects(env, run);
      assert.match(run.error.message, new RegExp(field.replace('.', '\\.')));
      assert.deepEqual(env.calls, [], 'no git or gh before the settings check');
      t.mock.restoreAll();
    }
  });

  test(`uses local runs root for consumer state (${fixture})`, async (t) => {
    const packageRoot = path.resolve(__dirname, '..');
    const before = fs.readdirSync(packageRoot).sort();
    for (const runsRoot of ['absolute', path.join('..', 'relative-runs')]) {
      const env = setup(t, fixture);
      if (runsRoot !== 'absolute') env.localConfig.runsRoot = runsRoot;
      const expected = runsRoot === 'absolute' ? env.runsRoot : path.resolve(env.consumerRoot, runsRoot);
      const run = await drive(env);
      assert.equal(run.error, null, run.error && run.error.message);
      const resolveCall = run.sandboxCalls.find((call) => call.resolveRunsRoot).resolveRunsRoot;
      assert.equal(resolveCall[1], env.consumerRoot, 'resolver gets the consumer root');
      assert.equal(resolveCall[0].runsRoot, env.localConfig.runsRoot);
      const ctx = run.picked[0].ctx;
      assert.equal(ctx.sandboxEnv.runsRoot, expected);
      assert.equal(ctx.sandboxEnv.rootKey, sandbox.rootKeyFor(env.consumerRoot));
      assert.ok(run.sandboxCalls.includes(`removeLeftovers ${sandbox.rootKeyFor(env.consumerRoot)}`), 'cleanup keyed by the consumer');
      assert.ok(fs.existsSync(expected), 'state lives in the runs root');
      assert.equal(fs.existsSync(lockPathFor(expected)), false, 'lock released');
      t.mock.restoreAll();
    }
    assert.deepEqual(fs.readdirSync(packageRoot).sort(), before, 'the package directory is unchanged');
  });

  test(`rejects unsafe local runs root before side effects (${fixture})`, async (t) => {
    for (const kind of ['inside', 'link']) {
      const env = setup(t, fixture);
      const home = process.env.HOME;
      if (kind === 'inside') {
        env.localConfig.runsRoot = path.join(home, 'runs');
      } else {
        const link = path.join(tempDir(t), 'link-into-home');
        fs.mkdirSync(path.join(home, 'target'));
        fs.symlinkSync(path.join(home, 'target'), link, process.platform === 'win32' ? 'junction' : 'dir');
        env.localConfig.runsRoot = path.join(link, 'runs');
      }
      env.runsRoot = env.localConfig.runsRoot;
      const run = await drive(env);
      assertNoSideEffects(env, run);
      assert.match(run.error.message, /home directory/);
      assert.equal(fs.existsSync(env.localConfig.runsRoot), false, 'nothing created');
      t.mock.restoreAll();
    }
  });

  test(`requires block labels in consumer repository before side effects (${fixture})`, async (t) => {
    for (const labels of [[HUMAN_LABEL], [`${BLOCK_LABEL}-old`, HUMAN_LABEL], [BLOCK_LABEL, `${HUMAN_LABEL}-x`]]) {
      const env = setup(t, fixture, { labels });
      const run = await drive(env);
      assertNoSideEffects(env, run);
      const missing = labels.includes(BLOCK_LABEL) ? HUMAN_LABEL : BLOCK_LABEL;
      assert.match(run.error.message, new RegExp(`"${missing}"`));
      assert.ok(!env.calls.some((c) => c.file === 'gh' && c.args[0] === 'label' && c.args[1] === 'create'), 'labels are not created');
      assert.ok(env.calls.filter((c) => c.file === 'gh').every((c) => c.cwd === env.consumerRoot));
      t.mock.restoreAll();
    }
  });

  test(`rejects legacy branch prefix in local config (${fixture})`, async (t) => {
    const env = setup(t, fixture, { localConfig: { branchPrefix: 'task/ISSUE-' } });
    const run = await drive(env);
    assertNoSideEffects(env, run);
    assert.match(run.error.message, /branchPrefix/);
    assert.match(run.error.message, /branchTemplate/);
  });

  test(`rejects consumer root without origin before side effects (${fixture})`, async (t) => {
    const env = setup(t, fixture);
    const plain = tempDir(t);
    const noOrigin = tempDir(t);
    gitIn(noOrigin, 'init', '-q');
    for (const { root, reason } of [{ root: plain, reason: /not a git repository/ }, { root: noOrigin, reason: /no origin remote/ }]) {
      const first = env.calls.length;
      const run = await drive({ ...env, consumerRoot: root });
      assertNoSideEffects(env, run);
      assert.match(run.error.message, reason);
      assert.ok(env.calls.slice(first).every((call) => call.cwd === root), 'the current directory is never used');
    }
  });
}

test('uses explicit consumer root from foreign working directory', async (t) => {
  const env = setup(t, 'monorepo');
  // The test process runs in another git repository with another origin.
  assert.notEqual(path.resolve(process.cwd()), env.consumerRoot);
  gitIn(process.cwd(), 'rev-parse', '--show-toplevel');
  const issue = issueWith(7, ['packages/billing/src/a.ts']);
  env.gh.mutations.length = 0;
  const box = mockSandbox(t, {
    onAgent: ({ pass, runDir }) => {
      if (pass === 'self-review') return 'REVIEW: PASS';
      if (pass === 'code-review') return 'CODEREVIEW: PASS';
      writeFiles(runDir, { 'packages/billing/src/a.ts': 'export {};\n' });
      return done('feat', 'x');
    },
    onRun: (spec) => {
      if (spec.network !== 'none') installBaseSkills(spec.runDir);
      return okResult();
    },
  });
  const run = await drive(env, { classifyIssues: () => [{ ...issue, status: 'not-started', ready: true }], runOneIssue: require('./core').runIssue, processEnv: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-placeholder' } });
  assert.equal(run.error, null, run.error && run.error.message);
  assert.equal(run.results[7].status, 'done', JSON.stringify(run.results[7]));
  const runsRoot = env.runsRoot;
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  for (const call of env.calls) {
    assert.ok(inside(env.consumerRoot, call.cwd) || inside(runsRoot, call.cwd), `${call.file} ${call.args.join(' ')} in ${call.cwd}`);
  }
  const clone = box.agents[0].spec.runDir;
  assert.ok(inside(runsRoot, clone));
  const pr = env.calls.find((c) => c.file === 'gh' && c.args[0] === 'pr');
  assert.equal(pr.cwd, env.consumerRoot);
  assert.ok(gitIn(env.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').includes('task/ISSUE-7-neutral-change'), 'pushed to the consumer origin');
  assert.ok(env.gh.mutations.every((m) => m.kind !== 'label'));
});

// --- startup and loop ---

test('stops before clone when image build fails', async (t) => {
  const env = setup(t, 'single-package');
  const { api, calls } = fakeSandboxApi({
    buildImage: () => {
      throw new Error('Building the sandbox image failed (exit 1)');
    },
  });
  const run = await drive(env, { sandboxApi: api });
  assert.match(run.error.message, /Building the sandbox image/);
  assert.deepEqual(run.picked, []);
  assert.deepEqual(calls.filter((c) => typeof c === 'string'), ['assertAvailable', `removeLeftovers ${sandbox.rootKeyFor(env.consumerRoot)}`]);
  assert.equal(fs.existsSync(lockPathFor(env.runsRoot)), false, 'lock released after the failure');
});

test('fails fast when container runtime is unavailable', async (t) => {
  const env = setup(t, 'single-package');
  const { api } = fakeSandboxApi({
    assertAvailable: () => {
      throw new Error('Docker is not available, the Ralph sandbox needs a running Docker engine');
    },
  });
  const run = await drive(env, { sandboxApi: api });
  assert.match(run.error.message, /Docker is not available/);
  assert.deepEqual(run.picked, []);
});

test('stops before docker and clone when the agent model is invalid', async (t) => {
  const env = setup(t, 'single-package', { localConfig: { agentModel: 'sonnet 5' } });
  const run = await drive(env);
  assertNoSideEffects(env, run);
  assert.match(run.error.message, /agentModel/);
});

for (const status of ['final_gate_blocked', 'dependency_sync_blocked']) {
  test(`prints the reason of a ${status} result`, async (t) => {
    const env = setup(t, 'single-package');
    const lines = [];
    t.mock.method(console, 'log', (line) => lines.push(String(line)));
    await drive(env, { runOneIssue: async () => ({ status, reason: 'gate red: lint failed in a.ts' }) });
    t.mock.restoreAll();
    const summary = lines.find((line) => line.includes(`Issue #7: ${status}`));
    assert.ok(summary && summary.includes('gate red: lint failed in a.ts'));
  });
}

const readyEntry = (id) => ({ id, dependsOn: [], status: 'not-started', ready: true, title: `issue ${id}` });

test('picks each ready issue once and records a crash', async (t) => {
  const env = setup(t, 'single-package');
  const picked = [];
  const run = await drive(env, {
    maxIterations: 5,
    classifyIssues: () => [readyEntry(7), readyEntry(8)],
    runOneIssue: async (ctx, byId, chosen) => {
      picked.push(chosen.id);
      if (chosen.id === 7) throw new Error('boom');
      return { status: 'done', pr: 'https://example.invalid/pr/2' };
    },
  });
  assert.deepEqual(picked, [7, 8]);
  const crashed = run.states.find((patch) => patch.lastResult && patch.lastResult.status === 'crashed');
  assert.equal(crashed.lastResult.issue, 7);
  assert.match(crashed.lastResult.error, /boom/);
});

test('writes state and lock in the runs root', async (t) => {
  const env = setup(t, 'single-package');
  const fake = fakeSandboxApi();
  let lockSeen = false;
  await runRalph({
    consumerRoot: env.consumerRoot,
    profile: env.profile,
    localConfig: env.localConfig,
    deps: {
      sandboxApi: fake.api,
      classifyIssues: () => READY(),
      runOneIssue: async () => {
        lockSeen = fs.existsSync(lockPathFor(env.runsRoot));
        return { status: 'done', pr: 'x' };
      },
    },
  });
  assert.ok(lockSeen);
  assert.equal(JSON.parse(fs.readFileSync(statePathFor(env.runsRoot), 'utf8')).iterations, 1);
});

test('the CLI takes an optional consumer root', () => {
  assert.deepEqual(parseArgs([]), { consumerRoot: null, config: null, maxIterations: null });
  assert.equal(parseArgs(['--config']), null);
  assert.equal(parseArgs(['--unknown', 'x']), null);
  assert.equal(parseArgs(['--consumer-root', '/x', '--max-iterations', '0']), null);
  assert.deepEqual(parseArgs(['--consumer-root', '/x', '--max-iterations', '2']), { consumerRoot: '/x', config: null, maxIterations: 2 });
  assert.ok(os.tmpdir());
});

// --- the real CLI path: root discovery, trusted profile, base check ---

const CLI_DEPS = { echo: { out: () => {}, err: () => {} }, saveState: () => {} };

/** Runs `main` with the sandbox replaced; `cwd` is where the root search starts. */
/** @type {(...args: any[]) => any} */
const cli = async (env, { cwd = env.consumerRoot, rootArgs = [], classifyIssues = () => READY(), runOneIssue, localConfig = env.localConfig, stepRegistry, iterations = 1 } = {}) => {
  const configPath = path.join(tempDir(env.t, 'ralph-cfg-'), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(localConfig));
  const fake = fakeSandboxApi({ installExitHandlers: () => {} });
  const picked = [];
  let error = null;
  try {
    await main([...rootArgs, '--config', configPath, '--max-iterations', String(iterations)], {
      cwd,
      deps: {
        ...CLI_DEPS,
        sandboxApi: fake.api,
        stepRegistry,
        classifyIssues,
        runOneIssue:
          runOneIssue ||
          (async (ctx) => {
            picked.push(ctx);
            return { status: 'done', pr: 'https://example.invalid/pr/1' };
          }),
      },
    });
  } catch (caught) {
    error = caught;
  }
  return { error, picked, sandboxCalls: fake.calls };
};

const assertStoppedBeforeLock = (env, run) => {
  assert.ok(run.error, 'the CLI failed');
  assert.deepEqual(run.picked, [], 'no issue was run');
  assert.deepEqual(run.sandboxCalls.filter((call) => typeof call === 'string'), [], 'no Docker step');
  assert.equal(fs.existsSync(env.runsRoot), false, 'no lock and no runs directory');
  assert.deepEqual(env.calls.filter((call) => call.file === 'gh'), [], 'no gh call');
};

for (const fixture of FIXTURE_PROFILES) {
  test(`loads profile from repository root (${fixture})`, async (t) => {
    const env = setup(t, fixture);
    const run = await cli(env);
    assert.equal(run.error, null, run.error && run.error.message);
    assert.equal(run.picked[0].consumerRoot, env.consumerRoot);
    assert.deepEqual(run.picked[0].profile, env.profile);
  });

  test(`resolves profile from git root when started in subdirectory (${fixture})`, async (t) => {
    const env = setup(t, fixture);
    const sub = path.join(env.consumerRoot, 'deep', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const run = await cli(env, { cwd: sub });
    assert.equal(run.error, null, run.error && run.error.message);
    assert.equal(run.picked[0].consumerRoot, env.consumerRoot);
    assert.deepEqual(run.picked[0].profile, env.profile);
  });

  test(`fails without profile before cloning (${fixture})`, async (t) => {
    const env = setup(t, fixture, { rootProfile: null });
    const run = await cli(env);
    assertStoppedBeforeLock(env, run);
    assert.match(run.error.message, /Profile not found/);
    assert.ok(run.error.message.includes(path.join(env.consumerRoot, '.factory', 'profile.json')), run.error.message);
  });

  test(`fails on invalid profile naming field (${fixture})`, async (t) => {
    const env = setup(t, fixture, { rootProfile: JSON.stringify({ ...controllerProfile(t, fixture), branchTemplate: 7 }) });
    const run = await cli(env);
    assertStoppedBeforeLock(env, run);
    assert.match(run.error.message, /branchTemplate/);
  });

  test(`does not start disabled controller (${fixture})`, async (t) => {
    const env = setup(t, fixture, {
      mutate: (profile) => {
        profile.ralph.enabled = false;
      },
    });
    const run = await cli(env);
    assertStoppedBeforeLock(env, run);
    assert.match(run.error.message, /not enabled/);
  });

  test(`keeps trusted startup profile (${fixture})`, async (t) => {
    const env = setup(t, fixture, { localConfig: { issues: [{ id: 7 }, { id: 8 }], maxIterations: 2 } });
    const initial = structuredClone(env.profile);
    const seen = [];
    const run = await cli(env, {
      iterations: 2,
      classifyIssues: () => [readyEntry(7), readyEntry(8)],
      runOneIssue: async (ctx, _byId, chosen) => {
        seen.push(ctx.profile);
        if (chosen.id === 7) fs.writeFileSync(path.join(env.consumerRoot, '.factory', 'profile.json'), '{ "changed": true }');
        return { status: 'done', pr: 'x' };
      },
    });
    assert.equal(run.error, null, run.error && run.error.message);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], 'one snapshot for the whole run');
    assert.deepEqual(seen[1], initial);
    assert.ok(Object.isFrozen(seen[1]) && Object.isFrozen(seen[1].apps) && Object.isFrozen(seen[1].apps[0]));
  });

  test(`preserves pipeline validation after profile discovery (${fixture})`, async (t) => {
    const polish = { name: 'polish', kind: 'check', skipOnDocOnly: false, run: () => ({ kind: 'passed' }) };
    const mutate = (profile) => {
      profile.ralph.enabledSteps = ['implement', 'polish', 'final-gate'];
    };
    const unknown = setup(t, fixture, { mutate });
    assertStoppedBeforeLock(unknown, await cli(unknown));
    t.mock.restoreAll();

    // The prepared registry passed in deps is the one in force, not only the default.
    const env = setup(t, fixture, { mutate });
    const run = await cli(env, { stepRegistry: createRegistry([...DEFAULT_REGISTRY.values(), polish]) });
    assert.equal(run.error, null, run.error && run.error.message);
    assert.deepEqual(run.picked[0].profile.ralph.enabledSteps, ['implement', 'polish', 'final-gate']);
  });

  test(`rejects invalid pipeline after discovery before side effects (${fixture})`, async (t) => {
    const cases = [
      {
        mutate: (profile) => {
          profile.ralph.enabledSteps = ['implement', 'ghost', 'final-gate'];
        },
        message: /ghost/,
      },
      {
        mutate: (profile) => {
          profile.ralph.stepBudgets = { 'final-gate': 1 };
        },
        message: /ralph\.stepBudgets\.final-gate/,
      },
    ];
    for (const { mutate, message } of cases) {
      const env = setup(t, fixture, { mutate, localConfig: { issues: [] } });
      const run = await cli(env, { classifyIssues: () => [] });
      assertStoppedBeforeLock(env, run);
      assert.match(run.error.message, message);
      t.mock.restoreAll();
    }
  });

  test(`uses explicit consumer root instead of cwd (${fixture})`, async (t) => {
    const env = setup(t, fixture);
    const foreign = makeConsumer(t, { profile: { not: 'the profile of this run' } });
    for (const cwd of [foreign.consumerRoot, tempDir(t)]) {
      const first = env.calls.length;
      const run = await cli(env, { cwd, rootArgs: ['--consumer-root', env.consumerRoot] });
      assert.equal(run.error, null, run.error && run.error.message);
      assert.equal(run.picked[0].consumerRoot, env.consumerRoot);
      assert.deepEqual(run.picked[0].profile, env.profile);
      const made = env.calls.slice(first);
      assert.ok(made.length > 0 && made.every((call) => call.cwd === env.consumerRoot), 'git and gh run in the chosen consumer');
    }
  });

  test(`rejects invalid explicit root without cwd fallback (${fixture})`, async (t) => {
    const env = setup(t, fixture);
    const sub = path.join(env.consumerRoot, 'packages');
    fs.mkdirSync(sub, { recursive: true });
    for (const [explicit, reason] of [
      [sub, /not the top of its git repository/],
      [tempDir(t), /not a git repository/],
    ]) {
      const run = await cli(env, { rootArgs: ['--consumer-root', explicit] });
      assertStoppedBeforeLock(env, run);
      assert.match(run.error.message, reason);
      assert.ok(run.error.message.includes(explicit));
    }
  });
}

test('fails outside git repository', async (t) => {
  const env = setup(t, 'single-package');
  const run = await cli(env, { cwd: tempDir(t) });
  assertStoppedBeforeLock(env, run);
  assert.match(run.error.message, /not inside a git repository/);
});

// --- trusted snapshot of runRalph ---

const isDeepFrozen = (value) => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(isDeepFrozen));

for (const fixture of FIXTURE_PROFILES) {
  test(`copies and deeply freezes profile for programmatic runs (${fixture})`, async (t) => {
    const env = setup(t, fixture);
    const run = await drive(env);
    assert.equal(run.error, null, run.error && run.error.message);
    const snapshot = run.picked[0].ctx.profile;
    assert.notEqual(snapshot, env.profile);
    assert.deepEqual(snapshot, env.profile);
    assert.ok(isDeepFrozen(snapshot));
    assert.equal(Object.isFrozen(env.profile), false);
    assert.equal(Object.isFrozen(env.profile.apps), false);
  });

  test(`does not mutate trusted snapshot through nested references (${fixture})`, async (t) => {
    const env = setup(t, fixture);
    const initial = structuredClone(env.profile);
    const run = await drive(env, {
      runOneIssue: async (ctx) => {
        env.profile.apps[0].name = 'renamed';
        env.profile.protectedPaths.push('extra/');
        env.profile.ralph.enabledSteps = ['implement'];
        assert.deepEqual(ctx.profile, initial, 'the caller changes do not reach the snapshot');
        assert.throws(() => {
          ctx.profile.apps[0].name = 'x';
        }, TypeError);
        assert.throws(() => ctx.profile.protectedPaths.push('y'), TypeError);
        assert.throws(() => {
          ctx.profile.ralph.enabled = false;
        }, TypeError);
        assert.deepEqual(ctx.profile, initial);
        return { status: 'done', pr: 'x' };
      },
    });
    assert.equal(run.error, null, run.error && run.error.message);
    assert.equal(run.results[7].status, 'done', JSON.stringify(run.results[7]));
  });

  test(`rejects clone profile mismatch (${fixture})`, async (t) => {
    const host = controllerProfile(t, fixture);
    const variants = {
      value: { ...host, protectedPaths: [...host.protectedPaths, 'extra/'] },
      'array order': { ...host, protectedPaths: [...host.protectedPaths].reverse() },
    };
    const issue = issueWith(7, ['src/a.ts']);
    for (const stacked of [false, true]) {
      for (const [kind, other] of Object.entries(variants)) {
        const label = `${kind} stacked=${stacked}`;
        const env = setup(t, fixture, { rootProfile: stacked ? undefined : other });
        const box = mockSandbox(t);
        if (stacked) pushBranch(t, env.origin, 'task/ISSUE-2-dep', { '.factory/profile.json': JSON.stringify(other) });
        const statuses = [
          { ...issue, status: 'not-started', ready: true, dependsOn: stacked ? [2] : [] },
          ...(stacked ? [{ id: 2, title: 'Dep', dependsOn: [], status: 'in-flight' }] : []),
        ];
        const run = await drive(env, { classifyIssues: () => statuses, runOneIssue: require('./core').runIssue, processEnv: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-placeholder' } });
        assert.equal(run.error, null, run.error && run.error.message);
        const result = run.results[7];
        assert.equal(result.status, 'prepare_failed', label);
        assert.match(result.error, /differs from the host profile/, label);
        assert.ok(result.error.includes(env.consumerRoot) && result.error.includes(result.runDir), label);
        assert.ok(result.error.includes(stacked ? 'origin/task/ISSUE-2-dep' : 'origin/trunk'), label);
        assert.deepEqual(box.proxies, [], label);
        assert.equal(box.runs.length + box.agents.length, 0, label);
        assert.deepEqual(env.gh.mutations, [], label);
        t.mock.restoreAll();
      }
    }
  });
}
