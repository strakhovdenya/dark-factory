'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createRegistry } = require('./registry');
const {
  CORE_CHECK_NAMES,
  BASE_REASON_CODES,
  createCoreRegistry,
  coreRegistry,
} = require('./index');
const { evaluate } = require('../verdict/verdict');
const { buildResult } = require('../verdict/result');
const { singleRun } = require('../verdict/second-run');
const { loadProfile } = require('../../profile/load');
const { deterministicReason } = require('../verdict/reason');
const {
  report,
  evaluateChecked,
  V2_SPEC,
  v2Report,
} = require('../verdict/test-helpers');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'profiles');
const FIXTURE_PROFILES = ['monorepo', 'single-package'];

const checksOf = (fixture) =>
  loadProfile(path.join(FIXTURES, fixture)).verifier?.checks ?? [];

// A core registry whose checks record each call and the context they got.
const spyRegistry = () => {
  const calls = [];
  const registry = createRegistry({ baseCodes: BASE_REASON_CODES });
  for (const name of CORE_CHECK_NAMES) {
    const check = coreRegistry.select([name]).checks[0];
    registry.register({
      ...check,
      run: (context) => {
        calls.push({ name, context });
        return check.run(context);
      },
    });
  }
  return { registry, calls };
};

// Inputs on which every core check finds something, so a check that runs
// always shows up in the reasons.
const FAILING_INPUTS = {
  spec: V2_SPEC,
  approval: { approved_hash: null, current_hash: 'b'.repeat(64) },
  scope: { out_of_scope: ['docs/x.md'] },
  computedItems: [
    {
      id: 'DOD-1',
      text: '',
      status: 'FAIL',
      summary: 'computed',
      refs: [],
      computed: true,
    },
  ],
  tamperingFindings: ['x.test.js:1: skip-style marker added'],
  refsProblems: ['AC-1: quote not found'],
  ciFailures: ['ci check failed: Sample (failure)'],
  allowedModels: ['other-model'],
};

const CHECK_OF_CODE = new Map(
  CORE_CHECK_NAMES.flatMap((name) =>
    coreRegistry.select([name]).checks[0].codes.map((code) => [code, name]),
  ),
);

for (const fixture of FIXTURE_PROFILES) {
  test(`runs only checks enabled by profile (${fixture})`, () => {
    const enabled = checksOf(fixture);
    assert.ok(enabled.length > 0, 'the fixture enables some checks');
    const { registry, calls } = spyRegistry();
    const result = evaluateChecked(v2Report(), {
      ...FAILING_INPUTS,
      registry,
      checks: enabled,
    });
    const called = [...new Set(calls.map(({ name }) => name))];
    const expected = CORE_CHECK_NAMES.filter((name) => enabled.includes(name));
    assert.deepStrictEqual(called, expected);
    // Each check got the same shared context with the parsed report.
    for (const { context } of calls) {
      assert.strictEqual(typeof context, 'object');
      assert.ok('report' in context);
    }
    const reasonChecks = new Set(
      result.reasons
        .map(({ code }) => CHECK_OF_CODE.get(code))
        .filter((name) => name !== undefined),
    );
    for (const name of CORE_CHECK_NAMES) {
      assert.strictEqual(
        reasonChecks.has(name),
        enabled.includes(name),
        `reasons of ${name}`,
      );
    }
  });

  test(`fails closed on unknown check in profile (${fixture})`, () => {
    const checks = [...checksOf(fixture), 'no-such-check'];
    const result = evaluateChecked(v2Report(), { spec: V2_SPEC, checks });
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.failures.includes('unknown check in profile: no-such-check'),
      result.failures.join('\n'),
    );
    const reason = result.reasons.find(({ code }) => code === 'unknown_check');
    assert.strictEqual(reason.source, 'deterministic');
    // Without a report the unknown check still fails the verdict.
    const noReport = evaluateChecked(null, { spec: V2_SPEC, checks });
    assert.ok(noReport.failures.includes('unknown check in profile: no-such-check'));
  });
}

