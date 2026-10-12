'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REASON_CODES: CODE,
  REASON_CODE_SET,
  ITEM_SOURCE_MODEL,
  ITEM_SOURCE_COMPUTED,
  buildResult,
} = require('./result');
const { singleRun, reconcile } = require('./second-run');
const { computeCiItems } = require('./computed');
const {
  criterion,
  report,
  ref,
  invariant,
  specItem,
  ciItem,
  absenceItem,
  ciJson,
  scanResult,
  PROVENANCE,
  runReport,
  evaluateRun,
  evaluateChecked,
} = require('./test-helpers');

const SCRIPT = path.join(__dirname, '..', 'acceptance-verdict.js');

// Fixture names only — not a real CI check or source path, so this file
// carries no project-specific literal (INV-8).
const SAMPLE_PATH = 'sample/widget.txt';
const SAMPLE_CHECK_NAME = 'Example Check';

const CI_SPEC = {
  format: 'v2',
  problems: [],
  items: [
    specItem('AC-1', 'behavior', 'first behavior'),
    ciItem('DOD-1', SAMPLE_CHECK_NAME, 'checks are green'),
    absenceItem('DOD-2', 'TODO', SAMPLE_PATH, 'no TODO left'),
    { id: 'INV-1', section: 's', type: null, text: 'inv', verify: null },
  ],
};

const SCRIPTS_CHECK = {
  name: SAMPLE_CHECK_NAME,
  status: 'completed',
  conclusion: 'success',
};

const ABSENCE_ENTRY = {
  id: 'DOD-2',
  text: '',
  status: 'FAIL',
  summary: `DOD-2: literal "TODO" found in ${SAMPLE_PATH}`,
  refs: [],
  computed: true,
};

const itemById = (result, id) => result.items.find((item) => item.id === id);

const AC_REPORT = report({
  criteria: [
    criterion('FAIL', 'model text', {
      id: 'AC-1',
      refs: [ref({ path: SAMPLE_PATH, quote: 'const   x = 1' })],
    }),
  ],
  invariants: [invariant('INV-1', 'PASS')],
});

test('writes verdict item statuses and coded reasons', () => {
  const ciItems = computeCiItems(
    CI_SPEC.items,
    ciJson({ checks: [SCRIPTS_CHECK] }),
  );
  const computedItems = [...ciItems, ABSENCE_ENTRY];
  const evaluated = evaluateChecked(AC_REPORT, {
    spec: CI_SPEC,
    computedItems,
  });
  const result = buildResult(singleRun(evaluated), computedItems);

  assert.strictEqual(result.verdict, 'FAIL');
  assert.strictEqual(result.spec_format, 'v2');
  assert.deepStrictEqual(itemById(result, 'AC-1'), {
    id: 'AC-1',
    source: ITEM_SOURCE_MODEL,
    statuses: ['FAIL'],
    refs: [{ path: SAMPLE_PATH, quote: 'const   x = 1' }],
  });
  assert.deepStrictEqual(itemById(result, 'INV-1').statuses, ['PASS']);
  assert.deepStrictEqual(itemById(result, 'DOD-1'), {
    id: 'DOD-1',
    source: ITEM_SOURCE_COMPUTED,
    statuses: ['PASS'],
    refs: [],
  });
  assert.strictEqual(itemById(result, 'DOD-2').source, ITEM_SOURCE_COMPUTED);
  assert.deepStrictEqual(itemById(result, 'DOD-2').statuses, ['FAIL']);
  assert.strictEqual(result.items.length, 4);

  assert.deepStrictEqual(
    result.reasons.map(({ code, id, source }) => ({ code, id, source })),
    [
      { code: CODE.CRITERION_FAILED, id: 'AC-1', source: 'model' },
      { code: CODE.COMPUTED_ITEM_FAILED, id: 'DOD-2', source: 'deterministic' },
    ],
  );
  for (const reason of result.reasons) {
    assert.ok(REASON_CODE_SET.has(reason.code));
    assert.strictEqual(typeof reason.text, 'string');
  }
});

test('--result-out writes the result file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-'));
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const resultFile = path.join(dir, 'result.json');
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT,
      write('verdict.json', AC_REPORT),
      '--out', path.join(dir, 'comment.md'),
      '--result-out', resultFile,
      '--refs-problems', write('refs-problems.json', '[]'),
      '--spec', write('spec-lint.json', JSON.stringify(CI_SPEC)),
      '--scope', write('scope.json', JSON.stringify({ out_of_scope: [] })),
      '--ci', write('ci.json', ciJson({ checks: [SCRIPTS_CHECK] })),
      '--absence', write('absence.json', JSON.stringify([ABSENCE_ENTRY])),
      '--tampering-scan', write('scan.json', JSON.stringify(scanResult())),
      '--provenance', write('provenance.json', JSON.stringify(PROVENANCE)),
      '--allowed-models',
      write('models.json', JSON.stringify([PROVENANCE.model])),
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  fs.rmSync(dir, { recursive: true });

  assert.strictEqual(run.status, 0);
  assert.strictEqual(result.verdict, run.stdout.trim());
  assert.deepStrictEqual(
    result.items.map(({ id, source, statuses }) => ({ id, source, statuses })),
    [
      { id: 'AC-1', source: 'model', statuses: ['FAIL'] },
      { id: 'INV-1', source: 'model', statuses: ['PASS'] },
      { id: 'DOD-1', source: 'computed', statuses: ['PASS'] },
      { id: 'DOD-2', source: 'computed', statuses: ['FAIL'] },
    ],
  );
  const failed = result.reasons.find(({ id }) => id === 'AC-1');
  assert.strictEqual(failed.code, CODE.CRITERION_FAILED);
});

test('records both statuses when runs disagree', () => {
  const first = evaluateRun(
    runReport({ statuses: { 'AC-1': 'FAIL', 'INV-1': 'FAIL' } }),
  );
  const second = evaluateRun(runReport({ statuses: { 'INV-1': 'FAIL' } }));
  const outcome = reconcile(first, second);
  assert.strictEqual(outcome.verdict, 'NEEDS_HUMAN');

  const result = buildResult(outcome);
  assert.strictEqual(result.verdict, 'NEEDS_HUMAN');
  assert.deepStrictEqual(itemById(result, 'AC-1').statuses, ['FAIL', 'PASS']);
  assert.deepStrictEqual(itemById(result, 'INV-1').statuses, ['FAIL']);
  assert.deepStrictEqual(itemById(result, 'TR-1').statuses, ['PASS']);

  const single = buildResult(singleRun(first));
  for (const item of single.items) assert.strictEqual(item.statuses.length, 1);
  assert.deepStrictEqual(itemById(single, 'AC-1').statuses, ['FAIL']);
});

test('writes result for missing report', () => {
  const computedItems = [ABSENCE_ENTRY];
  for (const raw of [null, '{not json']) {
    const evaluated = evaluateRun(raw, { computedItems });
    const result = buildResult(singleRun(evaluated), computedItems);
    assert.strictEqual(result.verdict, 'FAIL');
    const modelItems = result.items.filter(
      ({ source }) => source === ITEM_SOURCE_MODEL,
    );
    assert.deepStrictEqual(modelItems, []);
    assert.deepStrictEqual(
      result.items.map(({ id }) => id),
      ['DOD-2'],
    );
    const missing = result.reasons.filter(
      ({ code }) => code === CODE.REPORT_MISSING,
    );
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].source, 'model');
    assert.strictEqual(missing[0].id, null);
  }
});

