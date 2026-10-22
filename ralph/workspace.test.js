'use strict';

// Portable tests of the per-issue clone: DEL_RALPH, permissions, installs, dependency sync and the
// gate. Sandbox calls are replaced at the runtime (no Docker); git runs for real on local
// repositories. The Docker scenarios of the reference suite are listed in
// test/fixtures/ralph-controller/integration-cases.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workspace = require('./workspace');
const sandbox = require('./sandbox');
const { buildTaskRules } = require('./prompts');
const { runIssue } = require('./core');
const { BLOCK_LABEL } = require('./config');
const { loadProfile } = require('../profile/load');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const {
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
  runContext,
  tempDir,
} = require('../test/helpers/ralph');

const {
  hasDelRalphMarker,
  writeAgentPermissions,
  writeReviewerPermissions,
  writeCodeReviewPermissions,
  runProjectGate,
  runProjectGateForPorcelain,
  determineTouchedApps,
  installDependencies,
  syncDependencies,
  createSandboxGateRunner,
  prepareAgentSessionDir,
} = workspace;

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'profiles');
const fixtureProfile = (fixture) => loadProfile(path.join(FIXTURES, fixture));

// --- DEL_RALPH marker ---

const promptMarkerExamples = (t) => {
  const rules = buildTaskRules({ profile: controllerProfile(t, 'single-package'), maxTurns: 150 }).join('\n');
  return [...rules.matchAll(/`([^`\n]*DEL_RALPH:[^`\n]*)`/g)].map((match) => match[1]);
};

test('every marker example from the prompt is detected as a first-line marker', (t) => {
  const examples = promptMarkerExamples(t);
  assert.ok(examples.length > 0);
  for (const example of examples) assert.ok(hasDelRalphMarker(`${example}\nconst a = 1;\n`), example);
});

test('detects the bare form and every allowed comment prefix', () => {
  for (const prefix of ['', '// ', '//', '# ', '/* ', '<!-- ', '-- ', '  // ']) {
    assert.ok(hasDelRalphMarker(`${prefix}DEL_RALPH: migrated\nrest`), JSON.stringify(prefix));
  }
  assert.ok(hasDelRalphMarker('// DEL_RALPH: x\r\nrest'));
  assert.ok(hasDelRalphMarker('﻿// DEL_RALPH: x\nrest'));
  assert.ok(hasDelRalphMarker('DEL_RALPH: x'));
});

test('ignores a marker that is not on the first line or inside other text', () => {
  assert.equal(hasDelRalphMarker('const a = 1;\n// DEL_RALPH: x\n'), false);
  assert.equal(hasDelRalphMarker('\n// DEL_RALPH: x\n'), false);
  assert.equal(hasDelRalphMarker('// see DEL_RALPH: docs\n'), false);
  assert.equal(hasDelRalphMarker('const s = "DEL_RALPH: x";\n'), false);
  assert.equal(hasDelRalphMarker(''), false);
});

// --- permissions ---

const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).permissions;

const writeAll = (dir, profile) => ({
  agent: (writeAgentPermissions(dir, profile, ['js-gof', 'code-review']), readSettings(dir)),
  reviewer: (writeReviewerPermissions(dir, profile), readSettings(dir)),
  codeReview: (writeCodeReviewPermissions(dir, profile), readSettings(dir)),
});

const BROAD_RULES = ['Bash', 'Bash(*)', 'Bash(node *)', 'Bash(npx *)', 'Bash(npm run *)'];

