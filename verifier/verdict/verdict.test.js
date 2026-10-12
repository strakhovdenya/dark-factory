'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  evaluate,
  SOURCE_MODEL,
  SOURCE_DETERMINISTIC,
} = require('./verdict');
const { checkRefs } = require('./refs');
const { REASON_CODES: CODE, REASON_CODE_SET } = require('./result');
const { checkIds, checkCoverage, checkIssueCoverage } = require('./coverage');
const { parseCiFailures } = require('./ci');
const { parseTamperingScan, readScopeResult, readSpecResult } =
  require('./inputs');
const {
  ref,
  criterion,
  report,
  evaluateChecked,
  makeCheckout,
  ISSUE_MD,
  V2_SPEC,
  invariant,
  v2Report,
  hasFailureWith,
  CI_ABSENCE_SPEC_ITEMS,
  SHA_APPROVED,
  APPROVAL_V2_SPEC,
  APPROVAL_LEGACY_SPEC,
  approvalOf,
  LOSS,
  SKIP_FINDING,
  scanResult,
  ciJson,
  codeqlSuccess,
  PROVENANCE,
} = require('./test-helpers');

test('passes when every criterion passes and nothing is tampered', () => {
  assert.strictEqual(evaluateChecked(report()).passed, true);
});

test('reasons carry their source and failures keep the reason texts in order', () => {
  const raw = report({
    criteria: [criterion('FAIL', 'AC', { id: 'AC-1' })],
    test_tampering: ['weakened'],
  });
  const result = evaluateChecked(raw, {
    refsProblems: ['bad quote'],
    ciFailures: ['check failed: Sample Check (failure)'],
    tamperingFindings: [SKIP_FINDING],
    provenance: null,
  });
  assert.deepStrictEqual(
    result.reasons.map(({ source }) => source),
    [
      SOURCE_DETERMINISTIC,
      SOURCE_MODEL,
      SOURCE_MODEL,
      SOURCE_DETERMINISTIC,
      SOURCE_MODEL,
      SOURCE_DETERMINISTIC,
    ],
  );
  assert.deepStrictEqual(
    result.failures,
    result.reasons.map(({ text }) => text),
  );
  assert.deepStrictEqual(result.failures, [
    'provenance missing',
    'criterion failed: AC-1',
    'test tampering: weakened',
    `test tampering (scan): ${SKIP_FINDING}`,
    'bad reference: bad quote',
    'check failed: Sample Check (failure)',
  ]);
});

test('a failed computed item is a deterministic reason', () => {
  const computed = {
    id: 'DOD-1',
    text: '',
    status: 'FAIL',
    summary: 'missing',
    refs: [],
    computed: true,
  };
  const result = evaluateChecked(report(), { computedItems: [computed] });
  const reason = result.reasons.find(({ text }) => text.includes('DOD-1'));
  assert.strictEqual(reason.source, SOURCE_DETERMINISTIC);
});

test('a missing report still lists the deterministic input failures', () => {
  const result = evaluateChecked(null, {
    ciFailures: ['check failed: Sample Check (failure)'],
    tamperingFindings: [SKIP_FINDING],
  });
  assert.deepStrictEqual(result.reasons, [
    {
      text: 'no report',
      source: SOURCE_MODEL,
      code: CODE.REPORT_MISSING,
      id: null,
    },
    {
      text: `test tampering (scan): ${SKIP_FINDING}`,
      source: SOURCE_DETERMINISTIC,
      code: CODE.TAMPERING_SCAN_FINDING,
      id: null,
    },
    {
      text: 'check failed: Sample Check (failure)',
      source: SOURCE_DETERMINISTIC,
      code: CODE.CI_CHECK_FAILED,
      id: null,
    },
  ]);
});

test('a missing report is a model reason and pre-report checks are deterministic', () => {
  const result = evaluateChecked(null, { spec: null });
  assert.deepStrictEqual(result.reasons, [
    {
      text: 'spec was not checked',
      source: SOURCE_DETERMINISTIC,
      code: CODE.SPEC_NOT_CHECKED,
      id: null,
    },
    {
      text: 'no report',
      source: SOURCE_MODEL,
      code: CODE.REPORT_MISSING,
      id: null,
    },
  ]);
});

