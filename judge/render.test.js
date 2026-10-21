'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  COMMENT_MARKER,
  DISCLAIMER,
  render,
  decodeHiddenBlock,
  renderComment,
  decodeRounds,
  loadCommentConfig,
} = require('./render');

const HIDDEN_PREFIX = '<!-- calibration-judge-analysis:';
const sha = (seed) => crypto.createHash('sha256').update(seed).digest('hex');

const assembled = (overrides = {}) => ({
  round_key: {
    repository: 'owner/repo',
    verifier_run_id: 101,
    verifier_run_attempt: 2,
  },
  head_sha: 'b'.repeat(40),
  inputs: {
    issue: { status: 'present', historical: true },
    diff: { status: 'present', historical: true },
  },
  error: null,
  independent: {
    independent_expected_verdict: 'PASS',
    requirements: [
      {
        id: 'AC-1',
        literal_requirement: 'x',
        evidence_expected: 'y',
        single_interpretation: true,
        verify_proves_requirement: true,
        status: 'SATISFIED',
        rationale: 'covered by a test',
      },
    ],
  },
  analysis: {
    observed_verdict: 'FAIL',
    independent_expected_verdict: 'PASS',
    primary_cause: 'VERIFIER_FALSE_FAIL',
    responsibility: 'verifier',
    confidence: 'MEDIUM',
    issue_defects: [
      {
        finding_id: 'F-2',
        criterion_id: 'TR-1',
        subtype: 'MISSING_EDGE_CASE',
        description: 'edge case not named',
        evidence: [{ type: 'input', ref: 'issue.md', note: 'TR-1 text' }],
      },
    ],
    implementation_defects: [],
    verifier_defects: [
      {
        finding_id: 'F-1',
        criterion_id: 'AC-1',
        subtype: 'INVENTED_REQUIREMENT',
        recommended_change_target: 'prompt',
        description: 'asked for a test the issue never required',
        evidence: [
          { type: 'code', sha: 'b'.repeat(40), path: 'a.js', note: 'present' },
        ],
      },
    ],
    correct_verifier_findings: [],
    counterfactual: {
      fix_issue_only: 'DOES_NOT_RESOLVE',
      fix_implementation_only: 'DOES_NOT_RESOLVE',
      fix_verifier_only: 'RESOLVES',
    },
    systemic_lessons: ['require the prompt to quote the issue item it enforces'],
    golden_case_recommendation: null,
  },
  ...overrides,
});