test('runs only checks enabled by profile', () => {
  const { registry, calls } = spyRegistry();
  const result = evaluateChecked(report(), {
    ...FAILING_INPUTS,
    spec: { format: 'legacy', problems: [] },
    registry,
    checks: [],
  });
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(result.passed, true, result.failures.join('\n'));
  // Order of reasons follows registration, not the order in the profile.
  const forward = evaluateChecked(report(), {
    ...FAILING_INPUTS,
    checks: ['ci-checks', 'test-tampering-scan'],
  });
  const backward = evaluateChecked(report(), {
    ...FAILING_INPUTS,
    checks: ['test-tampering-scan', 'ci-checks'],
  });
  assert.deepStrictEqual(forward.failures, backward.failures);
});

test('fails closed on unknown check in profile', () => {
  const result = evaluateChecked(report(), { checks: ['no-such-check'] });
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.failures, [
    'unknown check in profile: no-such-check',
  ]);
});

const extraCheck = (reasons) => ({
  name: 'extra-check',
  stage: 'report',
  codes: ['extra_check_failed'],
  run: () => reasons,
});

test('accepts reason codes declared at registration', () => {
  const baseCount = BASE_REASON_CODES.length;
  const registry = createCoreRegistry();
  assert.strictEqual(registry.reasonCodes().has('extra_check_failed'), false);
  registry.register(
    extraCheck([deterministicReason('extra_check_failed', 'extra failed')]),
  );
  assert.strictEqual(registry.reasonCodes().has('extra_check_failed'), true);
  assert.strictEqual(BASE_REASON_CODES.length, baseCount, 'base list unchanged');
  assert.strictEqual(coreRegistry.reasonCodes().has('extra_check_failed'), false);

  const result = evaluateChecked(report(), {
    registry,
    checks: ['extra-check'],
  });
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.failures, ['extra failed']);
  const { reasons } = buildResult(singleRun(result));
  assert.deepStrictEqual(reasons.map(({ code }) => code), ['extra_check_failed']);

  // A code the check did not declare is an error, not a new code.
  const undeclared = createCoreRegistry();
  undeclared.register(
    extraCheck([deterministicReason('not_registered', 'undeclared code')]),
  );
  assert.throws(
    () => evaluateChecked(report(), { registry: undeclared, checks: ['extra-check'] }),
    /returned reason code "not_registered" it did not declare/,
  );
});

test('registry rejects malformed and duplicate checks', () => {
  const registry = createRegistry();
  const valid = extraCheck([]);
  registry.register(valid);
  assert.throws(() => registry.register(valid), /already registered/);
  assert.throws(() => registry.register({ ...valid, name: '' }), /name/);
  assert.throws(() => registry.register({ ...valid, name: 'b', stage: 'x' }), /stage/);
  assert.throws(() => registry.register({ ...valid, name: 'c', codes: [] }), /codes/);
  assert.throws(() => registry.register({ ...valid, name: 'd', run: null }), /run/);
  assert.throws(
    () => registry.register({ ...valid, name: 'e', note: 'x' }),
    /note must be a function/,
  );
});

test('core registry holds the core checks in a fixed order', () => {
  assert.deepStrictEqual(coreRegistry.names(), CORE_CHECK_NAMES);
  assert.deepStrictEqual(CORE_CHECK_NAMES, [
    'spec-approval',
    'affects-scope',
    'computed-items',
    'test-tampering-scan',
    'references',
    'ci-checks',
    'allowed-model',
  ]);
});

test('evaluate without a check list runs every registered check', () => {
  const all = evaluate(report(), {});
  const explicit = evaluate(report(), { checks: CORE_CHECK_NAMES });
  assert.deepStrictEqual(all.failures, explicit.failures);
});