for (const fixture of FIXTURE_PROFILES) {
  test(`grants profile gate commands and read-only git (${fixture})`, (t) => {
    const profile = fixtureProfile(fixture);
    const profiles = writeAll(tempDir(t), profile);
    const gate = profile.apps.flatMap((app) => app.gate || []).map((c) => c.argv.join(' '));
    assert.ok(gate.length > 0);
    for (const [name, { allow, deny }] of Object.entries(profiles)) {
      for (const command of gate) {
        assert.ok(allow.includes(`Bash(${command})`), `${name}: ${command}`);
        assert.ok(allow.includes(`Bash(${command} *)`), `${name}: ${command} *`);
      }
      for (const read of ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)']) assert.ok(allow.includes(read), `${name}: ${read}`);
      assert.equal(allow.includes('Bash(git show:*)'), name !== 'agent', `${name}: git show`);
      for (const denied of ['Bash(git commit*)', 'Bash(git push*)', 'Bash(gh *)']) assert.ok(deny.includes(denied), `${name}: ${denied}`);
      assert.ok(!allow.some((rule) => /^Bash\((git (commit|push)|gh)/.test(rule)), name);
    }
    assert.ok(profiles.reviewer.deny.includes('Edit(**)') && profiles.codeReview.deny.includes('Write(**)'));
    assert.ok(profiles.codeReview.allow.includes('Skill(code-review)'));
    assert.ok(profiles.agent.allow.includes('Skill(js-gof)') && !profiles.agent.allow.includes('Skill(code-review)'));
  });

  test(`grants no broad or mutating command rules (${fixture})`, (t) => {
    for (const gate of [undefined, [{ argv: ['make'], cwd: '.' }]]) {
      const profile = fixtureProfile(fixture);
      profile.install = [{ argv: ['tool', 'install'], cwd: '.' }];
      for (const app of profile.apps) {
        app.gate = gate;
        app.dependencySync = [{ argv: ['tool', 'sync'], cwd: '.' }];
      }
      for (const [name, { allow }] of Object.entries(writeAll(tempDir(t), profile))) {
        for (const rule of BROAD_RULES) assert.ok(!allow.includes(rule), `${name}: ${rule}`);
        assert.ok(!allow.some((rule) => /tool (install|sync)/.test(rule)), `${name}: install or sync granted`);
        assert.ok(!allow.some((rule) => /npx /.test(rule)), `${name}: package runner granted`);
        const bash = allow.filter((rule) => rule.startsWith('Bash('));
        const gitRules = bash.filter((rule) => rule.startsWith('Bash(git '));
        assert.ok(gitRules.every((rule) => /^Bash\(git (status|diff|log|show):\*\)$/.test(rule)), `${name}: ${gitRules}`);
        const expected = gate ? ['Bash(make)', 'Bash(make *)'] : [];
        assert.deepEqual(bash.filter((rule) => !rule.startsWith('Bash(git ')), expected, name);
      }
    }
  });

  test(`agent profile keeps Edit/Write but denies protected paths (${fixture})`, (t) => {
    const profile = fixtureProfile(fixture);
    const dir = tempDir(t);
    writeAgentPermissions(dir, profile, []);
    const { allow, deny } = readSettings(dir);
    assert.ok(allow.includes('Edit') && allow.includes('Write'));
    for (const pattern of ['.git/**', '.claude/**', ...profile.protectedPaths.map((p) => `${p.replace(/\/$/, '')}/**`)]) {
      assert.ok(deny.includes(`Edit(${pattern})`), pattern);
      assert.ok(deny.includes(`Write(${pattern})`), pattern);
    }
  });
}

test('agent settings are never written through a link', (t) => {
  const profile = fixtureProfile('single-package');
  const outside = tempDir(t);
  const dir = tempDir(t);
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'operator file\n');
  fs.mkdirSync(path.join(dir, '.claude'));
  const settings = path.join(dir, '.claude', 'settings.local.json');
  let fileLinkCreated = true;
  try {
    fs.symlinkSync(victim, settings, 'file');
  } catch (error) {
    // Windows without the symlink privilege: the directory-link case below still runs.
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    fileLinkCreated = false;
  }
  if (fileLinkCreated) {
    writeReviewerPermissions(dir, profile);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'operator file\n');
    assert.equal(fs.lstatSync(settings).isSymbolicLink(), false);
  }
  fs.rmSync(path.join(dir, '.claude'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(dir, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => writeCodeReviewPermissions(dir, profile), /outside the clone/);
    assert.equal(fs.existsSync(path.join(outside, 'settings.local.json')), false);
  } finally {
    fs.unlinkSync(path.join(dir, '.claude'));
  }
});

// --- gate ---

const initRepo = (t, files) => {
  isolateGit(t);
  const dir = tempDir(t);
  gitIn(dir, 'init', '-q');
  writeFiles(dir, files);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'init');
  return dir;
};

const GATE_REPO = { 'packages/billing/a.ts': 'export {};\n', 'packages/storefront/b.ts': 'export {};\n' };

test('project gate runs the profile commands of touched apps only', (t) => {
  const dir = initRepo(t, GATE_REPO);
  const profile = fixtureProfile('monorepo');
  const calls = [];
  const apps = determineTouchedApps(profile, ['packages/storefront/b.ts']);
  const result = runProjectGate(dir, apps, (command) => {
    calls.push(`${command.cwd}: ${command.argv.join(' ')}`);
    return 'ok';
  }, () => {});
  assert.equal(result.ok, true);
  assert.deepEqual(calls, profile.apps[1].gate.map((c) => `${c.cwd}: ${c.argv.join(' ')}`));
});

