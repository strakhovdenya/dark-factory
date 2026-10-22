'use strict';

// Portable tests of the controller state machine. A neutral consumer repository is a real local
// git repository (no network); gh is replaced at the child_process boundary and Docker at the
// sandbox runtime, so no GitHub, Docker or model is needed (see `scenario` in test/helpers).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runIssue, publishChanges } = require('./core');
const { BLOCK_LABEL } = require('./config');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const {
  HUMAN_VERDICT,
  HUMAN_LABEL,
  gitIn,
  writeFiles,
  pushBranch,
  controllerProfile,
  okResult,
  SELF_REPORT_FULL,
  done,
  issueWith,
  runContext,
  APP_FILE,
  defaultAgent,
  scenario,
  originBranches,
} = require('../test/helpers/ralph');

// --- publishChanges: commit -> push -> PR -> issue side effects ---

const CHOSEN = {
  id: 1,
  title: 'Example',
  dependsOn: [],
  body: '## Acceptance Criteria\n\n- [ ] AC-1 first\n- [ ] AC-2 second\n\n## Other\n',
};
const VERDICT = { type: 'fix', summary: 'did the thing' };
const PR_URL = 'https://example.invalid/pr/9';
const CTX = { consumerRoot: 'consumer', originUrl: 'origin-url' };

const publishOps = (calls, overrides = {}) => ({
  commitChanges: () => {
    calls.push('commit');
    return 'fix: ISSUE-1 did the thing';
  },
  enablePush: (_runDir, originUrl) => calls.push(`enablePush ${originUrl}`),
  pushBranch: () => calls.push('push'),
  createPr: () => {
    calls.push('createPr');
    return PR_URL;
  },
  checkOffAcceptanceCriteria: () => calls.push('checkOff'),
  postTestEvidenceComment: (_ctx, evidence) => calls.push({ evidence }),
  removeRunDirIfExists: () => calls.push('cleanup'),
  ...overrides,
});

const publish = (ops) =>
  publishChanges(CTX, { runDir: 'dir', chosen: CHOSEN, verdict: VERDICT, branchName: 'task/ISSUE-1-example', baseRef: 'origin/trunk', finalOutput: SELF_REPORT_FULL(2) }, ops);

test('checks off criteria and posts evidence after createPr', () => {
  const calls = [];
  const result = publish(publishOps(calls));
  assert.deepEqual(result, { status: 'done', pr: PR_URL });
  const names = calls.map((call) => (typeof call === 'string' ? call : 'evidence'));
  assert.deepEqual(names, ['commit', 'enablePush origin-url', 'push', 'createPr', 'checkOff', 'evidence', 'cleanup']);
  assert.equal(calls.find((call) => typeof call !== 'string').evidence.pr, PR_URL);
});

test('skips side effects when createPr fails', () => {
  const calls = [];
  const result = publish(
    publishOps(calls, {
      createPr: () => {
        throw new Error('gh pr create failed');
      },
    }),
  );
  assert.equal(result.status, 'pr_failed');
  assert.ok(!calls.includes('checkOff'));
  assert.ok(!calls.some((call) => typeof call !== 'string'));
  assert.ok(!calls.includes('cleanup'));
});

test('skips side effects when push fails', () => {
  const calls = [];
  const result = publish(
    publishOps(calls, {
      pushBranch: () => {
        throw new Error('rejected');
      },
    }),
  );
  assert.equal(result.status, 'push_failed');
  assert.ok(!calls.includes('createPr'));
  assert.ok(!calls.includes('checkOff'));
});

test('keeps the done result when the evidence comment fails', () => {
  const calls = [];
  const result = publish(
    publishOps(calls, {
      postTestEvidenceComment: () => {
        throw new Error('gh comment failed');
      },
    }),
  );
  assert.deepEqual(result, { status: 'done', pr: PR_URL });
});

// --- runIssue: prepare steps ---