const codeOf = (result, text) =>
  result.reasons.find((reason) => reason.text.includes(text)).code;

test('assigns a closed-list code to every reason kind', () => {
  const computed = {
    id: 'DOD-2',
    text: '',
    status: 'FAIL',
    summary: 'found',
    refs: [],
    computed: true,
  };
  const raw = report({
    criteria: [
      criterion('FAIL', 'AC', { id: 'AC-1' }),
      criterion('UNVERIFIABLE', 'TR', { id: 'TR-1' }),
      criterion('PASS', 'DOD', { id: 'DOD-1', refs: [] }),
    ],
    invariants: [
      invariant('INV-1', 'FAIL'),
      invariant('INV-2', 'PASS', { refs: [] }),
    ],
    test_tampering: ['weakened'],
  });
  const full = evaluateChecked(raw, {
    spec: V2_SPEC,
    scope: { out_of_scope: ['docs/x.md'] },
    approval: approvalOf(SHA_APPROVED),
    refsProblems: ['bad quote'],
    ciFailures: ['ci check failed: Sample Check (failure)'],
    tamperingFindings: [SKIP_FINDING],
    assertionLosses: [LOSS],
    provenance: { ...PROVENANCE, model: 'other-model' },
    computedItems: [computed],
  });
  const invalidSpec = evaluateChecked(raw, {
    spec: { format: 'v2', problems: ['missing section'] },
  });
  const legacy = evaluateChecked(
    report({ out_of_scope_files: ['docs/y.md'], criteria: [] }),
    {
      spec: null,
      refsProblems: null,
      ciFailures: null,
      tamperingFindings: null,
      allowedModels: null,
      approval: null,
      provenance: null,
    },
  );
  const noReport = evaluateChecked(null, {
    spec: V2_SPEC,
    scope: null,
    approval: approvalOf(null),
  });
  const results = [full, invalidSpec, legacy, noReport];
  for (const result of results) {
    for (const reason of result.reasons) {
      assert.ok(REASON_CODE_SET.has(reason.code), reason.text);
      assert.ok(reason.id === null || typeof reason.id === 'string');
    }
  }
  const allCodes = new Set(
    results.flatMap((result) => result.reasons.map(({ code }) => code)),
  );
  assert.deepStrictEqual(allCodes, REASON_CODE_SET);

  const kinds = [
    codeOf(full, 'ci check failed: Sample Check'),
    codeOf(full, 'out of scope file (computed): docs/x.md'),
    codeOf(invalidSpec, 'spec invalid: missing section'),
    codeOf(full, 'criterion failed: AC-1'),
    codeOf(full, `test tampering (scan): ${SKIP_FINDING}`),
  ];
  assert.deepStrictEqual(kinds, [
    CODE.CI_CHECK_FAILED,
    CODE.OUT_OF_SCOPE_FILE,
    CODE.SPEC_INVALID,
    CODE.CRITERION_FAILED,
    CODE.TAMPERING_SCAN_FINDING,
  ]);
  assert.strictEqual(new Set(kinds).size, kinds.length);
  const failed = full.reasons.find(({ text }) => text === 'criterion failed: AC-1');
  assert.strictEqual(failed.id, 'AC-1');
  assert.strictEqual(codeOf(full, 'criterion failed: DOD-2'), CODE.COMPUTED_ITEM_FAILED);
});

test('fails when a changed file is out of scope', () => {
  const raw = report({ out_of_scope_files: ['docs/x.md'] });
  const result = evaluateChecked(raw);
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('out of scope file: docs/x.md'));
});

test('manual-verified does not excuse an out of scope file', () => {
  const raw = report({ out_of_scope_files: ['docs/x.md'] });
  const result = evaluateChecked(raw, { manualVerified: true });
  assert.strictEqual(result.passed, false);
});

