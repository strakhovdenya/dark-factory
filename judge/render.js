'use strict';

const COMMENT_MARKER = '<!-- calibration-judge -->';
const DISCLAIMER =
  '> **Calibration analysis, not a fix list.** ' +
  'Judge only observes and takes no part in the fix loop: ' +
  'the fixing AI receives only the verifier report.';

// The hidden block carries base64 of the JSON, so no character sequence the
// model writes (`-->` included) can close the HTML comment early.
const HIDDEN_PREFIX = '<!-- calibration-judge-analysis:';
const HIDDEN_SUFFIX = ' -->';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// The rounds history block: one entry per round key, each a revision history
// (publish.js's mergeRecord). Same base64-of-JSON shape as the per-round
// analysis block above, for the same reason.
const ROUNDS_PREFIX = '<!-- calibration-judge-rounds:';
const ROUNDS_SUFFIX = ' -->';
const SHA256_HEX = /^[0-9a-f]{64}$/;

const UNKNOWN = 'unknown';

// Field names of the analysis shape, not taxonomy values: each list holds
// one class of finding, and its own field name is the label shown.
const FINDING_GROUPS = [
  'issue_defects',
  'implementation_defects',
  'verifier_defects',
  'correct_verifier_findings',
];
const COUNTERFACTUAL_FIELDS = [
  'fix_issue_only',
  'fix_implementation_only',
  'fix_verifier_only',
];
const FINDING_COLUMNS = [
  'Group',
  'finding_id',
  'Item',
  'Subtype',
  'Description',
  'Evidence',
];

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

// Model text is untrusted: HTML is neutralised, Markdown control
// characters are backslash-escaped and newlines collapse, so a value never
// leaves its table cell or list item.
// A zero-width space after `@` keeps a quoted `@user` or `@org/team` from
// notifying anyone when the comment is posted.
const escapeText = (value) =>
  String(value ?? '')
    .replace(/[&<>]/g, (char) => HTML_ENTITIES[char])
    .replace(/[\\`*_[\]|#~]/g, (char) => `\\${char}`)
    .replace(/@/g, '@​')
    .replace(/\r?\n/g, ' ');

// For identifiers and taxonomy values. Not every such field is validated
// (subtype is free on some finding lists), so `<` and `>` are dropped too:
// nothing rendered can open an HTML comment or forge the hidden block.
const code = (value) => {
  const text = String(value ?? '')
    .replace(/[`\r\n<>]/g, '')
    .replace(/@/g, '@​')
    // Backslash is escaped before the pipe: escaping the pipe alone would
    // turn an input "\|" into "\\|" — an escaped backslash followed by an
    // unescaped pipe, which breaks out of the table cell.
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
  return `\`${text}\``;
};

const optionalCode = (value) =>
  value === null || value === undefined ? '—' : code(value);

const tableRow = (cells) => `| ${cells.join(' | ')} |`;

const tableHead = (columns) => [
  tableRow(columns),
  tableRow(columns.map(() => '---')),
];

const formatRoundKey = (roundKey) => {
  if (roundKey === null) return UNKNOWN;
  const parts = [
    roundKey.repository,
    `run ${roundKey.verifier_run_id}`,
    `attempt ${roundKey.verifier_run_attempt}`,
  ];
  return parts.map(escapeText).join(' · ');
};

const formatEvidence = (item) => {
  const where = item.type === 'code' ? `${item.sha}:${item.path}` : item.ref;
  return `${escapeText(where)} — ${escapeText(item.note)}`;
};

const headOf = (sha) => (sha === null ? UNKNOWN : code(sha));

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isKeyPart = (value) =>
  (typeof value === 'string' && value !== '') || typeof value === 'number';

const isRoundKey = (value) =>
  isObject(value) &&
  isKeyPart(value.repository) &&
  isKeyPart(value.verifier_run_id) &&
  isKeyPart(value.verifier_run_attempt);

const isSameRound = (left, right) =>
  String(left.repository) === String(right.repository) &&
  String(left.verifier_run_id) === String(right.verifier_run_id) &&
  String(left.verifier_run_attempt) === String(right.verifier_run_attempt);