/** @type {(...args: any[]) => any} */
const runOps = (calls, overrides = {}) => ({
  listRemoteBranches: () => {
    calls.push('listRemoteBranches');
    return ['trunk', 'task/ISSUE-2-other'];
  },
  prepareClone: () => calls.push('prepareClone'),
  assertBaseProfile: () => calls.push('assertBaseProfile'),
  defaultBranchOf: () => {
    calls.push('defaultBranchOf');
    return 'trunk';
  },
  createTaskBranch: (_runDir, branch, base) => calls.push(`createTaskBranch ${branch} ${base}`),
  startProxy: () => {
    calls.push('startProxy');
    return { network: 'net', proxyUrl: 'http://proxy', stop: () => calls.push('stopProxy') };
  },
  createSandboxGateRunner: () => () => 'ok',
  installDependencies: () => calls.push('installDependencies'),
  listInstalledSkillNames: () => ['js-conventions', 'js-gof', 'js-data-structures', 'error-handling', 'modern-javascript'],
  writeAgentPermissions: () => calls.push('writeAgentPermissions'),
  runIssueInClone: async () => {
    calls.push('runIssueInClone');
    return { status: 'done', pr: PR_URL };
  },
  ...overrides,
});

const unitContext = (t) => runContext(t, { consumerRoot: 'consumer', origin: 'origin', profile: controllerProfile(t, 'monorepo') });

test('writes agent permissions after installing dependencies', async (t) => {
  const calls = [];
  await runIssue(unitContext(t), new Map(), CHOSEN, runOps(calls));
  assert.ok(calls.includes('createTaskBranch task/ISSUE-1-example origin/trunk'));
  assert.ok(calls.indexOf('installDependencies') > calls.indexOf('startProxy'));
  assert.ok(calls.indexOf('writeAgentPermissions') > calls.indexOf('installDependencies'));
  assert.ok(calls.indexOf('runIssueInClone') > calls.indexOf('writeAgentPermissions'));
  assert.equal(calls[calls.length - 1], 'stopProxy');
});

test('stops with branch_exists when a task branch of the issue is on the remote', async (t) => {
  const calls = [];
  const ops = runOps(calls, { listRemoteBranches: () => ['task/ISSUE-1-an-older-title'] });
  const result = await runIssue(unitContext(t), new Map(), CHOSEN, ops);
  assert.equal(result.status, 'branch_exists');
  assert.match(result.reason, /task\/ISSUE-1-an-older-title/);
  assert.deepEqual(calls, []);
});

test('reports a template that cannot name the issue branch as prepare_failed', async (t) => {
  const calls = [];
  const ctx = unitContext(t);
  ctx.profile = { ...ctx.profile, branchTemplate: 'ISSUE-{issue}{slug}' };
  const result = await runIssue(ctx, new Map(), { ...CHOSEN, title: '2FA support' }, runOps(calls));
  assert.equal(result.status, 'prepare_failed');
  assert.match(result.error, /branchTemplate/);
  assert.deepEqual(calls, []);
});

test('reports prepare_failed when the remote branch lookup fails', async (t) => {
  const calls = [];
  const ops = runOps(calls, {
    listRemoteBranches: () => {
      throw new Error('network down');
    },
  });
  const result = await runIssue(unitContext(t), new Map(), CHOSEN, ops);
  assert.equal(result.status, 'prepare_failed');
  assert.ok(!calls.includes('prepareClone'));
});

// --- runIssue end to end on neutral consumers ---

