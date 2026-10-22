'use strict';

// Every git and gh call of the controller. The agent never does any of these itself. Each call
// gets an explicit working directory: the consumer root for the repository (origin, PRs, labels,
// comments) or its run clone for the clone's own git state. The process's current directory and
// the directory of the installed package are never used.

const childProcess = require('node:child_process');
const { BLOCK_LABEL } = require('./config');
const { hash, findApproval, APPROVAL_AUTHOR } = require('../verifier/spec-hash');
const { branchNameFor, issueNumberOfBranch } = require('../profile/branch');
const { acceptanceSectionSpan } = require('./parsing');

// Label set by the spec-approval workflow once an authorized owner approves the current,
// normalized issue body.
const SPEC_APPROVED_LABEL = 'spec-approved';

// Three distinct reasons a spec can be unapproved — surfaced separately in the run summary.
const UNAPPROVED_REASON = {
  NO_LABEL: `нет лейбла ${SPEC_APPROVED_LABEL}`,
  NO_APPROVAL_COMMENT: `нет комментария одобрения ${APPROVAL_AUTHOR}`,
  STALE_HASH: 'хеш одобрения не совпадает с текущим телом issue',
};

// --- git/gh helpers ---

// Large diffs and `gh api` pages overflow execFileSync's 1 MiB default (ENOBUFS).
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const EXEC_OPTIONS = { encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES };

const execOptionsWith = (opts) => {
  if (!opts || typeof opts.cwd !== 'string' || opts.cwd === '') {
    throw new TypeError('git/gh calls of the controller need an explicit cwd (consumer root or run clone)');
  }
  return { ...EXEC_OPTIONS, ...opts };
};

/**
 * @param {string[]} args
 * @param {{ cwd: string, [option: string]: any }} opts
 */
function git(args, opts) {
  return String(childProcess.execFileSync('git', args, execOptionsWith(opts))).trim();
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, [option: string]: any }} opts
 */
function gh(args, opts) {
  return String(childProcess.execFileSync('gh', args, execOptionsWith(opts))).trim();
}

// Raw `git status --porcelain=v1 -z -uall`: NUL-separated, unquoted paths, renames as `XY new, NUL,
// old`, every untracked file listed individually. Not trimmed — the leading space of ` M path` is
// part of the status. fsmonitor is forced off: the clone's .git is untrusted input for the host.
/** @param {{ cwd: string }} opts */
function gitPorcelainStatus(opts) {
  return String(childProcess.execFileSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '-uall'], execOptionsWith(opts)));
}

// The diff the self-review sees: tracked changes plus new untracked files (intent-to-add), never
// ignored ones. Mutates only the clone's index, which the commit step stages in full anyway.
function reviewDiff(runDir) {
  git(['add', '-N', '.'], { cwd: runDir });
  return git(['diff', 'HEAD'], { cwd: runDir });
}

// --- repository of the consumer ---

function originUrlOf(consumerRoot) {
  return git(['remote', 'get-url', 'origin'], { cwd: consumerRoot });
}

// The default branch of the consumer repository as the clone recorded it from origin
// (refs/remotes/origin/HEAD). No setting and no fallback name: unresolved is an error.
function defaultBranchOf(runDir) {
  let ref;
  try {
    ref = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: runDir, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    throw new Error(`Cannot resolve the default branch of origin in ${runDir}: refs/remotes/origin/HEAD is not set (${error.message})`, { cause: error });
  }
  const prefix = 'refs/remotes/origin/';
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    throw new Error(`Cannot resolve the default branch of origin in ${runDir}: unexpected ref "${ref}"`);
  }
  return ref.slice(prefix.length);
}

const splitLines = (out) =>
  String(out)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

// Branch names on the consumer's origin, without cloning. A failure throws: unknown is not "absent".
function listRemoteBranches(consumerRoot) {
  return splitLines(git(['ls-remote', '--heads', 'origin'], { cwd: consumerRoot }))
    .map((line) => line.split(/\s+/)[1] || '')
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
}

// Head branches of every PR of the consumer repository, in any state (REST, all pages).
function listPrHeadBranches(consumerRoot, run = gh) {
  return splitLines(run(['api', '--paginate', 'repos/{owner}/{repo}/pulls?state=all&per_page=100', '--jq', '.[].head.ref'], { cwd: consumerRoot }));
}

