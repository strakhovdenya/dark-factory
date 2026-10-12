'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  goldenDirOf,
  GOLDEN_DIR_FIELD,
  readCases,
  readActualsRaw,
  parseActual,
  summarize,
  checkGoldenSet,
  render,
} = require('./verifier-eval');
const { REASON_CODES } = require('../verdict/result');
const { createCoreRegistry } = require('../checks');

const SCRIPT = path.join(__dirname, 'verifier-eval.js');

const MIN_PAIRS = 5;

const { CRITERION_FAILED, CI_CHECK_FAILED, INVARIANT_FAILED } = REASON_CODES;

/** @param {string} verdict @param {unknown} [reasons] */
const actualJson = (verdict, reasons = []) =>
  JSON.stringify({ actual: verdict, reasons });

/** @param {string} name @param {string} [code] @param {string | null} [id] */
const failCase = (name, code = CRITERION_FAILED, id = 'AC-1') => ({
  name,
  expected: 'FAIL',
  criterionId: id,
  reasonCode: code,
  pairOf: null,
  mutationKind: null,
  isValid: true,
});

const passCase = (name) => ({
  name,
  expected: 'PASS',
  criterionId: null,
  reasonCode: null,
  pairOf: null,
  mutationKind: null,
  isValid: true,
});

const mutationCase = (name, pairOf, mutationKind) => ({
  ...failCase(name),
  pairOf,
  mutationKind,
});

const caseJson = (expected, extra = {}) =>
  JSON.stringify({ expected, reason: 'x', ...extra });

/** @param {string} [code] @param {string | null} [id] */
const failCaseJson = (code = CRITERION_FAILED, id = 'AC-1') =>
  caseJson('FAIL', { expected_criterion_id: id, expected_reason_code: code });

const passCaseJson = () =>
  caseJson('PASS', { expected_criterion_id: null, expected_reason_code: null });

// A project root whose profile names its golden case directory.
const writeProfile = (dir, verifier) => {
  fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
  const profile = {
    branchTemplate: 'task/ISSUE-{issue}-{slug}',
    apps: [{ name: 'main', path: '.' }],
    ...(verifier === undefined ? {} : { verifier }),
  };
  fs.writeFileSync(path.join(dir, '.factory', 'profile.json'), JSON.stringify(profile));
};

const makeEvalDirs = (cases, results) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-eval-'));
  writeProfile(dir, { goldenDir: 'golden' });
  const casesDir = path.join(dir, 'golden');
  const resultsDir = path.join(dir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(casesDir, { recursive: true });
  for (const [name, text] of Object.entries(cases)) {
    fs.mkdirSync(path.join(casesDir, name), { recursive: true });
    fs.writeFileSync(path.join(casesDir, name, 'case.json'), text);
  }
  for (const [name, text] of Object.entries(results)) {
    fs.writeFileSync(path.join(resultsDir, `${name}.json`), text);
  }
  return { dir, casesDir, resultsDir };
};

// casesDir is <project>/golden, as makeEvalDirs lays it out.
const runCli = (casesDir, resultsDir) =>
  spawnSync(
    process.execPath,
    [SCRIPT, '--project', path.dirname(casesDir), resultsDir],
    { encoding: 'utf8' },
  );

test('parseActual accepts PASS and FAIL with reasons', () => {
  assert.deepStrictEqual(parseActual(actualJson('PASS')), {
    verdict: 'PASS',
    reasons: [],
    items: [],
  });
  const reasons = [{ code: CRITERION_FAILED, id: 'AC-1' }];
  assert.deepStrictEqual(parseActual(actualJson('FAIL', reasons)), {
    verdict: 'FAIL',
    reasons,
    items: [],
  });
});

test('parseActual rejects invalid JSON', () => {
  assert.strictEqual(parseActual('not json'), null);
});

test('parseActual rejects a value other than PASS/FAIL', () => {
  assert.strictEqual(parseActual(actualJson('MAYBE')), null);
});

test('parseActual rejects a result without a valid reasons list', () => {
  assert.strictEqual(parseActual(JSON.stringify({ actual: 'FAIL' })), null);
  assert.strictEqual(parseActual(actualJson('FAIL', 'x')), null);
  assert.strictEqual(parseActual(actualJson('FAIL', [{ id: null }])), null);
});