test('project gate fails when a check changes the working tree', (t) => {
  const dir = initRepo(t, GATE_REPO);
  const profile = fixtureProfile('monorepo');
  const result = runProjectGate(dir, [profile.apps[0]], (command) => {
    if (command.argv.join(' ').includes('eslint')) fs.writeFileSync(path.join(dir, 'packages', 'billing', 'a.ts'), 'changed\n');
    return 'ok';
  }, () => {});
  assert.equal(result.ok, false);
  assert.match(result.output, /git status changed while the gate was running/);
});

test('project gate stops at the first failing check and reports each command', (t) => {
  const dir = initRepo(t, GATE_REPO);
  const profile = fixtureProfile('monorepo');
  const lines = [];
  const result = runProjectGate(
    dir,
    profile.apps,
    (command) => {
      if (command.argv.join(' ').includes('tsc')) throw Object.assign(new Error('failed'), { stdout: 'x.ts: error' });
      return 'ok';
    },
    (line) => lines.push(line),
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /x\.ts: error/);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /⏳ billing: node node_modules\/typescript\/bin\/tsc --noEmit \(cwd: packages\/billing\)\.\.\./);
  assert.match(lines[1], /❌ billing: .* — \d+s$/);
});

test('matches doc-only patterns without hiding binary changes', (t) => {
  const { hasCodeChanges } = require('./parsing');
  const profile = fixtureProfile('monorepo');
  const patterns = ['**/*.md', '**/docs/'];
  assert.equal(hasCodeChanges('?? packages/billing/docs/new/guide.md\0', patterns), false, 'nested new file matches the pattern');
  assert.equal(hasCodeChanges('?? packages/billing/docs/diagram.png\0', patterns), false, 'binary under a doc directory');
  assert.equal(hasCodeChanges('?? docs/a.md\0 M packages/billing/logo.png\0', patterns), true, 'binary outside doc patterns');
  const dir = initRepo(t, GATE_REPO);
  fs.writeFileSync(path.join(dir, 'packages', 'billing', 'logo.png'), Buffer.from([0, 1, 2, 255]));
  const porcelain = workspace.gitStatusZ(dir);
  const ran = [];
  runProjectGateForPorcelain(dir, profile, porcelain, (command) => ran.push(command.cwd), () => {});
  assert.ok(ran.length > 0 && ran.every((cwd) => cwd === 'packages/billing'), 'the binary file touches its app');
});

// --- installs and dependency sync with the sandbox runtime replaced ---

/** @type {(...args: any[]) => any} */
const recordRuns = (t, fail = () => false) => {
  const runs = [];
  t.mock.method(sandbox, 'runInSandboxSync', (spec) => {
    runs.push(spec);
    const failure = fail(spec, runs.length);
    if (failure) return { status: failure === 'timeout' ? null : 1, stdout: 'out', stderr: 'boom', error: failure === 'timeout' ? new Error('spawnSync docker ETIMEDOUT') : null, name: 'c' };
    return okResult();
  });
  return runs;
};

const BOX = (dir) => ({ image: 'neutral:test', rootKey: 'k', runLabel: 'issue-1', network: 'run-net', proxyUrl: 'http://proxy:3128', installEnv: { FLAG: '1' }, logsDir: path.join(dir, 'logs') });

test('uses project and application commands from profile', (t) => {
  const profile = fixtureProfile('monorepo');
  profile.install = [{ argv: ['tool', 'root-install'], cwd: '.' }];
  const runs = recordRuns(t);
  const dir = tempDir(t);
  installDependencies(dir, profile, BOX(dir));
  assert.deepEqual(
    runs.map((spec) => `${spec.workdir || '.'}: ${spec.command.join(' ')}`),
    ['.: tool root-install', 'packages/billing: npm install', 'packages/storefront: npm install'],
  );
  assert.equal(runs.filter((spec) => spec.command.includes('root-install')).length, 1, 'root install once');
  const gate = [];
  runProjectGate(initRepo(t, GATE_REPO), determineTouchedApps(profile, ['packages/billing/a.ts']), (c) => gate.push(c.cwd), () => {});
  assert.ok(gate.length === 2 && gate.every((cwd) => cwd === 'packages/billing'));
});

