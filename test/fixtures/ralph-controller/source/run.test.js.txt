const test = require('node:test');
const assert = require('node:assert');
const { summarizeStatuses } = require('./run');

function statusEntry(overrides) {
  return { id: 1, dependsOn: [], ...overrides };
}

test('summary excludes unapproved issue from ready list', () => {
  const statuses = [
    statusEntry({ id: 1, status: 'unapproved', unapprovedReason: 'нет лейбла spec-approved' }),
    statusEntry({ id: 2, status: 'not-started', ready: true }),
  ];
  const summary = summarizeStatuses(statuses, new Set());
  assert.deepStrictEqual(
    summary.ready.map((e) => e.id),
    [2],
  );
});

test('summary reports unapproved issue with its specific reason', () => {
  const statuses = [
    statusEntry({ id: 1, status: 'unapproved', unapprovedReason: 'нет лейбла spec-approved' }),
    statusEntry({ id: 2, status: 'unapproved', unapprovedReason: 'хеш одобрения не совпадает с текущим телом issue' }),
  ];
  const summary = summarizeStatuses(statuses, new Set());
  const unapprovedLine = summary.lines.find((line) => line.includes('Спека не одобрена'));
  assert.ok(unapprovedLine, 'expected a summary line about unapproved specs');
  assert.match(unapprovedLine, /#1 \(нет лейбла spec-approved\)/);
  assert.match(unapprovedLine, /#2 \(хеш одобрения не совпадает с текущим телом issue\)/);
});

test('summary keeps a ready issue selectable when another issue is unapproved', () => {
  const statuses = [
    statusEntry({ id: 1, status: 'unapproved', unapprovedReason: 'нет лейбла spec-approved' }),
    statusEntry({ id: 2, status: 'not-started', ready: true }),
  ];
  const summary = summarizeStatuses(statuses, new Set());
  assert.strictEqual(summary.ready.length, 1);
  assert.strictEqual(summary.ready[0].id, 2);
});

test('summary does not report everything done while an unapproved issue remains', () => {
  const statuses = [statusEntry({ id: 1, status: 'unapproved', unapprovedReason: 'нет лейбла spec-approved' })];
  const summary = summarizeStatuses(statuses, new Set());
  assert.strictEqual(summary.ready.length, 0);
  assert.ok(!summary.lines.some((line) => line.includes('Все Issue из конфига закрыты')));
});

// --- startup before the first clone (issue #506) ---

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startup, runController } = require('./run');
const sandbox = require('./sandbox');
const { runDirFor, sessionsRootFor, prepareClone, prepareAgentSessionDir } = require('./workspace');

const EXAMPLE_SANDBOX = require('./config.example.json').sandbox;
const SANDBOX_CONFIG = sandbox.validateSandboxConfig(EXAMPLE_SANDBOX);

const SCRATCH_FALLBACK = path.join(__dirname, '..', '..', '.ralph-sandbox-tmp');
const scratchOutsideHome = () => {
  const root = [os.tmpdir(), SCRATCH_FALLBACK].find((dir) => !sandbox.isInsideHome(dir));
  assert.ok(root, 'no scratch directory outside the operator home');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'ralph-run-'));
};

const configWith = (sandboxOverrides = {}) => ({ issues: [], maxIterations: 1, sandbox: { ...EXAMPLE_SANDBOX, ...sandboxOverrides } });

// A fake engine that records what startup asked of it; real path rules (resolveRunsRoot, rootKeyFor).
const fakeSandboxApi = (overrides = {}) => {
  const calls = [];
  const api = {
    ...sandbox,
    assertAvailable: () => calls.push('assertAvailable'),
    removeLeftovers: () => {
      calls.push('removeLeftovers');
      return { containers: 0, networks: 0 };
    },
    buildImage: () => calls.push('buildImage'),
    ...overrides,
  };
  return { api, calls };
};

const READY = [{ id: 7, dependsOn: [], status: 'not-started', ready: true, title: 'probe' }];

// Drives the real controller loop with a recorded runOneIssue in place of the real clone+agent.
const driveController = async (config, startupOptions) => {
  const cloned = [];
  let error = null;
  try {
    await runController(config, {
      maxIterations: 1,
      classifyIssues: () => READY,
      runOneIssue: async (cfg, byId, chosen, sandboxEnv) => {
        cloned.push({ id: chosen.id, sandboxEnv });
        return { status: 'done', pr: 'https://example.invalid/pr/1' };
      },
      saveState: () => {},
      startupOptions,
    });
  } catch (caught) {
    error = caught;
  }
  return { cloned, error };
};

