'use strict';

// The step pipeline: the registry, the profile's choice of steps and budgets, and the controller
// running it with every core protection. Real local git, gh replaced at the child_process boundary
// and Docker at the sandbox runtime; the agent is a script. No network, Docker or model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BASELINE_PIPELINE, DEFAULT_REGISTRY, createRegistry, resolvePipeline } = require('./registry');
const { parseWritesOutput } = require('./implement');
const { runRalph } = require('../run');
const sandbox = require('../sandbox');
const { BLOCK_LABEL, lockPathFor } = require('../config');
const { loadProfile } = require('../../profile/load');
const { FIXTURE_PROFILES, profileCopy } = require('../../test/helpers/profiles');
const {
  tempDir,
  writeFiles,
  controllerProfile,
  mockGh,
  SELF_REPORT_FULL,
  done,
  issueWith,
  APP_FILE,
  defaultRun,
  scenario,
} = require('../../test/helpers/ralph');

// --- helpers ---

const REVIEW_PASS = { 'self-review': 'REVIEW: PASS', 'code-review': 'CODEREVIEW: PASS' };
const REVIEW_FAIL = { 'self-review': 'REVIEW: FAIL: a.ts misses a check', 'code-review': 'CODEREVIEW: FAIL: a.ts duplicates code' };

const appendLine = (runDir, file, line) => {
  const full = path.join(runDir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, `${line}\n`);
};

/**
 * A scripted agent: a review answers from its script (the last answer repeats; a pass when there
 * is none); every write call appends a line to the app file and says DONE with its pass name.
 */
/** @type {(...args: any[]) => any} */
const scriptedAgent = (fixture, reviews = {}, { onWrite } = {}) => {
  const scripts = Object.fromEntries(Object.entries(reviews).map(([pass, answers]) => [pass, [...answers]]));
  return ({ pass, runDir }) => {
    const script = scripts[pass];
    if (script) return script.length > 1 ? script.shift() : script[0];
    if (REVIEW_PASS[pass]) return REVIEW_PASS[pass];
    if (onWrite) return onWrite({ pass, runDir });
    appendLine(runDir, APP_FILE[fixture], `// ${pass}`);
    return done(pass === 'implement' ? 'feat' : 'fix', `${pass} summary`, SELF_REPORT_FULL(2));
  };
};

const failing = (pass, times, then = REVIEW_PASS[pass]) => [...Array.from({ length: times }, () => REVIEW_FAIL[pass]), then];

const passesOf = (run) => run.box.agents.map((agent) => agent.pass);
const countOf = (run, pass) => passesOf(run).filter((name) => name === pass).length;
const stepNamesOf = (run) => run.result.steps.map((step) => step.name);
const gateRunsOf = (run) => run.box.runs.filter((r) => r.spec.network === 'none');

/** @type {(...args: any[]) => any} */
const ralphSettings = (settings) => (profile) => Object.assign(profile.ralph, settings);

/** @type {(name: string, run?: (ctx: any) => any) => any} */
const checkStep = (name, run = () => ({ kind: 'passed' })) => ({ name, kind: 'check', skipOnDocOnly: false, run });
const registryWith = (...steps) => createRegistry([...DEFAULT_REGISTRY.values(), ...steps]);

const assertNoPr = (run) => {
  assert.equal(run.prs.length, 0, 'no PR');
};

const loadCopy = (t, fixture, mutate) => () => loadProfile(profileCopy(t, fixture, mutate));

/**
 * runRalph with an empty queue: every side effect is recorded (git/gh at the process boundary,
 * Docker steps, issue selection and runs) and the runs root is a fresh path.
 */
