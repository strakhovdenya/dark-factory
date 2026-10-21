'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { COMMENT_MARKER } = require('./render');
const { buildAnalysisError } = require('./assemble');
const {
  toRoundKey,
  hashAnalysis,
  findOwnComment,
  encodeRounds,
  decodeRounds,
  mergeRecord,
  isRecordPresent,
  publish,
  publishWithRetry,
} = require('./publish');

const AUTHOR = 'judge-bot[bot]';
const REPOSITORY = 'owner/repo';
const MAX_BODY_LENGTH = 65536;

const keyOf = (runId, runAttempt) =>
  toRoundKey({ repository: REPOSITORY, runId, runAttempt });

const assembledFor = (runId, runAttempt, problem) =>
  buildAnalysisError(
    {
      round_key: {
        repository: REPOSITORY,
        verifier_run_id: runId,
        verifier_run_attempt: runAttempt,
      },
      head_sha: null,
      inputs: {},
    },
    'model',
    [problem],
  );

const commentOf = (id, login, body) => ({ id, user: { login }, body });

const publishRound = (comments, runId, runAttempt, problem) =>
  publish({
    comments,
    author: AUTHOR,
    roundKey: keyOf(runId, runAttempt),
    assembled: assembledFor(runId, runAttempt, problem),
    maxBodyLength: MAX_BODY_LENGTH,
  });

test('keeps earlier rounds when adding a round', () => {
  const first = publishRound([], 100, 1, 'round one');
  const second = publishRound(
    [commentOf(7, AUTHOR, first.body)],
    200,
    1,
    'round two',
  );
  const updated = publishRound(
    [commentOf(7, AUTHOR, second.body)],
    100,
    1,
    'round one updated',
  );

  assert.strictEqual(updated.commentId, 7);
  assert.strictEqual(updated.records.length, 2);
  const [roundOne, roundTwo] = updated.records;
  assert.deepStrictEqual(roundOne.round_key, keyOf(100, 1));
  assert.strictEqual(roundOne.revision, 2);
  assert.deepStrictEqual(roundOne.analysis.error.problems, ['round one updated']);
  assert.strictEqual(roundOne.sha256, hashAnalysis(roundOne.analysis));
  assert.notStrictEqual(roundOne.sha256, first.record.sha256);
  assert.deepStrictEqual(roundOne.history, [
    { revision: 1, sha256: first.record.sha256 },
  ]);
  assert.deepStrictEqual(roundTwo, second.records[1]);
  assert.ok(updated.body.includes(roundOne.sha256));
  assert.ok(updated.body.includes('round one updated'));

  const decoded = decodeRounds(updated.body);
  assert.strictEqual(decoded.ok, true);
  assert.deepStrictEqual(decoded.records, updated.records);
});

test('hashes canonical revision json', () => {
  const ordered = { a: 1, b: { c: 2, d: 3 }, e: [{ x: 1, y: 2 }] };
  const reordered = { e: [{ y: 2, x: 1 }], b: { d: 3, c: 2 }, a: 1 };
  const different = { a: 1, b: { c: 2, d: 4 }, e: [{ x: 1, y: 2 }] };

  assert.strictEqual(hashAnalysis(ordered), hashAnalysis(reordered));
  assert.notStrictEqual(hashAnalysis(ordered), hashAnalysis(different));
});

test('duplicate delivery changes nothing', () => {
  const first = publishRound([], 300, 2, 'same content');
  const redelivered = publishRound(
    [commentOf(9, AUTHOR, first.body)],
    300,
    2,
    'same content',
  );

  assert.strictEqual(redelivered.records.length, 1);
  assert.strictEqual(redelivered.record.revision, 1);
  assert.strictEqual(redelivered.record.sha256, first.record.sha256);
  assert.deepStrictEqual(redelivered.records, first.records);
});

test('non-duplicate rerun still appends a new revision', () => {
  const first = publishRound([], 300, 2, 'first');
  const rerun = publishRound([commentOf(9, AUTHOR, first.body)], 300, 2, 'rerun');
  const again = publishRound([commentOf(9, AUTHOR, rerun.body)], 300, 2, 'rerun again');

  assert.strictEqual(first.record.revision, 1);
  assert.strictEqual(first.records.length, 1);
  assert.strictEqual(rerun.record.revision, 2);
  assert.strictEqual(rerun.records.length, 1);
  assert.strictEqual(again.record.revision, 3);
  assert.strictEqual(again.records.length, 1);
});

test('another attempt of the same run is a separate round', () => {
  const first = publishRound([], 300, 1, 'attempt one');
  const second = publishRound(
    [commentOf(9, AUTHOR, first.body)],
    300,
    2,
    'attempt two',
  );
  assert.strictEqual(second.records.length, 2);
  assert.strictEqual(second.record.revision, 1);
});