const SCOPE_V2_SPEC = { format: 'v2', problems: [] };

test('computed out of scope path fails v2 verdict', () => {
  const raw = report({ out_of_scope_files: [] });
  const scope = { out_of_scope: ['docs/unrelated.md'] };
  const result = evaluateChecked(raw, { spec: SCOPE_V2_SPEC, scope });
  assert.strictEqual(result.passed, false);
  assert.ok(
    result.failures.includes(
      'out of scope file (computed): docs/unrelated.md',
    ),
  );
});

test('legacy out_of_scope_files still fails verdict', () => {
  const raw = report({ out_of_scope_files: ['docs/x.md'] });
  const spec = { format: 'legacy', problems: [] };
  const result = evaluateChecked(raw, { spec });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('out of scope file: docs/x.md'));
});

test('missing scope file fails v2 verdict as not checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const scopeResult = readScopeResult(path.join(dir, 'absent.json'));
  assert.strictEqual(scopeResult, null);
  const result = evaluateChecked(report(), { spec: SCOPE_V2_SPEC, scope: scopeResult });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('scope was not checked'));
  fs.rmSync(dir, { recursive: true });
});

test('malformed scope file fails v2 verdict as not checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const file = path.join(dir, 'scope.json');
  fs.writeFileSync(file, '{oops');
  const scopeResult = readScopeResult(file);
  assert.strictEqual(scopeResult, null);
  const result = evaluateChecked(report(), { spec: SCOPE_V2_SPEC, scope: scopeResult });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('scope was not checked'));
  fs.rmSync(dir, { recursive: true });
});

test('in scope path does not fail verdict', () => {
  const raw = report({ out_of_scope_files: [] });
  const scope = { out_of_scope: [] };
  const result = evaluateChecked(raw, { spec: SCOPE_V2_SPEC, scope });
  assert.strictEqual(result.passed, true);
});

test('legacy issue skips scope-file check', () => {
  const spec = { format: 'legacy', problems: [] };
  const result = evaluateChecked(report(), { spec, scope: undefined });
  assert.strictEqual(result.passed, true);
  assert.ok(!result.failures.includes('scope was not checked'));
});

test('fails on zero criteria', () => {
  const result = evaluateChecked(report({ criteria: [] }));
  assert.strictEqual(result.passed, false);
});

test('fails on invalid JSON', () => {
  assert.strictEqual(evaluateChecked('{oops').passed, false);
});

test('fails when a report is missing', () => {
  assert.strictEqual(evaluateChecked(null).passed, false);
});

test('fails when the report violates the schema', () => {
  const invalid = report({ criteria: [{ text: 'a', status: 'MAYBE' }] });
  assert.strictEqual(evaluateChecked(invalid).passed, false);
  const missingField = JSON.stringify({ criteria: [criterion('PASS')] });
  assert.strictEqual(evaluateChecked(missingField).passed, false);
});

test('fails on the old evidence-string shape', () => {
  const legacy = report({
    criteria: [{ text: 'a', status: 'PASS', evidence: 'x.ts:1' }],
  });
  assert.strictEqual(evaluateChecked(legacy).passed, false);
});

test('fails when a reference is malformed', () => {
  const badLine = criterion('PASS', 'AC', { refs: [ref({ line: 0 })] });
  assert.strictEqual(
    evaluateChecked(report({ criteria: [badLine] })).passed,
    false,
  );
  const noQuote = criterion('PASS', 'AC', { refs: [ref({ quote: ' ' })] });
  assert.strictEqual(
    evaluateChecked(report({ criteria: [noQuote] })).passed,
    false,
  );
});

test('fails when any criterion fails', () => {
  const raw = report({ criteria: [criterion('PASS'), criterion('FAIL')] });
  assert.strictEqual(evaluateChecked(raw).passed, false);
});

test('PASS without references fails', () => {
  const raw = report({ criteria: [criterion('PASS', 'AC', { refs: [] })] });
  const result = evaluateChecked(raw);
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures[0].includes('without references'));
});

