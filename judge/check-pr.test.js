'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadProfile } = require('../profile/load');
const { issueOfBranch, findPullRequest, checkPullRequest } = require('./check-pr');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');

const REPOSITORY = 'owner/project';
const HEAD = 'a'.repeat(40);
const CUSTOM_TEMPLATE = 'work/{issue}/{slug}';

const templateOf = (t, fixture, template) =>
  loadProfile(
    profileCopy(t, fixture, (profile) => {
      if (template !== undefined) profile.branchTemplate = template;
    }),
  ).branchTemplate;

const pull = (headRef, overrides = {}) => ({
  number: 7,
  head_ref: headRef,
  head_repo: REPOSITORY,
  commit_shas: [HEAD],
  ...overrides,
});

const round = (overrides = {}) => ({ pr_number: 7, head_sha: HEAD, ...overrides });

test('rejects branch not matching profile template', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const branchTemplate = templateOf(t, fixture, CUSTOM_TEMPLATE);
    for (const branch of ['task/ISSUE-12-name', 'work/x/name', 'work/12', 'main', '']) {
      const result = checkPullRequest(pull(branch), round(), {
        repository: REPOSITORY,
        branchTemplate,
      });
      assert.strictEqual(result.ok, false, `${fixture} ${branch}`);
      assert.match(result.reason, /not on a task branch/);
    }
  }
});

test('accepts a branch of the profile template tied to the round', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const branchTemplate = templateOf(t, fixture);
    const branch = branchTemplate.replace('{issue}', '12').replace('{slug}', 'name');
    const options = { repository: REPOSITORY, branchTemplate };
    assert.deepStrictEqual(checkPullRequest(pull(branch), round(), options), {
      ok: true,
      reason: null,
    });
    const byCommit = checkPullRequest(pull(branch), round({ pr_number: null }), options);
    assert.strictEqual(byCommit.ok, true);
  }
});

test('fails closed on foreign repository, missing head and unrelated round', (t) => {
  const branchTemplate = templateOf(t, 'single-package');
  const branch = 'task/ISSUE-3-x';
  const options = { repository: REPOSITORY, branchTemplate };
  const cases = [
    { candidate: pull(branch, { head_repo: 'someone/fork' }), roundMeta: round(), reason: /is not from/ },
    { candidate: pull(branch), roundMeta: round({ head_sha: null }), reason: /no head commit/ },
    { candidate: pull(branch), roundMeta: round({ pr_number: 8 }), reason: /belongs to PR #8/ },
    {
      candidate: pull(branch),
      roundMeta: round({ pr_number: null, head_sha: 'c'.repeat(40) }),
      reason: /not a commit/,
    },
    { candidate: null, roundMeta: round(), reason: /pull request data is missing/ },
  ];
  for (const { candidate, roundMeta, reason } of cases) {
    const result = checkPullRequest(candidate, roundMeta, options);
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, reason);
  }
});

test('uses full profile template across all issue lookup paths', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const branchTemplate = templateOf(t, fixture, CUSTOM_TEMPLATE);
    assert.strictEqual(issueOfBranch(branchTemplate, 'work/42/some-name'), 42);
    assert.strictEqual(issueOfBranch(branchTemplate, 'task/ISSUE-42-some-name'), null);
    assert.strictEqual(issueOfBranch(branchTemplate, undefined), null);

    const options = { repository: REPOSITORY, branchTemplate };
    const pulls = [
      { number: 1, head: { ref: 'work/41/other', repo: { full_name: REPOSITORY } } },
      { number: 2, head: { ref: 'work/42/mine', repo: { full_name: 'someone/fork' } } },
      { number: 3, head: { ref: 'task/ISSUE-42-old', repo: { full_name: REPOSITORY } } },
      { number: 4, head: { ref: 'work/42/mine', repo: { full_name: REPOSITORY } } },
    ];
    assert.strictEqual(findPullRequest(pulls, { ...options, issue: 42 }), 4);
    assert.strictEqual(findPullRequest(pulls, { ...options, issue: 41 }), 1);
    assert.strictEqual(findPullRequest(pulls, { ...options, issue: 43 }), null);

    const taken = checkPullRequest(pull('work/42/mine'), round(), options);
    assert.strictEqual(taken.ok, true, fixture);
  }
});

test('no pull request is chosen when two match the labeled issue', (t) => {
  const branchTemplate = templateOf(t, 'monorepo');
  const pulls = [
    { number: 1, head: { ref: 'task/ISSUE-9-a', repo: { full_name: REPOSITORY } } },
    { number: 2, head: { ref: 'task/ISSUE-9-b', repo: { full_name: REPOSITORY } } },
  ];
  assert.strictEqual(findPullRequest(pulls, { repository: REPOSITORY, branchTemplate, issue: 9 }), null);
  assert.strictEqual(findPullRequest(pulls.slice(1), { repository: REPOSITORY, branchTemplate, issue: 9 }), 2);
});