// Branches that the profile's template recognizes as the given issue's, whatever slug the title
// had when they were created.
const branchesOfIssue = (branches, template, id) => branches.filter((name) => issueNumberOfBranch(template, name) === id);

// Comments come from the REST API, in the `{ user: { login }, body }` shape findApproval()
// expects — the same source the spec-approval workflow uses. One JSON object per line.
const COMMENT_FIELDS_JQ = '.[] | {user: {login: .user.login}, body: .body}';

const parseCommentLines = (out) => splitLines(out).map((line) => JSON.parse(line));

// Comments only matter for the approval check, which needs the label first, so an issue without
// the label costs one API call per loop iteration, not two.
function issueState(consumerRoot, id, run = gh) {
  try {
    const info = JSON.parse(run(['issue', 'view', String(id), '--json', 'number,title,body,url,state,labels'], { cwd: consumerRoot }));
    const hasApprovalLabel = (info.labels || []).some((label) => label.name === SPEC_APPROVED_LABEL);
    if (!hasApprovalLabel) return { ...info, comments: [] };
    const comments = parseCommentLines(run(['api', '--paginate', `repos/{owner}/{repo}/issues/${id}/comments`, '--jq', COMMENT_FIELDS_JQ], { cwd: consumerRoot }));
    return { ...info, comments };
  } catch {
    return null;
  }
}

function approvalStatus(info) {
  const hasLabel = (info.labels || []).some((label) => label.name === SPEC_APPROVED_LABEL);
  if (!hasLabel) return { approved: false, reason: UNAPPROVED_REASON.NO_LABEL };
  const approvedHash = findApproval(info.comments || []);
  if (approvedHash === null) return { approved: false, reason: UNAPPROVED_REASON.NO_APPROVAL_COMMENT };
  if (approvedHash !== hash(info.body)) return { approved: false, reason: UNAPPROVED_REASON.STALE_HASH };
  return { approved: true, reason: null };
}

/** Labels that keep an issue out of later runs: the core block label and the human-needed one. */
const blockingLabelsOf = (profile) => [BLOCK_LABEL, profile.labels?.humanNeeded].filter(Boolean);

// Classifies every configured issue against live GitHub state:
// - 'blocked' / 'blocked-by-dependency': ralph-blocked or labels.humanNeeded, directly or
//   transitively through dependsOn;
// - 'unapproved': OPEN, not blocked, but the spec-approved freeze is missing or stale;
// - 'in-flight': a PR in any state whose head branch the template recognizes as this issue;
// - 'unknown': the issue or its PR lookup could not be read — never selected;
// - for 'not-started' entries only, `ready` — every dependency is done or in flight.
// `deps` replaces the two GitHub lookups in tests.
function classify({ consumerRoot, profile, issues }, deps = {}) {
  const getIssueState = deps.getIssueState || ((id) => issueState(consumerRoot, id));
  const listPrBranches = deps.listPrBranches || (() => listPrHeadBranches(consumerRoot));
  const blockingLabels = blockingLabelsOf(profile);
  let prBranches = null;
  const hasExistingPr = (id) => {
    if (prBranches === null) prBranches = listPrBranches();
    return branchesOfIssue(prBranches, profile.branchTemplate, id).length > 0;
  };

  const raw = issues.map((entry) => {
    const info = getIssueState(entry.id);
    if (!info) return { ...entry, status: 'unknown' };
    if (info.state !== 'OPEN') return { ...entry, status: 'done', title: info.title };
    if ((info.labels || []).some((l) => blockingLabels.includes(l.name))) return { ...entry, status: 'blocked', title: info.title, body: info.body };
    const approval = approvalStatus(info);
    if (!approval.approved) return { ...entry, status: 'unapproved', title: info.title, body: info.body, unapprovedReason: approval.reason };
    let hasPr;
    try {
      hasPr = hasExistingPr(entry.id);
    } catch (error) {
      console.log(`⚠️ Не удалось проверить PR для issue #${entry.id}: ${error.message}`);
      // Unknown is not "no PR": the issue stays out of the ready queue.
      return { ...entry, status: 'unknown', title: info.title };
    }
    return { ...entry, status: hasPr ? 'in-flight' : 'not-started', title: info.title, body: info.body };
  });

  const byId = new Map(raw.map((e) => [e.id, e]));

  function isBlockedTransitively(id, seen) {
    if (seen.has(id)) return false;
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) return false;
    if (entry.status === 'blocked') return true;
    return (entry.dependsOn || []).some((depId) => isBlockedTransitively(depId, seen));
  }

  const withBlocking = raw.map((entry) => {
    if (entry.status === 'not-started' && isBlockedTransitively(entry.id, new Set())) {
      return { ...entry, status: 'blocked-by-dependency' };
    }
    return entry;
  });

  const byId2 = new Map(withBlocking.map((e) => [e.id, e]));
  return withBlocking.map((entry) => {
    if (entry.status !== 'not-started') return entry;
    const ready = (entry.dependsOn || []).every((depId) => {
      const dep = byId2.get(depId);
      return dep && (dep.status === 'done' || dep.status === 'in-flight');
    });
    return { ...entry, ready };
  });
}