test('UNVERIFIABLE fails unless manual-verified is set', () => {
  const raw = report({ criteria: [criterion('UNVERIFIABLE')] });
  assert.strictEqual(evaluateChecked(raw).passed, false);
  const manual = evaluateChecked(raw, { manualVerified: true });
  assert.strictEqual(manual.passed, true);
});

test('manual-verified does not excuse a FAIL criterion', () => {
  const raw = report({ criteria: [criterion('FAIL')] });
  const result = evaluateChecked(raw, { manualVerified: true });
  assert.strictEqual(result.passed, false);
});

test('non-empty test_tampering fails, even when manual-verified', () => {
  const raw = report({ test_tampering: ['x.spec.ts: assertion removed'] });
  const result = evaluateChecked(raw, { manualVerified: true });
  assert.strictEqual(result.passed, false);
});

test('ignores a verdict field supplied by the model', () => {
  const raw = report({ verdict: 'PASS', criteria: [criterion('FAIL')] });
  assert.strictEqual(evaluateChecked(raw).passed, false);
});

test('risk_zones must be non-empty and come from the closed list', () => {
  assert.strictEqual(evaluateChecked(report({ risk_zones: [] })).passed, false);
  assert.strictEqual(
    evaluateChecked(report({ risk_zones: ['made_up'] })).passed,
    false,
  );
  assert.strictEqual(
    evaluateChecked(report({ risk_zones: ['ci', 'adr_034_manual_note'] }))
      .passed,
    true,
  );
});

test('risk_zones "none" cannot be combined with other zones', () => {
  const raw = report({ risk_zones: ['none', 'ci'] });
  assert.strictEqual(evaluateChecked(raw).passed, false);
});

test('fails when references were not checked', () => {
  const result = evaluate(report());
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('references were not checked'));
});

test('fails when a reference problem was reported', () => {
  const result = evaluateChecked(report(), {
    refsProblems: ['AC one: apps/api/x.ts:1 - quote not found on that line'],
  });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures[0].startsWith('bad reference:'));
});

test('fails the verdict for each tampering scan finding', () => {
  // Built by concatenation (never a contiguous literal): this spec file is
  // itself of class "test", so a literal marker here would flag this file.
  const marker = '.' + 'only(';
  const finding = `x.spec.ts:1: skip-style marker "${marker}" added in test file`;
  const result = evaluateChecked(report(), { tamperingFindings: [finding] });
  assert.strictEqual(result.passed, false);
  assert.ok(
    result.failures.includes(`test tampering (scan): ${finding}`),
  );
});

test('fails the verdict when the tampering scan result is missing or invalid', () => {
  assert.strictEqual(parseTamperingScan(null), null);
  assert.strictEqual(parseTamperingScan('{oops'), null);
  assert.strictEqual(parseTamperingScan(JSON.stringify({ notFindings: [] })), null);
  const result = evaluateChecked(report(), { tamperingFindings: null });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('tampering scan was not run'));
});

test('does not fail the verdict when the tampering scan result has no findings', () => {
  const result = evaluateChecked(report(), { tamperingFindings: [] });
  assert.strictEqual(result.passed, true);
});

test('fails with provenance missing when the provenance file is absent', () => {
  const result = evaluateChecked(report(), { provenance: null });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('provenance missing'));
});

test('allows a model listed in allowed-models', () => {
  const result = evaluateChecked(report(), {
    allowedModels: [PROVENANCE.model],
  });
  assert.strictEqual(result.passed, true);
});

test('fails when model is not in allowed-models', () => {
  const result = evaluateChecked(report(), {
    allowedModels: ['gpt-6-luna-mini'],
  });
  assert.strictEqual(result.passed, false);
  assert.ok(
    result.failures.includes(
      `VERIFIER_MODEL is not in allowed-models.json: ${PROVENANCE.model}`,
    ),
  );
});