const isRevisionEntry = (value) =>
  isObject(value) &&
  Number.isInteger(value.revision) &&
  value.revision >= 1 &&
  typeof value.sha256 === 'string' &&
  SHA256_HEX.test(value.sha256);

const isOptionalString = (value) => value === null || typeof value === 'string';

const isRowSummary = (value) =>
  isObject(value) &&
  isOptionalString(value.head_sha) &&
  isOptionalString(value.change_type) &&
  isOptionalString(value.comparability) &&
  isOptionalString(value.verdict) &&
  isOptionalString(value.error_stage) &&
  typeof value.transitions === 'string' &&
  typeof value.findings === 'string';

// `analysis` is null for a round compressed to save comment space
// (renderComment): its content then lives only in the Judge artifact, and the
// comment keeps its revision hashes plus the `summary` its table row needs.
// A record written before revision history existed has no `history`; it is
// read as an empty one rather than rejected, so older comments keep their
// rounds.
const isRecord = (value) =>
  isObject(value) &&
  isRoundKey(value.round_key) &&
  Number.isInteger(value.revision) &&
  value.revision >= 1 &&
  typeof value.sha256 === 'string' &&
  SHA256_HEX.test(value.sha256) &&
  (isObject(value.analysis) ||
    (value.analysis === null && isRowSummary(value.summary))) &&
  (value.history === undefined ||
    (Array.isArray(value.history) && value.history.every(isRevisionEntry)));

const normalizeRecord = (record) =>
  record.history === undefined ? { ...record, history: [] } : record;

const encodeRounds = (records) => {
  const json = JSON.stringify({ rounds: records });
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  return `${ROUNDS_PREFIX}${encoded}${ROUNDS_SUFFIX}`;
};

// Never throws: a missing, truncated, non-base64, non-JSON or wrongly shaped
// block is reported as a reason instead of a partial history.
const decodeRounds = (body) => {
  const failure = (reason) => ({ ok: false, records: [], error: reason });
  if (typeof body !== 'string') return failure('comment is not a string');
  const start = body.lastIndexOf(ROUNDS_PREFIX);
  if (start === -1) return failure('rounds block not found');
  const bodyStart = start + ROUNDS_PREFIX.length;
  const end = body.indexOf(ROUNDS_SUFFIX, bodyStart);
  if (end === -1) return failure('rounds block is not closed');
  const encoded = body.slice(bodyStart, end);
  const isBase64 =
    encoded !== '' && encoded.length % 4 === 0 && BASE64.test(encoded);
  if (!isBase64) return failure('rounds block is not valid base64');
  let data = null;
  try {
    data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return failure('rounds block is not valid JSON');
  }
  const records = isObject(data) ? data.rounds : null;
  if (!Array.isArray(records) || !records.every(isRecord)) {
    return failure('rounds block has an invalid shape');
  }
  return { ok: true, records: records.map(normalizeRecord), error: null };
};

// Chronological order of rounds within one PR: by verifier run, then attempt
// (a rerun of the same run). Round keys of one comment always share a
// repository, so that part is not part of the ordering.
const compareRoundOrder = (left, right) => {
  const runDiff = Number(left.verifier_run_id) - Number(right.verifier_run_id);
  if (runDiff !== 0) return runDiff;
  return Number(left.verifier_run_attempt) - Number(right.verifier_run_attempt);
};

const sortedRecords = (records) =>
  [...records].sort((left, right) =>
    compareRoundOrder(left.round_key, right.round_key),
  );

const renderCommentHeader = () => [
  COMMENT_MARKER,
  DISCLAIMER,
  '',
  '## Calibration Judge',
];

const renderRoundSummary = (assembled) => [
  `Round: ${formatRoundKey(assembled.round_key)}`,
  `Head: ${headOf(assembled.head_sha)}`,
];

const renderError = (error) => [
  '',
  `### Analysis error (stage: ${escapeText(error.stage)})`,
  '',
  ...error.problems.map((problem) => `- ${escapeText(problem)}`),
];

const renderRootCause = (analysis) => {
  const verdict = analysis.independent_expected_verdict;
  return [
    '',
    '### Root cause',
    '',
    `- primary_cause: ${code(analysis.primary_cause)}`,
    `- responsibility: ${code(analysis.responsibility)}`,
    `- confidence: ${code(analysis.confidence)}`,
    `- observed_verdict: ${code(analysis.observed_verdict)}`,
    `- independent_expected_verdict: ${code(verdict)}`,
  ];
};

