'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  loadFingerprintConfig,
  classifyTaskChange,
  computeFingerprint,
  compareRounds,
} = require('./compare');

const CONFIG = {
  significantInputs: [
    { key: 'baseSha', manifestField: 'base_sha' },
    { key: 'verifierCommit', manifestField: 'verifier_commit', statusKey: 'provenance' },
    { key: 'model', manifestField: 'model', statusKey: 'provenance' },
    { key: 'codexVersion', manifestField: 'codex_version', statusKey: 'provenance' },
    {
      key: 'trustedConfigHashes',
      manifestField: 'trusted_config_hashes',
      presentByFile: true,
    },
    { key: 'ciSnapshot', inputKey: 'ci', stripIgnoredFields: true },
    { key: 'specApproval', inputKey: 'specApproval' },
    {
      key: 'authorizedExceptions',
      inputKey: 'verifierComment',
      extractLinesContaining: [
        'manual-verified ignored:',
        'test removal approval ignored:',
      ],
    },
  ],
  ciSnapshotIgnoredFields: ['id', 'started_at', 'completed_at'],
};

const CI_SNAPSHOT = {
  checks: [
    { name: 'check-alpha', conclusion: 'success', id: 1, started_at: 't1' },
    { name: 'check-beta', conclusion: 'success', id: 2, started_at: 't2' },
  ],
  statuses: [{ context: 'codecov/patch', state: 'success', id: 3 }],
};

// Mirrors the real rendered verifier comment shape closely enough to
// exercise the head_sha-leak bug the code review found: the Provenance
// block embeds head_sha, which must not leak into the authorizedExceptions
// fingerprint value (compare.js's extractLinesContaining keeps only the
// "ignored:" lines, discarding the rest of the comment).
const makeVerifierComment = (headSha, ignoredLines = []) =>
  [
    '## Acceptance verifier: PASS',
    ...ignoredLines,
    '**Provenance**',
    `- PR head: ${headSha}`,
  ].join('\n');

const makeRound = (overrides = {}) => {
  const headSha = overrides.head_sha ?? 'head1';
  return {
    round_key: { repository: 'o/r', verifier_run_id: 1, verifier_run_attempt: 1 },
    base_sha: 'base1',
    head_sha: headSha,
    issue_body_sha256: 'a'.repeat(64),
    verifier_commit: 'commit1',
    model: 'model-a',
    codex_version: 'codex-1',
    trusted_config_hashes: {
      'verifier/prompt.md': { present: true, sha256: 'promptHash1' },
    },
    inputs: {
      provenance: { status: 'present', historical: true },
      ci: { status: 'present', historical: true },
      specApproval: { status: 'present', historical: true },
      verifierComment: { status: 'present', historical: true },
    },
    contents: {
      ci: structuredClone(CI_SNAPSHOT),
      specApproval: { approved_hash: 'h1', current_hash: 'h1' },
      verifierComment: makeVerifierComment(headSha),
    },
    ...overrides,
  };
};

const withRunIdentifiers = (round, runId, runAttempt) => ({
  ...round,
  round_key: { ...round.round_key, verifier_run_id: runId, verifier_run_attempt: runAttempt },
});

test('loadFingerprintConfig rejects a missing fingerprint section', () => {
  assert.throws(() => loadFingerprintConfig({}), /fingerprint is missing/);
});

test('loadFingerprintConfig rejects a malformed significantInputs entry', () => {
  assert.throws(
    () => loadFingerprintConfig({ fingerprint: { significantInputs: [{ key: 'x' }] } }),
    /significantInputs is invalid/,
  );
});

test('loadFingerprintConfig rejects a duplicate significant input key', () => {
  const data = {
    fingerprint: {
      significantInputs: [
        { key: 'x', manifestField: 'base_sha' },
        { key: 'x', manifestField: 'verifier_commit' },
      ],
    },
  };
  assert.throws(() => loadFingerprintConfig(data), /duplicate fingerprint input key: x/);
});

test('loadFingerprintConfig accepts a valid section and defaults ciSnapshotIgnoredFields', () => {
  const data = {
    fingerprint: { significantInputs: [{ key: 'baseSha', manifestField: 'base_sha' }] },
  };
  const config = loadFingerprintConfig(data);
  assert.deepStrictEqual(config.ciSnapshotIgnoredFields, []);
  assert.strictEqual(config.significantInputs.length, 1);
});

// AC-1
test('classifies code change', () => {
  const previous = makeRound();
  const current = makeRound({ head_sha: 'head2' });
  assert.deepStrictEqual(classifyTaskChange(previous, current), { type: 'code', reason: null });
});

// AC-2
test('classifies issue change', () => {
  const previous = makeRound();
  const current = makeRound({ issue_body_sha256: 'b'.repeat(64) });
  assert.deepStrictEqual(classifyTaskChange(previous, current), { type: 'issue', reason: null });
});

// AC-3
test('classifies both changes', () => {
  const previous = makeRound();
  const current = makeRound({ head_sha: 'head2', issue_body_sha256: 'b'.repeat(64) });
  assert.deepStrictEqual(classifyTaskChange(previous, current), { type: 'both', reason: null });
});

// AC-4
test('classifies no task change', () => {
  const previous = makeRound();
  const current = makeRound();
  assert.deepStrictEqual(classifyTaskChange(previous, current), { type: 'none', reason: null });
});

// AC-5
test('comparable when significant inputs match', () => {
  const previous = makeRound();
  const current = makeRound({ head_sha: 'head2' });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.taskChange.type, 'code');
  assert.deepStrictEqual(result.comparability, {
    result: 'COMPARABLE',
    reason: null,
    changedInputs: [],
    incompleteInputs: [],
  });
});

