'use strict';

// Integration scenarios of the Ralph controller on the two neutral fixture profiles (monorepo and
// single package): the real runIssue on a local git repository with a bare origin, the real
// bin/setup.js of the package installed in the clone, and the exact commands the profile declares.
// The agent, GitHub and the sandbox are replaced as in the other portable tests (no network, no
// Docker, no model). The finer cases (budgets, parsers, permissions) stay in core.test.js,
// steps/registry.test.js and workspace.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BLOCK_LABEL } = require('./config');
const { DEFAULT_REGISTRY, createRegistry } = require('./steps/registry');
const { assertBaseProfileMatches } = require('./trusted-profile');
const baseSet = require('../skills/base-set.json');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const {
  CLONE_MARKER,
  APP_FILE,
  gitIn,
  tempDir,
  writeFiles,
  done,
  okResult,
  defaultAgent,
  defaultRun,
  isFactorySetup,
  originBranches,
  scenario,
} = require('../test/helpers/ralph');

const ROOT_INSTALL = [{ argv: ['tool', 'root-install'], cwd: '.' }];
const ALL_STEPS = ['implement', 'dummy', 'self-review', 'code-review', 'final-gate'];
const BASE_STEPS = ['implement', 'self-review', 'code-review', 'final-gate'];
const PR_URL = 'https://example.invalid/pr/1';

// A file inside a protected path that only that profile declares.
const PROTECTED_FILE = { monorepo: 'packages/billing/migrations/001.sql', 'single-package': 'scripts/tool.js' };

const rootRelative = (cwd) => (cwd === '.' ? '' : cwd);
const commandOf = (command) => ({ argv: command.argv, cwd: rootRelative(command.cwd) });
const specOf = (spec) => ({ argv: spec.command, cwd: spec.workdir });
const passedSteps = (names) => names.map((name) => ({ name, outcome: 'passed' }));

/** The apps of the profile that cover `file`, in profile order (a plain prefix test, not the controller's). */
const appsCovering = (profile, file) => profile.apps.filter((app) => app.path === '.' || file.startsWith(`${app.path}/`));

/** What the profile declares: every install (root first, then each app) and the gates of the apps touching `file`. */
const expectedCommands = (profile, file) => ({
  install: [...(profile.install ?? []), ...profile.apps.flatMap((app) => app.install ?? [])].map(commandOf),
  gate: appsCovering(profile, file).flatMap((app) => app.gate ?? []).map(commandOf),
});

const dummyStep = (run) => ({ name: 'dummy', kind: 'check', skipOnDocOnly: false, run });
const registryWithDummy = (run) => createRegistry([...DEFAULT_REGISTRY.values(), dummyStep(run)]);
const enableSteps = (names) => (profile) => {
  profile.ralph.enabledSteps = names;
};

/** The installed set as the agent sees it in the clone. */
const readInstalledSet = (runDir) => {
  const claude = path.join(runDir, '.claude');
  return {
    skills: fs.readdirSync(path.join(claude, 'skills')).sort(),
    agents: fs.readdirSync(path.join(claude, 'agents')).sort(),
    copies: JSON.parse(fs.readFileSync(path.join(claude, '.factory-installed.json'), 'utf8')).copies,
    copiedMarker: fs.readFileSync(path.join(claude, 'skills', 'issues', path.basename(CLONE_MARKER.file)), 'utf8'),
    packageMarker: fs.readFileSync(path.join(runDir, 'node_modules', 'dark-factory', CLONE_MARKER.file), 'utf8'),
  };
};

/** The set the package declares: process skills and metaskills (not runtime skills) and the agents. */
const expectedInstalledSet = () => {
  const skills = [...baseSet.processSkills, ...baseSet.jsMetaskills].map((entry) => entry.name).sort();
  const agents = baseSet.agents.map((entry) => `${entry.name}.md`).sort();
  const copies = [...skills.map((name) => `.claude/skills/${name}`), ...agents.map((name) => `.claude/agents/${name}`)].sort();
  return { skills, agents, copies, copiedMarker: CLONE_MARKER.text, packageMarker: CLONE_MARKER.text };
};

/**
 * One issue through the real controller. Sandbox runs are classified (setup / install / gate) and
 * logged with the agent calls in one ordered list; `gate(spec)` may answer the gate commands. The
 * installed set is read at the first agent call, before the agent changes anything.
 */