const renderCounterfactual = (counterfactual) => [
  '',
  '### Counterfactual',
  '',
  ...tableHead(['Change', 'Outcome']),
  ...COUNTERFACTUAL_FIELDS.map((field) =>
    tableRow([field, code(counterfactual[field])]),
  ),
];

const renderIndependent = (independent) => [
  '',
  '### Independent assessment (stage 1)',
  '',
  ...tableHead(['Item', 'Status', 'Justification']),
  ...independent.requirements.map((item) =>
    tableRow([code(item.id), code(item.status), escapeText(item.rationale)]),
  ),
];

const findingRow = (group, finding) =>
  tableRow([
    group,
    escapeText(finding.finding_id),
    optionalCode(finding.criterion_id),
    optionalCode(finding.subtype),
    escapeText(finding.description),
    finding.evidence.map(formatEvidence).join('<br>'),
  ]);

const renderFindings = (analysis) => {
  const rows = FINDING_GROUPS.flatMap((group) =>
    analysis[group].map((finding) => findingRow(group, finding)),
  );
  const header = ['', '### Defects and findings', ''];
  if (rows.length === 0) return [...header, 'No findings.'];
  return [...header, ...tableHead(FINDING_COLUMNS), ...rows];
};

const renderRecommendations = (analysis) => {
  const targets = analysis.verifier_defects.map((finding) => {
    const target = code(finding.recommended_change_target);
    return `- ${escapeText(finding.finding_id)}: ${target}`;
  });
  const lessons = analysis.systemic_lessons.map(
    (lesson) => `- ${escapeText(lesson)}`,
  );
  const golden = analysis.golden_case_recommendation;
  const body = [];
  if (targets.length > 0) {
    body.push('What to change in the verifier:', ...targets, '');
  }
  if (lessons.length > 0) body.push('Systemic lessons:', ...lessons, '');
  if (golden !== null) body.push(`Golden case: ${escapeText(golden)}`, '');
  if (body.length === 0) body.push('No recommendations.');
  return ['', '### Recommendations', '', ...body];
};

// An input is listed when it was not read at all or was read from a live
// fallback instead of the historical copy; a fully historical,
// complete package shows no such section.
const renderMissingInputs = (inputs) => {
  const missing = Object.entries(inputs).filter(
    ([, input]) => input.status !== 'present' || input.historical === false,
  );
  if (missing.length === 0) return [];
  const describe = (input) =>
    input.status === 'present' ? 'not historical' : escapeText(input.status);
  return [
    '',
    '### Missing or non-historical inputs',
    '',
    ...missing.map(([key, input]) => `- ${code(key)}: ${describe(input)}`),
  ];
};

const encodeHiddenBlock = (assembled) => {
  const json = JSON.stringify(assembled);
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  return `${HIDDEN_PREFIX}${encoded}${HIDDEN_SUFFIX}`;
};

const renderRoundBody = (assembled) => {
  if (assembled.error !== null) return renderError(assembled.error);
  const { analysis, independent } = assembled;
  return [
    ...renderRootCause(analysis),
    ...renderCounterfactual(analysis.counterfactual),
    ...renderIndependent(independent),
    ...renderFindings(analysis),
    ...renderRecommendations(analysis),
  ];
};

// Renders an assembled analysis (assemble.js) as a standalone comment body
// (the `calibration-judge.js render` preview command — one round, its own
// hidden analysis block). The multi-round PR comment is built by
// renderComment() instead, which never embeds this per-round hidden block
// (it already carries the full analysis inside the rounds history block, so
// embedding it twice would only grow the comment for no benefit). Every
// taxonomy value shown is read from the analysis itself, never from a list
// in this module.
const render = (assembled) => {
  const lines = [
    ...renderCommentHeader(),
    '',
    ...renderRoundSummary(assembled),
    ...renderRoundBody(assembled),
    ...renderMissingInputs(assembled.inputs),
    '',
    encodeHiddenBlock(assembled),
  ];
  return `${lines.join('\n')}\n`;
};