test('counts fail case caught by expected reason', () => {
  const reasons = [
    { code: CI_CHECK_FAILED, id: null },
    { code: CRITERION_FAILED, id: 'AC-1' },
  ];
  const summary = summarize([failCase('434')], {
    434: actualJson('FAIL', reasons),
  });
  assert.strictEqual(summary.falsePass, 0);
  assert.strictEqual(summary.falseFail, 0);
  assert.strictEqual(summary.runFailures, 0);
  assert.strictEqual(summary.reasonMismatches, 0);
  assert.strictEqual(summary.rows[0].outcome, 'matched');
  assert.deepStrictEqual(summary.rows[0].actualReasons, reasons);
});

test('counts unrelated fail as reason mismatch', () => {
  const unrelated = [{ code: CI_CHECK_FAILED, id: null }];
  const summary = summarize([failCase('434')], {
    434: actualJson('FAIL', unrelated),
  });
  assert.strictEqual(summary.reasonMismatches, 1);
  assert.strictEqual(summary.falsePass, 0);
  assert.strictEqual(summary.falseFail, 0);
  assert.strictEqual(summary.runFailures, 0);
  const noReasons = summarize([failCase('434')], { 434: actualJson('FAIL') });
  assert.strictEqual(noReasons.reasonMismatches, 1);
});

test('requires expected criterion id', () => {
  const otherId = [{ code: CRITERION_FAILED, id: 'AC-2' }];
  const summary = summarize([failCase('434')], {
    434: actualJson('FAIL', otherId),
  });
  assert.strictEqual(summary.reasonMismatches, 1);
  const noId = [{ code: CRITERION_FAILED, id: null }];
  const withoutId = summarize([failCase('434')], {
    434: actualJson('FAIL', noId),
  });
  assert.strictEqual(withoutId.reasonMismatches, 1);
  const otherCode = [{ code: INVARIANT_FAILED, id: 'AC-1' }];
  const wrongCode = summarize([failCase('434')], {
    434: actualJson('FAIL', otherCode),
  });
  assert.strictEqual(wrongCode.reasonMismatches, 1);
});

test('matches rule without criterion id by code', () => {
  const testCase = failCase('434', CI_CHECK_FAILED, null);
  const caught = summarize([testCase], {
    434: actualJson('FAIL', [{ code: CI_CHECK_FAILED, id: null }]),
  });
  assert.strictEqual(caught.reasonMismatches, 0);
  assert.strictEqual(caught.rows[0].outcome, 'matched');
  const wrongCode = summarize([testCase], {
    434: actualJson('FAIL', [{ code: CRITERION_FAILED, id: null }]),
  });
  assert.strictEqual(wrongCode.reasonMismatches, 1);
});

test('separates false pass and false fail', () => {
  const summary = summarize([failCase('434'), passCase('900')], {
    434: actualJson('PASS'),
    900: actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-1' }]),
  });
  assert.strictEqual(summary.falsePass, 1);
  assert.strictEqual(summary.falseFail, 1);
  assert.strictEqual(summary.reasonMismatches, 0);
  assert.strictEqual(summary.runFailures, 0);
  assert.deepStrictEqual(
    summary.rows.map((row) => row.outcome),
    ['false_pass', 'false_fail'],
  );
});

test('does not check reason for pass cases', () => {
  const warnings = [{ code: CI_CHECK_FAILED, id: null }];
  const summary = summarize([passCase('900')], {
    900: actualJson('PASS', warnings),
  });
  assert.strictEqual(summary.reasonMismatches, 0);
  assert.strictEqual(summary.falseFail, 0);
  assert.strictEqual(summary.rows[0].outcome, 'matched');
});