for (const fixture of FIXTURE_PROFILES) {
  test(`preserves reference controller behaviour (${fixture})`, async (t) => {
    const run = await scenario(t, fixture);
    const steps = ['implement', 'self-review', 'code-review', 'final-gate'].map((name) => ({ name, outcome: 'passed' }));
    assert.deepEqual(run.result, { status: 'done', pr: 'https://example.invalid/pr/1', steps });
    const branch = 'task/ISSUE-7-neutral-change';
    assert.deepEqual(originBranches(run.origin).sort(), [branch, 'trunk']);
    assert.equal(gitIn(run.origin, 'log', '-1', '--format=%s', branch), 'feat: ISSUE-7 add the value');
    assert.deepEqual(gitIn(run.origin, 'show', '--name-only', '--format=', branch).split('\n'), [APP_FILE[fixture]]);
    const pr = run.prs[0].args;
    assert.equal(pr[pr.indexOf('--base') + 1], 'trunk');
    assert.equal(pr[pr.indexOf('--head') + 1], branch);
    assert.deepEqual(run.box.agents.map((a) => a.pass), ['implement', 'self-review', 'code-review']);
    assert.ok(run.gh.mutations.some((m) => m.kind === 'edit' && m.args.includes('--body')), 'acceptance boxes checked off');
    assert.equal(run.comments.length, 1);
    assert.match(run.comments[0].body, /TYPE: feat/);
    assert.equal(run.labelsSet.length, 0);
    const gates = run.box.runs.filter((r) => r.spec.network === 'none');
    assert.ok(gates.length > 0, 'final gate ran');
    assert.equal(fs.existsSync(run.box.agents[0].spec.runDir), false, 'run dir removed after the PR');
  });

  test(`blocks protected path changes (${fixture})`, async (t) => {
    for (const target of ['scripts/tool.js', 'deep/area/key.secret', 'Scripts/other.js']) {
      const run = await scenario(t, fixture, {
        mutate: (profile) => profile.protectedPaths.push('**/*.secret'),
        onAgent: defaultAgent(fixture, {
          implement: ({ runDir }) => {
            writeFiles(runDir, { [target]: 'x\n' });
            return done('feat', 'x');
          },
        }),
      });
      assert.equal(run.result.status, 'blocked', target);
      assert.match(run.result.reason, /protected paths/);
      assert.equal(run.prs.length, 0, target);
      assert.ok(run.labelsSet.includes(BLOCK_LABEL));
      t.mock.restoreAll();
    }
  });

  test(`blocks when profile-required skill is missing (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, { onRun: () => okResult() });
    assert.equal(run.result.status, 'blocked');
    assert.match(run.result.reason, /js-conventions/);
    assert.equal(run.box.agents.length, 0, 'agent not started');
    assert.deepEqual(run.labelsSet, [BLOCK_LABEL]);
    assert.equal(run.prs.length, 0);
  });

  test(`sets human-decision label from profile (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      onAgent: defaultAgent(fixture, { implement: () => `thinking\n${HUMAN_VERDICT}: the schema needs an owner decision` }),
    });
    assert.equal(run.result.status, 'blocked');
    assert.equal(run.result.humanNeeded, true);
    assert.deepEqual(run.labelsSet.sort(), [BLOCK_LABEL, HUMAN_LABEL].sort());
    assert.match(run.comments[0].body, /owner decision/);
    assert.equal(run.prs.length, 0);
  });

  test(`preserves implementation result and review fix summaries (${fixture})`, async (t) => {
    const reviews = { 'self-review': ['REVIEW: FAIL: a.ts misses a check', 'REVIEW: PASS'], 'code-review': ['CODEREVIEW: FAIL: a.ts duplicates code', 'CODEREVIEW: PASS'] };
    const run = await scenario(t, fixture, {
      onAgent: ({ pass, runDir }) => {
        if (reviews[pass]) return reviews[pass].shift();
        const file = APP_FILE[fixture];
        if (pass === 'implement') {
          writeFiles(runDir, { [file]: 'export const value = 1;\n' });
          return done('feat', 'add the value', '=== ACCEPTANCE CRITERIA SELF-REPORT ===\n1. COVERED: x\n2. NOT VERIFIED: y\n=== END ACCEPTANCE CRITERIA SELF-REPORT ===');
        }
        fs.appendFileSync(path.join(runDir, file), `// ${pass}\n`);
        return done('fix', `${pass} summary`, SELF_REPORT_FULL(2));
      },
    });
    assert.equal(run.result.status, 'done');
    const branch = 'task/ISSUE-7-neutral-change';
    assert.equal(gitIn(run.origin, 'log', '-1', '--format=%s', branch), 'feat: ISSUE-7 add the value');
    const pr = run.prs[0].args;
    assert.equal(pr[pr.indexOf('--title') + 1], 'feat: ISSUE-7 add the value');
    const comment = run.comments[0].body;
    assert.match(comment, /SUMMARY: add the value/);
    assert.match(comment, /Review fixes applied after the initial DONE:\*\*\n1\. review-fix summary\n2\. code-review-fix summary/);
    assert.match(comment, /все пункты покрыты, чек-боксы отмечены/, 'acceptance report from the last fix');
    assert.deepEqual(run.box.agents.map((a) => a.pass), ['implement', 'self-review', 'review-fix', 'self-review', 'code-review', 'code-review-fix', 'code-review']);
    assert.deepEqual(run.result.steps.map((s) => s.outcome), ['passed', 'passed', 'passed', 'passed']);
  });

  test(`omits fix summaries when review passed (${fixture})`, async (t) => {
    const run = await scenario(t, fixture);
    assert.equal(run.result.status, 'done');
    assert.doesNotMatch(run.comments[0].body, /Review fixes applied/);
  });

  test(`always applies sandbox policy to executable phases (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      mutate: (profile) => {
        profile.install = [{ argv: ['tool', 'install'], cwd: '.' }];
      },
    });
    assert.equal(run.result.status, 'done');
    for (const agent of run.box.agents) {
      assert.equal(agent.spec.readOnlyGit, true);
      assert.equal(agent.spec.network, 'run-net');
      assert.equal(agent.spec.proxyUrl, 'http://proxy:3128');
    }
    const installs = run.box.runs.filter((r) => r.spec.network !== 'none');
    const gates = run.box.runs.filter((r) => r.spec.network === 'none');
    assert.ok(installs.length > 0 && gates.length > 0);
    for (const { spec } of installs) {
      assert.equal(spec.readOnlyGit, true);
      assert.equal(spec.network, 'run-net');
      assert.equal(spec.proxyUrl, 'http://proxy:3128');
    }
    for (const { spec } of gates) {
      assert.equal(spec.readOnlyGit, true);
      assert.equal(spec.proxyUrl, undefined);
    }
    assert.ok(!run.calls.some((call) => call.file !== 'git' && call.file !== 'gh'), 'Docker only through the runtime');
  });

  test(`applies sandbox install env only to install phase (${fixture})`, async (t) => {
    const manifest = fixture === 'monorepo' ? 'packages/billing/package.json' : 'package.json';
    const run = await scenario(t, fixture, {
      files: { [manifest]: '{"name":"x","dependencies":{}}\n' },
      issue: issueWith(7, [APP_FILE[fixture], manifest]),
      mutate: (profile) => {
        profile.sandbox.installEnv = { NEUTRAL_INSTALL_FLAG: 'on' };
        profile.install = [{ argv: ['tool', 'install'], cwd: '.' }];
        profile.apps[0].dependencySync = [{ argv: ['tool', 'sync'], cwd: profile.apps[0].path }];
      },
      onAgent: defaultAgent(fixture, {
        implement: ({ runDir }) => {
          writeFiles(runDir, { [APP_FILE[fixture]]: 'export {};\n', [manifest]: '{"name":"x","dependencies":{"dep":"1.0.0"}}\n' });
          return done('feat', 'add dep');
        },
      }),
    });
    assert.equal(run.result.status, 'done', JSON.stringify(run.result));
    const syncs = run.box.runs.filter((r) => r.spec.command.join(' ') === 'tool sync');
    const installs = run.box.runs.filter((r) => r.spec.command.join(' ') === 'tool install');
    assert.equal(syncs.length, 1);
    for (const { spec } of [...syncs, ...installs]) assert.equal(spec.publicEnv.NEUTRAL_INSTALL_FLAG, 'on');
    for (const { spec } of run.box.runs.filter((r) => r.spec.network === 'none')) assert.equal(spec.publicEnv.NEUTRAL_INSTALL_FLAG, undefined);
    for (const agent of run.box.agents) {
      assert.equal((agent.spec.publicEnv || {}).NEUTRAL_INSTALL_FLAG, undefined);
      assert.equal((agent.spec.env || {}).NEUTRAL_INSTALL_FLAG, undefined);
    }
  });

  test(`blocks without sandbox and never falls back to host (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, { proxy: false });
    assert.equal(run.result.status, 'prepare_failed');
    assert.match(run.result.error, /Docker is not available/);
    assert.equal(run.box.agents.length, 0);
    assert.equal(run.box.runs.length, 0, 'no install and no gate');
    assert.equal(run.prs.length, 0);
    assert.ok(!run.calls.some((call) => call.file !== 'git' && call.file !== 'gh'), 'nothing ran on the host');
  });
}