const ROUNDS_TABLE_COLUMNS = [
  '#',
  'Round',
  'Head',
  'Change',
  'Comparability',
  'Verdict',
  'Status transitions',
  'Finding classes',
];

const changeTypeOf = (assembled) =>
  assembled.round_comparison?.taskChange?.type ?? null;

const comparabilityOf = (assembled) =>
  assembled.round_comparison?.comparability?.result ?? null;

const transitionsSummary = (assembled) => {
  const transitions = assembled.transitions;
  if (!isObject(transitions) || !Array.isArray(transitions.transitions)) {
    return '—';
  }
  if (transitions.reason === 'first round') return 'first round';
  const items = transitions.transitions;
  const changed = items.filter((item) => item.changed).length;
  const flipped = items.filter((item) => item.flip).length;
  if (changed === 0) return 'no changes';
  if (flipped === 0) return `changed: ${changed}`;
  return `changed: ${changed} (flip: ${flipped})`;
};

// One summary string per round: how many findings currently carry each
// `fate` taxonomy value, read from the finding itself — never from a list in
// this module.
const findingClassesSummary = (assembled) => {
  const findings = FINDING_GROUPS.flatMap((group) => assembled.analysis[group]);
  if (findings.length === 0) return 'no findings';
  const counts = new Map();
  for (const finding of findings) {
    const fate = finding.fate ?? UNKNOWN;
    counts.set(fate, (counts.get(fate) ?? 0) + 1);
  }
  return [...counts.entries()].map(([fate, count]) => `${fate}: ${count}`).join(', ');
};

// The data one table row needs, as plain values. A compressed record keeps
// only this, so its row still renders after its full analysis is dropped.
// A round whose analysis failed carries its error stage instead of a verdict
// and findings; key, head, comparison and transitions still come from
// the script's own round context, computed independently of the model
// stages (assemble.js).
const rowSummaryOf = (assembled) => {
  const isFailed = assembled.error !== null;
  return {
    head_sha: assembled.head_sha ?? null,
    change_type: changeTypeOf(assembled),
    comparability: comparabilityOf(assembled),
    verdict: isFailed ? null : assembled.analysis.observed_verdict,
    error_stage: isFailed ? String(assembled.error.stage) : null,
    transitions: transitionsSummary(assembled),
    findings: isFailed ? '' : findingClassesSummary(assembled),
  };
};

const summaryOfRecord = (record) =>
  record.analysis === null ? record.summary : rowSummaryOf(record.analysis);

const roundTableRow = (roundKey, summary, index) => {
  const cells = [
    String(index),
    formatRoundKey(roundKey),
    headOf(summary.head_sha),
    optionalCode(summary.change_type),
    optionalCode(summary.comparability),
  ];
  const transitions = escapeText(summary.transitions);
  if (summary.error_stage !== null) {
    const errorCell = escapeText(`error: ${summary.error_stage}`);
    return tableRow([...cells, code('ERROR'), transitions, errorCell]);
  }
  const verdict = optionalCode(summary.verdict);
  return tableRow([...cells, verdict, transitions, escapeText(summary.findings)]);
};

// The rounds table lists every round known so far, oldest first,
// including rounds whose full analysis was compressed out of the comment.
const renderRoundsTable = (records) => {
  const rows = sortedRecords(records).map((record, index) =>
    roundTableRow(record.round_key, summaryOfRecord(record), index + 1),
  );
  return ['### Rounds', '', ...tableHead(ROUNDS_TABLE_COLUMNS), ...rows];
};

const renderFooter = (record, roundCount, historyError, truncated = false) => {
  const lines = [
    '',
    `Revision of this round's analysis: ${record.revision} · ` +
      `sha256 \`${record.sha256}\``,
    `Rounds in the analysis history: ${roundCount}`,
  ];
  if (truncated) {
    lines.push(
      '',
      '> **Comment compressed.** The full JSON of older rounds is kept only in ' +
        'the Judge artifact; only revision hashes remain here for them.',
    );
  }
  if (historyError !== null) {
    lines.push(
      '',
      '> **The earlier analysis history was not read** ' +
        `(${escapeText(historyError)}); only this round was kept.`,
    );
  }
  return lines;
};