test('treats missing reason data as run failure', () => {
  const missingResult = summarize([failCase('434')], {});
  assert.strictEqual(missingResult.runFailures, 1);
  assert.deepStrictEqual(missingResult.rows[0].actualReasons, []);
  assert.strictEqual(missingResult.rows[0].actual, null);
  const notJson = summarize([failCase('434')], { 434: 'not json' });
  assert.strictEqual(notJson.runFailures, 1);
  const noField = summarize([failCase('434')], {
    434: JSON.stringify({ actual: 'FAIL' }),
  });
  assert.strictEqual(noField.runFailures, 1);
  const wrongValue = summarize([failCase('434')], { 434: actualJson('MAYBE') });
  assert.strictEqual(wrongValue.runFailures, 1);
  for (const summary of [missingResult, notJson, noField, wrongValue]) {
    assert.strictEqual(summary.falsePass, 0);
    assert.strictEqual(summary.falseFail, 0);
    assert.strictEqual(summary.reasonMismatches, 0);
  }
  const invalidCase = { ...failCase('434'), reasonCode: null, isValid: false };
  const noExpectation = summarize([invalidCase], {
    434: actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-1' }]),
  });
  assert.strictEqual(noExpectation.runFailures, 1);
  assert.strictEqual(noExpectation.reasonMismatches, 0);
});

test('readCases marks a case without expected reason as invalid', () => {
  const { dir, casesDir } = makeEvalDirs(
    {
      434: failCaseJson(),
      446: caseJson('FAIL'),
      463: failCaseJson('not_a_known_code'),
      470: caseJson('FAIL', {
        expected_criterion_id: '',
        expected_reason_code: CRITERION_FAILED,
      }),
      900: passCaseJson(),
      901: caseJson('PASS'),
      902: caseJson('PASS', {
        expected_criterion_id: 'AC-1',
        expected_reason_code: CRITERION_FAILED,
      }),
    },
    {},
  );
  const validity = Object.fromEntries(
    readCases(casesDir).map(({ name, isValid }) => [name, isValid]),
  );
  assert.deepStrictEqual(validity, {
    434: true,
    446: false,
    463: false,
    470: false,
    900: true,
    901: false,
    902: false,
  });
  fs.rmSync(dir, { recursive: true });
});

test('renders reason columns and separate counters', () => {
  const summary = summarize(
    [
      failCase('434', CI_CHECK_FAILED, null),
      failCase('446'),
      failCase('463'),
      failCase('470'),
      passCase('900'),
    ],
    {
      434: actualJson('FAIL', [{ code: CI_CHECK_FAILED, id: null }]),
      446: actualJson('FAIL', [{ code: INVARIANT_FAILED, id: 'INV-1' }]),
      463: actualJson('PASS'),
      900: actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-9' }]),
    },
  );
  const lines = render(summary).split('\n');
  assert.ok(
    lines.includes(
      'case | expected | actual | expected reason | actual reasons',
    ),
  );
  assert.ok(
    lines.includes('434 | FAIL | FAIL | ci_check_failed | ci_check_failed'),
  );
  assert.ok(
    lines.includes(
      '446 | FAIL | FAIL | criterion_failed#AC-1 | invariant_failed#INV-1',
    ),
  );
  assert.ok(lines.includes('463 | FAIL | PASS | criterion_failed#AC-1 | -'));
  assert.ok(lines.includes('470 | FAIL | ERROR | criterion_failed#AC-1 | -'));
  assert.ok(lines.includes('900 | PASS | FAIL | - | criterion_failed#AC-9'));
  assert.ok(lines.includes('run failures: 1'));
  assert.ok(lines.includes('reason mismatches: 1'));
  assert.ok(lines.includes('false PASS: 1, false FAIL: 1'));
});

test('exits non-zero on reason mismatch', () => {
  const caught = [{ code: CRITERION_FAILED, id: 'AC-1' }];
  const matching = makeEvalDirs(
    { 434: failCaseJson(), 900: passCaseJson() },
    { 434: actualJson('FAIL', caught), 900: actualJson('PASS') },
  );
  const ok = runCli(matching.casesDir, matching.resultsDir);
  assert.strictEqual(ok.status, 0);
  assert.ok(ok.stdout.includes('reason mismatches: 0'));
  fs.rmSync(matching.dir, { recursive: true });

  const mismatch = makeEvalDirs(
    { 434: failCaseJson() },
    { 434: actualJson('FAIL', [{ code: CI_CHECK_FAILED, id: null }]) },
  );
  const bad = runCli(mismatch.casesDir, mismatch.resultsDir);
  assert.strictEqual(bad.status, 1);
  assert.ok(bad.stdout.includes('reason mismatches: 1'));
  assert.ok(bad.stdout.includes('false PASS: 0, false FAIL: 0'));
  fs.rmSync(mismatch.dir, { recursive: true });

  const falseFail = makeEvalDirs(
    { 900: passCaseJson() },
    { 900: actualJson('FAIL', caught) },
  );
  const noFail = runCli(falseFail.casesDir, falseFail.resultsDir);
  assert.strictEqual(noFail.status, 0);
  assert.ok(noFail.stdout.includes('false PASS: 0, false FAIL: 1'));
  fs.rmSync(falseFail.dir, { recursive: true });
});

