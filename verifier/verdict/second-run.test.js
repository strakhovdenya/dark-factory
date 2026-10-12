'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  VERDICT_NEEDS_HUMAN,
  TEST_TAMPERING_KEY,
  needsSecondRun,
  divergingIds,
  singleRun,
  reconcile,
} = require('./second-run');
const {
  report,
  evaluateChecked,
  runReport,
  evaluateRun,
  ciItem,
  V2_SPEC,
  LEGACY_SPEC,
  BAD_REF_PROBLEM,
  CI_FAILURE,
  SKIP_FINDING,
} = require('./test-helpers');

const badRefs = { refsProblems: [BAD_REF_PROBLEM] };

test('needs-second-run is true when every FAIL reason is model judgement', () => {
  const result = evaluateRun(runReport(), badRefs);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(needsSecondRun(result), true);
});

test('needs-second-run is false when a deterministic CI failure is present', () => {
  const result = evaluateRun(runReport({ statuses: { 'AC-1': 'FAIL' } }), {
    ciFailures: [CI_FAILURE],
  });
  assert.strictEqual(result.passed, false);
  assert.strictEqual(needsSecondRun(result), false);
});

test('needs-second-run is false on a passing verdict', () => {
  const result = evaluateRun(runReport());
  assert.strictEqual(result.passed, true);
  assert.strictEqual(needsSecondRun(result), false);
});

test('needs-second-run is false for a legacy issue', () => {
  const result = evaluateChecked(report(), { spec: LEGACY_SPEC, ...badRefs });
  assert.strictEqual(result.passed, false);
  assert.strictEqual(needsSecondRun(result), false);
});

test('needs-second-run is true when the first report is missing', () => {
  const result = evaluateRun(null);
  assert.strictEqual(result.report, null);
  assert.strictEqual(needsSecondRun(result), true);
});

test('needs-second-run is true when the first report is invalid', () => {
  assert.strictEqual(needsSecondRun(evaluateRun('{not json')), true);
});

test('needs-second-run is false for a missing first report with a deterministic failure', () => {
  const result = evaluateRun(null, { ciFailures: [CI_FAILURE] });
  assert.strictEqual(needsSecondRun(result), false);
});

test('a failed computed item blocks the second run even without a first report', () => {
  const computed = {
    id: 'DOD-1',
    text: '',
    status: 'FAIL',
    summary: 'check missing',
    refs: [],
    computed: true,
  };
  for (const raw of [null, '{not json']) {
    const result = evaluateRun(raw, { computedItems: [computed] });
    assert.ok(result.failures.includes('criterion failed: DOD-1'));
    assert.strictEqual(needsSecondRun(result), false);
  }
});

test('model test_tampering counts as a model reason', () => {
  const result = evaluateRun(runReport({ testTampering: ['assertion removed'] }));
  assert.strictEqual(result.passed, false);
  assert.strictEqual(needsSecondRun(result), true);
});

test('a tampering scan finding blocks the second run', () => {
  const result = evaluateRun(runReport(), { tamperingFindings: [SKIP_FINDING] });
  assert.strictEqual(result.passed, false);
  assert.strictEqual(needsSecondRun(result), false);
});

test('needs-second-run is false when reasons are mixed deterministic and model', () => {
  const result = evaluateRun(runReport(), {
    ...badRefs,
    ciFailures: [CI_FAILURE],
  });
  assert.strictEqual(needsSecondRun(result), false);
});

test('an UNVERIFIABLE item counts as a model reason', () => {
  const raw = runReport({ statuses: { 'AC-1': 'UNVERIFIABLE' } });
  assert.strictEqual(needsSecondRun(evaluateRun(raw)), true);
});

test('agreeing runs take the second run verdict and can pass', () => {
  const first = evaluateRun(runReport(), badRefs);
  const second = evaluateRun(runReport());
  const outcome = reconcile(first, second);
  assert.strictEqual(outcome.verdict, 'PASS');
  assert.strictEqual(outcome.result, second);
  assert.deepStrictEqual(outcome.diverged, []);
  assert.deepStrictEqual(outcome.secondRun.firstFailures, first.failures);
});

