'use strict';

const { parseStatusZ, entryPaths } = require('./boundary');
const { isDocOnlyPath } = require('../profile/path-patterns');
const { loadCore, namesOf } = require('../verifier/issue-contract');

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escapeRegExp = (text) => text.replace(REGEX_SPECIAL, '\\$&');

// `porcelain` is `git status --porcelain=v1 -z -uall` output (github.js gitPorcelainStatus()):
// it covers untracked new files that a plain `git diff` misses. Returns the current path of every
// entry (the new name for a rename).
function changedFilePathsFromPorcelain(porcelain) {
  return parseStatusZ(porcelain).map((entry) => entry.path);
}

// Every path an entry touches: both sides of a rename or copy, deleted files included.
function allChangedPaths(porcelain) {
  return parseStatusZ(porcelain).flatMap(entryPaths);
}

// Doc-only changes skip the review passes and the final gate. Deliberately conservative: the diff
// is doc-only only when EVERY changed path (both sides of a rename, deleted and binary files too)
// matches the profile's docOnlyPathPatterns; an empty or absent list means nothing is doc-only.
// False positives (reviewing something harmless) are cheap; false negatives are the risk.
function hasCodeChanges(porcelainStatus, docOnlyPatterns = []) {
  const paths = allChangedPaths(porcelainStatus);
  if (paths.length === 0) return false;
  if (docOnlyPatterns.length === 0) return true;
  return paths.some((filePath) => !isDocOnlyPath(filePath, docOnlyPatterns));
}

// Takes the LAST match of `re` in `text`, not the first — the agent's
// transcript can legitimately contain earlier text that quotes/plans around
// these exact sentinel words (e.g. restating the instructions) before the
// real, final verdict. Matching the first occurrence risked treating that
// as the verdict instead of what the agent actually concluded with.
function lastMatch(text, re) {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let match;
  let last = null;
  while ((match = global.exec(text)) !== null) {
    last = match;
    if (match.index === global.lastIndex) global.lastIndex++; // avoid infinite loop on zero-width match
  }
  return last;
}

// The agent sometimes wraps the sentinel line in markdown emphasis
// (`**DONE**` instead of `DONE`) despite the prompt asking for a literal
// line — found live on a real #282 run, where an otherwise fully-valid,
// fully-tested implementation was reported as agent_failed purely because
// the strict `^DONE\s*$` regex didn't match the bold-wrapped line. Strip
// leading/trailing markdown emphasis/code markers (`*`, `_`, backtick) from
// each line before matching, rather than trying to enumerate every possible
// wrapping in the regex itself.
function stripLineMarkdownEmphasis(text) {
  return text.replace(/^[ \t]*[*_`]+|[*_`]+[ \t]*$/gm, '');
}

// `humanNeededVerdict` is the profile's ralph.humanNeededVerdict, matched literally (regex
// characters escaped). `rawOutput` accumulates the assistant's text across EVERY turn of the
// whole agent run (runAgent() does `output += block.text` per turn, not
// just the final message) — a long run can easily echo one of these
// sentinel words in passing (e.g. reasoning about why something is *not*
// a human-needed case) well before the real, final verdict. Fixed
// by index (each `lastMatch()` gives the last occurrence's index): pick
// whichever sentinel actually occurs LAST in the whole text, not the first
// one found by checking patterns in a fixed priority order — a fixed
// priority order would let an early, incidental mention of
// human-needed verdict win over a legitimate final DONE.
function parseVerdict(rawOutput, humanNeededVerdict) {
  const output = stripLineMarkdownEmphasis(rawOutput);
  const humanNeededMatch = humanNeededVerdict
    ? lastMatch(output, new RegExp(`^${escapeRegExp(humanNeededVerdict)}:\\s*([\\s\\S]*)$`, 'm'))
    : null;
  const blockedMatch = lastMatch(output, /^BLOCKED:\s*([\s\S]*)$/m);
  const doneMatch = lastMatch(output, /^DONE\s*$/m);

  const candidates = [];
  if (humanNeededMatch) candidates.push({ index: humanNeededMatch.index, kind: 'human-needed', reason: humanNeededMatch[1].trim() });
  if (blockedMatch) candidates.push({ index: blockedMatch.index, kind: 'blocked', reason: blockedMatch[1].trim() });
  if (doneMatch) candidates.push({ index: doneMatch.index, kind: 'done' });

  if (candidates.length === 0) return { kind: 'unknown' };
  candidates.sort((a, b) => b.index - a.index);
  const winner = candidates[0];

  if (winner.kind === 'done') {
    const typeMatch = lastMatch(output, /^TYPE:\s*(\w+)/m);
    const summaryMatch = lastMatch(output, /^SUMMARY:\s*(.+)$/m);
    return {
      kind: 'done',
      type: typeMatch ? typeMatch[1] : 'chore',
      summary: summaryMatch ? summaryMatch[1].trim() : 'implement issue',
    };
  }
  return { kind: winner.kind, reason: winner.reason };
}