test('prints exact false PASS and false FAIL counts for a mixed set of cases', () => {
  const caught = [{ code: CRITERION_FAILED, id: 'AC-1' }];
  const { dir, casesDir, resultsDir } = makeEvalDirs(
    {
      434: failCaseJson(), // matches (FAIL/FAIL, expected reason)
      446: failCaseJson(), // false PASS (FAIL/PASS)
      900: passCaseJson(), // false FAIL (PASS/FAIL)
      463: failCaseJson(), // missing actual result
    },
    {
      434: actualJson('FAIL', caught),
      446: actualJson('PASS'),
      900: actualJson('FAIL', caught),
    },
  );
  const run = runCli(casesDir, resultsDir);
  assert.ok(run.stdout.includes('false PASS: 1, false FAIL: 1'));
  assert.ok(run.stdout.includes('run failures: 1'));
  assert.ok(run.stdout.includes('reason mismatches: 0'));
  fs.rmSync(dir, { recursive: true });
});

test('reports zero counts and no crash for an empty case directory', () => {
  const { dir, casesDir, resultsDir } = makeEvalDirs({}, {});
  const run = runCli(casesDir, resultsDir);
  assert.strictEqual(run.status, 0);
  assert.ok(run.stdout.includes('no cases found'));
  assert.ok(run.stdout.includes('false PASS: 0, false FAIL: 0'));
  fs.rmSync(dir, { recursive: true });
});

test('readCases skips a subdirectory without a valid case.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-eval-'));
  fs.mkdirSync(path.join(dir, '434'));
  fs.writeFileSync(
    path.join(dir, '434', 'case.json'),
    failCaseJson(CRITERION_FAILED, null),
  );
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'case.json'), 'not json');
  fs.mkdirSync(path.join(dir, 'no-case-file'));
  const cases = readCases(dir);
  assert.deepStrictEqual(cases, [failCase('434', CRITERION_FAILED, null)]);
  fs.rmSync(dir, { recursive: true });
});

test('readActualsRaw reads only files for known case names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-eval-'));
  fs.writeFileSync(path.join(dir, '434.json'), actualJson('FAIL'));
  fs.writeFileSync(path.join(dir, 'unrelated.json'), actualJson('PASS'));
  const actualsRaw = readActualsRaw(dir, [failCase('434')]);
  assert.deepStrictEqual(actualsRaw, { 434: actualJson('FAIL') });
  fs.rmSync(dir, { recursive: true });
});

test('parseArgs reads --project, the results dir and an optional --out', () => {
  assert.deepStrictEqual(parseArgs(['--project', 'p', 'results']), {
    project: 'p',
    resultsDir: 'results',
    out: null,
  });
  assert.deepStrictEqual(
    parseArgs(['--project', 'p', 'results', '--out', 'x.md']),
    { project: 'p', resultsDir: 'results', out: 'x.md' },
  );
  assert.strictEqual(parseArgs(['results']), null);
  assert.strictEqual(parseArgs(['cases', 'results']), null);
  assert.strictEqual(parseArgs([]), null);
});

test('reads golden directory from profile', () => {
  const { dir, casesDir, resultsDir } = makeEvalDirs(
    { 434: failCaseJson(CI_CHECK_FAILED, null) },
    { 434: actualJson('FAIL', [{ code: CI_CHECK_FAILED, id: null }]) },
  );
  // A second directory the profile does not name is never read.
  fs.mkdirSync(path.join(dir, 'other', '999'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'other', '999', 'case.json'), passCaseJson());
  assert.strictEqual(goldenDirOf(dir), casesDir);
  const run = runCli(casesDir, resultsDir);
  assert.strictEqual(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('434 | FAIL | FAIL | ci_check_failed'));
  assert.ok(!run.stdout.includes('999'));
  fs.rmSync(dir, { recursive: true });
});

