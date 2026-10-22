'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const github = require('./github');
const workspace = require('./workspace');
const { summarizeStatuses } = require('./run');
const { BLOCK_LABEL } = require('./config');
const { hash, marker, APPROVAL_AUTHOR } = require('../verifier/spec-hash');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const { HUMAN_LABEL, isolateGit, gitIn, makeConsumer, controllerProfile, mockGh, fakeGitHub, tempDir, writeFiles } = require('../test/helpers/ralph');

const { classify, issueState, listPrHeadBranches, resolveBaseRef, reviewDiff, git, EXEC_OPTIONS, SPEC_APPROVED_LABEL } = github;

const BASE_BODY = '## Acceptance Criteria\n\n- [ ] AC-1 do the thing\n';
const approvalComment = (body) => ({ user: { login: APPROVAL_AUTHOR }, body: `${marker(hash(body))}\nSpec approved by owner.\n` });
const APPROVED = { labels: [{ name: SPEC_APPROVED_LABEL }], comments: [approvalComment(BASE_BODY)] };

const issueFixture = ({ state = 'OPEN', labels = [], body = BASE_BODY, comments = [], title = 'Example issue', number = 1 } = {}) => ({ number, title, body, url: 'https://example.invalid/issues/1', state, labels, comments });

const PROFILE = { branchTemplate: 'task/ISSUE-{issue}-{slug}', labels: { humanNeeded: HUMAN_LABEL }, ralph: { techDebtTrackerIssue: 99 } };
const ctxOf = (issues, profile = PROFILE) => ({ consumerRoot: 'consumer', profile, issues });
const classifyOne = (info, deps = {}) => classify(ctxOf([{ id: 1, dependsOn: [] }]), { getIssueState: () => info, listPrBranches: () => [], ...deps })[0];

test('classify marks issue without spec-approved label as unapproved', () => {
  const entry = classifyOne(issueFixture({ comments: [approvalComment(BASE_BODY)] }));
  assert.equal(entry.status, 'unapproved');
  assert.match(entry.unapprovedReason, new RegExp(SPEC_APPROVED_LABEL));
});

test('classify marks issue without approval comment as unapproved', () => {
  const entry = classifyOne(issueFixture({ labels: [{ name: SPEC_APPROVED_LABEL }] }));
  assert.equal(entry.status, 'unapproved');
  assert.ok(entry.unapprovedReason.includes(APPROVAL_AUTHOR));
});

test('classify marks issue with stale approval hash as unapproved', () => {
  const entry = classifyOne(issueFixture({ ...APPROVED, body: `${BASE_BODY}extra paragraph added after approval\n` }));
  assert.equal(entry.status, 'unapproved');
  assert.match(entry.unapprovedReason, /хеш/);
});

test('classify marks issue with valid approval as not-started, also after boxes are ticked', () => {
  assert.equal(classifyOne(issueFixture(APPROVED)).status, 'not-started');
  assert.equal(classifyOne(issueFixture({ ...APPROVED, body: BASE_BODY.replace('[ ]', '[x]') })).status, 'not-started');
});

test('classify does not look up PRs for a closed issue', () => {
  const entry = classifyOne(issueFixture({ state: 'CLOSED' }), {
    listPrBranches: () => {
      throw new Error('must not be called for a closed issue');
    },
  });
  assert.equal(entry.status, 'done');
});

test('classify marks issue with non-bot approval comment as unapproved', () => {
  const comments = [{ user: { login: 'some-user' }, body: `${marker(hash(BASE_BODY))}\n` }];
  assert.equal(classifyOne(issueFixture({ labels: [{ name: SPEC_APPROVED_LABEL }], comments })).status, 'unapproved');
});

// Shapes as gh returns them: `gh issue view --json` has no comments, the REST comments endpoint
// prints one `{user: {login}, body}` object per line.
const fakeGhRun = ({ comments, failApi = false, labels = [{ name: SPEC_APPROVED_LABEL }] }) => {
  const view = { number: 1, title: 'Example issue', body: BASE_BODY, url: 'https://example.invalid/issues/1', state: 'OPEN', labels };
  return (args) => {
    if (args[0] === 'issue') return JSON.stringify(view);
    if (failApi) throw new Error('gh api failed');
    return comments.map((comment) => JSON.stringify(comment)).join('\n');
  };
};