test('fails fast when container runtime is unavailable', async () => {
  const repoRoot = scratchOutsideHome();
  try {
    const { cloned, error } = await driveController(configWith(), { repoRoot, docker: 'ralph-no-such-container-runtime' });
    assert.ok(error, 'startup threw');
    assert.match(error.message, /Docker is not available/);
    assert.deepStrictEqual(cloned, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('rejects runs root inside operator home', async () => {
  const repoRoot = scratchOutsideHome();
  try {
    const { api, calls } = fakeSandboxApi();
    const insideHome = path.join(os.homedir(), 'ralph-runs-under-home');
    const { cloned, error } = await driveController(configWith({ runsRoot: insideHome }), { repoRoot, sandboxApi: api });
    assert.ok(error, 'startup threw');
    assert.match(error.message, /sandbox\.runsRoot/);
    assert.deepStrictEqual(cloned, []);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(fs.existsSync(insideHome), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('uses configured runs root outside operator home', async () => {
  const scratch = scratchOutsideHome();
  try {
    const origin = path.join(scratch, 'origin');
    fs.mkdirSync(origin);
    const git = (...args) => execFileSync('git', args, { cwd: origin, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(origin, 'README.md'), 'probe\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

    const runsRoot = path.join(scratch, 'configured-runs');
    const { api } = fakeSandboxApi();
    const env = startup(configWith({ runsRoot }), { repoRoot: path.join(scratch, 'repo'), sandboxApi: api });
    assert.strictEqual(env.runsRoot, path.resolve(runsRoot));

    const runDir = runDirFor(env.runsRoot, 7);
    prepareClone(env.runsRoot, runDir, 'main', 'task/ISSUE-7-probe', origin);
    const sessionsDir = prepareAgentSessionDir(sessionsRootFor(env.runsRoot, 7), '01-implement');
    for (const dir of [runDir, sessionsDir]) {
      assert.ok(fs.existsSync(dir), dir);
      assert.ok(!path.relative(env.runsRoot, dir).startsWith('..'), `${dir} is under ${env.runsRoot}`);
    }
    assert.ok(fs.existsSync(path.join(runDir, 'README.md')));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('stops before clone when image build fails', async () => {
  const repoRoot = scratchOutsideHome();
  try {
    const { api, calls } = fakeSandboxApi({
      buildImage: () => {
        throw new Error('Building the sandbox image failed (exit 1)');
      },
    });
    const { cloned, error } = await driveController(configWith(), { repoRoot, sandboxApi: api });
    assert.ok(error, 'startup threw');
    assert.match(error.message, /Building the sandbox image/);
    assert.deepStrictEqual(cloned, []);
    assert.deepStrictEqual(calls, ['assertAvailable', 'removeLeftovers']);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('continues to clone when image build succeeds', async () => {
  const repoRoot = scratchOutsideHome();
  try {
    const { api, calls } = fakeSandboxApi();
    const { cloned, error } = await driveController(configWith(), { repoRoot, sandboxApi: api });
    assert.strictEqual(error, null);
    assert.deepStrictEqual(calls, ['assertAvailable', 'removeLeftovers', 'buildImage']);
    assert.strictEqual(cloned.length, 1);
    assert.strictEqual(cloned[0].id, 7);
    assert.strictEqual(cloned[0].sandboxEnv.sandboxConfig.image, SANDBOX_CONFIG.image);
    assert.strictEqual(cloned[0].sandboxEnv.rootKey, sandbox.rootKeyFor(repoRoot));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// --- leftovers of a killed controller, real Docker ---

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const isRunning = (id) => docker('ps', '-q', '--no-trunc', '--filter', `id=${id}`).stdout.trim() !== '';
const startSleeper = (labels) => {
  const result = docker('run', '-d', '--rm', ...labels.flatMap((label) => ['--label', label]), SANDBOX_CONFIG.image, 'sleep', '300');
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
};

let imageReady = false;
const ensureImage = () => {
  if (imageReady) return;
  sandbox.assertAvailable();
  sandbox.buildImage(SANDBOX_CONFIG, { stdio: 'ignore' });
  imageReady = true;
};

test('startup removes leftover ralph containers', () => {
  ensureImage();
  const repoRoot = scratchOutsideHome();
  const rootKey = sandbox.rootKeyFor(repoRoot);
  const leftover = startSleeper([`${sandbox.LABEL_MANAGED}=${rootKey}`, `${sandbox.LABEL_RUN}=issue-1`]);
  const network = `ralph-net-leftover-${crypto.randomBytes(3).toString('hex')}`;
  assert.strictEqual(docker('network', 'create', '--internal', '--label', `${sandbox.LABEL_MANAGED}=${rootKey}`, network).status, 0);
  try {
    assert.ok(isRunning(leftover));
    const { api } = fakeSandboxApi({ assertAvailable: sandbox.assertAvailable, removeLeftovers: sandbox.removeLeftovers });
    startup(configWith(), { repoRoot, sandboxApi: api });
    assert.strictEqual(isRunning(leftover), false);
    assert.strictEqual(docker('network', 'ls', '-q', '--filter', `name=^${network}$`).stdout.trim(), '');
  } finally {
    docker('rm', '-f', leftover);
    docker('network', 'rm', network);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('startup leaves unlabelled containers running', () => {
  ensureImage();
  const repoRoot = scratchOutsideHome();
  const unlabelled = startSleeper([]);
  // Another repository's Ralph: same label key, different root key.
  const otherRepo = startSleeper([`${sandbox.LABEL_MANAGED}=other${crypto.randomBytes(3).toString('hex')}`]);
  try {
    const { api } = fakeSandboxApi({ assertAvailable: sandbox.assertAvailable, removeLeftovers: sandbox.removeLeftovers });
    startup(configWith(), { repoRoot, sandboxApi: api });
    assert.strictEqual(isRunning(unlabelled), true);
    assert.strictEqual(isRunning(otherRepo), true);
  } finally {
    docker('rm', '-f', unlabelled, otherRepo);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// The final gate and lockfile sync report their cause in `reason`, not `error`; the console summary
// must show it instead of pointing at a log that has nothing above.
for (const status of ['final_gate_blocked', 'lockfile_sync_blocked']) {
  test(`prints the reason of a ${status} result`, async (t) => {
    const repoRoot = scratchOutsideHome();
    const lines = [];
    t.mock.method(console, 'log', (line) => lines.push(String(line)));
    try {
      const { api } = fakeSandboxApi();
      await runController(configWith(), {
        maxIterations: 1,
        classifyIssues: () => READY,
        runOneIssue: async () => ({ status, reason: 'gate red: lint failed in a.ts' }),
        saveState: () => {},
        startupOptions: { repoRoot, sandboxApi: api },
      });
    } finally {
      t.mock.restoreAll();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
    const summary = lines.find((line) => line.includes(`Issue #7: ${status}`));
    assert.ok(summary, 'status line printed');
    assert.ok(summary.includes('gate red: lint failed in a.ts'));
    assert.ok(!summary.includes('см. лог выше'));
  });
}

test('startup passes the configured agent model to the run', async () => {
  const repoRoot = scratchOutsideHome();
  try {
    const { api } = fakeSandboxApi();
    const { cloned, error } = await driveController({ ...configWith(), agentModel: 'claude-sonnet-5-5' }, { repoRoot, sandboxApi: api });
    assert.strictEqual(error, null);
    assert.strictEqual(cloned[0].sandboxEnv.agentModel, 'claude-sonnet-5-5');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('stops before docker and clone when the agent model is invalid', async () => {
  const repoRoot = scratchOutsideHome();
  try {
    const { api, calls } = fakeSandboxApi();
    const { cloned, error } = await driveController({ ...configWith(), agentModel: 'sonnet 5' }, { repoRoot, sandboxApi: api });
    assert.ok(error, 'startup threw');
    assert.match(error.message, /config\.agentModel/);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(cloned, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// --- loop reliability (issue #399) ---

const readyEntry = (id) => ({ id, dependsOn: [], status: 'not-started', ready: true, title: `issue ${id}` });

const driveLoop = async (issues, runOneIssue, maxIterations = 5) => {
  const repoRoot = scratchOutsideHome();
  const states = [];
  try {
    const { api } = fakeSandboxApi();
    await runController(configWith(), {
      maxIterations,
      classifyIssues: () => issues,
      runOneIssue,
      saveState: (patch) => states.push(patch),
      startupOptions: { repoRoot, sandboxApi: api },
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
  return states;
};

test('excludes a done issue from later iterations', async () => {
  const picked = [];
  await driveLoop([readyEntry(7)], async (cfg, byId, chosen) => {
    picked.push(chosen.id);
    return { status: 'done', pr: 'https://example.invalid/pr/1' };
  });
  assert.deepStrictEqual(picked, [7]);
});

test('picks the next ready issue after a done one', async () => {
  const picked = [];
  await driveLoop([readyEntry(7), readyEntry(8)], async (cfg, byId, chosen) => {
    picked.push(chosen.id);
    return { status: 'done', pr: 'https://example.invalid/pr/1' };
  });
  assert.deepStrictEqual(picked, [7, 8]);
});

test('records crashed and continues when runOneIssue throws', async () => {
  const picked = [];
  const states = await driveLoop([readyEntry(7), readyEntry(8)], async (cfg, byId, chosen) => {
    picked.push(chosen.id);
    if (chosen.id === 7) throw new Error('boom');
    return { status: 'done', pr: 'https://example.invalid/pr/2' };
  });
  assert.deepStrictEqual(picked, [7, 8]);
  const crashed = states.find((patch) => patch.lastResult && patch.lastResult.status === 'crashed');
  assert.ok(crashed, 'crashed state written');
  assert.strictEqual(crashed.lastResult.issue, 7);
  assert.match(crashed.lastResult.error, /boom/);
});