test('fails when profile has no golden directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-eval-'));
  writeProfile(dir, {});
  // A directory at the conventional place must not be picked up as a default.
  fs.mkdirSync(path.join(dir, '.github', 'verifier', 'golden', '434'), {
    recursive: true,
  });
  assert.strictEqual(GOLDEN_DIR_FIELD, 'verifier.goldenDir');
  assert.throws(() => goldenDirOf(dir), /verifier\.goldenDir/);
  const results = path.join(dir, 'results');
  fs.mkdirSync(results);
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--project', dir, results],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 2);
  assert.ok(run.stderr.includes('verifier.goldenDir'), run.stderr);
  assert.strictEqual(run.stdout, '');
  fs.rmSync(dir, { recursive: true });
});

test('fails when the profile is invalid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-eval-'));
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory', 'profile.json'), '{}');
  const run = spawnSync(process.execPath, [SCRIPT, '--project', dir, dir], {
    encoding: 'utf8',
  });
  assert.strictEqual(run.status, 2);
  assert.ok(run.stderr.includes('branchTemplate'), run.stderr);
  fs.rmSync(dir, { recursive: true });
});

test('accepts reason codes a registered check declared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-eval-'));
  fs.mkdirSync(path.join(dir, 'x'));
  fs.writeFileSync(
    path.join(dir, 'x', 'case.json'),
    failCaseJson('extra_check_failed', null),
  );
  assert.strictEqual(readCases(dir)[0].isValid, false);
  const registry = createCoreRegistry();
  registry.register({
    name: 'extra-check',
    stage: 'report',
    codes: ['extra_check_failed'],
    run: () => [],
  });
  assert.strictEqual(readCases(dir, registry.reasonCodes())[0].isValid, true);
  fs.rmSync(dir, { recursive: true });
});

test('CLI reports usage and exits 2 on missing args', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(run.status, 2);
  assert.ok(run.stderr.includes('usage:'));
});

test('CLI evaluates a cases/results directory pair end to end', () => {
  const { dir, resultsDir } = makeEvalDirs(
    { 434: failCaseJson(CI_CHECK_FAILED, null) },
    { 434: actualJson('FAIL', [{ code: CI_CHECK_FAILED, id: null }]) },
  );
  const out = path.join(dir, 'summary.md');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--project', dir, resultsDir, '--out', out],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  const summary = fs.readFileSync(out, 'utf8');
  assert.ok(summary.includes('434 | FAIL | FAIL | ci_check_failed'));
  assert.ok(summary.includes('false PASS: 0, false FAIL: 0'));
  fs.rmSync(dir, { recursive: true });
});

test('CLI exits 1 when a false PASS is present', () => {
  const { dir, casesDir, resultsDir } = makeEvalDirs(
    { 434: failCaseJson() },
    { 434: actualJson('PASS') },
  );
  const run = runCli(casesDir, resultsDir);
  assert.strictEqual(run.status, 1);
  assert.ok(run.stdout.includes('false PASS: 1, false FAIL: 0'));
  fs.rmSync(dir, { recursive: true });
});

test('names pass case without mutation pair', () => {
  const cases = [
    passCase('a'),
    passCase('b'),
    mutationCase('a-m', 'a', 'violated_invariant'),
  ];
  const result = checkGoldenSet(cases, { minPairs: 1, requiredKinds: [] });
  assert.deepStrictEqual(result.unpairedPass, ['b']);
});

test('names missing pass cases and missing corruption kinds', () => {
  const kinds = ['violated_invariant', 'removed_negative_test'];
  const cases = [];
  for (const name of ['a', 'b', 'c', 'd']) {
    cases.push(passCase(name));
    cases.push(mutationCase(`${name}-m`, name, 'violated_invariant'));
  }
  const result = checkGoldenSet(cases, {
    minPairs: MIN_PAIRS,
    requiredKinds: kinds,
  });
  assert.strictEqual(result.missingPairs, 1);
  assert.deepStrictEqual(result.missingKinds, ['removed_negative_test']);
  assert.deepStrictEqual(result.unpairedPass, []);
});

