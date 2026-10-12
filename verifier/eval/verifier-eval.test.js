'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  readCases,
  readActualsRaw,
  parseActual,
  summarize,
  checkGoldenSet,
  render,
} = require('./verifier-eval');
const { REASON_CODES, buildResult } = require('./acceptance-verdict/result');

const SCRIPT = path.join(__dirname, 'verifier-eval.js');
const GOLDEN_DIR = path.join(__dirname, '..', '.github', 'verifier', 'golden');

const MIN_PAIRS = 5;
const REQUIRED_KINDS = [
  'removed_negative_test',
  'violated_invariant',
  'one_sided_cross_layer',
  'file_outside_affects',
];

const { CRITERION_FAILED, CI_CHECK_FAILED, INVARIANT_FAILED } = REASON_CODES;

const actualJson = (verdict, reasons = []) =>
  JSON.stringify({ actual: verdict, reasons });

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

const failCaseJson = (code = CRITERION_FAILED, id = 'AC-1') =>
  caseJson('FAIL', { expected_criterion_id: id, expected_reason_code: code });

const passCaseJson = () =>
  caseJson('PASS', { expected_criterion_id: null, expected_reason_code: null });

const makeEvalDirs = (cases, results) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-eval-'));
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

const runCli = (casesDir, resultsDir) =>
  spawnSync(process.execPath, [SCRIPT, casesDir, resultsDir], {
    encoding: 'utf8',
  });

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

test('parseArgs reads positional dirs and an optional --out', () => {
  assert.deepStrictEqual(parseArgs(['cases', 'results']), {
    casesDir: 'cases',
    resultsDir: 'results',
    out: null,
  });
  assert.deepStrictEqual(parseArgs(['cases', 'results', '--out', 'x.md']), {
    casesDir: 'cases',
    resultsDir: 'results',
    out: 'x.md',
  });
  assert.strictEqual(parseArgs(['cases']), null);
  assert.strictEqual(parseArgs([]), null);
});

test('CLI reports usage and exits 2 on missing args', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(run.status, 2);
  assert.ok(run.stderr.includes('usage:'));
});

test('CLI evaluates a cases/results directory pair end to end', () => {
  const { dir, casesDir, resultsDir } = makeEvalDirs(
    { 434: failCaseJson(CI_CHECK_FAILED, null) },
    { 434: actualJson('FAIL', [{ code: CI_CHECK_FAILED, id: null }]) },
  );
  const out = path.join(dir, 'summary.md');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, casesDir, resultsDir, '--out', out],
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

const EVAL_WORKFLOW = path.join(
  __dirname,
  '..',
  '.github',
  'workflows',
  'acceptance-verifier-eval.yml',
);

const workflowLines = () =>
  fs
    .readFileSync(EVAL_WORKFLOW, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));

const workflowText = () => workflowLines().join('\n');

const jobText = (text, name) => {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = lines.slice(start + 1);
  const length = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  const end = length < 0 ? lines.length : start + 1 + length;
  return lines.slice(start, end).join('\n');
};

const stepsOf = (job) => job.split(/^ {6}- /m).slice(1);

const stepNamed = (job, name) => {
  const step = stepsOf(job).find(
    (text) =>
      text.startsWith(`name: ${name}`) || text.startsWith(`id: ${name}`),
  );
  assert.ok(step, `step ${name} exists`);
  return step;
};

test('eval workflow rebuilds code dependent inputs after mutation', () => {
  const job = jobText(workflowText(), 'verify-case');
  const names = stepsOf(job).map((text) => text.split('\n')[0]);
  const mutation = names.findIndex((name) => name.includes('Apply mutation'));
  const prepare = names.findIndex((name) => name.includes('Prepare inputs'));
  const lint = names.findIndex((name) => name.includes('Lint issue'));
  assert.ok(mutation >= 0 && mutation < prepare && prepare < lint);
  const mutationStep = stepNamed(job, 'Apply mutation patch (data only)');
  assert.match(mutationStep, /if: steps\.patch\.outputs\.present == 'true'/);
  assert.match(mutationStep, /golden-mutation\.js/);
  const prepareStep = stepNamed(job, 'Prepare inputs');
  assert.doesNotMatch(prepareStep, /golden-mutation\.js/);
  for (const script of ['test-tampering-scan.js', 'affects-scope.js']) {
    assert.match(prepareStep, new RegExp(script));
  }
  assert.match(stepNamed(job, 'Lint issue against contract'), /issue-lint\.js/);
  assert.strictEqual(
    (workflowText().match(/golden-mutation\.js/g) ?? []).length >= 2,
    true,
  );
});