test('fails when model differs from allowed-models only by case', () => {
  const upper = PROVENANCE.model.toUpperCase();
  const result = evaluateChecked(report(), {
    provenance: { ...PROVENANCE, model: upper },
    allowedModels: [PROVENANCE.model],
  });
  assert.strictEqual(result.passed, false);
  assert.ok(
    result.failures.includes(
      `VERIFIER_MODEL is not in allowed-models.json: ${upper}`,
    ),
  );
});

test('fails when model is an empty string', () => {
  const result = evaluateChecked(report(), {
    provenance: { ...PROVENANCE, model: '' },
    allowedModels: [PROVENANCE.model],
  });
  assert.strictEqual(result.passed, false);
  assert.ok(
    result.failures.includes('VERIFIER_MODEL is not in allowed-models.json: '),
  );
});

test('fails the verdict when the allowed models list is missing or invalid', () => {
  const result = evaluateChecked(report(), { allowedModels: null });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('allowed models were not checked'));
});

test('fails with provenance missing even when the spec is invalid (INV-6)', () => {
  const spec = { format: 'v2', problems: ['AC-1: invalid item syntax'] };
  const result = evaluate('{oops', { spec, provenance: null });
  assert.deepStrictEqual(result.failures, [
    'provenance missing',
    'spec invalid: AC-1: invalid item syntax',
  ]);
});

test('fails with provenance missing even when no report was read (INV-6)', () => {
  const result = evaluate(null, {
    spec: null,
    refsProblems: [],
    ciFailures: [],
    tamperingFindings: [],
    allowedModels: [],
    provenance: null,
  });
  assert.deepStrictEqual(result.failures, [
    'provenance missing',
    'spec was not checked',
    'no report',
  ]);
});

test('renders each tampering scan finding as a distinct failure reason', () => {
  const result = evaluateChecked(report(), {
    tamperingFindings: ['finding one', 'finding two'],
  });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('test tampering (scan): finding one'));
  assert.ok(result.failures.includes('test tampering (scan): finding two'));
});

test('manual-verified does not excuse a tampering scan finding', () => {
  const result = evaluateChecked(report(), {
    manualVerified: true,
    tamperingFindings: ['finding one'],
  });
  assert.strictEqual(result.passed, false);
});

test('success, neutral, skipped and running checks do not fail', () => {
  const checks = [
    { name: 'a', status: 'completed', conclusion: 'success' },
    { name: 'b', status: 'completed', conclusion: 'neutral' },
    { name: 'c', status: 'completed', conclusion: 'skipped' },
    { name: 'd', status: 'in_progress', conclusion: null },
  ];
  const statuses = [{ name: 'e', state: 'pending' }];
  const ci = parseCiFailures(
    ciJson({ checks: [codeqlSuccess, ...checks], statuses }),
  );
  assert.deepStrictEqual(ci, []);
  assert.strictEqual(
    evaluateChecked(report(), { ciFailures: ci }).passed,
    true,
  );
});

test('an invalid v2 spec fails closed without reading the model report', () => {
  const spec = { format: 'v2', problems: ['AC-1: invalid item syntax'] };
  // Malformed raw: if evaluate read it, it would add an 'invalid JSON'
  // failure alongside the spec one, which this test rules out.
  const result = evaluate('{oops', { spec, provenance: PROVENANCE });
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.report, null);
  assert.deepStrictEqual(result.failures, [
    'spec invalid: AC-1: invalid item syntax',
  ]);
});

test('a valid v2 spec does not change the verdict compared to omitting --spec', () => {
  const spec = { format: 'v2', problems: [] };
  const withSpec = evaluateChecked(report(), { spec });
  const withoutSpec = evaluateChecked(report());
  assert.strictEqual(withSpec.passed, true);
  assert.deepStrictEqual(withSpec.failures, withoutSpec.failures);
});

test('a missing spec file fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
  const specResult = readSpecResult(path.join(dir, 'absent.json'));
  assert.strictEqual(specResult, null);
  const result = evaluateChecked(report(), { spec: specResult });
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.failures, ['spec was not checked']);
  fs.rmSync(dir, { recursive: true });
});