// Section names come from the issue contract (the section with the given role, main title and
// alternatives); this file holds no list of its own.
const ACCEPTANCE_ROLE = 'acceptance';
const SCOPE_ROLE = 'scope';
const headingNamesOf = (role) => loadCore().sections.filter((s) => s.role === role).flatMap(namesOf);

// Start and end offsets of a section's content (after its `##` heading, up to the next `##`
// heading), or null without the section. Sliced by index: JS has no `\Z`, and `$` under the `/m`
// flag matches every line end.
function sectionSpan(issueBody, role) {
  const names = headingNamesOf(role).map(escapeRegExp).join('|');
  const headingMatch = new RegExp(`^##\\s*(?:${names})\\s*$`, 'm').exec(issueBody);
  if (!headingMatch) return null;
  const start = headingMatch.index + headingMatch[0].length;
  const nextHeadingMatch = /^##\s/m.exec(issueBody.slice(start));
  const end = nextHeadingMatch ? start + nextHeadingMatch.index : issueBody.length;
  return { start, end };
}

const acceptanceSectionSpan = (issueBody) => sectionSpan(issueBody, ACCEPTANCE_ROLE);

/** Text of the issue's scope (Affects) section, '' without it. */
function extractAffectsSection(issueBody) {
  const span = sectionSpan(issueBody || '', SCOPE_ROLE);
  return span ? issueBody.slice(span.start, span.end) : '';
}

// The acceptance checklist of the issue body itself (not the agent's output) — the canonical,
// ordered list the self-report below is checked against. Each entry is the bullet text without
// the leading `- [ ]`/`- [x]`; only the order is compared (reconcileAcceptanceCriteria()).
function extractAcceptanceCriteriaItems(issueBody) {
  if (!issueBody) return [];
  const span = acceptanceSectionSpan(issueBody);
  if (!span) return [];
  const section = issueBody.slice(span.start, span.end);
  const items = [];
  const lineRe = /^-\s*\[[ xX]\]\s*(.+)$/gm;
  let m;
  while ((m = lineRe.exec(section)) !== null) {
    items.push(m[1].trim());
  }
  return items;
}

// Parses the agent's `=== ACCEPTANCE CRITERIA SELF-REPORT ===` block (see
// buildTaskRules()) from its LAST occurrence in the output (same
// last-occurrence-wins reasoning as parseVerdict() — a fix pass's own,
// later self-report supersedes the original DONE's). Returns an array of
// `{ index, status: 'covered' | 'not_verified', detail }` in the order the
// agent wrote them — does NOT itself check this against the issue's real
// AC list; that's reconcileAcceptanceCriteria()'s job, kept separate so a
// malformed/missing self-report (empty array here) fails that comparison
// safely rather than throwing.
function parseAcceptanceCriteriaSelfReport(rawOutput) {
  const output = stripLineMarkdownEmphasis(rawOutput);
  const blockRe = /=== ACCEPTANCE CRITERIA SELF-REPORT ===([\s\S]*?)=== END ACCEPTANCE CRITERIA SELF-REPORT ===/g;
  let last = null;
  let m;
  while ((m = blockRe.exec(output)) !== null) last = m;
  if (!last) return [];

  const lineRe = /^\s*(\d+)\.\s*(COVERED|NOT VERIFIED):\s*(.+)$/gim;
  const items = [];
  let lm;
  while ((lm = lineRe.exec(last[1])) !== null) {
    items.push({
      index: Number(lm[1]),
      status: lm[2].toUpperCase() === 'COVERED' ? 'covered' : 'not_verified',
      detail: lm[3].trim(),
    });
  }
  return items;
}