/** @type {(t: any, fixture: string, options?: any) => Promise<any>} */
const profileRun = async (t, fixture, { mutate, gate, implement, stepRegistry } = {}) => {
  const events = [];
  const state = { installed: null };
  const agent = defaultAgent(fixture, { implement });
  const run = await scenario(t, fixture, {
    mutate: (profile) => {
      profile.install = ROOT_INSTALL;
      if (mutate) mutate(profile);
    },
    stepRegistry,
    onRun: (spec) => {
      const kind = isFactorySetup(spec) ? 'setup' : spec.network === 'none' ? 'gate' : 'install';
      events.push(kind === 'setup' ? { kind } : { kind, ...specOf(spec) });
      return kind === 'gate' && gate ? gate(spec) : defaultRun(spec);
    },
    onAgent: (call) => {
      if (!state.installed) state.installed = readInstalledSet(call.runDir);
      events.push({ kind: 'agent', pass: call.pass });
      return agent(call);
    },
  });
  return { ...run, events, state };
};

const commandsOf = (run, kind) => run.events.filter((event) => event.kind === kind).map(({ argv, cwd }) => ({ argv, cwd }));
const passesOf = (run) => run.box.agents.map((agent) => agent.pass);
const gitCalls = (run, verb) => run.calls.filter((call) => call.file === 'git' && call.args.includes(verb));

const assertNotPublished = (run) => {
  assert.deepEqual(gitCalls(run, 'commit'), [], 'no commit');
  assert.deepEqual(gitCalls(run, 'push'), [], 'no push');
  assert.deepEqual(originBranches(run.origin), ['trunk'], 'the origin has only its base branch');
  assert.equal(run.prs.length, 0, 'no PR');
  assert.ok(run.labelsSet.includes(BLOCK_LABEL), 'the issue is marked blocked');
};

/** The profile committed in the selected base matches the trusted snapshot the controller was given. */
const assertBaseCarriesSnapshot = (t, run) => {
  const runDir = tempDir(t, 'ralph-base-');
  writeFiles(runDir, { '.factory/profile.json': gitIn(run.origin, 'show', 'trunk:.factory/profile.json') });
  assertBaseProfileMatches({ snapshot: run.ctx.profile, consumerRoot: run.consumerRoot, runDir, baseRef: 'trunk' });
};

const assertPositiveRun = (t, fixture, run, names) => {
  assert.equal(run.result.status, 'done', JSON.stringify(run.result));
  assertBaseCarriesSnapshot(t, run);

  const kinds = run.events.map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === 'setup').length, 1, 'setup runs once');
  assert.ok(kinds.includes('install'), 'installs ran');
  assert.ok(kinds.lastIndexOf('install') < kinds.indexOf('setup'), 'setup after every install');
  assert.ok(kinds.indexOf('setup') < kinds.indexOf('agent'), 'setup before the agent');
  assert.ok(kinds.indexOf('agent') < kinds.indexOf('gate'), 'the gate after the agent');
  assert.deepEqual(run.state.installed, expectedInstalledSet());

  const commands = expectedCommands(run.ctx.profile, APP_FILE[fixture]);
  assert.deepEqual(commandsOf(run, 'install'), commands.install, 'install commands of the root and of every app');
  assert.deepEqual(commandsOf(run, 'gate'), commands.gate, 'gate commands of the touched apps only');
  assert.ok(commands.gate.length > 0 && commands.install.length > 1);

  assert.deepEqual(run.result.steps, passedSteps(names));
  assert.deepEqual(passesOf(run), ['implement', 'self-review', 'code-review']);
  assert.equal(run.prs.length, 1);
  assert.equal(run.result.pr, PR_URL);
  const branches = originBranches(run.origin).filter((branch) => branch !== 'trunk');
  assert.equal(branches.length, 1);
  assert.deepEqual(gitIn(run.origin, 'diff', '--name-only', 'trunk', branches[0]).split('\n'), [APP_FILE[fixture]]);
};

test('runs monorepo fixture profile end to end', async (t) => {
  const run = await profileRun(t, 'monorepo');
  assertPositiveRun(t, 'monorepo', run, BASE_STEPS);
  const { install, gate } = expectedCommands(run.ctx.profile, APP_FILE.monorepo);
  assert.equal(run.ctx.profile.apps.length, 2);
  assert.deepEqual(install.map((command) => command.cwd), ['', 'packages/billing', 'packages/storefront']);
  assert.ok(gate.every((command) => command.cwd === 'packages/billing'), 'the other app is not gated');
});