test('eval passes frozen approval and exceptions', () => {
  const job = jobText(workflowText(), 'summarize');
  const step = stepNamed(job, 'Reconcile each case and write its result');
  assert.match(step, /--approval "\$CASE_DIR\/approval\.json"/);
  assert.match(step, /--manual-verified\)/);
  assert.match(step, /--test-removal-approved\)/);
  assert.match(step, /CASE_DIR="\$GOLDEN_DIR\/\$CASE"/);
  assert.doesNotMatch(job, /gh api/);
});

test('eval workflow defines golden directory once', () => {
  const text = workflowText();
  assert.strictEqual(text.split('verifier/golden').length - 1, 1);
  const top = text.match(/^env:\n((?: {2}.*\n|\n)+)/m);
  assert.ok(top, 'top-level env exists');
  assert.match(top[1], /^ {2}GOLDEN_DIR: \.github\/verifier\/golden$/m);
});

test('eval workflow steps reference GOLDEN_DIR', () => {
  const text = workflowText();
  const reader = /GOLDEN_DIR/;
  const discover = jobText(text, 'discover');
  assert.match(discover, /sparse-checkout: \|\n\s+\$\{\{ env\.GOLDEN_DIR \}\}/);
  assert.match(stepNamed(discover, 'list'), reader);
  for (const name of ['verify-case', 'verify-case-second']) {
    const job = jobText(text, name);
    assert.match(
      stepNamed(job, 'Checkout golden case files from the default branch'),
      reader,
    );
    assert.match(stepNamed(job, 'Read case.json'), reader);
  }
  const prepare = stepNamed(jobText(text, 'verify-case'), 'Prepare inputs');
  assert.match(prepare, reader);
  const summarize = jobText(text, 'summarize');
  assert.match(
    stepNamed(summarize, 'Checkout from the default branch'),
    /sparse-checkout: \|[\s\S]*\$\{\{ env\.GOLDEN_DIR \}\}/,
  );
  assert.match(
    stepNamed(summarize, 'Reconcile each case and write its result'),
    reader,
  );
  assert.match(stepNamed(summarize, 'Summarize'), reader);
});

test('summarize stores coded reasons per case', () => {
  const job = jobText(workflowText(), 'summarize');
  const step = stepNamed(job, 'Reconcile each case and write its result');
  assert.match(
    step,
    /acceptance-verdict\.js[^\n]*--result-out "results\/\$CASE-verdict\.json"/,
  );
  assert.match(step, /jq -c --arg actual "\$RESULT"/);
  assert.match(
    step,
    /reasons: \[\(\.reasons \/\/ \[\]\)\[\] \| \{ code, id \}\]/,
  );
  assert.match(step, /"results\/\$CASE\.json"/);
});

test('summarize uses shared golden directory value', () => {
  const job = jobText(workflowText(), 'summarize');
  assert.doesNotMatch(job, /verifier\/golden/);
  assert.match(
    stepNamed(job, 'Reconcile each case and write its result'),
    /CASE_DIR="\$GOLDEN_DIR\/\$CASE"/,
  );
  assert.match(
    stepNamed(job, 'Summarize'),
    /node scripts\/verifier-eval\.js "\$GOLDEN_DIR" results/,
  );
});

const CHECKOUT_USES = /^\s*uses: actions\/checkout@/m;
const MOVE_STEP = 'Move golden files out of workspace';
const VERIFY_JOBS = ['verify-case', 'verify-case-second'];