/** @type {(...args: any[]) => any} */
const startRalph = async (t, profile, stepRegistry) => {
  const calls = mockGh(t);
  const runsRoot = path.join(tempDir(t), 'runs');
  const events = [];
  const sandboxApi = {
    ...sandbox,
    assertAvailable: () => events.push('docker'),
    removeLeftovers: () => events.push('leftovers'),
    buildImage: () => events.push('image'),
  };
  let error = null;
  try {
    await runRalph({
      consumerRoot: tempDir(t),
      profile,
      localConfig: { issues: [], runsRoot },
      deps: {
        sandboxApi,
        stepRegistry,
        classifyIssues: () => {
          events.push('classify');
          return [];
        },
        runOneIssue: async () => {
          events.push('runIssue');
          return { status: 'done', pr: 'x' };
        },
        saveState: () => {},
      },
    });
  } catch (caught) {
    error = caught;
  }
  return { error, events, calls, runsRoot };
};

const assertStoppedBeforeRun = (start) => {
  assert.ok(start.error, 'the run did not start');
  assert.deepEqual(start.events, [], 'no Docker, no queue, no issue run');
  assert.deepEqual(start.calls, [], 'no git or gh');
  assert.equal(fs.existsSync(lockPathFor(start.runsRoot)), false, 'no lock');
  assert.equal(fs.existsSync(start.runsRoot), false, 'no runs root');
};

// --- pipeline selection ---

test('uses complete baseline pipeline by default', (t) => {
  assert.deepEqual(BASELINE_PIPELINE, ['implement', 'self-review', 'code-review', 'final-gate']);
  for (const fixture of FIXTURE_PROFILES) {
    const profile = controllerProfile(t, fixture);
    assert.equal(profile.ralph.enabledSteps, undefined, fixture);
    const { steps } = resolvePipeline(profile);
    assert.deepEqual(steps.map((step) => step.name), BASELINE_PIPELINE, fixture);
  }
});

test('preserves consumer review budgets', () => {
  // The example profiles of the two consumer projects, in directory order: the second one keeps
  // the default budgets, the first one sets its own.
  const examples = path.join(__dirname, '..', '..', 'examples', 'profiles');
  const consumers = fs.readdirSync(examples, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.equal(consumers.length, 2);
  const profiles = consumers.map((name) => loadProfile(path.join(examples, name)));
  const budgets = profiles.map((profile) => Object.fromEntries(resolvePipeline(profile).budgets));
  assert.deepEqual(budgets, [{ 'self-review': 4, 'code-review': 2 }, { 'self-review': 2, 'code-review': 2 }]);
  assert.deepEqual(profiles[0].ralph.stepBudgets, { 'self-review': 4, 'code-review': 2 }, 'set explicitly');
  assert.equal(profiles[1].ralph.stepBudgets, undefined, 'defaults');
});

test('rejects profile disabling mandatory step', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const cases = [
      { steps: ['self-review', 'code-review', 'final-gate'], missing: ['implement'] },
      { steps: ['implement', 'self-review', 'code-review'], missing: ['final-gate'] },
      { steps: [], missing: ['implement', 'final-gate'] },
    ];
    for (const { steps, missing } of cases) {
      const load = loadCopy(t, fixture, ralphSettings({ enabled: true, techDebtTrackerIssue: 3, enabledSteps: steps }));
      assert.throws(load, (/** @type {any} */ error) => {
        for (const name of missing) assert.match(error.message, new RegExp(`ralph\\.enabledSteps: mandatory step "${name}" is missing`));
        return true;
      }, `${fixture}: ${JSON.stringify(steps)}`);
    }
  }
});

