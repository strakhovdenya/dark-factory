'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeStatuses, runRalph, parseArgs } = require('./run');
const sandbox = require('./sandbox');
const { BLOCK_LABEL, lockPathFor, statePathFor } = require('./config');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const {
  HUMAN_LABEL,
  isolateGit,
  gitIn,
  writeFiles,
  makeConsumer,
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
const setup = (t, fixture, { mutate, labels, localConfig = {} } = {}) => {
  useHome(t);
  isolateGit(t);
  const { origin, consumerRoot } = makeConsumer(t);
  const gh = fakeGitHub({ labels });
  const calls = mockGh(t, gh.onGh);
  const runsRoot = path.join(tempDir(t, 'ralph-runs-'), 'runs');
  const profile = controllerProfile(t, fixture, mutate);
  return { origin, consumerRoot, gh, calls, runsRoot, profile, localConfig: { issues: [{ id: 7 }], runsRoot, ...localConfig } };
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

test('the CLI needs an explicit consumer root', () => {
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['--config', 'x.json']), null);
  assert.equal(parseArgs(['--consumer-root', '/x', '--max-iterations', '0']), null);
  assert.deepEqual(parseArgs(['--consumer-root', '/x', '--max-iterations', '2']), { consumerRoot: '/x', config: null, maxIterations: 2 });
  assert.ok(os.tmpdir());
});