const checkoutPath = (step) => {
  const match = step.match(/^\s*path: *["']?([^\s"'#]+)["']? *(#.*)?$/m);
  return match === null ? null : match[1];
};

const isRootCheckout = (step) => {
  const checkoutDir = checkoutPath(step);
  return checkoutDir === null || checkoutDir === '.' || checkoutDir === './';
};

const isMoveStep = (step) => step.startsWith(`name: ${MOVE_STEP}`);

const rootCheckoutViolations = (job) => {
  const steps = stepsOf(job);
  return steps.filter(
    (step, index) =>
      CHECKOUT_USES.test(step) &&
      isRootCheckout(step) &&
      !(index > 0 && isMoveStep(steps[index - 1])),
  );
};

const assertMovesGoldenBeforeHead = (jobName) => {
  const steps = stepsOf(jobText(workflowText(), jobName));
  const golden = steps.findIndex((step) => checkoutPath(step) === 'golden-src');
  const read = steps.findIndex((step) =>
    step.startsWith('name: Read case.json'),
  );
  const move = steps.findIndex(isMoveStep);
  const head = steps.findIndex((step) =>
    step.startsWith('name: Checkout case head (data only)'),
  );
  assert.ok(golden >= 0, 'golden-src checkout exists');
  assert.ok(read > golden, 'case.json is read after the golden checkout');
  assert.ok(move > read, 'golden files move after case.json is read');
  assert.strictEqual(head, move + 1, 'head checkout directly follows the move');
  assert.match(steps[move], /mv golden-src "\$RUNNER_TEMP\/golden-src"/);
};

test('first run moves golden files out before head checkout', () => {
  assertMovesGoldenBeforeHead('verify-case');
});

test('second run moves golden files out before head checkout', () => {
  assertMovesGoldenBeforeHead('verify-case-second');
});

test('root checkouts in verify jobs follow golden move', () => {
  for (const name of VERIFY_JOBS) {
    const job = jobText(workflowText(), name);
    assert.deepStrictEqual(rootCheckoutViolations(job), []);
    const exempt = stepsOf(job).filter(
      (step) => CHECKOUT_USES.test(step) && !isRootCheckout(step),
    );
    assert.ok(exempt.some((step) => checkoutPath(step) === 'trusted'));
    assert.ok(exempt.some((step) => checkoutPath(step) === 'golden-src'));
  }
});

test('verify jobs read golden files only from runner temp', () => {
  for (const name of VERIFY_JOBS) {
    const steps = stepsOf(jobText(workflowText(), name));
    const after = steps.slice(steps.findIndex(isMoveStep) + 1);
    assert.ok(after.length > 0);
    for (const step of after) {
      const outside = step.replaceAll('$RUNNER_TEMP/golden-src', '');
      assert.doesNotMatch(outside, /golden-src/);
    }
    const detect = after.find((step) =>
      step.startsWith('name: Detect mutation'),
    );
    assert.ok(detect, 'mutation patch is detected after the move');
    assert.match(detect, /id: patch/);
    assert.match(detect, /\$RUNNER_TEMP\/golden-src/);
    const apply = after.find((step) => step.startsWith('name: Apply mutation'));
    assert.match(apply, /if: steps\.patch\.outputs\.present == 'true'/);
  }
});

test('head checkout does not rely on clean false', () => {
  for (const name of VERIFY_JOBS) {
    const steps = stepsOf(jobText(workflowText(), name));
    const head = steps.find((step) =>
      step.startsWith('name: Checkout case head (data only)'),
    );
    assert.ok(head);
    assert.doesNotMatch(head, /clean: false/);
  }
});

test('detects root checkout without golden move', () => {
  const job = (...steps) =>
    ['  verify-case:', '    steps:', ...steps].join('\n');
  const move = [`      - name: ${MOVE_STEP}`, '        run: mv golden-src x'];
  const checkout = (...extra) => [
    '      - name: Checkout',
    '        uses: actions/checkout@v7',
    '        with:',
    '          fetch-depth: 0',
    ...extra,
  ];
  const violations = (...lines) => rootCheckoutViolations(job(...lines)).length;
  assert.strictEqual(violations(...checkout()), 1);
  assert.strictEqual(violations(...checkout('          path: .')), 1);
  assert.strictEqual(violations(...checkout('          path: "."')), 1);
  assert.strictEqual(violations(...checkout(), ...move), 1);
  assert.strictEqual(violations(...move, ...checkout()), 0);
  assert.strictEqual(violations(...checkout('          path: trusted')), 0);
  const unnamed = ['      - uses: actions/checkout@v7', '        with:'];
  assert.strictEqual(violations(...unnamed), 1);
});

const readRawCase = (name) =>
  JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name, 'case.json'), 'utf8'));

test('golden set has at least five confirmed pass cases with mutation pairs', () => {
  const cases = readCases(GOLDEN_DIR);
  const passCases = cases.filter((item) => item.expected === 'PASS');
  const result = checkGoldenSet(cases, {
    minPairs: MIN_PAIRS,
    requiredKinds: [],
  });
  assert.ok(passCases.length >= MIN_PAIRS);
  assert.deepStrictEqual(result.unpairedPass, []);
  assert.strictEqual(result.missingPairs, 0);
  for (const item of cases) {
    assert.ok(item.isValid, `${item.name} is not a valid case`);
    if (item.pairOf !== null) assert.strictEqual(item.expected, 'FAIL');
  }
});