test('runs single-package fixture profile end to end', async (t) => {
  const run = await profileRun(t, 'single-package');
  assertPositiveRun(t, 'single-package', run, BASE_STEPS);
  const { install, gate } = expectedCommands(run.ctx.profile, APP_FILE['single-package']);
  assert.equal(run.ctx.profile.apps.length, 1);
  assert.deepEqual(install.map((command) => command.cwd), ['', '']);
  assert.ok(gate.every((command) => command.cwd === ''), 'the gate runs in the root');
});

test('blocks protected path change in both profiles', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const file = PROTECTED_FILE[fixture];
    const run = await profileRun(t, fixture, {
      implement: ({ runDir }) => {
        writeFiles(runDir, { [file]: 'changed\n', [APP_FILE[fixture]]: 'export const value = 1;\n' });
        return done('feat', 'change');
      },
    });
    assert.ok(run.ctx.profile.protectedPaths.some((pattern) => file.startsWith(pattern)), `${fixture}: the file is protected by its profile`);
    assert.equal(run.result.status, 'blocked', fixture);
    assert.match(run.result.reason, /protected paths/, fixture);
    assert.ok(run.result.reason.includes(file), `${fixture}: the reason names the file`);
    assert.deepEqual(passesOf(run), ['implement'], `${fixture}: no further agent call`);
    assert.deepEqual(commandsOf(run, 'gate'), [], `${fixture}: no gate`);
    assertNotPublished(run);
    t.mock.restoreAll();
  }
});

test('failing gate blocks in both profiles', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const run = await profileRun(t, fixture, { gate: () => ({ ...okResult(), status: 1, stderr: 'check failed' }) });
    assert.equal(run.result.status, 'final_gate_blocked', fixture);
    assert.deepEqual(run.result.steps.at(-1), { name: 'final-gate', outcome: 'blocked' }, fixture);
    assert.deepEqual(run.result.steps.map((step) => step.name), BASE_STEPS, fixture);
    assert.ok(commandsOf(run, 'gate').length > 0, `${fixture}: the gate ran`);
    assertNotPublished(run);
    t.mock.restoreAll();
  }
});

test('dummy step enabled by profile runs in order', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const diffs = [];
    const run = await profileRun(t, fixture, {
      mutate: enableSteps(ALL_STEPS),
      stepRegistry: registryWithDummy((ctx) => {
        diffs.push(ctx.diff);
        return { kind: 'passed' };
      }),
    });
    assertPositiveRun(t, fixture, run, ALL_STEPS);
    assert.equal(diffs.length, 1, `${fixture}: the dummy step ran once`);
    assert.ok(diffs[0].includes(APP_FILE[fixture]), `${fixture}: it saw the change of the implement step`);
    t.mock.restoreAll();
  }
});

test('dummy step disabled by profile changes nothing', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    let calls = 0;
    const control = await profileRun(t, fixture);
    t.mock.restoreAll();
    const registered = await profileRun(t, fixture, {
      stepRegistry: registryWithDummy(() => {
        calls++;
        return { kind: 'blocked', reason: 'must not run' };
      }),
    });
    assert.equal(calls, 0, `${fixture}: the dummy step is not called`);
    assert.equal(control.result.status, 'done', fixture);
    assert.deepEqual(registered.result, control.result, fixture);
    assert.deepEqual(registered.result.steps, passedSteps(BASE_STEPS), fixture);
    assert.deepEqual(passesOf(registered), passesOf(control), fixture);
    assert.deepEqual(registered.events, control.events, `${fixture}: same setup, install, agent and gate sequence`);
    assert.equal(registered.prs.length, 1);
    assert.deepEqual(registered.prs, control.prs, `${fixture}: the same PR`);
    assert.deepEqual(registered.labelsSet, control.labelsSet, fixture);
    t.mock.restoreAll();
  }
});

test('failing dummy step blocks before final gate', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    let calls = 0;
    const run = await profileRun(t, fixture, {
      mutate: enableSteps(ALL_STEPS),
      stepRegistry: registryWithDummy(() => {
        calls++;
        return { kind: 'blocked', reason: 'dummy refuses this change' };
      }),
    });
    assert.equal(calls, 1, fixture);
    assert.equal(run.result.status, 'blocked', fixture);
    assert.match(run.result.reason, /dummy refuses this change/, fixture);
    assert.deepEqual(run.result.steps, [{ name: 'implement', outcome: 'passed' }, { name: 'dummy', outcome: 'blocked' }], fixture);
    assert.deepEqual(passesOf(run), ['implement'], `${fixture}: no review, no new agent call`);
    assert.deepEqual(commandsOf(run, 'gate'), [], `${fixture}: no gate`);
    assertNotPublished(run);
    t.mock.restoreAll();
  }
});