// AC-6
test('none with changed policy is inputs changed', () => {
  const previous = makeRound();
  const current = makeRound({
    model: 'model-b',
    contents: {
      ...makeRound().contents,
      ci: {
        ...structuredClone(CI_SNAPSHOT),
        checks: [{ ...CI_SNAPSHOT.checks[0], conclusion: 'failure' }, CI_SNAPSHOT.checks[1]],
      },
      specApproval: { approved_hash: null, current_hash: 'h1' },
    },
  });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.taskChange.type, 'none');
  assert.strictEqual(result.comparability.result, 'INPUTS_CHANGED');
  assert.ok(result.comparability.changedInputs.includes('model'));
  assert.ok(result.comparability.changedInputs.includes('ciSnapshot'));
  assert.ok(result.comparability.changedInputs.includes('specApproval'));
});

test('authorizedExceptions ignores head_sha noise in the verifier comment', () => {
  const previous = makeRound({ head_sha: 'head1' });
  const current = makeRound({ head_sha: 'head2' });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.taskChange.type, 'code');
  assert.strictEqual(result.comparability.result, 'COMPARABLE');
  assert.ok(!result.comparability.changedInputs.includes('authorizedExceptions'));
});

test('detects a changed authorized exception line', () => {
  const previous = makeRound();
  const current = makeRound({
    contents: {
      ...makeRound().contents,
      verifierComment: makeVerifierComment('head1', [
        'manual-verified ignored: set by someone',
      ]),
    },
  });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.comparability.result, 'INPUTS_CHANGED');
  assert.deepStrictEqual(result.comparability.changedInputs, ['authorizedExceptions']);
});

// AC-7
test('unknown when provenance is incomplete', () => {
  const previous = makeRound();
  const current = makeRound({
    inputs: { ...makeRound().inputs, provenance: { status: 'absent', historical: null } },
  });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.comparability.result, 'UNKNOWN');
  assert.ok(result.comparability.incompleteInputs.includes('verifierCommit'));
  assert.ok(result.comparability.incompleteInputs.includes('model'));
  assert.ok(result.comparability.incompleteInputs.includes('codexVersion'));
  assert.deepStrictEqual(result.comparability.changedInputs, []);
});

test('unknown when a significant input is historical: false', () => {
  const previous = makeRound();
  const current = makeRound({
    inputs: { ...makeRound().inputs, ci: { status: 'present', historical: false } },
  });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.comparability.result, 'UNKNOWN');
  assert.deepStrictEqual(result.comparability.incompleteInputs, ['ciSnapshot']);
});

// AC-8
test('normalizes ci snapshot order and timestamps', () => {
  const previous = makeRound();
  const current = makeRound({
    contents: {
      ...makeRound().contents,
      ci: {
        statuses: [{ context: 'codecov/patch', state: 'success', id: 99 }],
        checks: [
          { name: 'check-beta', conclusion: 'success', id: 20, started_at: 'later' },
          { name: 'check-alpha', conclusion: 'success', id: 10, started_at: 'other' },
        ],
      },
    },
  });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.comparability.result, 'COMPARABLE');
});

// AC-9
test('detects changed ci conclusion', () => {
  const previous = makeRound();
  const current = makeRound({
    contents: {
      ...makeRound().contents,
      ci: {
        ...structuredClone(CI_SNAPSHOT),
        checks: [{ ...CI_SNAPSHOT.checks[0], conclusion: 'failure' }, CI_SNAPSHOT.checks[1]],
      },
    },
  });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.comparability.result, 'INPUTS_CHANGED');
  assert.deepStrictEqual(result.comparability.changedInputs, ['ciSnapshot']);
});

test('detects an added or removed ci check', () => {
  const previous = makeRound();
  const current = makeRound({
    contents: {
      ...makeRound().contents,
      ci: { ...structuredClone(CI_SNAPSHOT), checks: [CI_SNAPSHOT.checks[0]] },
    },
  });
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.comparability.result, 'INPUTS_CHANGED');
  assert.deepStrictEqual(result.comparability.changedInputs, ['ciSnapshot']);
});

// AC-10
test('ignores run identifiers in fingerprint', () => {
  const previous = withRunIdentifiers(makeRound(), 1, 1);
  const current = withRunIdentifiers(makeRound(), 2, 1);
  const result = compareRounds(previous, current, CONFIG);
  assert.strictEqual(result.comparability.result, 'COMPARABLE');
});

// AC-11
test('first round has no comparison', () => {
  const current = makeRound();
  const result = compareRounds(null, current, CONFIG);
  assert.deepStrictEqual(result, {
    taskChange: { type: null, reason: 'first round' },
    comparability: { result: null, reason: 'first round', changedInputs: [], incompleteInputs: [] },
  });
});

// TR-1
test('missing task identity is not none', () => {
  const previous = makeRound({ head_sha: null });
  const current = makeRound();
  assert.deepStrictEqual(classifyTaskChange(previous, current), {
    type: null,
    reason: 'head_sha is missing',
  });

  const previousWithoutIssue = makeRound({ issue_body_sha256: null });
  assert.deepStrictEqual(classifyTaskChange(previousWithoutIssue, current), {
    type: null,
    reason: 'issue_body_sha256 is missing',
  });
});

test('computeFingerprint reports trusted config hashes as incomplete when a file is missing', () => {
  const round = makeRound({
    trusted_config_hashes: {
      'verifier/prompt.md': { present: false, sha256: null },
    },
  });
  const { incomplete } = computeFingerprint(round, CONFIG);
  assert.ok(incomplete.includes('trustedConfigHashes'));
});