test('passes file token literally outside hooks', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const profile = fixtureProfile(fixture);
    const token = { argv: ['tool', '{file}', '--x={file}'], cwd: '.' };
    profile.install = [token];
    for (const app of profile.apps) app.install = [token];
    profile.apps[0].gate = [token];
    profile.dependencySync = [token];
    profile.apps[0].dependencySync = [token];
    const runs = recordRuns(t);
    const dir = initRepo(t, { 'package.json': '{}\n', [`${profile.apps[0].path}/package.json`]: '{}\n' });
    installDependencies(dir, profile, BOX(dir));
    syncDependencies(dir, profile, ' M package.json\0', BOX(dir));
    createSandboxGateRunner(dir, BOX(dir))(token);
    assert.ok(runs.length >= 4, fixture);
    for (const spec of runs) assert.deepEqual(spec.command, ['tool', '{file}', '--x={file}'], fixture);
    t.mock.restoreAll();
  }
});

for (const fixture of FIXTURE_PROFILES) {
  test(`does not run dependency sync without manifest change (${fixture})`, (t) => {
    const profile = fixtureProfile(fixture);
    profile.dependencySync = [{ argv: ['tool', 'sync'], cwd: '.' }];
    for (const app of profile.apps) app.dependencySync = [{ argv: ['tool', 'sync'], cwd: app.path }];
    const runs = recordRuns(t);
    const dir = tempDir(t);
    const result = syncDependencies(dir, profile, ' M package-lock.json\0 M src/package.json.md\0?? a.ts\0', BOX(dir));
    assert.deepEqual(result, { ok: true, ran: false, blockedReason: null });
    assert.equal(runs.length, 0);
  });
}

test('selects only the areas that serve the changed manifest', (t) => {
  const profile = fixtureProfile('monorepo');
  profile.dependencySync = [{ argv: ['sync', 'root'], cwd: '.' }];
  profile.apps[0].dependencySync = [{ argv: ['sync', 'billing'], cwd: 'packages/billing' }];
  profile.apps[1].dependencySync = [{ argv: ['sync', 'storefront', '1'], cwd: 'packages/storefront' }, { argv: ['sync', 'storefront', '2'], cwd: 'packages/storefront' }];
  const runs = recordRuns(t);
  const dir = tempDir(t);
  const porcelain = 'R  packages/storefront/package.json\0packages/old/package.json.bak\0 D package.json\0 M packages/storefront/package.json\0';
  const result = syncDependencies(dir, profile, porcelain, BOX(dir));
  assert.equal(result.ok, true);
  assert.deepEqual(runs.map((spec) => spec.command.join(' ')), ['sync root', 'sync storefront 1', 'sync storefront 2']);
});

// --- whole-issue scenarios ---

const APP_FILE = { monorepo: 'packages/billing/src/a.ts', 'single-package': 'src/a.ts' };
const MANIFEST = { monorepo: 'packages/billing/package.json', 'single-package': 'package.json' };

/** @type {(...args: any[]) => any} */
const scenario = async (t, fixture, { mutate, files = {}, implement, onRun, defaultBranch } = {}) => {
  isolateGit(t);
  const profile = controllerProfile(t, fixture, mutate);
  const { origin, consumerRoot, scratch } = makeConsumer(t, { files: { [MANIFEST[fixture]]: '{"name":"x"}\n', ...files }, defaultBranch, profile });
  const issue = issueWith(3, [APP_FILE[fixture], MANIFEST[fixture]]);
  const gh = fakeGitHub({ body: issue.body });
  const calls = mockGh(t, gh.onGh);
  const box = mockSandbox(t, {
    onAgent: ({ pass, runDir }) => {
      if (pass === 'self-review') return 'REVIEW: PASS';
      if (pass === 'code-review') return 'CODEREVIEW: PASS';
      writeFiles(runDir, { [APP_FILE[fixture]]: 'export {};\n' });
      return (implement && implement(runDir)) || done('feat', 'change');
    },
    onRun: (spec) => {
      const answer = onRun ? onRun(spec) : null;
      if (answer) return answer;
      if (spec.network !== 'none') installBaseSkills(spec.runDir);
      return okResult();
    },
  });
  const ctx = runContext(t, { consumerRoot, origin, profile });
  const result = await runIssue(ctx, new Map([[issue.id, { ...issue, status: 'not-started' }]]), issue);
  const commands = box.runs.map((r) => r.spec.command.join(' '));
  const prs = gh.mutations.filter((m) => m.kind === 'pr');
  const labels = gh.mutations.filter((m) => m.kind === 'label').map((m) => m.label);
  return { result, box, commands, prs, labels, origin, consumerRoot, scratch, calls, ctx };
};