test('issueState reads approval comments through the REST endpoint in the consumer root', () => {
  const calls = [];
  const run = fakeGhRun({ comments: [approvalComment(BASE_BODY)] });
  const info = issueState('consumer', 7, (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    return run(args);
  });
  assert.deepEqual(calls[1].args.slice(0, 3), ['api', '--paginate', 'repos/{owner}/{repo}/issues/7/comments']);
  assert.ok(calls.every((call) => call.cwd === 'consumer'));
  assert.equal(classifyOne(info).status, 'not-started');
});

test('issueState rejects a login without the bot suffix and fails closed', () => {
  const info = issueState('consumer', 1, fakeGhRun({ comments: [{ user: { login: 'github-actions' }, body: `${marker(hash(BASE_BODY))}\n` }] }));
  assert.equal(classifyOne(info).status, 'unapproved');
  assert.equal(issueState('consumer', 1, fakeGhRun({ comments: [], failApi: true })), null);
});

test('issueState skips the comments request for an issue without the approval label', () => {
  const calls = [];
  const run = fakeGhRun({ comments: [], failApi: true, labels: [] });
  const info = issueState('consumer', 1, (args) => {
    calls.push(args);
    return run(args);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(info.comments, []);
});

for (const fixture of FIXTURE_PROFILES) {
  test(`excludes blocked issues from later runs (${fixture})`, (t) => {
    const profile = controllerProfile(t, fixture);
    const infos = {
      1: issueFixture({ ...APPROVED, number: 1, labels: [...APPROVED.labels, { name: BLOCK_LABEL }] }),
      2: issueFixture({ ...APPROVED, number: 2, labels: [...APPROVED.labels, { name: HUMAN_LABEL }] }),
      3: issueFixture({ ...APPROVED, number: 3 }),
      4: issueFixture({ ...APPROVED, number: 4 }),
      5: issueFixture({ ...APPROVED, number: 5, labels: [...APPROVED.labels, { name: `${BLOCK_LABEL}-old` }] }),
    };
    const issues = [
      { id: 1, dependsOn: [] },
      { id: 2, dependsOn: [] },
      { id: 3, dependsOn: [1] },
      { id: 4, dependsOn: [] },
      { id: 5, dependsOn: [] },
    ];
    const statuses = classify({ consumerRoot: 'consumer', profile, issues }, { getIssueState: (id) => infos[id], listPrBranches: () => [] });
    assert.deepEqual(statuses.map((s) => s.status), ['blocked', 'blocked', 'blocked-by-dependency', 'not-started', 'not-started']);
    assert.deepEqual(summarizeStatuses(statuses, new Set()).ready.map((s) => s.id), [4, 5]);

    const gh = fakeGitHub();
    mockGh(t, gh.onGh);
    const ctx = { consumerRoot: tempDir(t), profile };
    github.postBlockedComment(ctx, 4, 'plain block');
    github.postBlockedComment(ctx, 5, 'human decision', { humanNeeded: true });
    const labelsOf = (issue) => gh.mutations.filter((m) => m.kind === 'label' && m.issue === String(issue)).map((m) => m.label);
    assert.deepEqual(labelsOf(4), [BLOCK_LABEL]);
    assert.deepEqual(labelsOf(5), [BLOCK_LABEL, HUMAN_LABEL]);
  });
}

test('finds existing branch and PR after title change', () => {
  const info = issueFixture({ ...APPROVED, title: 'A brand new title' });
  const entry = classifyOne(info, { listPrBranches: () => ['task/ISSUE-12-x', 'task/ISSUE-1-the-old-title', 'other'] });
  assert.equal(entry.status, 'in-flight');
  assert.equal(classifyOne(info, { listPrBranches: () => ['task/ISSUE-11-x', 'task/ISSUE-1'] }).status, 'not-started');

  const calls = [];
  const branches = listPrHeadBranches('consumer', (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    return 'task/ISSUE-1-the-old-title\nfeature\n';
  });
  assert.deepEqual(branches, ['task/ISSUE-1-the-old-title', 'feature']);
  assert.ok(calls[0].args.join(' ').includes('state=all'), 'PRs in any state');
  assert.equal(calls[0].cwd, 'consumer');
  assert.deepEqual(github.branchesOfIssue(branches, PROFILE.branchTemplate, 1), ['task/ISSUE-1-the-old-title']);
});

test('does not select issue when PR lookup fails', () => {
  const lookups = [];
  const statuses = classify(ctxOf([{ id: 1, dependsOn: [] }, { id: 2, dependsOn: [] }]), {
    getIssueState: (id) => issueFixture({ ...APPROVED, number: id }),
    listPrBranches: () => {
      lookups.push('pr');
      throw new Error('gh unavailable');
    },
  });
  assert.deepEqual(statuses.map((s) => s.status), ['unknown', 'unknown']);
  assert.ok(statuses.every((s) => s.ready !== true));
  assert.deepEqual(summarizeStatuses(statuses, new Set()).ready, []);
});

test('branches from repository default branch', (t) => {
  isolateGit(t);
  const profile = controllerProfile(t, 'single-package');
  const { origin, consumerRoot } = makeConsumer(t, { defaultBranch: 'trunk' });
  const runsRoot = path.join(tempDir(t), 'runs');
  const runDir = workspace.runDirFor(runsRoot, 2);
  workspace.prepareClone(runsRoot, runDir, github.originUrlOf(consumerRoot));
  const defaultBranch = github.defaultBranchOf(runDir);
  assert.equal(defaultBranch, 'trunk');

  const independent = { id: 2, dependsOn: [] };
  const byId = new Map([[5, { id: 5, status: 'in-flight', title: 'Dep title' }], [6, { id: 6, status: 'done', title: 'Merged' }]]);
  const independentBase = resolveBaseRef(profile, byId, independent, defaultBranch);
  assert.equal(independentBase, 'origin/trunk');
  assert.equal(resolveBaseRef(profile, byId, { id: 3, dependsOn: [6] }, defaultBranch), 'origin/trunk');
  assert.equal(resolveBaseRef(profile, byId, { id: 4, dependsOn: [5] }, defaultBranch), 'origin/task/ISSUE-5-dep-title');
  const remote = ['trunk', 'task/ISSUE-50-x', 'task/ISSUE-5-title-before-rename'];
  assert.equal(resolveBaseRef(profile, byId, { id: 4, dependsOn: [5] }, defaultBranch, remote), 'origin/task/ISSUE-5-title-before-rename', 'the existing branch of the dependency');

  workspace.createTaskBranch(runDir, 'task/ISSUE-2-x', independentBase);
  assert.equal(gitIn(runDir, 'rev-parse', 'HEAD'), gitIn(origin, 'rev-parse', 'trunk'));

  const gh = fakeGitHub();
  const calls = mockGh(t, gh.onGh);
  github.createPr({ consumerRoot }, { id: 2 }, 'task/ISSUE-2-x', independentBase, 'feat: ISSUE-2 x');
  const pr = gh.mutations.find((m) => m.kind === 'pr').args;
  assert.equal(pr[pr.indexOf('--base') + 1], 'trunk');
  assert.equal(calls.find((c) => c.file === 'gh').cwd, consumerRoot);
});

test('git and gh calls of the controller need an explicit cwd', () => {
  const loose = /** @type {any} */ (github);
  assert.throws(() => loose.git(['status']), /explicit cwd/);
  assert.throws(() => loose.gh(['issue', 'list']), /explicit cwd/);
  assert.throws(() => loose.gitPorcelainStatus({}), /explicit cwd/);
});

const makeRepo = (t) => {
  isolateGit(t);
  const dir = tempDir(t);
  gitIn(dir, 'init', '-q');
  writeFiles(dir, { '.gitignore': 'ignored.txt\n', 'tracked.txt': 'one\n' });
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'init');
  return dir;
};

test('review diff includes untracked files and excludes ignored ones', (t) => {
  const dir = makeRepo(t);
  writeFiles(dir, { 'tracked.txt': 'two\n', 'brand-new.txt': 'fresh content\n', 'ignored.txt': 'secret\n' });
  const diff = reviewDiff(dir);
  assert.match(diff, /tracked\.txt/);
  assert.match(diff, /brand-new\.txt/);
  assert.match(diff, /fresh content/);
  assert.ok(!diff.includes('ignored.txt') && !diff.includes('secret'));
});

test('git helper returns output larger than 1 MiB', (t) => {
  const dir = makeRepo(t);
  const size = 2 * 1024 * 1024;
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(size));
  gitIn(dir, 'add', 'big.txt');
  gitIn(dir, 'commit', '-qm', 'big');
  assert.equal(git(['show', 'HEAD:big.txt'], { cwd: dir }).length, size);
  assert.ok(EXEC_OPTIONS.maxBuffer > size);
});

test('out-of-scope findings go to the profile tech-debt tracker', (t) => {
  const gh = fakeGitHub();
  mockGh(t, gh.onGh);
  github.postOutOfScopeNote({ consumerRoot: tempDir(t), profile: PROFILE }, 3, 'x.ts:1 — dup');
  assert.deepEqual(gh.mutations.map((m) => m.issue), ['99', '3']);
});