test('ignores mutation whose pass case is missing when counting pairs', () => {
  const cases = [mutationCase('x-m', 'x', 'violated_invariant')];
  const result = checkGoldenSet(cases, {
    minPairs: 1,
    requiredKinds: ['violated_invariant'],
  });
  assert.strictEqual(result.missingPairs, 1);
  assert.deepStrictEqual(result.missingKinds, ['violated_invariant']);
});

test('reports broken pair as run failure', () => {
  const cases = [
    failCase('other'),
    mutationCase('lost-m', 'lost', 'violated_invariant'),
    mutationCase('other-m', 'other', 'violated_invariant'),
  ];
  const actuals = {
    other: actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-1' }]),
    'lost-m': actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-1' }]),
    'other-m': actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-1' }]),
  };
  const summary = summarize(cases, actuals);
  assert.strictEqual(summary.runFailures, 2);
  assert.deepStrictEqual(
    summary.rows.map((row) => row.note),
    [null, 'broken pair', 'broken pair'],
  );
  assert.deepStrictEqual(summary.pairs, []);
  assert.match(render(summary), /broken pair/);
});

test('renders pairs side by side', () => {
  const cases = [passCase('p'), mutationCase('p-m', 'p', 'violated_invariant')];
  const actuals = {
    p: actualJson('PASS'),
    'p-m': actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-1' }]),
  };
  const summary = summarize(cases, actuals);
  assert.deepStrictEqual(summary.pairs, [
    { pass: 'p', mutation: 'p-m', passActual: 'PASS', mutationActual: 'FAIL' },
  ]);
  const lines = render(summary).split('\n');
  assert.ok(lines.includes('pairs: 1'));
  assert.ok(lines.includes('p: PASS | p-m: FAIL'));
});

test('readCases reads pair fields and rejects a mutation without patch', () => {
  const mutation = caseJson('FAIL', {
    expected_criterion_id: 'AC-1',
    expected_reason_code: CRITERION_FAILED,
    pair_of: 'p',
    mutation_kind: 'violated_invariant',
  });
  const { casesDir } = makeEvalDirs(
    {
      p: passCaseJson(),
      'p-m': mutation,
      'p-n': mutation,
    },
    {},
  );
  fs.writeFileSync(path.join(casesDir, 'p-m', 'mutation.patch'), 'diff\n');
  const byName = new Map(readCases(casesDir).map((item) => [item.name, item]));
  assert.strictEqual(byName.get('p').pairOf, null);
  assert.strictEqual(byName.get('p-m').pairOf, 'p');
  assert.strictEqual(byName.get('p-m').mutationKind, 'violated_invariant');
  assert.strictEqual(byName.get('p-m').isValid, true);
  assert.strictEqual(byName.get('p-n').isValid, false);
});

test('does not count an invalid mutation case as a pair', () => {
  const invalid = { ...mutationCase('p-m', 'p', 'violated_invariant') };
  invalid.isValid = false;
  const result = checkGoldenSet([passCase('p'), invalid], {
    minPairs: 1,
    requiredKinds: ['violated_invariant'],
  });
  assert.deepStrictEqual(result.unpairedPass, ['p']);
  assert.strictEqual(result.missingPairs, 1);
  assert.deepStrictEqual(result.missingKinds, ['violated_invariant']);
});

const needsHumanJson = (items, reasons = []) =>
  JSON.stringify({ actual: 'NEEDS_HUMAN', reasons, items });

const item = (id, ...statuses) => ({ id, statuses });

const summarizeOne = (testCase, raw) =>
  summarize([testCase], { [testCase.name]: raw });

const rowLine = (summary) => render(summary).split('\n')[1];

test('counts diverged case as needs human', () => {
  const summary = summarizeOne(
    failCase('m'),
    needsHumanJson([
      item('AC-1', 'FAIL', 'FAIL'),
      item('INV-1', 'PASS', 'FAIL'),
    ]),
  );
  assert.strictEqual(summary.needsHuman, 1);
  assert.strictEqual(summary.runFailures, 0);
  assert.strictEqual(summary.falsePass, 0);
  assert.strictEqual(summary.falseFail, 0);
  assert.strictEqual(summary.reasonMismatches, 0);
});

