'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  NOT_REPORTED,
  NOT_TRACKED,
  SOURCE_RESULT,
  SOURCE_VERDICT2,
  SOURCE_VERDICT,
  roundStatuses,
  computeTransitions,
} = require('./transitions');

const ref = (path, quote) => ({ path, quote });

const resultItem = (id, statuses, refs = [], source = 'model') => ({
  id,
  source,
  statuses,
  refs,
});

const resultOf = (items) => ({
  verdict: 'FAIL',
  spec_format: 'v2',
  items,
  reasons: [],
});

const roundOf = (items) => ({ result: resultOf(items) });

const entry = (id, status, refs = []) => ({
  id,
  text: 'model text',
  status,
  summary: 'checked',
  refs: refs.map((item) => ({ ...item, line: 1, kind: 'impl' })),
});

const reportOf = (criteria, invariants = []) => ({
  criteria,
  invariants,
  test_tampering: [],
  risk_zones: ['none'],
  out_of_scope_files: [],
});

const byId = (outcome, id) =>
  outcome.transitions.find((transition) => transition.id === id);

const DEFECT_FATE_FIELDS = [
  'fate',
  'defect_fate',
  'finding_fate',
  'resolved',
  'persisting',
];

test('computes per id status transitions', () => {
  const previous = roundOf([
    resultItem('AC-1', ['FAIL']),
    resultItem('INV-1', ['PASS']),
    resultItem('DOD-1', ['FAIL'], [], 'computed'),
  ]);
  const current = roundOf([
    resultItem('AC-1', ['PASS']),
    resultItem('INV-1', ['FAIL']),
    resultItem('DOD-1', ['PASS'], [], 'computed'),
  ]);
  const outcome = computeTransitions(previous, current, 'code');
  assert.strictEqual(outcome.partial, false);
  assert.strictEqual(outcome.previous.source, SOURCE_RESULT);
  assert.deepStrictEqual(
    outcome.transitions.map(({ id, from, to, changed }) => ({
      id,
      from,
      to,
      changed,
    })),
    [
      { id: 'AC-1', from: 'FAIL', to: 'PASS', changed: true },
      { id: 'INV-1', from: 'PASS', to: 'FAIL', changed: true },
      { id: 'DOD-1', from: 'FAIL', to: 'PASS', changed: true },
    ],
  );
});

test('a diverged item is shown as both statuses', () => {
  const previous = roundOf([resultItem('AC-1', ['FAIL', 'PASS'])]);
  const current = roundOf([resultItem('AC-1', ['PASS'])]);
  const transition = byId(computeTransitions(previous, current, 'code'), 'AC-1');
  assert.strictEqual(transition.from, 'FAIL/PASS');
  assert.strictEqual(transition.to, 'PASS');
});

test('marks missing ids as not reported', () => {
  const previous = roundOf([resultItem('AC-1', ['PASS'])]);
  const current = roundOf([resultItem('AC-2', ['FAIL'])]);
  const outcome = computeTransitions(previous, current, 'none');
  const gone = byId(outcome, 'AC-1');
  const appeared = byId(outcome, 'AC-2');
  assert.strictEqual(gone.from, 'PASS');
  assert.strictEqual(gone.to, NOT_REPORTED);
  assert.strictEqual(appeared.from, NOT_REPORTED);
  assert.strictEqual(appeared.to, 'FAIL');
  assert.strictEqual(gone.flip, false);
  assert.strictEqual(appeared.flip, false);
});

test('marks flip when task did not change', () => {
  const previous = roundOf([
    resultItem('AC-1', ['FAIL']),
    resultItem('AC-2', ['PASS']),
  ]);
  const current = roundOf([
    resultItem('AC-1', ['PASS']),
    resultItem('AC-2', ['PASS']),
  ]);
  const outcome = computeTransitions(previous, current, 'none');
  assert.strictEqual(outcome.task_change, 'none');
  assert.strictEqual(byId(outcome, 'AC-1').flip, true);
  assert.strictEqual(byId(outcome, 'AC-2').flip, false);
});

test('does not mark flip after code change', () => {
  const previous = roundOf([resultItem('AC-1', ['FAIL'])]);
  const current = roundOf([resultItem('AC-1', ['PASS'])]);
  for (const type of ['code', 'issue', 'both', null, undefined]) {
    const transition = byId(computeTransitions(previous, current, type), 'AC-1');
    assert.strictEqual(transition.changed, true);
    assert.strictEqual(transition.flip, false, String(type));
  }
});

test('fail to pass is not resolved', () => {
  const previous = roundOf([resultItem('AC-1', ['FAIL'])]);
  const current = roundOf([resultItem('AC-1', ['PASS'])]);
  const outcome = computeTransitions(previous, current, 'code');
  const transition = byId(outcome, 'AC-1');
  assert.deepStrictEqual(Object.keys(transition).sort(), [
    'changed',
    'flip',
    'from',
    'id',
    'refs',
    'to',
  ]);
  for (const field of DEFECT_FATE_FIELDS) {
    assert.ok(!(field in transition), field);
    assert.ok(!(field in outcome), field);
  }
  assert.doesNotMatch(JSON.stringify(outcome), /RESOLVED|PERSISTING/);
});