test('matching statuses across both runs keep the verdict FAIL', () => {
  const failing = runReport({ statuses: { 'AC-1': 'FAIL' } });
  const outcome = reconcile(evaluateRun(failing), evaluateRun(failing));
  assert.strictEqual(outcome.verdict, 'FAIL');
  assert.deepStrictEqual(outcome.diverged, []);
});

test('diverging statuses between runs produce NEEDS_HUMAN naming the ids', () => {
  const first = evaluateRun(
    runReport({ statuses: { 'AC-1': 'FAIL', 'TR-1': 'FAIL' } }),
  );
  const outcome = reconcile(first, evaluateRun(runReport()));
  assert.strictEqual(outcome.verdict, VERDICT_NEEDS_HUMAN);
  assert.deepStrictEqual(outcome.diverged, ['AC-1', 'TR-1']);
});

test('a diverging invariant status also produces NEEDS_HUMAN', () => {
  const first = evaluateRun(runReport({ statuses: { 'INV-1': 'FAIL' } }));
  const outcome = reconcile(first, evaluateRun(runReport()));
  assert.strictEqual(outcome.verdict, VERDICT_NEEDS_HUMAN);
  assert.deepStrictEqual(outcome.diverged, ['INV-1']);
});

test('a test_tampering disagreement produces NEEDS_HUMAN', () => {
  const first = evaluateRun(runReport({ testTampering: ['assertion removed'] }));
  const outcome = reconcile(first, evaluateRun(runReport()));
  assert.strictEqual(outcome.verdict, VERDICT_NEEDS_HUMAN);
  assert.deepStrictEqual(outcome.diverged, [TEST_TAMPERING_KEY]);
});

test('computed ci and absence ids are not compared', () => {
  const items = V2_SPEC.items.filter(({ id }) => id !== 'DOD-1');
  const spec = { ...V2_SPEC, items: [...items, ciItem('DOD-1', 'Test')] };
  const first = evaluateRun(runReport({ statuses: { 'DOD-1': 'FAIL' } }), {
    spec,
  });
  const second = evaluateRun(runReport(), { spec });
  const outcome = reconcile(first, second);
  assert.deepStrictEqual(outcome.diverged, []);
  assert.strictEqual(outcome.verdict, 'PASS');
});

test('an id missing from the first report is not a divergence', () => {
  const first = JSON.parse(runReport());
  first.criteria = first.criteria.filter(({ id }) => id !== 'TR-1');
  const second = JSON.parse(runReport({ statuses: { 'TR-1': 'FAIL' } }));
  assert.deepStrictEqual(divergingIds(first, second, V2_SPEC.items), []);
});

test('a missing first report takes the valid second report verdict', () => {
  const outcome = reconcile(evaluateRun(null), evaluateRun(runReport()));
  assert.strictEqual(outcome.verdict, 'PASS');
  assert.strictEqual(outcome.secondRun.firstEntries, null);
});

test('an invalid or missing second report keeps the verdict FAIL', () => {
  const first = evaluateRun(runReport(), badRefs);
  for (const raw of [null, '{not json']) {
    const outcome = reconcile(first, evaluateRun(raw));
    assert.strictEqual(outcome.verdict, 'FAIL');
    assert.notStrictEqual(outcome.secondRun, null);
  }
});

test('a single run keeps its own verdict and records no second run', () => {
  const passing = singleRun(evaluateRun(runReport()));
  assert.strictEqual(passing.verdict, 'PASS');
  assert.strictEqual(passing.secondRun, null);
  const failing = singleRun(evaluateRun(runReport(), badRefs));
  assert.strictEqual(failing.verdict, 'FAIL');
  assert.deepStrictEqual(failing.diverged, []);
});

test('first entries list every criterion and invariant status', () => {
  const first = evaluateRun(runReport({ statuses: { 'AC-1': 'FAIL' } }));
  const outcome = reconcile(first, evaluateRun(runReport()));
  assert.deepStrictEqual(outcome.secondRun.firstEntries, [
    { id: 'AC-1', status: 'FAIL' },
    { id: 'TR-1', status: 'PASS' },
    { id: 'DOD-1', status: 'PASS' },
    { id: 'INV-1', status: 'PASS' },
    { id: 'INV-2', status: 'N/A' },
  ]);
});