test('an unparsable spec file fails closed the same way as a missing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
  const file = path.join(dir, 'spec-lint.json');
  fs.writeFileSync(file, '{oops');
  const specResult = readSpecResult(file);
  assert.strictEqual(specResult, null);
  const result = evaluateChecked(report(), { spec: specResult });
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.failures, ['spec was not checked']);
  fs.rmSync(dir, { recursive: true });
});

test('an unreadable spec is folded in alongside real report diagnostics, not instead of them', () => {
  const result = evaluate(null, {
    spec: null,
    refsProblems: [],
    ciFailures: [],
    tamperingFindings: [],
    allowedModels: [PROVENANCE.model],
    provenance: PROVENANCE,
  });
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.failures, ['spec was not checked', 'no report']);
});

const evaluateV2 = (raw) => {
  const refsProblems = checkIds(JSON.parse(raw), V2_SPEC.items);
  return evaluateChecked(raw, { spec: V2_SPEC, refsProblems });
};

test('v2 report whose criteria ids equal the issue ids has no id problems', () => {
  const raw = v2Report({ ids: ['DOD-1', 'AC-1', 'TR-1'] });
  assert.deepStrictEqual(checkIds(JSON.parse(raw), V2_SPEC.items), []);
  assert.strictEqual(evaluateV2(raw).passed, true);
});

test('v2 report missing an issue id fails naming the id', () => {
  const result = evaluateV2(v2Report({ ids: ['AC-1', 'TR-1'] }));
  assert.strictEqual(result.passed, false);
  assert.ok(
    hasFailureWith(result, 'issue criterion id missing from report: "DOD-1"'),
  );
});

test('v2 report with an id absent from the issue fails naming the id', () => {
  const result = evaluateV2(
    v2Report({ ids: ['AC-1', 'TR-1', 'DOD-1', 'AC-7'] }),
  );
  assert.strictEqual(result.passed, false);
  assert.ok(hasFailureWith(result, 'criterion id not in issue: "AC-7"'));
});

test('v2 report with a duplicate id fails naming the id', () => {
  const result = evaluateV2(
    v2Report({ ids: ['AC-1', 'TR-1', 'DOD-1', 'TR-1'] }),
  );
  assert.strictEqual(result.passed, false);
  assert.ok(
    hasFailureWith(result, 'duplicate criterion id in report: "TR-1"'),
  );
});

test('v2 invariants with PASS and N/A statuses do not fail', () => {
  const raw = v2Report();
  const parsed = JSON.parse(raw);
  assert.deepStrictEqual(parsed.invariants[1].refs, []);
  assert.deepStrictEqual(checkIds(parsed, V2_SPEC.items), []);
  const result = evaluateV2(raw);
  assert.strictEqual(result.passed, true);
  assert.deepStrictEqual(result.failures, []);
});

test('v2 report missing an issue invariant fails naming it', () => {
  const raw = v2Report({ invariants: [invariant('INV-2', 'N/A')] });
  const result = evaluateV2(raw);
  assert.strictEqual(result.passed, false);
  assert.ok(
    hasFailureWith(result, 'issue invariant id missing from report: "INV-1"'),
  );
});

test('v2 invariant with FAIL status fails naming it', () => {
  const raw = v2Report({
    invariants: [invariant('INV-1', 'FAIL'), invariant('INV-2', 'N/A')],
  });
  const result = evaluateV2(raw);
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('invariant failed: INV-1'));
});

test('v2 invariant PASS without valid references fails', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const badQuote = JSON.parse(
    v2Report({
      invariants: [
        invariant('INV-1', 'PASS', { refs: [ref({ quote: 'not there' })] }),
        invariant('INV-2', 'N/A'),
      ],
    }),
  );
  const problems = checkRefs(badQuote, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].startsWith('INV-1: apps/api/x.ts:1'));
  const withBadQuote = evaluateChecked(JSON.stringify(badQuote), {
    spec: V2_SPEC,
    refsProblems: problems,
  });
  assert.strictEqual(withBadQuote.passed, false);

  const noRefs = v2Report({
    invariants: [
      invariant('INV-1', 'PASS', { refs: [] }),
      invariant('INV-2', 'N/A'),
    ],
  });
  const noRefsProblems = checkRefs(JSON.parse(noRefs), root);
  assert.deepStrictEqual(noRefsProblems, ['INV-1: PASS without references']);
  const result = evaluateChecked(noRefs, {
    spec: V2_SPEC,
    refsProblems: noRefsProblems,
  });
  assert.strictEqual(result.passed, false);
  assert.ok(
    result.failures.includes('invariant passed without references: INV-1'),
  );
  fs.rmSync(root, { recursive: true });
});

