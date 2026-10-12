'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseCiFailures } = require('./ci');
const { evaluate } = require('./verdict');
const { report, ciJson, codeqlSuccess } = require('./test-helpers');

test('cancelled, timed_out, action_required and startup_failure fail', () => {
  const checks = [
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
  ].map((conclusion, index) => ({
    name: `job ${index}`,
    status: 'completed',
    conclusion,
  }));
  assert.strictEqual(
    parseCiFailures(ciJson({ checks: [codeqlSuccess, ...checks] })).length,
    4,
  );
});

test('a failed or errored commit status fails', () => {
  const statuses = [
    { name: 'codecov/patch', state: 'failure' },
    { name: 'other', state: 'error' },
  ];
  assert.deepStrictEqual(parseCiFailures(ciJson({ statuses })), [
    'ci status failed: codecov/patch (failure)',
    'ci status failed: other (error)',
  ]);
});

test('the verifier own checks are ignored', () => {
  const checks = ['Verify', 'Report'].map((name) => ({
    name,
    status: 'completed',
    conclusion: 'failure',
  }));
  const statuses = [{ name: 'Acceptance Verifier', state: 'failure' }];
  assert.deepStrictEqual(
    parseCiFailures(ciJson({ checks: [codeqlSuccess, ...checks], statuses })),
    [],
  );
});

test('missing or malformed ci.json fails closed', () => {
  assert.strictEqual(parseCiFailures('{oops'), null);
  assert.strictEqual(parseCiFailures('{"checks":[]}'), null);
  assert.strictEqual(parseCiFailures('{"checks":[1],"statuses":[]}'), null);
  const noStatus = ciJson({
    checks: [{ name: 'Analyze (javascript-typescript)' }],
  });
  assert.strictEqual(parseCiFailures(noStatus), null);
  const noConclusion = ciJson({
    checks: [{ name: 'Analyze (javascript-typescript)', status: 'x' }],
  });
  assert.strictEqual(parseCiFailures(noConclusion), null);
  const noState = ciJson({ statuses: [{ name: 'codecov/patch' }] });
  assert.strictEqual(parseCiFailures(noState), null);
  const result = evaluate(report(), { refsProblems: [] });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('CI results were not checked'));
});

test('CI workflow conclusion must be success', () => {
  assert.deepStrictEqual(parseCiFailures(ciJson({ conclusion: 'failure' })), [
    'CI workflow did not succeed (failure)',
  ]);
});

const REQUIRED_CHECKS = ['Lint', 'Other Check'];

test('reports required check missing when absent from ci.json', () => {
  const failures = parseCiFailures(ciJson({ checks: [] }), REQUIRED_CHECKS);
  assert.ok(failures.includes('required check missing: Lint'));
  assert.ok(failures.includes('required check missing: Other Check'));
});

test('reports required check not completed when still running', () => {
  const checks = [
    { name: 'Lint', status: 'in_progress', conclusion: null },
    { name: 'Other Check', status: 'completed', conclusion: 'success' },
  ];
  const failures = parseCiFailures(ciJson({ checks }), REQUIRED_CHECKS);
  assert.deepStrictEqual(failures, ['required check not completed: Lint']);
});

test('reports required check failed for non-success conclusion', () => {
  const checks = [
    { name: 'Lint', status: 'completed', conclusion: 'success' },
    { name: 'Other Check', status: 'completed', conclusion: 'failure' },
  ];
  const failures = parseCiFailures(ciJson({ checks }), REQUIRED_CHECKS);
  assert.ok(failures.includes('required check failed: Other Check (failure)'));
});

test('reports no required-check failure when all required checks succeed', () => {
  const checks = REQUIRED_CHECKS.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  }));
  const failures = parseCiFailures(ciJson({ checks }), REQUIRED_CHECKS);
  assert.deepStrictEqual(failures, []);
});

test('reports no required-check failure when the required list is empty', () => {
  const failures = parseCiFailures(ciJson({ checks: [] }), []);
  assert.deepStrictEqual(failures, []);
});

test('duplicate check-run entries for a required check fail closed', () => {
  const success = { name: 'Lint', status: 'completed', conclusion: 'success' };
  const failures = parseCiFailures(
    ciJson({ checks: [success, success] }),
    ['Lint'],
  );
  assert.deepStrictEqual(failures, [
    'required check ambiguous: Lint (2 matches)',
  ]);
});

// Derives the expected required-check names from ci.yml's own job `name:`
// lines (job id at 2-space indent, its first `name:` at 4-space indent) so
// this test carries no literal CI check name of its own (INV-6): it fails
// when required-checks.json and ci.yml's real jobs drift in either
// direction, not only when a hardcoded snapshot goes stale. Order is
// compared as a set: required-checks.json is a list of names, not a
// statement about ci.yml's job declaration order.
const JOB_ID_LINE = /^ {2}[A-Za-z0-9_-]+:\s*$/;
const JOB_NAME_LINE = /^ {4}name: (.+)$/;

const jobNamesOf = (workflowText) => {
  const lines = workflowText.split(/\r?\n/);
  const names = [];
  let awaitingName = false;
  for (const line of lines) {
    if (JOB_ID_LINE.test(line)) {
      awaitingName = true;
      continue;
    }
    if (!awaitingName) continue;
    const match = JOB_NAME_LINE.exec(line);
    if (match !== null) {
      names.push(match[1].trim());
      awaitingName = false;
    } else if (!/^ {4,}/.test(line)) {
      awaitingName = false;
    }
  }
  return names;
};

test('required-checks.json matches ci.yml job names and excludes codecov/patch', () => {
  const requiredFile = path.join(
    __dirname,
    '..',
    '..',
    '.github',
    'verifier',
    'required-checks.json',
  );
  const ciFile = path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');
  const requiredChecks = JSON.parse(fs.readFileSync(requiredFile, 'utf8'));
  const ciJobNames = jobNamesOf(fs.readFileSync(ciFile, 'utf8'));

  assert.ok(ciJobNames.length > 0);
  assert.strictEqual(new Set(requiredChecks).size, requiredChecks.length);
  assert.deepStrictEqual(new Set(requiredChecks), new Set(ciJobNames));
  assert.ok(!requiredChecks.includes('codecov/patch'));
});