test('rejects invalid explicit pipeline', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const cases = [
      { steps: ['implement', 'self-review', 'self-review', 'final-gate'], reason: /ralph\.enabledSteps: must NOT have duplicate items/ },
      { steps: ['self-review', 'implement', 'final-gate'], reason: /"implement" must be the first step/ },
      { steps: ['implement', 'final-gate', 'code-review'], reason: /"final-gate" must be the last step/ },
      { steps: ['implement', 'code-review', 'self-review', 'final-gate'], reason: /"self-review" must come before "code-review"/ },
    ];
    for (const { steps, reason } of cases) {
      assert.throws(loadCopy(t, fixture, ralphSettings({ enabled: true, techDebtTrackerIssue: 3, enabledSteps: steps })), reason, `${fixture}: ${steps}`);
    }

    const unloaded = { ...controllerProfile(t, fixture), ralph: { enabled: true, enabledSteps: ['implement', 'self-review', 'self-review', 'final-gate'] } };
    assert.throws(() => resolvePipeline(unloaded), /step "self-review" is listed more than once/, 'a profile that skipped the loader');

    const profile = controllerProfile(t, fixture, ralphSettings({ enabledSteps: ['implement', 'polish', 'final-gate'] }));
    const start = await startRalph(t, profile);
    assertStoppedBeforeRun(start);
    assert.match(start.error.message, /ralph\.enabledSteps: step "polish" is not registered/);
    t.mock.restoreAll();
  }
});

test('fails on unknown step in profile', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const profile = controllerProfile(t, fixture, ralphSettings({ enabledSteps: ['implement', 'self-review', 'mystery-step', 'final-gate'] }));
    const start = await startRalph(t, profile);
    assertStoppedBeforeRun(start);
    assert.match(start.error.message, /step "mystery-step" is not registered/);
    t.mock.restoreAll();
  }
});

test('rejects invalid step budget', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    for (const value of [0, -1, 1.5, '2']) {
      const load = loadCopy(t, fixture, ralphSettings({ enabled: true, techDebtTrackerIssue: 3, stepBudgets: { 'self-review': value } }));
      assert.throws(load, /ralph\.stepBudgets\.self-review: must be/, `${fixture}: ${JSON.stringify(value)}`);
    }
  }
});

test('rejects budget for unknown or non-fixing step', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    for (const key of ['unknown-step', 'implement', 'final-gate']) {
      const profile = controllerProfile(t, fixture, ralphSettings({ stepBudgets: { [key]: 1 } }));
      const start = await startRalph(t, profile);
      assertStoppedBeforeRun(start);
      assert.match(start.error.message, new RegExp(`ralph\\.stepBudgets\\.${key}: step "${key}"`), key);
      t.mock.restoreAll();
    }
  }
});

test('rejects step with unknown permission profile', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const rogue = { name: 'rogue', kind: 'agent', mode: 'writes', permissions: 'operator', skipOnDocOnly: false, buildPrompt: () => 'x', parseOutput: parseWritesOutput };
    const profile = controllerProfile(t, fixture, ralphSettings({ enabledSteps: ['implement', 'rogue', 'final-gate'] }));
    const start = await startRalph(t, profile, registryWith(rogue));
    assertStoppedBeforeRun(start);
    assert.match(start.error.message, /step "rogue": unknown permission profile "operator"/);
    t.mock.restoreAll();
  }
});