test('falls back to model reports for old rounds', () => {
  const spec = {
    format: 'v2',
    problems: [],
    items: [
      { id: 'AC-1', type: 'behavior' },
      { id: 'DOD-1', type: 'ci' },
    ],
  };
  const verdict = reportOf([entry('AC-1', 'FAIL')]);
  const verdict2 = reportOf([entry('AC-1', 'PASS')], [entry('INV-1', 'PASS')]);

  const withSecond = roundStatuses({ result: null, verdict2, verdict, spec });
  assert.strictEqual(withSecond.source, SOURCE_VERDICT2);
  assert.deepStrictEqual(withSecond.items.get('AC-1').statuses, ['PASS']);
  assert.deepStrictEqual(withSecond.notTracked, ['DOD-1']);

  const invalidSecond = roundStatuses({
    result: null,
    verdict2: { criteria: 'broken' },
    verdict,
    spec,
  });
  assert.strictEqual(invalidSecond.source, SOURCE_VERDICT);
  assert.deepStrictEqual(invalidSecond.items.get('AC-1').statuses, ['FAIL']);

  const invalidResult = roundStatuses({ result: { items: 'x' }, verdict, spec });
  assert.strictEqual(invalidResult.source, SOURCE_VERDICT);

  const current = roundOf([
    resultItem('AC-1', ['PASS']),
    resultItem('DOD-1', ['PASS'], [], 'computed'),
  ]);
  const outcome = computeTransitions({ verdict, spec }, current, 'code');
  assert.strictEqual(outcome.partial, true);
  assert.strictEqual(outcome.previous.partial, true);
  assert.strictEqual(outcome.previous.source, SOURCE_VERDICT);
  assert.deepStrictEqual(outcome.previous.not_tracked, ['DOD-1']);
  assert.strictEqual(outcome.current.partial, false);
  const ci = byId(outcome, 'DOD-1');
  assert.strictEqual(ci.from, NOT_TRACKED);
  assert.strictEqual(ci.to, 'PASS');
  assert.strictEqual(ci.changed, false);
});

test('a stray model entry for a computed item in an old round stays not tracked', () => {
  const spec = {
    format: 'v2',
    problems: [],
    items: [
      { id: 'AC-1', type: 'behavior' },
      { id: 'DOD-1', type: 'ci' },
      { id: 'DOD-2', type: 'absence' },
    ],
  };
  const verdict = reportOf([
    entry('AC-1', 'PASS'),
    entry('DOD-1', 'FAIL'),
    entry('DOD-2', 'FAIL'),
  ]);
  const old = roundStatuses({ verdict, spec });
  assert.deepStrictEqual([...old.items.keys()], ['AC-1']);
  assert.deepStrictEqual(old.notTracked, ['DOD-1', 'DOD-2']);

  const current = roundOf([
    resultItem('AC-1', ['PASS']),
    resultItem('DOD-1', ['PASS'], [], 'computed'),
    resultItem('DOD-2', ['PASS'], [], 'computed'),
  ]);
  const outcome = computeTransitions({ verdict, spec }, current, 'none');
  for (const id of ['DOD-1', 'DOD-2']) {
    const transition = byId(outcome, id);
    assert.strictEqual(transition.from, NOT_TRACKED);
    assert.strictEqual(transition.changed, false);
    assert.strictEqual(transition.flip, false);
  }
});

test('diffs quoted references ignoring whitespace', () => {
  const previous = roundOf([
    resultItem('AC-1', ['FAIL'], [
      ref('a.js', 'const  x =   1;'),
      ref('a.js', 'old line'),
    ]),
  ]);
  const current = roundOf([
    resultItem('AC-1', ['FAIL'], [
      ref('a.js', ' const x = 1; '),
      ref('b.js', 'new line'),
    ]),
  ]);
  const transition = byId(computeTransitions(previous, current, 'none'), 'AC-1');
  assert.deepStrictEqual(transition.refs, {
    added: [ref('b.js', 'new line')],
    removed: [ref('a.js', 'old line')],
  });
  assert.strictEqual(transition.changed, false);
  assert.strictEqual(transition.flip, false);

  const samePathOtherQuote = computeTransitions(
    roundOf([resultItem('AC-2', ['PASS'], [ref('a.js', 'one')])]),
    roundOf([resultItem('AC-2', ['PASS'], [ref('c.js', 'one')])]),
    'code',
  );
  assert.deepStrictEqual(byId(samePathOtherQuote, 'AC-2').refs, {
    added: [ref('c.js', 'one')],
    removed: [ref('a.js', 'one')],
  });
});

test('handles round without any report', () => {
  const previous = roundOf([
    resultItem('AC-1', ['PASS']),
    resultItem('INV-1', ['FAIL']),
  ]);
  for (const empty of [{}, { result: null, verdict2: null, verdict: null }, null]) {
    const outcome = computeTransitions(previous, empty, 'none');
    assert.strictEqual(outcome.current.no_data, true);
    assert.strictEqual(outcome.current.source, null);
    assert.strictEqual(outcome.partial, true);
    for (const transition of outcome.transitions) {
      assert.strictEqual(transition.to, NOT_REPORTED);
      assert.strictEqual(transition.flip, false);
    }
    assert.strictEqual(outcome.transitions.length, 2);
  }
  const reversed = computeTransitions({ verdict: 'not json' }, previous, 'none');
  assert.strictEqual(reversed.previous.no_data, true);
  assert.ok(reversed.transitions.every(({ from }) => from === NOT_REPORTED));
});

test('first round has no transitions', () => {
  const outcome = computeTransitions(null, roundOf([resultItem('AC-1', ['PASS'])]), null);
  assert.strictEqual(outcome.reason, 'first round');
  assert.strictEqual(outcome.previous, null);
  assert.deepStrictEqual(outcome.transitions, []);
});