test('merges concurrent round entries', () => {
  // Simulates a round published by a concurrent workflow run landing in the
  // comment between this round's own read and write: the caller always
  // rereads immediately before merging (AC-5), so by the time this merge
  // runs it already sees the concurrent round's record.
  const concurrent = publishRound([], 400, 1, 'other round');
  const result = publishRound(
    [commentOf(3, AUTHOR, concurrent.body)],
    500,
    1,
    'this round',
  );

  assert.strictEqual(result.records.length, 2);
  const keys = result.records.map((record) => record.round_key.verifier_run_id);
  assert.deepStrictEqual(keys.sort(), ['400', '500']);
});

test('abandons a write instead of overwriting a round published just before it', () => {
  // A concurrent round is published in the gap between this attempt's
  // merge-basis read and its recheck read, right before the write would
  // happen. Checking only "is my own revision present" after the write
  // would miss this: it stays present even if the write silently discarded
  // the concurrent round. The recheck must abort that write instead.
  const concurrent = publishRound([], 900, 1, 'concurrent round');
  let server = [];
  let calls = 0;
  const readComments = () => {
    calls += 1;
    if (calls === 2) server = [commentOf(1, AUTHOR, concurrent.body)];
    return server;
  };
  const writeComment = (commentId, body) => {
    server = [commentOf(1, AUTHOR, body)];
  };

  const outcome = publishWithRetry({
    author: AUTHOR,
    roundKey: keyOf(800, 1),
    assembled: assembledFor(800, 1, 'this round'),
    maxBodyLength: MAX_BODY_LENGTH,
    maxAttempts: 3,
    readComments,
    writeComment,
  });

  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.attempts, 2);
  const decoded = decodeRounds(server[0].body);
  const keys = decoded.records.map((record) => record.round_key.verifier_run_id);
  assert.deepStrictEqual(keys.sort(), ['800', '900']);
});

test('numbers concurrent revisions of one round', () => {
  const first = publishRound([], 600, 1, 'first');
  const concurrentSecond = publishRound(
    [commentOf(4, AUTHOR, first.body)],
    600,
    1,
    'concurrent second',
  );
  // The merge below is built from text that already carries revision 2,
  // written by a concurrent run between this caller's own read and write.
  const third = publishRound(
    [commentOf(4, AUTHOR, concurrentSecond.body)],
    600,
    1,
    'third',
  );

  assert.strictEqual(third.records.length, 1);
  const [record] = third.records;
  assert.strictEqual(record.revision, 3);
  assert.deepStrictEqual(record.history, [
    { revision: 1, sha256: first.record.sha256 },
    { revision: 2, sha256: concurrentSecond.record.sha256 },
  ]);
});

test('retries lost write and fails after limit', () => {
  const roundKey = keyOf(700, 1);
  const assembled = assembledFor(700, 1, 'retry case');

  // Succeeds after one lost write: the first write's verification read finds
  // nothing (simulating a concurrent overwrite between write and verify), so
  // the second attempt rereads, remerges and rewrites, and this time the
  // verification read sees it.
  let server = [];
  let dropNextWrite = true;
  const succeeding = publishWithRetry({
    author: AUTHOR,
    roundKey,
    assembled,
    maxBodyLength: MAX_BODY_LENGTH,
    maxAttempts: 3,
    readComments: () => server,
    writeComment: (commentId, body) => {
      if (dropNextWrite) {
        dropNextWrite = false;
        server = [];
        return;
      }
      server = [commentOf(1, AUTHOR, body)];
    },
  });
  assert.strictEqual(succeeding.ok, true);
  assert.strictEqual(succeeding.attempts, 2);
  assert.strictEqual(
    isRecordPresent(server, AUTHOR, succeeding.result.record),
    true,
  );

  // Every write appears lost: the loop exhausts its attempts and reports
  // failure instead of retrying forever.
  let lostServer = [];
  const failing = publishWithRetry({
    author: AUTHOR,
    roundKey,
    assembled,
    maxBodyLength: MAX_BODY_LENGTH,
    maxAttempts: 3,
    readComments: () => lostServer,
    writeComment: () => {
      lostServer = [];
    },
  });
  assert.strictEqual(failing.ok, false);
  assert.strictEqual(failing.attempts, 3);
});