// Which ref a new branch starts from: the consumer's default branch (from the clone) for an
// independent issue or one whose dependency is merged, otherwise the dependency's own task branch
// (stacked PR). Always an origin/... ref: a fresh clone has remote-tracking refs only.
function resolveBaseRef(profile, byId, entry, defaultBranch) {
  if (!entry.dependsOn || entry.dependsOn.length === 0) return `origin/${defaultBranch}`;
  const depId = entry.dependsOn[0];
  const dep = byId.get(depId);
  if (!dep || dep.status === 'done') return `origin/${defaultBranch}`;
  return `origin/${branchNameFor(profile.branchTemplate, depId, dep.title)}`;
}

// --- controller-owned GitHub mutations (the agent never does these) ---

// Every BLOCKED outcome: a comment with the reason, the core block label, and for the
// human-needed verdict also the profile's labels.humanNeeded. `coverage` (parsing.js
// summarizeSelfReportedCoverage()) is the agent's own unverified claim of how close it got.
function postBlockedComment({ consumerRoot, profile }, id, reason, { humanNeeded = false, coverage = null } = {}) {
  const coverageLine = coverage
    ? `\n\nСамоотчёт агента на момент блокировки (не проверено независимо): ${coverage.covered} из ${coverage.total} пунктов Acceptance Criteria отмечены как COVERED.`
    : '';
  const opts = { cwd: consumerRoot };
  gh(['issue', 'comment', String(id), '--body', `BLOCKED: ${reason}${coverageLine}`], opts);
  gh(['issue', 'edit', String(id), '--add-label', BLOCK_LABEL], opts);
  if (humanNeeded) {
    gh(['issue', 'edit', String(id), '--add-label', profile.labels.humanNeeded], opts);
  }
}

// ONE combined issue comment per DONE: the agent's acceptance self-report and the test evidence.
// Posted only after the PR exists. The headline TYPE/SUMMARY is the implementation's DONE; fixes
// made by the review loops are listed separately, so the last one-line fix never replaces it.
// Everything is labelled as the agent's own, not independently re-verified, claim.
function postTestEvidenceComment({ consumerRoot }, { chosen, verdict, branchName, acItems, selfReport, allCovered, checkedOff, pr, reviewFixSummaries = [] }) {
  const date = new Date().toISOString().slice(0, 10);
  const sections = [];

  if (acItems.length > 0) {
    const byIndex = new Map(selfReport.map((e) => [e.index, e]));
    const acLines = acItems.map((text, i) => {
      const entry = byIndex.get(i + 1);
      const mark = entry && entry.status === 'covered' ? '✅' : '⏳';
      const detail = entry ? entry.detail : 'нет соответствующей строки в самоотчёте агента';
      return `${mark} ${i + 1}. ${text}\n   ${detail}`;
    });
    // `checkedOff` (not `allCovered`) drives the wording: it confirms `gh issue edit` succeeded.
    const acHeader = checkedOff
      ? '**Acceptance Criteria** — все пункты покрыты, чек-боксы отмечены автоматически:'
      : allCovered
        ? '**Acceptance Criteria** — все пункты покрыты по самоотчёту, но отметить чек-боксы через `gh issue edit` не удалось (см. лог контроллера) — нужна ручная отметка:'
        : '**Acceptance Criteria** — не все пункты подтверждены (см. ⏳ ниже), чек-боксы НЕ отмечены автоматически, нужна ручная проверка перед мержем:';
    sections.push(`${acHeader}\n\n${acLines.join('\n\n')}`);
  }

  const evidenceLines = [
    `**Test evidence** — ${date}, branch \`${branchName}\`, PR: ${pr}.`,
    '',
    'Agent-reported DONE — self-reported by the autonomous agent, not independently re-verified by the controller.',
    '',
    `- TYPE: ${verdict.type}`,
    `- SUMMARY: ${verdict.summary}`,
  ];
  if (reviewFixSummaries.length > 0) {
    evidenceLines.push('', '**Review fixes applied after the initial DONE:**', ...reviewFixSummaries.map((s, i) => `${i + 1}. ${s}`));
  }
  sections.push(evidenceLines.join('\n'));

  gh(['issue', 'comment', String(chosen.id), '--body', sections.join('\n\n---\n\n')], { cwd: consumerRoot });
}