const installSteps = (fixture) => (profile) => {
  profile.install = [{ argv: ['tool', 'root-1'], cwd: '.' }, { argv: ['tool', 'root-2'], cwd: '.' }];
  for (const app of profile.apps) app.install = [{ argv: ['tool', `install-${app.name}`], cwd: app.path }];
  profile.apps[0].dependencySync = [{ argv: ['tool', 'sync-1'], cwd: profile.apps[0].path }, { argv: ['tool', 'sync-2'], cwd: profile.apps[0].path }];
  return fixture;
};

/** @type {(...args: any[]) => any} */
const failingRun = (match, kind = 'exit') => (spec) =>
  spec.command.join(' ') === match ? { status: kind === 'timeout' ? null : 1, stdout: '', stderr: 'boom', error: kind === 'timeout' ? new Error('ETIMEDOUT') : null, name: 'c' } : null;

const assertBlockedBeforeAgent = (run, step, cwd) => {
  assert.equal(run.result.status, 'blocked');
  assert.match(run.result.reason, new RegExp(step.replace(/[[\]]/g, '\\$&')));
  assert.match(run.result.reason, new RegExp(`cwd: ${cwd.replace('.', '\\.')}`));
  assert.equal(run.box.agents.length, 0, 'no agent');
  assert.ok(!run.box.runs.some((r) => r.spec.network === 'none'), 'no gate');
  assert.equal(run.prs.length, 0, 'no PR');
  assert.ok(run.labels.includes(BLOCK_LABEL));
};