// --- trusted profile: the selected base is checked against the host snapshot ---

const reverseKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]));
};

const PROFILE_FILE = '.factory/profile.json';
const nothingExecuted = (run) => {
  assert.deepEqual(run.box.proxies, [], 'no proxy');
  assert.equal(run.box.runs.length, 0, 'no install and no gate');
  assert.equal(run.box.agents.length, 0, 'no agent');
  assert.equal(run.prs.length, 0, 'no PR');
  assert.deepEqual(run.gh.mutations, [], 'no GitHub change');
  assert.deepEqual(originBranches(run.origin), ['trunk'], 'nothing pushed');
};

test('checks the base profile after checkout and before the proxy', async (t) => {
  const calls = [];
  await runIssue(unitContext(t), new Map(), CHOSEN, runOps(calls));
  assert.ok(calls.indexOf('assertBaseProfile') > calls.indexOf('createTaskBranch task/ISSUE-1-example origin/trunk'));
  assert.ok(calls.indexOf('assertBaseProfile') < calls.indexOf('startProxy'));
});

for (const fixture of FIXTURE_PROFILES) {
  test(`accepts semantically equal base profile (${fixture})`, async (t) => {
    const host = controllerProfile(t, fixture);
    const reordered = JSON.stringify(reverseKeys(host), null, 4);
    assert.notEqual(reordered, JSON.stringify(host));
    const stacked = await scenario(t, fixture, { baseProfile: reordered });
    assert.equal(stacked.result.status, 'done', JSON.stringify(stacked.result));
    t.mock.restoreAll();

    // The base chosen from a dependency's task branch is the one that is compared.
    const issue = { ...issueWith(7, [APP_FILE[fixture]]), dependsOn: [2] };
    const dependent = await scenario(t, fixture, {
      issue,
      entries: [{ id: 2, title: 'Dep', dependsOn: [], status: 'in-flight' }],
      prepareOrigin: (origin) => pushBranch(t, origin, 'task/ISSUE-2-dep', { [PROFILE_FILE]: reordered }),
    });
    assert.equal(dependent.result.status, 'done', JSON.stringify(dependent.result));
    const pr = dependent.prs[0].args;
    assert.equal(pr[pr.indexOf('--base') + 1], 'task/ISSUE-2-dep');
  });

  test(`rejects missing base profile before execution (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, { baseProfile: null });
    assert.equal(run.result.status, 'prepare_failed');
    assert.match(run.result.error, /Profile not found: expected .*profile\.json/);
    assert.ok(run.result.error.includes(run.consumerRoot), 'names the host');
    assert.ok(run.result.error.includes(run.result.runDir), 'names the clone');
    assert.ok(run.result.error.includes('origin/trunk'), 'names the base');
    nothingExecuted(run);
  });

  test(`rejects invalid base profile before execution (${fixture})`, async (t) => {
    const broken = [JSON.stringify({ ...controllerProfile(t, fixture), branchTemplate: 7 }), '{ not json'];
    for (const baseProfile of broken) {
      const run = await scenario(t, fixture, { baseProfile });
      assert.equal(run.result.status, 'prepare_failed');
      assert.match(run.result.error, /Invalid profile [\s\S]*branchTemplate|is not valid JSON/);
      assert.ok(run.result.error.includes('origin/trunk'));
      nothingExecuted(run);
      t.mock.restoreAll();
    }
  });

  test(`blocks profile changes independently of project protections (${fixture})`, async (t) => {
    const changes = {
      edit: (runDir) => fs.appendFileSync(path.join(runDir, PROFILE_FILE), '\n'),
      delete: (runDir) => fs.rmSync(path.join(runDir, PROFILE_FILE)),
    };
    for (const [kind, change] of Object.entries(changes)) {
      let denied = [];
      const run = await scenario(t, fixture, {
        mutate: (profile) => {
          profile.protectedPaths = (profile.protectedPaths || []).filter((pattern) => !pattern.includes('factory'));
        },
        issue: issueWith(7, [APP_FILE[fixture], PROFILE_FILE]),
        onAgent: defaultAgent(fixture, {
          implement: ({ runDir }) => {
            denied = JSON.parse(fs.readFileSync(path.join(runDir, '.claude', 'settings.local.json'), 'utf8')).permissions.deny;
            writeFiles(runDir, { [APP_FILE[fixture]]: 'export {};\n' });
            change(runDir);
            return done('feat', 'x');
          },
        }),
      });
      assert.ok(denied.includes(`Edit(${PROFILE_FILE})`) && denied.includes(`Write(${PROFILE_FILE})`), `${kind}: permissions deny the profile`);
      assert.equal(run.result.status, 'blocked', kind);
      assert.match(run.result.reason, /protected paths: .*\.factory\/profile\.json/);
      assert.deepEqual(run.box.agents.map((agent) => agent.pass), ['implement'], 'no next step');
      assert.equal(run.prs.length, 0);
      assert.deepEqual(originBranches(run.origin), ['trunk'], 'no push');
      t.mock.restoreAll();
    }
  });
}