// Reads the comment-size limit from the already-parsed
// judge/inputs.json object: a missing or invalid value fails closed.
const loadCommentConfig = (data) => {
  const maxBodyLength = data?.comment?.maxBodyLength;
  if (!Number.isInteger(maxBodyLength) || maxBodyLength <= 0) {
    throw new Error('inputs config: comment.maxBodyLength is invalid');
  }
  return { maxBodyLength };
};

const compressRecord = (record) => ({
  round_key: record.round_key,
  revision: record.revision,
  sha256: record.sha256,
  analysis: null,
  summary: summaryOfRecord(record),
  history: record.history,
});

// Keeps the full analysis of the published round and of the newest
// `keepOthers` other rounds; every older round keeps only its revision
// hashes and its table-row summary. The published round is never
// compressed, even when it is not the newest one (a republished old round).
const compressOldest = (records, publishedKey, keepOthers) => {
  const others = sortedRecords(records)
    .filter((record) => !isSameRound(record.round_key, publishedKey))
    .map((record) => record.round_key);
  const compressed = others.slice(0, others.length - keepOthers);
  return records.map((record) => {
    const isCompressed = compressed.some((key) => isSameRound(key, record.round_key));
    if (!isCompressed || record.analysis === null) return record;
    return compressRecord(record);
  });
};

// Builds the full PR comment: header, the rounds table (always every
// round), the analysis of the round just published, and the rounds history
// hidden block. When the result would exceed `maxBodyLength`, other rounds'
// full analysis is dropped from the hidden block oldest first, keeping their
// revision hashes and row summary, until it fits or only the published
// round's analysis remains. If even that does not fit, this throws
// instead of writing a truncated comment — the visible table is never
// shortened, so there is nothing left to compress at that point. `record`
// must carry its full analysis (publish.js's mergeRecord guarantees it).
const renderComment = ({ records, record, historyError, maxBodyLength }) => {
  const base = [
    ...renderCommentHeader(),
    '',
    ...renderRoundsTable(records),
    '',
    '### Analysis of this round',
    '',
    ...renderRoundSummary(record.analysis),
    ...renderRoundBody(record.analysis),
    ...renderMissingInputs(record.analysis.inputs),
  ];
  for (let keepOthers = records.length - 1; keepOthers >= 0; keepOthers -= 1) {
    const payload = compressOldest(records, record.round_key, keepOthers);
    const truncated = payload.some((item) => item.analysis === null);
    const lines = [
      ...base,
      ...renderFooter(record, records.length, historyError, truncated),
      '',
      encodeRounds(payload),
    ];
    const body = `${lines.join('\n')}\n`;
    if (body.length <= maxBodyLength) return body;
  }
  throw new Error(
    'calibration-judge comment exceeds the configured size limit even at minimum compression',
  );
};

// Never throws: a missing, truncated, non-base64 or non-JSON block
// is reported as an error instead of a partially restored analysis. The
// real block is always the last line render() writes, so the last prefix is
// the one read.
const decodeHiddenBlock = (comment) => {
  const failure = (reason) => ({ ok: false, analysis: null, error: reason });
  if (typeof comment !== 'string') return failure('comment is not a string');
  const start = comment.lastIndexOf(HIDDEN_PREFIX);
  if (start === -1) return failure('hidden block not found');
  const bodyStart = start + HIDDEN_PREFIX.length;
  const end = comment.indexOf(HIDDEN_SUFFIX, bodyStart);
  if (end === -1) return failure('hidden block is not closed');
  const encoded = comment.slice(bodyStart, end);
  const isBase64 =
    encoded !== '' && encoded.length % 4 === 0 && BASE64.test(encoded);
  if (!isBase64) return failure('hidden block is not valid base64');
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    return { ok: true, analysis: JSON.parse(json), error: null };
  } catch {
    return failure('hidden block is not valid JSON');
  }
};

module.exports = {
  COMMENT_MARKER,
  DISCLAIMER,
  escapeText,
  render,
  decodeHiddenBlock,
  isSameRound,
  encodeRounds,
  decodeRounds,
  renderRoundsTable,
  renderComment,
  loadCommentConfig,
};