for (const fixture of FIXTURE_PROFILES) {
  // --- order and selection ---

  test(`runs enabled steps in profile order (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      mutate: ralphSettings({ enabledSteps: ['implement', 'self-review', 'code-review', 'final-gate'] }),
      onAgent: scriptedAgent(fixture),
    });
    assert.equal(run.result.status, 'done', JSON.stringify(run.result));
    assert.deepEqual(run.result.steps, ['implement', 'self-review', 'code-review', 'final-gate'].map((name) => ({ name, outcome: 'passed' })));
    assert.deepEqual(passesOf(run), ['implement', 'self-review', 'code-review']);
    assert.ok(gateRunsOf(run).length > 0, 'final gate ran');
    assert.equal(run.prs.length, 1);
  });

  test(`skips step disabled by profile (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      mutate: ralphSettings({ enabledSteps: ['implement', 'self-review', 'final-gate'] }),
      onAgent: scriptedAgent(fixture),
    });
    assert.equal(run.result.status, 'done');
    assert.deepEqual(stepNamesOf(run), ['implement', 'self-review', 'final-gate']);
    assert.deepEqual(passesOf(run), ['implement', 'self-review']);
    assert.ok(gateRunsOf(run).length > 0, 'final gate ran');
  });

  test(`accepts budget of disabled review without enabling it (${fixture})`, async (t) => {
    const mutate = ralphSettings({ enabledSteps: ['implement', 'self-review', 'final-gate'], stepBudgets: { 'code-review': 3 } });
    assert.equal(resolvePipeline(controllerProfile(t, fixture, mutate)).budgets.get('code-review'), 3, 'configuration accepted');
    const run = await scenario(t, fixture, { mutate, onAgent: scriptedAgent(fixture) });
    assert.equal(run.result.status, 'done');
    assert.equal(countOf(run, 'code-review'), 0);
    assert.ok(!stepNamesOf(run).includes('code-review'));
  });

  test(`runs registered extension step from injected registry (${fixture})`, async (t) => {
    const seen = [];
    const audit = checkStep('audit', (ctx) => {
      seen.push(ctx.diff);
      return { kind: 'passed' };
    });
    const run = await scenario(t, fixture, {
      mutate: ralphSettings({ enabledSteps: ['implement', 'self-review', 'audit', 'code-review', 'final-gate'] }),
      stepRegistry: registryWith(audit),
      onAgent: scriptedAgent(fixture),
    });
    assert.equal(run.result.status, 'done');
    assert.deepEqual(stepNamesOf(run), ['implement', 'self-review', 'audit', 'code-review', 'final-gate']);
    assert.equal(run.result.steps[2].outcome, 'passed');
    assert.equal(seen.length, 1);
    assert.match(seen[0], new RegExp(APP_FILE[fixture].replace(/[./]/g, '\\$&')), 'the step sees the current diff');
    assert.equal(run.prs.length, 1);
  });

  test(`keeps registered extension off unless listed (${fixture})`, async (t) => {
    let calls = 0;
    const audit = checkStep('audit', () => {
      calls++;
      return { kind: 'blocked', reason: 'must not run' };
    });
    const plain = await scenario(t, fixture, { onAgent: scriptedAgent(fixture) });
    t.mock.restoreAll();
    const registered = await scenario(t, fixture, { stepRegistry: registryWith(audit), onAgent: scriptedAgent(fixture) });
    assert.equal(calls, 0);
    assert.deepEqual(registered.result, plain.result);
    assert.deepEqual(passesOf(registered), passesOf(plain));
    assert.equal(registered.prs.length, 1);
  });

  // --- budgets ---

  test(`uses default budgets when profile has none (${fixture})`, async (t) => {
    const selfBlocked = await scenario(t, fixture, { onAgent: scriptedAgent(fixture, { 'self-review': [REVIEW_FAIL['self-review']] }) });
    assert.equal(selfBlocked.result.status, 'review_blocked');
    assert.equal(countOf(selfBlocked, 'review-fix'), 2);
    assert.equal(countOf(selfBlocked, 'self-review'), 3);
    assertNoPr(selfBlocked);
    t.mock.restoreAll();

    const codeBlocked = await scenario(t, fixture, { onAgent: scriptedAgent(fixture, { 'code-review': [REVIEW_FAIL['code-review']] }) });
    assert.equal(codeBlocked.result.status, 'code_review_blocked');
    assert.equal(countOf(codeBlocked, 'review-fix'), 0);
    assert.equal(countOf(codeBlocked, 'code-review-fix'), 2);
    assertNoPr(codeBlocked);
  });

  test(`keeps review budgets independent (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      onAgent: scriptedAgent(fixture, { 'self-review': failing('self-review', 2), 'code-review': failing('code-review', 2) }),
    });
    assert.equal(run.result.status, 'done', JSON.stringify(run.result));
    assert.equal(countOf(run, 'review-fix'), 2);
    assert.equal(countOf(run, 'code-review-fix'), 2);
    assert.equal(run.prs.length, 1);
  });

  test(`does not pool review budgets (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      mutate: ralphSettings({ stepBudgets: { 'self-review': 2, 'code-review': 1 } }),
      onAgent: scriptedAgent(fixture, { 'self-review': failing('self-review', 2), 'code-review': [REVIEW_FAIL['code-review']] }),
    });
    assert.equal(countOf(run, 'review-fix'), 2);
    assert.equal(countOf(run, 'code-review-fix'), 1);
    assert.equal(countOf(run, 'code-review'), 2);
    assert.equal(run.result.status, 'code_review_blocked');
    assert.deepEqual(run.result.steps.at(-1), { name: 'code-review', outcome: 'failed' });
    assertNoPr(run);
  });

  // --- review loop and read-only calls ---

  test(`applies unchanged-tree check to read-only calls only (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, { onAgent: scriptedAgent(fixture, { 'self-review': failing('self-review', 1) }) });
    assert.equal(run.result.status, 'done', JSON.stringify(run.result));
    assert.deepEqual(passesOf(run), ['implement', 'self-review', 'review-fix', 'self-review', 'code-review']);
    assert.equal(run.prs.length, 1);
  });

  test(`blocks read-only step that changed the tree (${fixture})`, async (t) => {
    const changing = await scenario(t, fixture, {
      onAgent: (call) => {
        if (call.pass === 'self-review') {
          writeFiles(call.runDir, { 'notes/reviewer.txt': 'reviewer edit\n' });
          return REVIEW_FAIL['self-review'];
        }
        return scriptedAgent(fixture)(call);
      },
    });
    assert.equal(changing.result.status, 'blocked');
    assert.match(changing.result.reason, /read-only review pass changed the working tree/);
    assert.equal(countOf(changing, 'review-fix'), 0, 'no fixer');
    assert.deepEqual(changing.result.steps.at(-1), { name: 'self-review', outcome: 'blocked' });
    assertNoPr(changing);
  });

  test(`blocks on unparseable review verdict (${fixture})`, async (t) => {
    for (const [pass, status, fix] of [['self-review', 'review_blocked', 'review-fix'], ['code-review', 'code_review_blocked', 'code-review-fix']]) {
      const run = await scenario(t, fixture, { onAgent: scriptedAgent(fixture, { [pass]: ['looks fine to me'] }) });
      assert.equal(run.result.status, status, pass);
      assert.match(run.result.reason, /did not return a clear PASS\/FAIL verdict/);
      assert.equal(countOf(run, fix), 0, `${pass}: no fixer`);
      assert.deepEqual(run.result.steps.at(-1), { name: pass, outcome: 'unparseable' });
      assert.ok(run.labelsSet.includes(BLOCK_LABEL));
      assertNoPr(run);
      t.mock.restoreAll();
    }
  });

  test(`rejects fix without diff (${fixture})`, async (t) => {
    // The fixer puts the tracked file back as it was: the run has no diff left.
    const original = 'export const value = 0;\n';
    const run = await scenario(t, fixture, {
      files: { [APP_FILE[fixture]]: original },
      onAgent: scriptedAgent(fixture, { 'self-review': [REVIEW_FAIL['self-review']] }, {
        onWrite: ({ pass, runDir }) => {
          writeFiles(runDir, { [APP_FILE[fixture]]: pass === 'implement' ? 'export const value = 1;\n' : original });
          return done('fix', `${pass} summary`);
        },
      }),
    });
    assert.equal(run.result.status, 'validate_failed');
    assert.match(run.result.error, /review-fix agent said DONE but produced no diff/);
    assert.deepEqual(passesOf(run), ['implement', 'self-review', 'review-fix'], 'no second review');
    assertNoPr(run);
  });

  test(`posts out-of-scope note and continues (${fixture})`, async (t) => {
    const note = 'other/area.ts:3 — duplicated helper';
    const run = await scenario(t, fixture, { onAgent: scriptedAgent(fixture, { 'code-review': [`CODEREVIEW: PASS-OUT-OF-SCOPE: ${note}`] }) });
    assert.equal(run.result.status, 'done');
    const tracker = String(run.profile.ralph.techDebtTrackerIssue);
    assert.ok(run.comments.some((c) => c.issue === tracker && c.body.includes(note)), 'note on the tech-debt tracker');
    assert.equal(countOf(run, 'code-review-fix'), 0);
    assert.deepEqual(run.result.steps.find((s) => s.name === 'code-review'), { name: 'code-review', outcome: 'passed-out-of-scope' });
    assert.equal(run.prs.length, 1);
  });

  test(`writes named permission profile for every agent call (${fixture})`, async (t) => {
    const seen = [];
    const agent = scriptedAgent(fixture, { 'self-review': failing('self-review', 1), 'code-review': failing('code-review', 1) });
    const run = await scenario(t, fixture, {
      onAgent: (call) => {
        const file = path.join(call.runDir, '.claude', 'settings.local.json');
        seen.push({ pass: call.pass, permissions: JSON.parse(fs.readFileSync(file, 'utf8')).permissions });
        return agent(call);
      },
    });
    assert.equal(run.result.status, 'done');
    assert.deepEqual(seen.map((s) => s.pass), ['implement', 'self-review', 'review-fix', 'self-review', 'code-review', 'code-review-fix', 'code-review']);
    const profileOf = ({ allow, deny }) => {
      if (allow.includes('Skill(code-review)') && deny.includes('Edit(**)')) return 'code-reviewer';
      if (deny.includes('Edit(**)')) return 'reviewer';
      if (allow.includes('Edit') && allow.includes('Write')) return 'implementer';
      return 'unknown';
    };
    const expected = { implement: 'implementer', 'review-fix': 'implementer', 'code-review-fix': 'implementer', 'self-review': 'reviewer', 'code-review': 'code-reviewer' };
    for (const { pass, permissions } of seen) {
      assert.equal(profileOf(permissions), expected[pass], pass);
      for (const denied of ['Bash(gh *)', 'Bash(git commit*)', 'Bash(git push*)']) assert.ok(permissions.deny.includes(denied), `${pass}: ${denied}`);
      assert.ok(!permissions.allow.some((rule) => /^Bash\((gh|git (commit|push))/.test(rule)), pass);
    }
  });

  // --- extensions and core protections ---

  test(`applies core protections to extension steps (${fixture})`, async (t) => {
    const polish = { name: 'polish', kind: 'agent', mode: 'writes', permissions: 'implementer', skipOnDocOnly: false, buildPrompt: () => 'polish the change', parseOutput: parseWritesOutput };
    const mutate = ralphSettings({ enabledSteps: ['implement', 'polish', 'final-gate'] });
    const protectedRun = await scenario(t, fixture, {
      mutate,
      stepRegistry: registryWith(polish),
      onAgent: scriptedAgent(fixture, {}, {
        onWrite: ({ pass, runDir }) => {
          writeFiles(runDir, pass === 'polish' ? { 'scripts/tool.js': 'x\n' } : { [APP_FILE[fixture]]: 'export {};\n' });
          return done('feat', pass);
        },
      }),
    });
    assert.equal(protectedRun.result.status, 'blocked');
    assert.match(protectedRun.result.reason, /protected paths/);
    assert.deepEqual(protectedRun.result.steps.at(-1), { name: 'polish', outcome: 'blocked' });
    assertNoPr(protectedRun);
    t.mock.restoreAll();

    // The mocked agent costs $0.01 a call: implement spends the whole task budget.
    const spent = await scenario(t, fixture, { mutate, stepRegistry: registryWith(polish), settings: { taskMaxUsd: 0.01 }, onAgent: scriptedAgent(fixture) });
    assert.deepEqual(passesOf(spent), ['implement'], 'the extension agent is not called');
    assert.notEqual(spent.result.status, 'done');
    assert.equal(spent.result.status, 'agent_failed');
    assert.match(spent.result.error, /task cost budget/);
    assert.deepEqual(spent.result.steps.at(-1), { name: 'polish', outcome: 'error' });
    assertNoPr(spent);
  });

  test(`stops pipeline on failing step before final gate (${fixture})`, async (t) => {
    const audit = checkStep('audit', () => ({ kind: 'blocked', reason: 'audit found a forbidden pattern' }));
    const run = await scenario(t, fixture, {
      mutate: ralphSettings({ enabledSteps: ['implement', 'self-review', 'code-review', 'audit', 'final-gate'] }),
      stepRegistry: registryWith(audit),
      onAgent: scriptedAgent(fixture),
    });
    assert.equal(run.result.status, 'blocked');
    assert.match(run.result.reason, /forbidden pattern/);
    assert.deepEqual(stepNamesOf(run), ['implement', 'self-review', 'code-review', 'audit']);
    assert.deepEqual(run.result.steps.at(-1), { name: 'audit', outcome: 'blocked' });
    assert.equal(gateRunsOf(run).length, 0, 'final gate not run');
    assert.ok(run.labelsSet.includes(BLOCK_LABEL));
    assertNoPr(run);
  });

  // --- finishing: dependency sync, final gate, doc-only ---

  const withManifest = (profile) => {
    profile.dependencySync = [{ argv: ['tool', 'sync'], cwd: '.' }];
    profile.apps.push({ name: 'extra', path: 'extra', gate: [{ argv: ['extra-check'], cwd: 'extra' }] });
  };
  const manifestIssue = issueWith(7, [APP_FILE[fixture], 'package.json']);
  const changeManifest = ({ pass, runDir }) => {
    if (pass !== 'implement') return null;
    writeFiles(runDir, { [APP_FILE[fixture]]: 'export {};\n', 'package.json': '{"name":"x","dependencies":{"dep":"1.0.0"}}\n' });
    return done('feat', 'add dep', SELF_REPORT_FULL(2));
  };

  test(`runs dependency sync right before final gate (${fixture})`, async (t) => {
    const events = [];
    const audit = checkStep('audit', () => {
      events.push('audit');
      return { kind: 'passed' };
    });
    const run = await scenario(t, fixture, {
      files: { 'package.json': '{"name":"x","dependencies":{}}\n' },
      issue: manifestIssue,
      mutate: (profile) => {
        withManifest(profile);
        profile.ralph.enabledSteps = ['implement', 'self-review', 'code-review', 'audit', 'final-gate'];
      },
      stepRegistry: registryWith(audit),
      onAgent: scriptedAgent(fixture, {}, { onWrite: changeManifest }),
      onRun: (spec) => {
        const command = spec.command.join(' ');
        if (command === 'tool sync') {
          events.push('sync');
          writeFiles(spec.runDir, { 'extra/generated.lock': 'synced\n' });
        } else if (spec.network === 'none') {
          events.push(`gate ${command}`);
        }
        return defaultRun(spec);
      },
    });
    assert.equal(run.result.status, 'done', JSON.stringify(run.result));
    const gates = events.filter((e) => e.startsWith('gate '));
    assert.ok(gates.length > 0);
    assert.ok(events.indexOf('audit') < events.indexOf('sync'), 'sync after the extension step');
    assert.ok(events.indexOf('sync') < events.indexOf(gates[0]), 'sync before the final gate');
    assert.ok(gates.includes('gate extra-check'), 'the gate saw the file the sync added');
    assert.deepEqual(stepNamesOf(run), ['implement', 'self-review', 'code-review', 'audit', 'final-gate']);
  });

  test(`blocks before final gate on dependency sync failure (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      files: { 'package.json': '{"name":"x","dependencies":{}}\n' },
      issue: manifestIssue,
      mutate: withManifest,
      onAgent: scriptedAgent(fixture, {}, { onWrite: changeManifest }),
      onRun: (spec) => (spec.command.join(' ') === 'tool sync' ? { status: 1, stdout: '', stderr: 'sync failed', error: null, name: 'c' } : defaultRun(spec)),
    });
    assert.equal(run.result.status, 'dependency_sync_blocked');
    assert.equal(gateRunsOf(run).length, 0, 'no gate command');
    assert.deepEqual(run.result.steps.at(-1), { name: 'final-gate', outcome: 'blocked' });
    assertNoPr(run);
  });

  test(`does not retry implement or final gate (${fixture})`, async (t) => {
    const unreadable = await scenario(t, fixture, { onAgent: scriptedAgent(fixture, {}, { onWrite: () => 'I am done, I think' }) });
    assert.equal(unreadable.result.status, 'agent_failed');
    assert.deepEqual(passesOf(unreadable), ['implement']);
    assert.deepEqual(unreadable.result.steps, [{ name: 'implement', outcome: 'unparseable' }]);
    assertNoPr(unreadable);
    t.mock.restoreAll();

    const red = await scenario(t, fixture, {
      onAgent: scriptedAgent(fixture),
      onRun: (spec) => (spec.network === 'none' ? { status: 1, stdout: '', stderr: 'lint failed', error: null, name: 'c' } : defaultRun(spec)),
    });
    assert.equal(red.result.status, 'final_gate_blocked');
    assert.equal(countOf(red, 'implement'), 1);
    assert.equal(gateRunsOf(red).length, 1, 'the gate ran once and stopped at its first red command');
    assert.deepEqual(red.result.steps.at(-1), { name: 'final-gate', outcome: 'blocked' });
    assertNoPr(red);
  });

  test(`skips reviews and gate commands for doc-only diff (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      issue: issueWith(7, ['README.md']),
      onAgent: scriptedAgent(fixture, {}, {
        onWrite: ({ runDir }) => {
          writeFiles(runDir, { 'README.md': 'neutral, documented\n' });
          return done('docs', 'document it', SELF_REPORT_FULL(2));
        },
      }),
    });
    assert.equal(run.result.status, 'done', JSON.stringify(run.result));
    assert.deepEqual(passesOf(run), ['implement']);
    assert.equal(gateRunsOf(run).length, 0);
    assert.deepEqual(run.result.steps, [
      { name: 'implement', outcome: 'passed' },
      { name: 'self-review', outcome: 'skipped' },
      { name: 'code-review', outcome: 'skipped' },
      { name: 'final-gate', outcome: 'skipped' },
    ]);
    assert.equal(run.prs.length, 1);
  });

  test(`keeps boundary checks for doc-only diff (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      issue: issueWith(7, ['README.md']),
      onAgent: scriptedAgent(fixture, {}, {
        onWrite: ({ runDir }) => {
          writeFiles(runDir, { 'README.md': 'neutral, documented\n', 'scripts/notes.md': 'x\n' });
          return done('docs', 'document it');
        },
      }),
    });
    assert.equal(run.result.status, 'blocked');
    assert.match(run.result.reason, /protected paths: scripts\/notes\.md/);
    assert.ok(run.labelsSet.includes(BLOCK_LABEL));
    assertNoPr(run);
  });

  test(`runs reviews and gate for mixed diff (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      issue: issueWith(7, ['README.md', APP_FILE[fixture]]),
      onAgent: scriptedAgent(fixture, {}, {
        onWrite: ({ runDir }) => {
          writeFiles(runDir, { 'README.md': 'neutral, documented\n', [APP_FILE[fixture]]: 'export {};\n' });
          return done('feat', 'mixed', SELF_REPORT_FULL(2));
        },
      }),
    });
    assert.equal(run.result.status, 'done');
    assert.deepEqual(passesOf(run), ['implement', 'self-review', 'code-review']);
    assert.ok(gateRunsOf(run).length > 0, 'gate commands ran');
    assert.ok(run.result.steps.every((step) => step.outcome === 'passed'));
  });
}