test('renders marker disclaimer and root cause sections', () => {
  const comment = render(assembled());
  const lines = comment.split('\n');

  assert.strictEqual(lines[0], COMMENT_MARKER);
  assert.strictEqual(lines[1], DISCLAIMER);
  assert.match(DISCLAIMER, /Calibration analysis, not a fix list/);
  assert.match(comment, /### Root cause/);
  assert.match(comment, /primary_cause: `VERIFIER_FALSE_FAIL`/);
  assert.match(comment, /responsibility: `verifier`/);
  assert.match(comment, /### Counterfactual/);
  assert.match(comment, /\| fix_verifier_only \| `RESOLVES` \|/);
  assert.match(comment, /### Defects and findings/);
  assert.match(comment, /\| verifier_defects \| F-1 \| `AC-1` \| `INVENTED_REQUIREMENT` \|/);
  assert.match(comment, /\| issue_defects \| F-2 \| `TR-1` \| `MISSING_EDGE_CASE` \|/);
  assert.match(comment, /### Recommendations/);
  assert.match(comment, /- F-1: `prompt`/);
  assert.match(comment, /require the prompt to quote the issue item it enforces/);
  assert.ok(!comment.includes('<!-- acceptance-verifier -->'));
});

test('renders taxonomy values taken from the analysis', () => {
  const custom = assembled();
  custom.analysis.primary_cause = 'SOME_FUTURE_CAUSE';
  const comment = render(custom);

  assert.match(comment, /primary_cause: `SOME_FUTURE_CAUSE`/);
});

test('round-trips analysis json through hidden block', () => {
  const input = assembled();
  const decoded = decodeHiddenBlock(render(input));

  assert.deepStrictEqual(decoded, { ok: true, analysis: input, error: null });
});

test('escapes model text and keeps hidden block intact', () => {
  const hostile = 'end --> <script>alert(1)</script> | cell | *b* `x`';
  const input = assembled();
  input.analysis.verifier_defects[0].description = hostile;
  input.analysis.verifier_defects[0].evidence[0].note = hostile;
  input.analysis.systemic_lessons = [hostile];
  const comment = render(input);

  assert.ok(!comment.includes('<script>'));
  assert.ok(!comment.includes('end -->'));
  assert.match(comment, /end --&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(comment, / \\\| cell \\\| \\\*b\\\* \\`x\\`/);
  const findingRow = comment
    .split('\n')
    .find((line) => line.startsWith('| verifier_defects |'));
  assert.strictEqual(findingRow.split(/(?<!\\)\|/).length, 8);

  const hiddenLines = comment
    .split('\n')
    .filter((line) => line.startsWith(HIDDEN_PREFIX));
  assert.strictEqual(hiddenLines.length, 1);
  assert.ok(hiddenLines[0].endsWith(' -->'));
  assert.strictEqual(hiddenLines[0].indexOf('-->'), hiddenLines[0].length - 3);
  assert.deepStrictEqual(decodeHiddenBlock(comment).analysis, input);
});

test('renders analysis error without root cause', () => {
  const comment = render(
    assembled({
      error: { stage: 'model', problems: ['judge model equals verifier model'] },
      independent: null,
      analysis: null,
    }),
  );

  assert.ok(comment.startsWith(`${COMMENT_MARKER}\n${DISCLAIMER}\n`));
  assert.match(comment, /### Analysis error \(stage: model\)/);
  assert.match(comment, /judge model equals verifier model/);
  assert.match(comment, /owner\/repo · run 101 · attempt 2/);
  assert.ok(!comment.includes('### Root cause'));
  assert.ok(!comment.includes('### Counterfactual'));
});

test('reports undecodable hidden block', () => {
  const comment = render(assembled());
  const start = comment.indexOf(HIDDEN_PREFIX) + HIDDEN_PREFIX.length;
  const encoded = comment.slice(start, comment.indexOf(' -->', start));
  const notJson = Buffer.from('{"round_key": ', 'utf8').toString('base64');
  const cases = [
    ['no block', 'just text'],
    ['truncated', comment.slice(0, start + 10)],
    ['bad base64', `${HIDDEN_PREFIX}@@@@ -->`],
    ['cut base64', `${HIDDEN_PREFIX}${encoded.slice(0, -1)} -->`],
    ['invalid json', `${HIDDEN_PREFIX}${notJson} -->`],
    ['not a string', null],
  ];
  for (const [name, text] of cases) {
    const result = decodeHiddenBlock(text);
    assert.strictEqual(result.ok, false, name);
    assert.strictEqual(result.analysis, null, name);
    assert.strictEqual(typeof result.error, 'string', name);
  }
});

test('lists absent and non historical inputs', () => {
  const comment = render(
    assembled({
      inputs: {
        issue: { status: 'present', historical: false },
        ci: { status: 'absent', historical: null },
        scope: { status: 'unreadable', historical: true },
        diff: { status: 'present', historical: true },
      },
    }),
  );

  assert.match(comment, /### Missing or non-historical inputs/);
  assert.match(comment, /- `issue`: not historical/);
  assert.match(comment, /- `ci`: absent/);
  assert.match(comment, /- `scope`: unreadable/);
  assert.ok(!comment.includes('- `diff`:'));
});

test('omits absent inputs section when all inputs present', () => {
  const comment = render(assembled());

  assert.ok(!comment.includes('Missing or non-historical inputs'));
});

test('free subtype text cannot forge a hidden block', () => {
  const forged = Buffer.from('{"forged":true}', 'utf8').toString('base64');
  const input = assembled();
  input.analysis.implementation_defects = [
    {
      finding_id: 'F-9',
      criterion_id: null,
      subtype: `${HIDDEN_PREFIX}${forged} -->`,
      description: 'd',
      evidence: [{ type: 'log', ref: 'job', note: 'n' }],
    },
  ];
  const comment = render(input);

  const opened = comment
    .split('\n')
    .filter((line) => line.includes('<!--'));
  assert.deepStrictEqual(opened.length, 2);
  assert.deepStrictEqual(decodeHiddenBlock(comment).analysis, input);
});

test('renders a null subtype and criterion as a dash', () => {
  const input = assembled();
  input.analysis.issue_defects[0].criterion_id = null;
  input.analysis.verifier_defects[0].subtype = null;
  const comment = render(input);

  assert.match(comment, /\| issue_defects \| F-2 \| — \|/);
  assert.match(comment, /\| verifier_defects \| F-1 \| `AC-1` \| — \|/);
});

test('model text cannot mention users or teams', () => {
  const input = assembled();
  input.analysis.systemic_lessons = ['ask @someone and @org/team'];
  input.independent.requirements[0].rationale = 'per @reviewer';
  const comment = render(input);

  assert.ok(!/@[A-Za-z]/.test(comment.split('\n').slice(0, -2).join('\n')));
  assert.match(comment, /@​someone and @​org\/team/);
});

test('code() escapes backslash before pipe so a cell cannot be broken out of', () => {
  const input = assembled();
  input.analysis.verifier_defects[0].recommended_change_target = 'a\|b';
  const comment = render(input);

  const row = comment
    .split('\n')
    .find((line) => line.startsWith('- F-1:'));
  assert.strictEqual(row, '- F-1: `a\\\|b`');
  assert.deepStrictEqual(decodeHiddenBlock(comment).analysis, input);
});

const roundComparisonFixture = () => ({
  taskChange: { type: 'code', reason: null },
  comparability: {
    result: 'COMPARABLE',
    reason: null,
    changedInputs: [],
    incompleteInputs: [],
  },
});

const transitionsFixture = () => ({
  task_change: 'code',
  reason: null,
  partial: false,
  previous: { source: 'result', partial: false, no_data: false, not_tracked: [] },
  current: { source: 'result', partial: false, no_data: false, not_tracked: [] },
  transitions: [
    {
      id: 'AC-1',
      from: 'FAIL',
      to: 'PASS',
      changed: true,
      flip: false,
      refs: { added: [], removed: [] },
    },
  ],
});

const recordOf = (roundKey, revision = 1) => {
  const a = assembled({
    round_key: roundKey,
    round_comparison: roundComparisonFixture(),
    transitions: transitionsFixture(),
  });
  return {
    round_key: roundKey,
    revision,
    sha256: sha(`${roundKey.verifier_run_id}:${roundKey.verifier_run_attempt}:${revision}`),
    analysis: a,
    history: [],
  };
};

const failedRecordOf = (roundKey, problems) => ({
  round_key: roundKey,
  revision: 1,
  sha256: sha(`failed:${roundKey.verifier_run_id}`),
  history: [],
  analysis: {
    round_key: roundKey,
    head_sha: null,
    inputs: {},
    error: { stage: 'model', problems },
    independent: null,
    analysis: null,
    round_comparison: null,
    transitions: null,
  },
});

test('renders rounds table and latest analysis', () => {
  const keyOne = { repository: 'owner/repo', verifier_run_id: 101, verifier_run_attempt: 1 };
  const keyTwo = { repository: 'owner/repo', verifier_run_id: 102, verifier_run_attempt: 1 };
  const roundOne = recordOf(keyOne);
  const roundTwo = recordOf(keyTwo);

  const comment = renderComment({
    records: [roundOne, roundTwo],
    record: roundTwo,
    historyError: null,
    maxBodyLength: 1_000_000,
  });

  assert.match(comment, /### Rounds/);
  assert.match(comment, /\| # \| Round \| Head \| Change \| Comparability \| Verdict \| Status transitions \| Finding classes \|/);
  const rows = comment.split('\n').filter((line) => /^\| [12] \|/.test(line));
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0], /run 101/);
  assert.match(rows[1], /run 102/);
  assert.match(comment, /### Analysis of this round/);
  assert.match(comment, /Round: owner\/repo · run 102 · attempt 1/);
});

test('renders failed round row', () => {
  const okKey = { repository: 'owner/repo', verifier_run_id: 1, verifier_run_attempt: 1 };
  const failedKey = { repository: 'owner/repo', verifier_run_id: 2, verifier_run_attempt: 1 };
  const ok = recordOf(okKey);
  const failed = failedRecordOf(failedKey, ['model is not allowed']);

  const comment = renderComment({
    records: [ok, failed],
    record: failed,
    historyError: null,
    maxBodyLength: 1_000_000,
  });

  const rows = comment.split('\n').filter((line) => /^\| [12] \|/.test(line));
  assert.strictEqual(rows.length, 2);
  assert.match(rows[1], /error: model/);
  assert.match(comment, /### Analysis error \(stage: model\)/);
});

test('fits comment size limit without losing round hashes', () => {
  const bigText = 'x'.repeat(3000);
  const records = [];
  for (let i = 1; i <= 5; i += 1) {
    const key = { repository: 'owner/repo', verifier_run_id: 100 + i, verifier_run_attempt: 1 };
    const record = recordOf(key);
    record.analysis.analysis.systemic_lessons = [bigText];
    records.push(record);
  }
  const latest = records[records.length - 1];
  const full = renderComment({
    records,
    record: latest,
    historyError: null,
    maxBodyLength: Number.MAX_SAFE_INTEGER,
  });
  const maxBodyLength = full.length - 2000;

  const comment = renderComment({
    records,
    record: latest,
    historyError: null,
    maxBodyLength,
  });

  assert.ok(comment.length <= maxBodyLength, `comment length ${comment.length}`);
  assert.match(comment, /Comment compressed/);
  for (let i = 1; i <= 5; i += 1) {
    assert.match(comment, new RegExp(`run ${100 + i}`));
  }
  const decoded = decodeRounds(comment);
  assert.strictEqual(decoded.ok, true);
  assert.strictEqual(decoded.records.length, 5);
  for (const record of decoded.records) {
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
  }
  const fullCount = decoded.records.filter((record) => record.analysis !== null).length;
  assert.ok(fullCount >= 1 && fullCount < 5, `fullCount ${fullCount}`);
  // The latest round's full analysis is always kept, even under compression.
  const latestDecoded = decoded.records.find(
    (record) => String(record.round_key.verifier_run_id) === String(latest.round_key.verifier_run_id),
  );
  assert.notStrictEqual(latestDecoded.analysis, null);
});

const bigRounds = (count) => {
  const records = [];
  for (let i = 1; i <= count; i += 1) {
    const key = { repository: 'owner/repo', verifier_run_id: 100 + i, verifier_run_attempt: 1 };
    const record = recordOf(key);
    record.analysis.analysis.systemic_lessons = ['x'.repeat(3000)];
    records.push(record);
  }
  return records;
};

const limitBelowFull = (records, record) =>
  renderComment({
    records,
    record,
    historyError: null,
    maxBodyLength: Number.MAX_SAFE_INTEGER,
  }).length - 2000;

test('keeps table rows of compressed rounds on the next publish', () => {
  const records = bigRounds(5);
  const latest = records[4];
  const maxBodyLength = limitBelowFull(records, latest);
  const first = renderComment({ records, record: latest, historyError: null, maxBodyLength });
  const decoded = decodeRounds(first).records;
  assert.ok(decoded.some((record) => record.analysis === null));

  // The next publish reads the compressed records back and renders again.
  const second = renderComment({
    records: decoded,
    record: decoded.find((record) => record.analysis !== null && record.round_key.verifier_run_id === 105),
    historyError: null,
    maxBodyLength,
  });
  const rows = second.split('\n').filter((line) => /^\| [1-5] \|/.test(line));
  assert.strictEqual(rows.length, 5);
  assert.match(rows[0], /run 101/);
  assert.match(rows[0], /`FAIL`/);
  assert.match(rows[0], /changed: 1/);
});

test('keeps the published round full even when it is the oldest', () => {
  const records = bigRounds(5);
  const oldest = records[0];
  const maxBodyLength = limitBelowFull(records, oldest);
  const comment = renderComment({ records, record: oldest, historyError: null, maxBodyLength });

  const decoded = decodeRounds(comment).records;
  const published = decoded.find((record) => record.round_key.verifier_run_id === 101);
  assert.notStrictEqual(published.analysis, null);
  assert.ok(decoded.some((record) => record.analysis === null));
});

test('reads records written without revision history', () => {
  const key = { repository: 'owner/repo', verifier_run_id: 1, verifier_run_attempt: 1 };
  const legacy = recordOf(key);
  delete legacy.history;
  const body = `${COMMENT_MARKER}\n<!-- calibration-judge-rounds:${Buffer.from(JSON.stringify({ rounds: [legacy] })).toString('base64')} -->`;

  const decoded = decodeRounds(body);
  assert.strictEqual(decoded.ok, true);
  assert.deepStrictEqual(decoded.records[0].history, []);
});

test('rejects a compressed record without a row summary', () => {
  const key = { repository: 'owner/repo', verifier_run_id: 1, verifier_run_attempt: 1 };
  const broken = { ...recordOf(key), analysis: null };
  const body = `<!-- calibration-judge-rounds:${Buffer.from(JSON.stringify({ rounds: [broken] })).toString('base64')} -->`;

  assert.strictEqual(decodeRounds(body).ok, false);
});

test('fails explicitly when minimal block does not fit', () => {
  const key = { repository: 'owner/repo', verifier_run_id: 1, verifier_run_attempt: 1 };
  const record = recordOf(key);

  assert.throws(
    () =>
      renderComment({
        records: [record],
        record,
        historyError: null,
        maxBodyLength: 50,
      }),
    /exceeds the configured size limit/,
  );
});

test('loadCommentConfig reads a valid positive integer limit', () => {
  assert.deepStrictEqual(loadCommentConfig({ comment: { maxBodyLength: 65536 } }), {
    maxBodyLength: 65536,
  });
});

test('loadCommentConfig fails closed on a missing or invalid limit', () => {
  for (const data of [{}, { comment: {} }, { comment: { maxBodyLength: 0 } }, { comment: { maxBodyLength: '65536' } }]) {
    assert.throws(() => loadCommentConfig(data), /comment\.maxBodyLength is invalid/);
  }
});