test('reports expected item failed in both runs', () => {
  const summary = summarizeOne(
    failCase('m'),
    needsHumanJson([item('AC-1', 'FAIL'), item('INV-1', 'PASS', 'FAIL')]),
  );
  assert.match(
    rowLine(summary),
    /expected item FAIL, runs did not diverge on it/,
  );
  assert.match(rowLine(summary), /diverged: INV-1 PASS\/FAIL/);
  assert.doesNotMatch(rowLine(summary), /both runs/);
});

test('reports run where expected item did not fail', () => {
  const second = summarizeOne(
    failCase('m'),
    needsHumanJson([item('AC-1', 'FAIL', 'PASS')]),
  );
  assert.match(rowLine(second), /expected item: first FAIL, second PASS/);
  const first = summarizeOne(
    failCase('m'),
    needsHumanJson([item('AC-1', 'UNVERIFIABLE', 'FAIL')]),
  );
  assert.match(
    rowLine(first),
    /expected item: first UNVERIFIABLE, second FAIL/,
  );
  const missing = summarizeOne(
    failCase('m'),
    needsHumanJson([item('INV-1', 'PASS', 'FAIL')]),
  );
  assert.match(rowLine(missing), /expected item not reported/);
});

test('reports diverged items of pass case', () => {
  const summary = summarizeOne(
    passCase('p'),
    needsHumanJson([item('INV-1', 'PASS', 'FAIL'), item('AC-2', 'PASS')]),
  );
  assert.strictEqual(summary.needsHuman, 1);
  assert.strictEqual(summary.falseFail, 0);
  assert.match(rowLine(summary), /diverged: INV-1 PASS\/FAIL/);
  assert.doesNotMatch(rowLine(summary), /expected item/);
});

test('exits non-zero on needs human', () => {
  const { casesDir, resultsDir } = makeEvalDirs(
    { a: passCaseJson() },
    { a: needsHumanJson([item('INV-1', 'PASS', 'FAIL')]) },
  );
  const result = runCli(casesDir, resultsDir);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /needs human: 1/);
  assert.match(result.stdout, /run failures: 0/);
});

test('keeps other counters when no case diverged', () => {
  const { casesDir, resultsDir } = makeEvalDirs(
    { a: passCaseJson(), b: failCaseJson() },
    {
      a: actualJson('PASS'),
      b: actualJson('FAIL', [{ code: CRITERION_FAILED, id: 'AC-1' }]),
    },
  );
  const result = runCli(casesDir, resultsDir);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /needs human: 0/);
  assert.match(result.stdout, /run failures: 0/);
  assert.match(result.stdout, /false PASS: 0, false FAIL: 0/);
});

test('counts diverged result without valid items as run failure', () => {
  const invalid = [
    needsHumanJson(undefined),
    needsHumanJson('AC-1'),
    needsHumanJson([{ statuses: ['FAIL'] }]),
    needsHumanJson([{ id: 'AC-1' }]),
    needsHumanJson([{ id: 'AC-1', statuses: [] }]),
    needsHumanJson([{ id: 'AC-1', statuses: [1, 2] }]),
  ];
  for (const raw of invalid) {
    const summary = summarizeOne(failCase('m'), raw);
    assert.strictEqual(summary.runFailures, 1, raw);
    assert.strictEqual(summary.needsHuman, 0, raw);
  }
});

test('does not report runs for expected reason without id', () => {
  const summary = summarizeOne(
    failCase('m', CI_CHECK_FAILED, null),
    needsHumanJson([item('AC-1', 'FAIL', 'PASS')]),
  );
  assert.strictEqual(summary.needsHuman, 1);
  assert.doesNotMatch(rowLine(summary), /expected item/);
  assert.match(rowLine(summary), /diverged: AC-1 FAIL\/PASS/);
});

test('keeps valid items of a PASS or FAIL result', () => {
  const raw = JSON.stringify({
    actual: 'FAIL',
    reasons: [],
    items: [item('AC-1', 'FAIL')],
  });
  assert.deepStrictEqual(parseActual(raw).items, [item('AC-1', 'FAIL')]);
  const invalid = JSON.stringify({ actual: 'FAIL', reasons: [], items: 1 });
  assert.deepStrictEqual(parseActual(invalid).items, []);
});