test('v2 spec uses id matching instead of count coverage', () => {
  const ids = ['AC-1', 'TR-1', 'X-1', 'X-2', 'X-3', 'X-4'];
  const parsed = JSON.parse(v2Report({ ids }));
  assert.deepStrictEqual(checkCoverage(parsed, ISSUE_MD), []);
  const problems = checkIssueCoverage(parsed, {
    spec: V2_SPEC,
    issueMarkdown: ISSUE_MD,
  });
  assert.ok(
    problems.includes('issue criterion id missing from report: "DOD-1"'),
  );
  assert.ok(!problems.some((problem) => problem.startsWith('report covers')));
  const result = evaluateChecked(JSON.stringify(parsed), {
    spec: V2_SPEC,
    refsProblems: problems,
  });
  assert.strictEqual(result.passed, false);
});

test('invariant status outside PASS FAIL N/A violates the schema', () => {
  const raw = v2Report({
    invariants: [
      invariant('INV-1', 'UNVERIFIABLE'),
      invariant('INV-2', 'N/A'),
    ],
  });
  const result = evaluateChecked(raw);
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.failures, ['report violates schema']);
});

test('report without id or invariants violates the schema', () => {
  const withoutInvariants = JSON.parse(report());
  withoutInvariants.invariants = undefined;
  const noInvariants = evaluateChecked(JSON.stringify(withoutInvariants));
  assert.strictEqual(noInvariants.passed, false);
  assert.deepStrictEqual(noInvariants.failures, ['report violates schema']);

  const withoutId = { ...criterion('PASS'), id: undefined };
  const noId = evaluateChecked(report({ criteria: [withoutId] }));
  assert.strictEqual(noId.passed, false);
  assert.deepStrictEqual(noId.failures, ['report violates schema']);
});

test('a reference with a missing or invalid kind is rejected', () => {
  const missingKind = criterion('PASS', 'AC', {
    refs: [{ path: 'apps/api/x.ts', line: 1, quote: 'export const x' }],
  });
  assert.strictEqual(
    evaluateChecked(report({ criteria: [missingKind] })).passed,
    false,
  );
  const invalidKind = criterion('PASS', 'AC', {
    refs: [ref({ kind: 'bogus' })],
  });
  assert.strictEqual(
    evaluateChecked(report({ criteria: [invalidKind] })).passed,
    false,
  );
});

test('an extra model entry for a ci/absence id is ignored', () => {
  const raw = report({
    criteria: [
      criterion('PASS', 'model text AC-1', { id: 'AC-1' }),
      criterion('FAIL', 'model text DOD-1', { id: 'DOD-1' }),
    ],
  });
  const idProblems = checkIds(JSON.parse(raw), CI_ABSENCE_SPEC_ITEMS);
  assert.deepStrictEqual(idProblems, []);

  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const refsProblems = checkRefs(JSON.parse(raw), root, CI_ABSENCE_SPEC_ITEMS);
  assert.deepStrictEqual(refsProblems, []);
  fs.rmSync(root, { recursive: true });

  const spec = { format: 'v2', problems: [], items: CI_ABSENCE_SPEC_ITEMS };
  const computedItems = [
    {
      id: 'DOD-1',
      text: '',
      status: 'PASS',
      summary: 'computed',
      refs: [],
      computed: true,
    },
  ];
  const result = evaluateChecked(raw, {
    spec,
    computedItems,
    refsProblems: idProblems,
  });
  assert.strictEqual(result.passed, true);
});