// The only place the controller changes an issue's acceptance checkboxes — only to `[x]`, and only
// after reconcileAcceptanceCriteria() confirmed a complete match. Re-reads the body so an edit made
// in the meantime is not overwritten.
function checkOffAcceptanceCriteria({ consumerRoot }, id) {
  const opts = { cwd: consumerRoot };
  const freshBody = gh(['issue', 'view', String(id), '--json', 'body', '-q', '.body'], opts);
  const span = acceptanceSectionSpan(freshBody);
  if (!span) return;
  const section = freshBody.slice(span.start, span.end);
  const updatedSection = section.replace(/^-\s*\[ \]/gm, '- [x]');
  if (updatedSection === section) return;
  const updated = freshBody.slice(0, span.start) + updatedSection + freshBody.slice(span.end);
  gh(['issue', 'edit', String(id), '--body', updated], opts);
}

// Non-blocking: code-review findings outside the issue's Affects are neither fixed inline nor
// dropped. They go to the profile's tech-debt tracker issue, with a pointer on the current issue.
function postOutOfScopeNote({ consumerRoot, profile }, id, findings) {
  const tracker = profile.ralph.techDebtTrackerIssue;
  const opts = { cwd: consumerRoot };
  gh(['issue', 'comment', String(tracker), '--body', `From issue #${id} (code-review, Ralph loop, out-of-scope for that issue — not auto-fixed):\n\n${findings}`], opts);
  gh(['issue', 'comment', String(id), '--body', `code-review (Ralph loop) found out-of-scope finding(s) while reviewing this issue's diff — filed to tech-debt tracker #${tracker} instead of fixing here: ${findings}`], opts);
}

function commitChanges(runDir, chosen, verdict) {
  git(['add', '-A'], { cwd: runDir });
  const message = `${verdict.type}: ISSUE-${chosen.id} ${verdict.summary}`;
  git(['commit', '-m', message], { cwd: runDir });
  return message;
}

function pushBranch(runDir, branchName) {
  git(['push', '-u', 'origin', branchName], { cwd: runDir });
}

// The PR targets the base the branch was created from, without `origin/`. Acceptance boxes stay
// unchecked here: only the reconciled self-report may tick them (checkOffAcceptanceCriteria()).
function createPr({ consumerRoot }, chosen, branchName, baseRef, commitMessage) {
  const base = baseRef.replace(/^origin\//, '');
  const body = `Closes #${chosen.id}\n\nImplemented by Ralph loop. Passed an automated post-DONE self-review pass (separate read-only agent invocation) — still review the diff yourself before merging.`;
  return gh(['pr', 'create', '--base', base, '--head', branchName, '--title', commitMessage, '--body', body], { cwd: consumerRoot });
}

// Exact names of the labels of the consumer repository.
function listLabels(consumerRoot, run = gh) {
  return JSON.parse(run(['label', 'list', '--limit', '1000', '--json', 'name'], { cwd: consumerRoot })).map((label) => label.name);
}

module.exports = {
  git,
  gh,
  gitPorcelainStatus,
  reviewDiff,
  EXEC_OPTIONS,
  originUrlOf,
  defaultBranchOf,
  listRemoteBranches,
  listPrHeadBranches,
  branchesOfIssue,
  issueState,
  classify,
  SPEC_APPROVED_LABEL,
  UNAPPROVED_REASON,
  approvalStatus,
  blockingLabelsOf,
  resolveBaseRef,
  postBlockedComment,
  postTestEvidenceComment,
  checkOffAcceptanceCriteria,
  postOutOfScopeNote,
  commitChanges,
  pushBranch,
  createPr,
  listLabels,
};