for (const fixture of FIXTURE_PROFILES) {
  test(`root install failure blocks before further execution (${fixture})`, async (t) => {
    for (const failing of ['tool root-1', 'tool root-2']) {
      const run = await scenario(t, fixture, { mutate: (p) => installSteps(fixture)(p), onRun: failingRun(failing) });
      const index = failing.endsWith('1') ? 0 : 1;
      assertBlockedBeforeAgent(run, `install[${index}]`, '.');
      assert.equal(run.commands[run.commands.length - 1], failing, 'nothing after the failing step');
      t.mock.restoreAll();
    }
  });

  test(`application install failure blocks before agent (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, { mutate: (p) => installSteps(fixture)(p), onRun: (spec) => failingRun(spec.command[1].startsWith('install-') ? spec.command.join(' ') : '')(spec) });
    assertBlockedBeforeAgent(run, 'apps[0].install[0]', run.ctx.profile.apps[0].path);
    assert.deepEqual(run.commands, ['tool root-1', 'tool root-2', run.commands[2]]);
  });

  test(`runs profile dependency sync for changed manifest (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      mutate: (p) => {
        installSteps(fixture)(p);
        p.sandbox.installEnv = { SYNC_FLAG: 'yes' };
        p.dependencySync = fixture === 'monorepo' ? [{ argv: ['tool', 'root-sync'], cwd: '.' }] : undefined;
        if (fixture === 'monorepo') p.apps[1].dependencySync = [{ argv: ['tool', 'other-sync'], cwd: p.apps[1].path }];
      },
      implement: (runDir) => {
        writeFiles(runDir, { [MANIFEST[fixture]]: '{"name":"x","dependencies":{"dep":"1.0.0"}}\n' });
        return null;
      },
      onRun: (spec) => {
        if (spec.command.join(' ') !== 'tool sync-2') return null;
        writeFiles(spec.runDir, { [path.posix.join(spec.workdir || '.', 'package-lock.json')]: '{"lock":true}\n' });
        return okResult();
      },
    });
    assert.equal(run.result.status, 'done', JSON.stringify(run.result));
    const afterAgent = run.box.runs.slice(run.box.runs.findIndex((r) => r.spec.network === 'none' || r.spec.command[1].startsWith('sync')));
    const syncs = afterAgent.filter((r) => r.spec.network !== 'none');
    assert.deepEqual(syncs.map((r) => r.spec.command.join(' ')), ['tool sync-1', 'tool sync-2'], 'only the affected area, nothing installed again');
    for (const { spec } of syncs) {
      assert.equal(spec.readOnlyGit, true);
      assert.equal(spec.network, 'run-net');
      assert.equal(spec.publicEnv.SYNC_FLAG, 'yes');
    }
    const lockPath = path.posix.join(path.posix.dirname(MANIFEST[fixture]), 'package-lock.json').replace(/^\.\//, '');
    const committed = gitIn(run.origin, 'show', '--name-only', '--format=', 'task/ISSUE-3-neutral-change').split('\n');
    assert.ok(committed.includes(lockPath), `${committed} has the synced lock file`);
    const gateIndex = run.box.runs.findIndex((r) => r.spec.network === 'none');
    const syncIndex = run.box.runs.findIndex((r) => r.spec.command.join(' ') === 'tool sync-2');
    assert.ok(gateIndex > syncIndex, 'final gate after the sync');
  });

  test(`blocks when dependency sync command is missing (${fixture})`, async (t) => {
    const cases = [
      { manifest: MANIFEST[fixture], field: fixture === 'monorepo' ? /apps\[0\]\.dependencySync/ : /dependencySync or apps\[0\]\.dependencySync/ },
      { manifest: 'tools/nested/package.json', field: /neither the root package\.json nor/ },
    ];
    for (const { manifest, field } of cases) {
      const run = await scenario(t, fixture, {
        implement: (runDir) => {
          writeFiles(runDir, { [manifest]: '{"name":"changed"}\n' });
          return null;
        },
      });
      assert.equal(run.result.status, 'dependency_sync_blocked', manifest);
      assert.match(run.result.reason, new RegExp(manifest.replace(/\./g, '\\.')));
      assert.match(run.result.reason, field);
      assert.ok(run.labels.includes(BLOCK_LABEL));
      assert.ok(!run.commands.some((c) => c.startsWith('npm ') && !run.ctx.profile.apps.some((a) => (a.install || []).some((i) => i.argv.join(' ') === c))), 'npm is not substituted');
      assert.ok(!run.box.runs.some((r) => r.spec.network === 'none'), 'no final gate');
      assert.equal(run.prs.length, 0);
      assert.equal(gitIn(run.origin, 'for-each-ref', 'refs/heads/task'), '', 'nothing pushed');
      t.mock.restoreAll();
    }
  });

  test(`dependency sync failure blocks before final gate (${fixture})`, async (t) => {
    for (const kind of ['exit', 'timeout']) {
      const run = await scenario(t, fixture, {
        mutate: (p) => installSteps(fixture)(p),
        implement: (runDir) => {
          writeFiles(runDir, { [MANIFEST[fixture]]: '{"name":"x","v":2}\n' });
          return null;
        },
        onRun: failingRun('tool sync-1', kind),
      });
      assert.equal(run.result.status, 'dependency_sync_blocked', kind);
      assert.match(run.result.reason, /apps\[0\]\.dependencySync\[0\]/);
      assert.match(run.result.reason, /cwd: /);
      assert.match(run.result.reason, /full output: .*install-apps_0_dependencySync_0_-.*\.log/);
      assert.ok(!run.commands.includes('tool sync-2'), 'later commands not run');
      assert.ok(!run.box.runs.some((r) => r.spec.network === 'none'), 'no final gate');
      assert.equal(run.prs.length, 0);
      assert.equal(gitIn(run.origin, 'for-each-ref', 'refs/heads/task'), '', 'no commit pushed');
      t.mock.restoreAll();
    }
  });
}

