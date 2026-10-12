'use strict';

const { STATUS_PASS, STATUS_FAIL, labelOf } = require('./common');

const COMMENT_MARKER = '<!-- acceptance-verifier -->';
const COMPUTED_SUFFIX = ' (computed)';
const SHIFT_ARROW = '→';

const escapeCell = (text) =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const renderList = (title, items, { showNone = false } = {}) => {
  if (items.length === 0 && !showNone) return [];
  const lines = items.length === 0 ? ['- none'] : items.map((i) => `- ${i}`);
  return ['', `**${title}**`, ...lines];
};

// A note for (list, entryId, refIndex) means the model's cited line was
// accepted from within the ±2-line window, not on the line itself — shown
// as cited→found so the model's slip stays visible instead of silently
// absorbed (INV-5: this never affects the verdict, display only).
const renderRefs = (refs, { list, entryId, notesByKey }) =>
  refs
    .map(({ path: file, line }, index) => {
      const note = notesByKey.get(`${list}:${entryId}:${index}`);
      if (note === undefined) return `${file}:${line}`;
      return `${file}:${note.cited}${SHIFT_ARROW}${note.found}`;
    })
    .join(', ');

// v2: the issue's own ID and text, never the model's wording.
const createNamer = (specItems) => {
  if (specItems === null) return (entry) => labelOf(entry);
  const texts = new Map(specItems.map((item) => [item.id, item.text]));
  return ({ id }) => {
    const text = texts.get(id);
    if (text !== undefined) return `${id} ${text}`;
    return `${id !== '' ? id : '(no id)'} (not in issue)`;
  };
};

const renderTable = (title, entries, nameOf, { list, notesByKey }) => {
  if (entries.length === 0) return [];
  const lines = [
    '',
    `| ${title} | Status | Summary | References |`,
    '|---|---|---|---|',
  ];
  for (const entry of entries) {
    const { id, status, summary, refs, computed } = entry;
    const displayStatus = computed ? `${status}${COMPUTED_SUFFIX}` : status;
    const refsCell = renderRefs(refs, { list, entryId: id, notesByKey });
    const cells = [nameOf(entry), displayStatus, summary, refsCell];
    lines.push(`| ${cells.map(escapeCell).join(' | ')} |`);
  }
  return lines;
};

// Identifies exactly which issue-body version and which verifier code/model
// produced this comment. Absent (null) when provenance.json was missing or
// malformed; the verdict already fails on that separately
// (PROVENANCE_MISSING), this only controls the display.
const renderProvenance = (provenance) => {
  if (provenance === null) return [];
  const { head_sha, issue_body_sha256, verifier_commit, model, codex_version } =
    provenance;
  return [
    '',
    '**Provenance**',
    `- PR head: ${head_sha}`,
    `- Issue body sha256: ${issue_body_sha256}`,
    `- Verifier commit: ${verifier_commit}`,
    `- Model: ${model}`,
    `- Codex CLI: ${codex_version}`,
  ];
};

// The moved count is information only and never changes the verdict.
const renderAssertions = (assertions) => {
  if (assertions === null) return [];
  const { losses, moved, isApproved } = assertions;
  const lines = [];
  if (moved > 0) lines.push('', `Moved assertion lines: ${moved}`);
  if (isApproved && losses.length > 0) {
    const approved = losses.map(({ path: file, lost }) => `${file}: ${lost}`);
    lines.push(...renderList('Approved assertion losses', approved));
  }
  return lines;
};

const describeEntry = ({ id, status }) =>
  `${id !== '' ? id : '(no id)'} ${status}`;

// Shown whenever the second run happened, whatever the final verdict, so the
// PR history keeps it (INV-12); absent when there was no second run.
const renderSecondRun = (secondRun) => {
  if (secondRun === null) return [];
  const { firstFailures, firstEntries } = secondRun;
  const firstResults =
    firstEntries === null
      ? 'no report'
      : firstEntries.map(describeEntry).join(', ');
  return [
    '',
    '**Second run**',
    'The first run failed only on model judgement, so the model was run ' +
      'again on the same inputs; the verdict above is from the second run.',
    ...renderList('First run FAIL reasons', firstFailures),
    '',
    `First run results: ${firstResults}`,
  ];
};

const renderComment = (
  {
    passed,
    report,
    failures,
    specFormat,
    specItems = null,
    approvalNote = null,
    assertions = null,
    provenance = null,
    refsNotesByKey = new Map(),
  },
  {
    problem = null,
    manualVerifiedIgnoredBy,
    testRemovalIgnoredBy,
    verdict = passed ? STATUS_PASS : STATUS_FAIL,
    diverged = [],
    secondRun = null,
  },
) => {
  const lines = [COMMENT_MARKER, `## Acceptance verifier: ${verdict}`];
  lines.push(...renderList('Runs disagree on', diverged));
  if (specFormat === 'legacy') lines.push('Issue format: legacy');
  if (approvalNote !== null) lines.push(approvalNote);
  if (manualVerifiedIgnoredBy !== undefined) {
    const actor = manualVerifiedIgnoredBy ?? 'unknown';
    lines.push('', `manual-verified ignored: set by ${actor}`);
  }
  if (testRemovalIgnoredBy !== undefined) {
    const actor = testRemovalIgnoredBy ?? 'unknown';
    lines.push('', `test removal approval ignored: set by ${actor}`);
  }
  lines.push(...renderProvenance(provenance));
  lines.push(...renderSecondRun(secondRun));
  lines.push(...renderAssertions(assertions));
  if (report !== null) {
    const nameOf = createNamer(specItems);
    const criteriaCtx = { list: 'criteria', notesByKey: refsNotesByKey };
    const invariantsCtx = { list: 'invariants', notesByKey: refsNotesByKey };
    lines.push(
      ...renderTable('Criterion', report.criteria, nameOf, criteriaCtx),
    );
    lines.push(
      ...renderTable('Invariant', report.invariants, nameOf, invariantsCtx),
    );
    const options = { showNone: true };
    lines.push(...renderList('Test tampering', report.test_tampering, options));
    lines.push(...renderList('Risk zones', report.risk_zones, options));
    const scopeTitle =
      specFormat === 'v2' ? 'Model scope hints' : 'Out of scope files';
    lines.push(...renderList(scopeTitle, report.out_of_scope_files, options));
  }
  const reasons = problem === null ? failures : [problem, ...failures];
  const isPass = verdict === STATUS_PASS;
  lines.push(...renderList('Why not PASS', isPass ? [] : reasons));
  return `${lines.join('\n')}\n`;
};

module.exports = {
  COMMENT_MARKER,
  renderComment,
};