test('mutation pairs cover required corruption kinds', () => {
  const cases = readCases(GOLDEN_DIR);
  const result = checkGoldenSet(cases, {
    minPairs: MIN_PAIRS,
    requiredKinds: REQUIRED_KINDS,
  });
  assert.deepStrictEqual(result.missingKinds, []);
});

test('golden cases declare expected reason fields', () => {
  const cases = readCases(GOLDEN_DIR);
  for (const item of cases) {
    const raw = readRawCase(item.name);
    assert.ok('expected_reason_code' in raw, `${item.name} reason code`);
    assert.ok('expected_criterion_id' in raw, `${item.name} criterion id`);
    if (item.pairOf === null) continue;
    const patch = fs.readFileSync(
      path.join(GOLDEN_DIR, item.name, 'mutation.patch'),
      'utf8',
    );
    assert.notStrictEqual(patch.trim(), '');
    assert.ok(raw.expected_reason_code);
  }
  for (const item of cases.filter((entry) => entry.expected === 'PASS')) {
    const raw = readRawCase(item.name);
    assert.strictEqual(raw.expected_reason_code, null);
    assert.strictEqual(raw.expected_criterion_id, null);
  }
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

test('golden pair cases share inputs with their pass case', () => {
  const mutations = readCases(GOLDEN_DIR).filter((item) => item.pairOf);
  assert.ok(mutations.length > 0);
  const readIn = (name, file) =>
    fs.readFileSync(path.join(GOLDEN_DIR, name, file), 'utf8');
  for (const { name, pairOf } of mutations) {
    const mutation = readRawCase(name);
    const original = readRawCase(pairOf);
    assert.strictEqual(mutation.base_sha, original.base_sha);
    assert.strictEqual(mutation.head_sha, original.head_sha);
    for (const file of ['issue.md', 'ci.json', 'approval.json']) {
      assert.strictEqual(readIn(name, file), readIn(pairOf, file), file);
    }
  }
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

// The eval workflow pipes every result through jq, so these tests need the
// real binary (preinstalled on CI runners) and fail loudly without it.
const runJq = (args, input) => {
  const run = spawnSync('jq', args, { input, encoding: 'utf8' });
  assert.ifError(run.error);
  assert.strictEqual(run.status, 0, run.stderr);
  return run.stdout;
};

const extractResultFilter = (step) => {
  const match = /jq -c --arg actual "\$RESULT" '([^']+)'/.exec(step);
  assert.ok(match, 'result jq filter not found');
  return match[1];
};

test('summarize stores item statuses per case', () => {
  const job = jobText(workflowText(), 'summarize');
  const step = stepNamed(job, 'Reconcile each case and write its result');
  const outcome = {
    verdict: 'NEEDS_HUMAN',
    diverged: ['AC-1'],
    secondRun: {
      firstFailures: [],
      firstEntries: [{ id: 'AC-1', status: 'PASS' }],
    },
    result: {
      specFormat: 'v2',
      reasons: [
        { code: CRITERION_FAILED, id: 'AC-1', source: 'model', text: 't' },
      ],
      report: {
        criteria: [{ id: 'AC-1', status: 'FAIL', computed: false, refs: [] }],
        invariants: [],
      },
    },
  };
  const verdict = JSON.stringify(buildResult(outcome));
  const output = runJq(
    ['-c', '--arg', 'actual', 'NEEDS_HUMAN', extractResultFilter(step)],
    verdict,
  );
  const stored = JSON.parse(output);
  assert.deepStrictEqual(stored.items, [
    { id: 'AC-1', statuses: ['PASS', 'FAIL'] },
  ]);
  assert.deepStrictEqual(stored.reasons, [
    { code: CRITERION_FAILED, id: 'AC-1' },
  ]);
  assert.ok(parseActual(output) !== null);
});

test('summarize writes empty lists for a result without reasons', () => {
  const job = jobText(workflowText(), 'summarize');
  const step = stepNamed(job, 'Reconcile each case and write its result');
  const output = runJq(
    ['-c', '--arg', 'actual', 'PASS', extractResultFilter(step)],
    '{}',
  );
  assert.deepStrictEqual(JSON.parse(output), {
    actual: 'PASS',
    reasons: [],
    items: [],
  });
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