test('v2 spec without approval fails', () => {
  const approval = approvalOf(null);
  const result = evaluateChecked(report(), { spec: APPROVAL_V2_SPEC, approval });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('spec not approved'));
});

test('changed v2 spec after approval fails', () => {
  const approval = approvalOf(SHA_APPROVED);
  const result = evaluateChecked(report(), { spec: APPROVAL_V2_SPEC, approval });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('spec changed after approval'));
});

test('changed legacy spec after approval fails', () => {
  const approval = approvalOf(SHA_APPROVED);
  const result = evaluateChecked(report(), { spec: APPROVAL_LEGACY_SPEC, approval });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('spec changed after approval'));
});

test('approval failures are kept when the report is missing', () => {
  const approval = approvalOf(SHA_APPROVED);
  const result = evaluateChecked(null, { spec: APPROVAL_V2_SPEC, approval });
  assert.ok(result.failures.includes('spec changed after approval'));
  assert.ok(result.failures.includes('no report'));
});

test('fails on assertion losses without test-removal approval', () => {
  const result = evaluateChecked(report(), { assertionLosses: [LOSS] });
  assert.strictEqual(result.passed, false);
  const reason = result.failures.find((f) => f.startsWith('test tampering (scan)'));
  assert.ok(reason.includes('apps/api/x.spec.ts'));
  assert.ok(reason.includes('3'));
});

test('test-removal approval does not excuse other scanner findings', () => {
  const result = evaluateChecked(report(), {
    tamperingFindings: [SKIP_FINDING],
    testRemovalApproved: true,
  });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes(`test tampering (scan): ${SKIP_FINDING}`));
});

test('test-removal approval does not excuse model test_tampering', () => {
  const raw = report({ test_tampering: ['assertion weakened'] });
  const result = evaluateChecked(raw, { testRemovalApproved: true });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('test tampering: assertion weakened'));
});

test('manual-verified does not excuse assertion losses', () => {
  const result = evaluateChecked(report(), {
    assertionLosses: [LOSS],
    manualVerified: true,
  });
  assert.strictEqual(result.passed, false);
});

test('fails closed on a tampering scan result without valid assertion fields', () => {
  const variants = [
    { findings: [], assertion_moved: 0 },
    { findings: [], assertion_losses: [] },
    { findings: [], assertion_losses: [{ lost: 1 }], assertion_moved: 0 },
    { findings: [], assertion_losses: [{ path: 'a' }], assertion_moved: 0 },
    { findings: [], assertion_losses: [{ path: 'a', lost: 0 }], assertion_moved: 0 },
    { findings: [], assertion_losses: [], assertion_moved: -1 },
  ];
  for (const variant of variants) {
    assert.strictEqual(parseTamperingScan(JSON.stringify(variant)), null);
  }
  const result = evaluateChecked(report(), { tamperingFindings: null });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('tampering scan was not run'));
  assert.deepStrictEqual(
    parseTamperingScan(JSON.stringify(scanResult({ assertion_losses: [LOSS] }))),
    { findings: [], assertionLosses: [LOSS], assertionMoved: 0 },
  );
});

test('fails when moved assertions come with another scanner finding', () => {
  const result = evaluateChecked(report(), {
    assertionMoved: 12,
    tamperingFindings: [SKIP_FINDING],
  });
  assert.strictEqual(result.passed, false);
});

test('missing or invalid refs-notes does not change the verdict', () => {
  const raw = report();
  const base = evaluateChecked(raw);
  const withBadNotes = evaluateChecked(raw, {
    refsNotes: [
      { list: 'criteria', entry: 5, ref: 0, cited: 1, found: 2 },
      { list: 'criteria', entry: 0, ref: 9, cited: 1, found: 2 },
    ],
  });
  assert.strictEqual(withBadNotes.passed, base.passed);
  assert.deepStrictEqual(withBadNotes.failures, base.failures);
  assert.strictEqual(withBadNotes.refsNotesByKey.size, 0);
});