test('ignores marker comments from other authors', () => {
  const existing = publishRound([], 400, 1, 'existing');
  const forged = encodeRounds([
    {
      round_key: keyOf(400, 1),
      revision: 41,
      sha256: 'a'.repeat(64),
      analysis: { forged: true },
      history: [],
    },
  ]);
  const comments = [
    commentOf(1, 'someone', `${COMMENT_MARKER}\n${forged}`),
    commentOf(2, 'other-tool[bot]', `${COMMENT_MARKER}\n${forged}`),
    commentOf(3, AUTHOR, existing.body),
  ];

  assert.strictEqual(findOwnComment(comments, AUTHOR).id, 3);
  const result = publishRound(comments, 400, 1, 'next');
  assert.strictEqual(result.commentId, 3);
  assert.strictEqual(result.record.revision, 2);

  const onlyForeign = publishRound(comments.slice(0, 2), 400, 1, 'next');
  assert.strictEqual(onlyForeign.commentId, null);
  assert.strictEqual(onlyForeign.record.revision, 1);
  assert.strictEqual(onlyForeign.historyError, null);
});

test('survives unreadable previous hidden block', () => {
  const broken = [
    `${COMMENT_MARKER}\n<!-- calibration-judge-rounds:not*base64 -->`,
    `${COMMENT_MARKER}\n<!-- calibration-judge-rounds:${Buffer.from('{').toString('base64')} -->`,
    `${COMMENT_MARKER}\n<!-- calibration-judge-rounds:${Buffer.from('{"rounds":[1]}').toString('base64')} -->`,
    `${COMMENT_MARKER}\n<!-- calibration-judge-rounds:abcd`,
    `${COMMENT_MARKER}\nno block at all`,
  ];
  for (const body of broken) {
    const result = publishRound([commentOf(5, AUTHOR, body)], 500, 1, 'new');
    assert.strictEqual(result.commentId, 5);
    assert.notStrictEqual(result.historyError, null);
    assert.strictEqual(result.records.length, 1);
    assert.deepStrictEqual(result.record.analysis.error.problems, ['new']);
    assert.ok(result.body.includes('The earlier analysis history was not read'));
    assert.strictEqual(decodeRounds(result.body).ok, true);
  }
});

test('redelivery with a legacy non-canonical hash is not a new revision', () => {
  const analysis = { b: 1, a: 2 };
  const legacySha = crypto.createHash('sha256').update(JSON.stringify(analysis)).digest('hex');
  const previous = [
    { round_key: keyOf(1, 1), revision: 4, sha256: legacySha, analysis, history: [] },
  ];

  const { records, record } = mergeRecord(previous, keyOf(1, 1), { b: 1, a: 2 });
  assert.strictEqual(record.revision, 4);
  assert.strictEqual(records, previous);
});

test('redelivery of a compressed round restores its analysis', () => {
  const analysis = { a: 1 };
  const summary = {
    head_sha: null,
    change_type: null,
    comparability: null,
    verdict: null,
    error_stage: 'model',
    transitions: '—',
    findings: '',
  };
  const previous = [
    {
      round_key: keyOf(1, 1),
      revision: 2,
      sha256: hashAnalysis(analysis),
      analysis: null,
      summary,
      history: [{ revision: 1, sha256: 'c'.repeat(64) }],
    },
  ];

  const { records, record } = mergeRecord(previous, keyOf(1, 1), { a: 1 });
  assert.strictEqual(record.revision, 2);
  assert.deepStrictEqual(record.analysis, analysis);
  assert.deepStrictEqual(record.history, previous[0].history);
  assert.strictEqual(records.length, 1);
});

test('publish keeps rounds of a comment written before revision history', () => {
  const legacy = {
    round_key: keyOf(50, 1),
    revision: 1,
    sha256: 'd'.repeat(64),
    analysis: assembledFor(50, 1, 'old round'),
  };
  const body = `${COMMENT_MARKER}\n<!-- calibration-judge-rounds:${Buffer.from(JSON.stringify({ rounds: [legacy] })).toString('base64')} -->`;

  const result = publishRound([commentOf(8, AUTHOR, body)], 51, 1, 'new round');
  assert.strictEqual(result.historyError, null);
  assert.strictEqual(result.records.length, 2);
  assert.deepStrictEqual(result.records[0].history, []);
});

test('mergeRecord keeps the input list unchanged', () => {
  const previous = mergeRecord([], keyOf(1, 1), { a: 1 }).records;
  const snapshot = structuredClone(previous);
  mergeRecord(previous, keyOf(1, 1), { a: 2 });
  assert.deepStrictEqual(previous, snapshot);
});

test('round keys compare numbers and strings alike', () => {
  const previous = mergeRecord(
    [],
    { repository: REPOSITORY, verifier_run_id: 10, verifier_run_attempt: 1 },
    { a: 1 },
  ).records;
  const { records, record } = mergeRecord(previous, keyOf('10', '1'), { a: 2 });
  assert.strictEqual(records.length, 1);
  assert.strictEqual(record.revision, 2);
});
