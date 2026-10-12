'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMENT_MARKER } = require('./acceptance-verdict/render');
const {
  parseCommentMetrics,
  parseVerdict,
  countRounds,
  aggregateMetrics,
  shareOf,
  main,
} = require('./verifier-metrics');

const commentWithTables = ({ verdict = 'FAIL', criteria = [], invariants = [] }) => {
  const rowLines = (rows) => rows.map((row) => `| ${row.join(' | ')} |`);
  const lines = [COMMENT_MARKER, `## Acceptance verifier: ${verdict}`];
  if (criteria.length > 0) {
    lines.push(
      '',
      '| Criterion | Status | Summary | References |',
      '|---|---|---|---|',
      ...rowLines(criteria),
    );
  }
  if (invariants.length > 0) {
    lines.push(
      '',
      '| Invariant | Status | Summary | References |',
      '|---|---|---|---|',
      ...rowLines(invariants),
    );
  }
  return lines.join('\n');
};

const makeSink = () => {
  const chunks = [];
  return {
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
};

// A stand-in for execFileSync(file, args, options): matches on a substring
// of the joined args so one fixture can serve both --pr and --prs shaped
// calls without caring about exact argument order.
const execFor = (fixtures) => {
  const calls = [];
  const exec = (file, args) => {
    calls.push(args);
    const joined = args.join(' ');
    const fixture = fixtures.find(({ match }) => joined.includes(match));
    if (fixture === undefined) {
      throw new Error(`unexpected gh call: ${joined}`);
    }
    if (fixture.error) throw fixture.error;
    return fixture.result;
  };
  exec.calls = calls;
  return exec;
};

test('counts items and unverifiable from comment table', () => {
  const comment = commentWithTables({
    criteria: [
      ['AC-1 does x', 'PASS', 'ok', 'f.js:1'],
      ['AC-2 does y', 'UNVERIFIABLE', 'not proven', 'f.js:2'],
      ['AC-3 does z', 'PASS (computed)', 'computed', 'f.js:3'],
    ],
  });
  assert.deepEqual(parseCommentMetrics(comment), { items: 3, unverifiable: 1 });
});

test('returns zero counts when comment has no verifier marker', () => {
  const comment = '## Acceptance verifier: PASS\n\nno marker here';
  assert.deepEqual(parseCommentMetrics(comment), { items: 0, unverifiable: 0 });
});

test('returns zero counts when marker present but table is empty', () => {
  const comment = commentWithTables({ verdict: 'PASS' });
  assert.deepEqual(parseCommentMetrics(comment), { items: 0, unverifiable: 0 });
});

test('ignores invariant table rows', () => {
  const comment = commentWithTables({
    verdict: 'PASS',
    criteria: [
      ['AC-1 a', 'PASS', 'ok', 'f.js:1'],
      ['AC-2 b', 'PASS', 'ok', 'f.js:2'],
    ],
    invariants: [
      ['INV-1 x', 'PASS', 'ok', 'f.js:3'],
      ['INV-2 y', 'N/A', 'ok', ''],
      ['INV-3 z', 'FAIL', 'bad', 'f.js:4'],
    ],
  });
  assert.deepEqual(parseCommentMetrics(comment), { items: 2, unverifiable: 0 });
});

test('counts verifier rounds from commit statuses by context', () => {
  const statuses = [
    { context: 'Acceptance Verifier' },
    { context: 'Acceptance Verifier' },
    { context: 'codecov/patch' },
    { context: 'acceptance verifier' },
  ];
  assert.equal(countRounds(statuses, 'Acceptance Verifier'), 2);
});

test('returns zero rounds for empty statuses list', () => {
  assert.equal(countRounds([], 'Acceptance Verifier'), 0);
});

test('parses PASS, FAIL and NEEDS_HUMAN verdict headings', () => {
  assert.equal(parseVerdict('## Acceptance verifier:  PASS  \n'), 'PASS');
  assert.equal(parseVerdict('## Acceptance verifier: FAIL'), 'FAIL');
  assert.equal(parseVerdict('## Acceptance verifier: NEEDS_HUMAN'), 'NEEDS_HUMAN');
});

test('returns null verdict when heading is missing', () => {
  assert.equal(parseVerdict('no heading at all'), null);
  assert.equal(parseVerdict('## Acceptance verifier: '), null);
  assert.equal(parseVerdict('## Acceptance verifier: MAYBE'), null);
});

test('computes unverifiable share rounded to two decimals', () => {
  assert.equal(shareOf(3, 12), 0.25);
});

test('reports zero share when items is zero', () => {
  assert.equal(shareOf(5, 0), 0);
});

test('aggregates verdict counts and shares across prs', () => {
  const prMetrics = [
    { verdict: 'PASS', items: 4, unverifiable: 0, runs: 1 },
    { verdict: 'PASS', items: 6, unverifiable: 1, runs: 2 },
    { verdict: 'FAIL', items: 5, unverifiable: 2, runs: 1 },
    { verdict: 'FAIL', items: 3, unverifiable: 0, runs: 1 },
    { verdict: 'NEEDS_HUMAN', items: 2, unverifiable: 1, runs: 3 },
  ];
  assert.deepEqual(aggregateMetrics(prMetrics), {
    verdict_counts: { PASS: 2, FAIL: 2, NEEDS_HUMAN: 1, unknown: 0 },
    needs_human_share: 0.2,
    items: 20,
    unverifiable: 4,
    runs: 8,
    unverifiable_share: 0.2,
  });
});

test('returns zero aggregate for empty pr list', () => {
  assert.deepEqual(aggregateMetrics([]), {
    verdict_counts: { PASS: 0, FAIL: 0, NEEDS_HUMAN: 0, unknown: 0 },
    needs_human_share: 0,
    items: 0,
    unverifiable: 0,
    runs: 0,
    unverifiable_share: 0,
  });
});

test('computes needs_human_share rounded to two decimals', () => {
  const prMetrics = [
    { verdict: 'PASS', items: 1, unverifiable: 0, runs: 1 },
    { verdict: 'PASS', items: 1, unverifiable: 0, runs: 1 },
    { verdict: 'NEEDS_HUMAN', items: 1, unverifiable: 0, runs: 1 },
  ];
  assert.equal(aggregateMetrics(prMetrics).needs_human_share, 0.33);
});

test('prints metrics json for a pr', () => {
  const comment = commentWithTables({
    verdict: 'FAIL',
    criteria: [
      ['AC-1 a', 'PASS', 'ok', 'f.js:1'],
      ['AC-2 b', 'PASS', 'ok', 'f.js:2'],
      ['AC-3 c', 'PASS', 'ok', 'f.js:3'],
      ['AC-4 d', 'UNVERIFIABLE', 'no', 'f.js:4'],
    ],
  });
  const exec = execFor([
    {
      match: 'issues/123/comments',
      result: JSON.stringify([
        { user: { login: 'github-actions[bot]' }, body: comment },
      ]),
    },
    {
      match: 'pr view 123',
      result: JSON.stringify({ commits: [{ oid: 'sha1' }, { oid: 'sha2' }] }),
    },
    {
      match: 'commits/sha1/statuses',
      result: JSON.stringify([{ context: 'Acceptance Verifier' }]),
    },
    {
      match: 'commits/sha2/statuses',
      result: JSON.stringify([
        { context: 'Acceptance Verifier' },
        { context: 'codecov/patch' },
      ]),
    },
  ]);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = main(['--pr', '123', '--context', 'Acceptance Verifier'], {
    exec,
    stdout,
    stderr,
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.text());
  assert.deepEqual(Object.keys(parsed), [
    'pr',
    'verdict',
    'runs',
    'items',
    'unverifiable',
    'unverifiable_share',
  ]);
  assert.deepEqual(parsed, {
    pr: 123,
    verdict: 'FAIL',
    runs: 2,
    items: 4,
    unverifiable: 1,
    unverifiable_share: 0.25,
  });
});

test('exits 1 with gh error message when gh fails', () => {
  const error = new Error('Command failed');
  error.stderr = 'gh: authentication required\n';
  const exec = execFor([{ match: 'issues/123/comments', error }]);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = main(['--pr', '123', '--context', 'Acceptance Verifier'], {
    exec,
    stdout,
    stderr,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /gh: authentication required/);
  assert.equal(stdout.text(), '');
});

test('prints aggregated metrics json for a list of prs', () => {
  const comment101 = commentWithTables({
    verdict: 'PASS',
    criteria: [
      ['AC-1 a', 'PASS', 'ok', 'f.js:1'],
      ['AC-2 b', 'PASS', 'ok', 'f.js:2'],
    ],
  });
  const comment102 = commentWithTables({
    verdict: 'FAIL',
    criteria: [
      ['AC-1 a', 'PASS', 'ok', 'f.js:1'],
      ['AC-2 b', 'UNVERIFIABLE', 'no', 'f.js:2'],
      ['AC-3 c', 'PASS', 'ok', 'f.js:3'],
    ],
  });
  const exec = execFor([
    {
      match: 'issues/101/comments',
      result: JSON.stringify([
        { user: { login: 'github-actions[bot]' }, body: comment101 },
      ]),
    },
    {
      match: 'pr view 101',
      result: JSON.stringify({ commits: [{ oid: 's1' }] }),
    },
    {
      match: 'commits/s1/statuses',
      result: JSON.stringify([{ context: 'Acceptance Verifier' }]),
    },
    {
      match: 'issues/102/comments',
      result: JSON.stringify([
        { user: { login: 'github-actions[bot]' }, body: comment102 },
      ]),
    },
    {
      match: 'pr view 102',
      result: JSON.stringify({ commits: [{ oid: 's2' }, { oid: 's3' }] }),
    },
    {
      match: 'commits/s2/statuses',
      result: JSON.stringify([{ context: 'Acceptance Verifier' }]),
    },
    {
      match: 'commits/s3/statuses',
      result: JSON.stringify([
        { context: 'Acceptance Verifier' },
        { context: 'Acceptance Verifier' },
      ]),
    },
  ]);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = main(['--prs', '101,102', '--context', 'Acceptance Verifier'], {
    exec,
    stdout,
    stderr,
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.text()), {
    prs: [101, 102],
    verdict_counts: { PASS: 1, FAIL: 1, NEEDS_HUMAN: 0, unknown: 0 },
    needs_human_share: 0,
    items: 5,
    unverifiable: 1,
    unverifiable_share: 0.2,
    runs: 4,
  });
});

test('exits 1 naming the failing pr when gh fails during --prs', () => {
  const comment201 = commentWithTables({
    verdict: 'PASS',
    criteria: [['AC-1 a', 'PASS', 'ok', 'f.js:1']],
  });
  const error = new Error('Command failed');
  error.stderr = 'gh: pull request not found\n';
  const exec = execFor([
    {
      match: 'issues/201/comments',
      result: JSON.stringify([
        { user: { login: 'github-actions[bot]' }, body: comment201 },
      ]),
    },
    { match: 'pr view 201', result: JSON.stringify({ commits: [] }) },
    { match: 'issues/202/comments', error },
  ]);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = main(['--prs', '201,202', '--context', 'Acceptance Verifier'], {
    exec,
    stdout,
    stderr,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /202/);
  assert.equal(stdout.text(), '');
});

test('exits 1 without calling gh when --context is missing', () => {
  const exec = execFor([]);
  const stderr = makeSink();
  const code = main(['--pr', '5'], { exec, stdout: makeSink(), stderr });
  assert.equal(code, 1);
  assert.match(stderr.text(), /--context/);
  assert.equal(exec.calls.length, 0);

  const codeEmpty = main(['--pr', '5', '--context', ''], {
    exec,
    stdout: makeSink(),
    stderr,
  });
  assert.equal(codeEmpty, 1);
  assert.equal(exec.calls.length, 0);
});

test('exits 1 without calling gh on invalid pr number', () => {
  const exec = execFor([]);
  const stderr1 = makeSink();
  const code1 = main(['--pr', 'abc', '--context', 'Acceptance Verifier'], {
    exec,
    stdout: makeSink(),
    stderr: stderr1,
  });
  assert.equal(code1, 1);
  assert.match(stderr1.text(), /abc/);

  const stderr2 = makeSink();
  const code2 = main(['--pr', '0', '--context', 'Acceptance Verifier'], {
    exec,
    stdout: makeSink(),
    stderr: stderr2,
  });
  assert.equal(code2, 1);
  assert.match(stderr2.text(), /0/);

  const stderr3 = makeSink();
  const code3 = main(['--prs', '12,x', '--context', 'Acceptance Verifier'], {
    exec,
    stdout: makeSink(),
    stderr: stderr3,
  });
  assert.equal(code3, 1);
  assert.match(stderr3.text(), /x/);
  assert.equal(exec.calls.length, 0);
});

