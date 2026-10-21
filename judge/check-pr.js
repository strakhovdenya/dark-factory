'use strict';

const { issueNumberOfBranch } = require('../profile/branch');

// Every question Judge asks about a task branch is answered with the profile's
// full branchTemplate (profile/branch.js): whether a PR is a task PR, which
// issue it belongs to, and which open PR belongs to a labeled issue.

const isPresent = (value) => value !== undefined && value !== null && value !== '';

/** The issue number of a task branch, or null when the branch is not one. */
const issueOfBranch = (branchTemplate, branch) =>
  typeof branch === 'string' ? issueNumberOfBranch(branchTemplate, branch) : null;

/**
 * The open pull request of a task branch of `repository` for `issue`, or null.
 * `pulls` is the list of open pull requests as the API returns them.
 */
const findPullRequest = (pulls, { repository, branchTemplate, issue }) => {
  const found = pulls.filter(
    (pull) =>
      pull?.head?.repo?.full_name === repository &&
      issueOfBranch(branchTemplate, pull.head.ref) === issue,
  );
  // Two open task PRs for one issue: which one the label means is unknown, so none is chosen.
  return found.length === 1 ? found[0].number : null;
};

/**
 * Decides whether a round may be analysed for a pull request. A verifier run
 * started by workflow_run carries the default branch in its own metadata, so
 * the PR and head commit come from the round's artifacts
 * (round = { pr_number, head_sha }) and are matched against the PR
 * (pull = { number, head_ref, head_repo, commit_shas }). Fails closed: a round
 * without a head commit, or with no way to tie it to the PR, is rejected.
 */
const checkPullRequest = (pull, round, { repository, branchTemplate }) => {
  const reject = (reason) => ({ ok: false, reason });
  const number = pull?.number;
  if (!isPresent(number)) return reject('pull request data is missing');
  if (pull.head_repo !== repository) {
    return reject(`PR #${number} is not from ${repository}`);
  }
  if (issueOfBranch(branchTemplate, pull.head_ref) === null) {
    return reject(`PR #${number} is not on a task branch (${branchTemplate})`);
  }
  const headSha = round?.head_sha;
  if (!isPresent(headSha)) return reject('round has no head commit');
  const roundPr = round.pr_number;
  if (isPresent(roundPr)) {
    return String(roundPr) === String(number)
      ? { ok: true, reason: null }
      : reject(`round belongs to PR #${roundPr}, not PR #${number}`);
  }
  const shas = Array.isArray(pull.commit_shas) ? pull.commit_shas : [];
  return shas.includes(headSha)
    ? { ok: true, reason: null }
    : reject(`round head ${headSha} is not a commit of PR #${number}`);
};

module.exports = { issueOfBranch, findPullRequest, checkPullRequest };