// The actual gate: the self-report only counts as a full, honest match when
// it has exactly one entry per real AC item (no skipped/merged items, no
// extras), in order, and every single one is 'covered' — a single
// 'not_verified' entry, or any count mismatch, means the controller must
// NOT check off anything automatically (see the callers below for why this
// is fine for batch autonomy — resolveBaseRef() never waits on this).
function reconcileAcceptanceCriteria(acItems, selfReport) {
  if (acItems.length === 0) return { allCovered: false, coveredIndices: [] };
  if (selfReport.length !== acItems.length) return { allCovered: false, coveredIndices: [] };
  const byIndex = new Map(selfReport.map((e) => [e.index, e]));
  const coveredIndices = [];
  for (let i = 1; i <= acItems.length; i++) {
    const entry = byIndex.get(i);
    if (!entry || entry.status !== 'covered') return { allCovered: false, coveredIndices: [] };
    coveredIndices.push(i);
  }
  return { allCovered: true, coveredIndices };
}

// Lenient counterpart of reconcileAcceptanceCriteria() for the BLOCKED comment: that one is
// all-or-nothing (any mismatch => nothing), which is useless as a progress signal. `total` comes
// from the issue's real AC list, not the self-report; entries only count when their index falls in
// 1..total (a garbled index must not push covered above total); duplicates count once. Returns null
// for an issue with no AC items — "no AC marked up" must not read as "0 of 0 done".
function summarizeSelfReportedCoverage(acItems, selfReport) {
  const total = acItems.length;
  if (total === 0) return null;
  const covered = new Set(
    selfReport.filter((e) => e.status === 'covered' && e.index >= 1 && e.index <= total).map((e) => e.index)
  ).size;
  return { covered, total };
}

// Same last-occurrence-wins approach as parseVerdict() above, for the
// separate post-DONE self-review pass's own sentinel lines.
function parseReviewVerdict(rawOutput) {
  const output = stripLineMarkdownEmphasis(rawOutput);
  const failMatch = lastMatch(output, /^REVIEW: FAIL:\s*([\s\S]*)$/m);
  const passMatch = lastMatch(output, /^REVIEW: PASS\s*$/m);

  const candidates = [];
  if (failMatch) candidates.push({ index: failMatch.index, kind: 'fail', reason: failMatch[1].trim() });
  if (passMatch) candidates.push({ index: passMatch.index, kind: 'pass' });

  if (candidates.length === 0) return { kind: 'unknown' };
  candidates.sort((a, b) => b.index - a.index);
  return candidates[0];
}

// Same last-occurrence-wins approach again, for the separate post-self-review
// code-review pass's own sentinel lines (buildCodeReviewPrompt()).
function parseCodeReviewVerdict(rawOutput) {
  const output = stripLineMarkdownEmphasis(rawOutput);
  const failMatch = lastMatch(output, /^CODEREVIEW: FAIL:\s*([\s\S]*)$/m);
  const outOfScopeMatch = lastMatch(output, /^CODEREVIEW: PASS-OUT-OF-SCOPE:\s*([\s\S]*)$/m);
  const passMatch = lastMatch(output, /^CODEREVIEW: PASS\s*$/m);

  const candidates = [];
  if (failMatch) candidates.push({ index: failMatch.index, kind: 'fail', reason: failMatch[1].trim() });
  if (outOfScopeMatch) candidates.push({ index: outOfScopeMatch.index, kind: 'pass-out-of-scope', reason: outOfScopeMatch[1].trim() });
  if (passMatch) candidates.push({ index: passMatch.index, kind: 'pass' });

  if (candidates.length === 0) return { kind: 'unknown' };
  candidates.sort((a, b) => b.index - a.index);
  return candidates[0];
}

module.exports = {
  escapeRegExp,
  changedFilePathsFromPorcelain,
  allChangedPaths,
  hasCodeChanges,
  lastMatch,
  stripLineMarkdownEmphasis,
  parseVerdict,
  acceptanceSectionSpan,
  extractAffectsSection,
  extractAcceptanceCriteriaItems,
  parseAcceptanceCriteriaSelfReport,
  reconcileAcceptanceCriteria,
  summarizeSelfReportedCoverage,
  parseReviewVerdict,
  parseCodeReviewVerdict,
};