test('fails without resolvable default branch', async (t) => {
  isolateGit(t);
  const { origin, consumerRoot } = makeConsumer(t);
  // origin HEAD names a branch that does not exist: a clone gets no refs/remotes/origin/HEAD.
  gitIn(origin, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
  const scratch = tempDir(t);
  const runsRoot = path.join(scratch, 'runs');
  const runDir = path.join(runsRoot, 'issue-1');
  workspace.prepareClone(runsRoot, runDir, origin);
  const { defaultBranchOf } = require('./github');
  assert.throws(() => defaultBranchOf(runDir), /Cannot resolve the default branch/);

  const profile = controllerProfile(t, 'single-package');
  const issue = issueWith(1, ['src/a.ts']);
  const gh = fakeGitHub({ body: issue.body });
  mockGh(t, gh.onGh);
  const box = mockSandbox(t);
  const ctx = runContext(t, { consumerRoot, origin, profile });
  const result = await runIssue(ctx, new Map(), issue);
  assert.equal(result.status, 'prepare_failed');
  assert.match(result.error, /default branch/);
  assert.ok(!/\bmain\b/.test(result.error));
  assert.equal(box.agents.length, 0);
  assert.equal(box.runs.length, 0);
});

test('keeps consumer state outside installed package', async (t) => {
  const packageRoot = path.resolve(__dirname, '..');
  const listing = () => fs.readdirSync(packageRoot).concat(fs.readdirSync(__dirname)).sort();
  const before = listing();
  for (const fixture of FIXTURE_PROFILES) {
    const run = await scenario(t, fixture);
    assert.equal(run.result.status, 'done');
    const runsRoot = run.ctx.sandboxEnv.runsRoot;
    const inside = (parent, child) => !path.relative(parent, child).startsWith('..') && !path.isAbsolute(path.relative(parent, child));
    for (const call of run.calls) {
      assert.ok(call.cwd, `${call.file} ${call.args.join(' ')} has an explicit cwd`);
      assert.ok(inside(run.consumerRoot, call.cwd) || inside(runsRoot, call.cwd), `${call.args.join(' ')} in ${call.cwd}`);
      assert.ok(!inside(packageRoot, call.cwd), 'never in the package');
    }
    for (const agent of run.box.agents) assert.ok(inside(runsRoot, agent.spec.runDir) && inside(runsRoot, agent.spec.sessionsDir));
    assert.ok(fs.existsSync(path.join(runsRoot, 'issue-3-sessions')));
    t.mock.restoreAll();
  }
  assert.deepEqual(listing(), before, 'the package directory is unchanged');
});

test('sandbox claude config trusts run dir in a fresh dir per call', (t) => {
  const sessionsRoot = tempDir(t);
  const first = prepareAgentSessionDir(sessionsRoot, '01-implement');
  const config = JSON.parse(fs.readFileSync(path.join(first, '.claude.json'), 'utf8'));
  assert.equal(config.projects[sandbox.CONTAINER_WORKDIR].hasTrustDialogAccepted, true);
  fs.writeFileSync(path.join(first, 'settings.json'), '{"hooks":{}}');
  const reused = prepareAgentSessionDir(sessionsRoot, '01-implement');
  assert.deepEqual(fs.readdirSync(reused), ['.claude.json']);
});

test('each run of an issue gets its own sessions dir', () => {
  const root = path.join('runs-root');
  const first = workspace.runSessionsDirFor(root, 7, new Date('2026-10-09T10:00:00.000Z'));
  const second = workspace.runSessionsDirFor(root, 7, new Date('2026-10-09T11:30:00.000Z'));
  assert.notEqual(first, second);
  for (const dir of [first, second]) assert.equal(path.dirname(dir), workspace.sessionsRootFor(root, 7));
  assert.ok(!/[:]/.test(path.basename(first)), 'the run folder name is valid on Windows');
});

test('host git status ignores an fsmonitor planted in the clone', (t) => {
  const dir = initRepo(t, { 'a.txt': 'a\n' });
  const marker = path.join(dir, 'fsmonitor-ran');
  const script = path.join(dir, 'monitor.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
  gitIn(dir, 'config', 'core.fsmonitor', `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`);
  workspace.gitStatusZ(dir);
  assert.equal(fs.existsSync(marker), false);
});

test('sandbox mode does not write operator claude config', (t) => {
  const fakeHome = tempDir(t);
  const operatorConfig = path.join(fakeHome, '.claude.json');
  const original = '{"projects":{}}\n';
  fs.writeFileSync(operatorConfig, original);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  prepareAgentSessionDir(tempDir(t), '01-implement');
  assert.equal(fs.readFileSync(operatorConfig, 'utf8'), original);
});

test('controller agent settings never show in the clone status or the commit', (t) => {
  isolateGit(t);
  const { origin } = makeConsumer(t);
  const runsRoot = path.join(tempDir(t), 'runs');
  const runDir = path.join(runsRoot, 'issue-1');
  workspace.prepareClone(runsRoot, runDir, origin);
  fs.writeFileSync(path.join(runDir, '.gitignore'), 'node_modules/\n');
  gitIn(runDir, 'commit', '-qam', 'consumer without settings ignore');
  writeAgentPermissions(runDir, fixtureProfile('single-package'), []);
  assert.equal(workspace.gitStatusZ(runDir), '');
});
