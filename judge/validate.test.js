'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateAnalysis,
  applyFateHistory,
  validateIndependentResult,
  checkModel,
} = require('./validate');

// The real taxonomy (AC-5/AC-6): the new SPEC_NOT_APPROVED cause and
// owner_process responsibility must come from this trusted file, not a
// fixture copy that could drift from it.
const REAL_TAXONOMY = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'test', 'fixtures', 'judge', 'taxonomy.json'),
    'utf8',
  ),
);

const TAXONOMY = {
  primary_cause: ['ISSUE_DEFECT', 'IMPLEMENTATION_DEFECT', 'INSUFFICIENT_EVIDENCE'],
  responsibility: ['issue_authoring', 'implementation', 'unknown'],
  issue_defect_subtype: ['AMBIGUOUS_REQUIREMENT'],
  verifier_defect_subtype: ['MISREAD_CODE'],
  recommended_change_target: ['prompt', 'none'],
  defect_fate: [
    'INITIAL',
    'RESOLVED',
    'PERSISTING',
    'NEW_REAL',
    'LATE_FINDING',
    'FIX_REGRESSION',
    'FALSE_FINDING',
    'UNKNOWN',
  ],
  fate_without_previous_round: ['INITIAL', 'FALSE_FINDING', 'UNKNOWN'],
  fate_requires_previous_finding: ['RESOLVED', 'PERSISTING'],
  fate_requires_new_finding: [
    'INITIAL',
    'NEW_REAL',
    'LATE_FINDING',
    'FIX_REGRESSION',
  ],
  counterfactual_outcome: ['RESOLVES', 'DOES_NOT_RESOLVE', 'UNKNOWN'],
  verdict: ['PASS', 'FAIL', 'UNDECIDABLE'],
  requirement_status: [
    'SATISFIED',
    'NOT_SATISFIED',
    'AMBIGUOUS_SPEC',
    'INSUFFICIENT_EVIDENCE',
  ],
  confidence: ['LOW', 'MEDIUM', 'HIGH'],
  check_source: ['model', 'deterministic'],
};

const SHA = 'a'.repeat(40);

const codeEvidence = (overrides = {}) => ({
  type: 'code',
  sha: SHA,
  path: 'src/module.js',
  note: 'the function returns FAIL unconditionally here',
  ...overrides,
});

const finding = (overrides = {}) => ({
  finding_id: 'f-1',
  criterion_id: 'AC-1',
  fate: 'INITIAL',
  evidence: [codeEvidence()],
  ...overrides,
});

const minimalAnalysis = (overrides = {}) => ({
  observed_verdict: 'FAIL',
  independent_expected_verdict: 'FAIL',
  primary_cause: 'IMPLEMENTATION_DEFECT',
  responsibility: 'implementation',
  confidence: 'HIGH',
  issue_defects: [],
  implementation_defects: [],
  verifier_defects: [],
  correct_verifier_findings: [],
  counterfactual: {
    fix_issue_only: 'DOES_NOT_RESOLVE',
    fix_implementation_only: 'RESOLVES',
    fix_verifier_only: 'DOES_NOT_RESOLVE',
  },
  systemic_lessons: [],
  golden_case_recommendation: null,
  ...overrides,
});

test('accepts a complete analysis', () => {
  const analysis = minimalAnalysis({
    implementation_defects: [finding({ check_source: 'model' })],
    verifier_defects: [
      finding({
        finding_id: 'f-2',
        criterion_id: null,
        subtype: 'MISREAD_CODE',
        recommended_change_target: 'prompt',
      }),
    ],
    issue_defects: [
      finding({ finding_id: 'f-3', subtype: 'AMBIGUOUS_REQUIREMENT' }),
    ],
    correct_verifier_findings: [finding({ finding_id: 'f-4' })],
  });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.deepStrictEqual(result, { valid: true, problems: [] });
});

test('rejects primary_cause outside taxonomy', () => {
  const analysis = minimalAnalysis({ primary_cause: 'NOT_A_REAL_CAUSE' });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.startsWith('primary_cause')));
});

test('rejects responsibility outside taxonomy', () => {
  const analysis = minimalAnalysis({ responsibility: 'not_a_real_component' });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.startsWith('responsibility')));
});

test('accepts spec approval cause from trusted taxonomy', () => {
  const analysis = minimalAnalysis({
    primary_cause: 'SPEC_NOT_APPROVED',
    responsibility: 'owner_process',
  });
  const result = validateAnalysis(analysis, REAL_TAXONOMY);
  assert.deepStrictEqual(result, { valid: true, problems: [] });
});

test('rejects spec approval cause in wrong case', () => {
  const analysis = minimalAnalysis({ primary_cause: 'spec_not_approved' });
  const result = validateAnalysis(analysis, REAL_TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.startsWith('primary_cause')));
});

test('rejects issue defect subtype outside taxonomy', () => {
  const analysis = minimalAnalysis({
    issue_defects: [finding({ subtype: 'NOT_A_REAL_SUBTYPE' })],
  });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('subtype')));
});

test('rejects verifier defect subtype outside taxonomy', () => {
  const analysis = minimalAnalysis({
    verifier_defects: [
      finding({ subtype: 'NOT_A_REAL_SUBTYPE', recommended_change_target: 'none' }),
    ],
  });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('subtype')));
});

test('rejects finding without criterion_id', () => {
  const bad = finding();
  delete bad.criterion_id;
  const analysis = minimalAnalysis({ implementation_defects: [bad] });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('criterion_id is required')));
});

test('accepts finding with null criterion_id', () => {
  const analysis = minimalAnalysis({
    implementation_defects: [finding({ criterion_id: null })],
  });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.deepStrictEqual(result, { valid: true, problems: [] });
});

test('rejects malformed criterion_id', () => {
  const analysis = minimalAnalysis({
    implementation_defects: [finding({ criterion_id: 'AC1' })],
  });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('criterion_id is malformed')));
});

test('rejects missing or duplicate finding_id', () => {
  const missing = finding();
  delete missing.finding_id;
  const missingResult = validateAnalysis(
    minimalAnalysis({ implementation_defects: [missing] }),
    TAXONOMY,
  );
  assert.strictEqual(missingResult.valid, false);
  assert.ok(
    missingResult.problems.some((problem) => problem.includes('finding_id is required')),
  );

  const duplicateResult = validateAnalysis(
    minimalAnalysis({
      implementation_defects: [finding({ finding_id: 'dup' })],
      correct_verifier_findings: [finding({ finding_id: 'dup' })],
    }),
    TAXONOMY,
  );
  assert.strictEqual(duplicateResult.valid, false);
  assert.ok(
    duplicateResult.problems.some((problem) => problem.includes('duplicate finding_id: dup')),
  );
});

test('rejects finding without evidence', () => {
  const emptyEvidence = validateAnalysis(
    minimalAnalysis({ implementation_defects: [finding({ evidence: [] })] }),
    TAXONOMY,
  );
  assert.strictEqual(emptyEvidence.valid, false);
  assert.ok(
    emptyEvidence.problems.some((problem) => problem.includes('evidence must be a non-empty array')),
  );

  const badShaResult = validateAnalysis(
    minimalAnalysis({
      implementation_defects: [
        finding({ evidence: [codeEvidence({ sha: 'not-a-sha' })] }),
      ],
    }),
    TAXONOMY,
  );
  assert.strictEqual(badShaResult.valid, false);
  assert.ok(badShaResult.problems.some((problem) => problem.includes('evidence[0] is invalid')));
});

const inputEvidence = (overrides = {}) => ({
  type: 'input',
  note: 'the file list of the round',
  sha: null,
  path: null,
  ref: null,
  ...overrides,
});

const withEvidence = (evidence) =>
  minimalAnalysis({ implementation_defects: [finding({ evidence })] });

test('accepts input evidence named by path', () => {
  const evidence = [
    inputEvidence({ path: 'input/files.txt' }),
    inputEvidence({ type: 'log', path: 'input/run.log' }),
    inputEvidence({ ref: 'criteria/AC-1' }),
    inputEvidence({ path: 'input/issue.md', ref: 'L12' }),
  ];
  const result = validateAnalysis(withEvidence(evidence), TAXONOMY);
  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(result.valid, true);
});

test('rejects input evidence without path or ref', () => {
  for (const type of ['input', 'log']) {
    for (const empty of [null, '']) {
      const evidence = [
        inputEvidence({ path: 'input/files.txt' }),
        inputEvidence({ type, path: empty, ref: empty }),
      ];
      const result = validateAnalysis(withEvidence(evidence), TAXONOMY);
      assert.strictEqual(result.valid, false);
      assert.ok(
        result.problems.some((problem) => problem.includes('evidence[1] is invalid')),
      );
      assert.ok(
        !result.problems.some((problem) => problem.includes('evidence[0] is invalid')),
      );
    }
  }
  const codeWithoutPath = validateAnalysis(
    withEvidence([codeEvidence({ path: null, ref: 'L1' })]),
    TAXONOMY,
  );
  assert.strictEqual(codeWithoutPath.valid, false);
});

test('accepts insufficient evidence analysis', () => {
  const analysis = minimalAnalysis({
    primary_cause: 'INSUFFICIENT_EVIDENCE',
    responsibility: 'unknown',
    independent_expected_verdict: 'UNDECIDABLE',
    confidence: 'LOW',
    counterfactual: {
      fix_issue_only: 'UNKNOWN',
      fix_implementation_only: 'UNKNOWN',
      fix_verifier_only: 'UNKNOWN',
    },
  });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.deepStrictEqual(result, { valid: true, problems: [] });
});

test('validates check_source separately from primary_cause', () => {
  const badSource = validateAnalysis(
    minimalAnalysis({
      implementation_defects: [finding({ check_source: 'not_a_real_source' })],
    }),
    TAXONOMY,
  );
  assert.strictEqual(badSource.valid, false);
  assert.ok(badSource.problems.some((problem) => problem.includes('check_source')));

  const nullSource = validateAnalysis(
    minimalAnalysis({
      implementation_defects: [finding({ check_source: null })],
    }),
    TAXONOMY,
  );
  assert.deepStrictEqual(nullSource, { valid: true, problems: [] });
});

const ROUND_KEY = {
  repository: 'owner/repo',
  verifier_run_id: 200,
  verifier_run_attempt: 1,
};
const PREVIOUS_ROUND_KEY = { ...ROUND_KEY, verifier_run_id: 100 };

const previousRound = (findings) => ({
  status: 'present',
  analysis: minimalAnalysis({ implementation_defects: findings }),
});

const FIRST_ROUND = { status: 'absent', analysis: null };

test('accepts fate classes in a later round', () => {
  const previous = previousRound([finding({ finding_id: 'f-1' })]);
  const analysis = minimalAnalysis({
    implementation_defects: [
      finding({ finding_id: 'f-1', fate: 'PERSISTING' }),
      finding({ finding_id: 'f-2', fate: 'NEW_REAL' }),
      finding({ finding_id: 'f-3', fate: 'LATE_FINDING' }),
      finding({ finding_id: 'f-4', fate: 'FIX_REGRESSION' }),
    ],
  });
  assert.deepStrictEqual(validateAnalysis(analysis, TAXONOMY), {
    valid: true,
    problems: [],
  });
  const result = applyFateHistory(analysis, previous, ROUND_KEY, TAXONOMY);
  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(result.valid, true);
});

test('rejects fate outside taxonomy', () => {
  const analysis = minimalAnalysis({
    implementation_defects: [finding({ fate: 'FIXED_SOMEHOW' })],
  });
  const result = validateAnalysis(analysis, TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('fate')));

  const missing = minimalAnalysis({
    implementation_defects: [finding({ fate: undefined })],
  });
  assert.strictEqual(validateAnalysis(missing, TAXONOMY).valid, false);
});

test('first round allows only initial false or unknown', () => {
  for (const fate of ['LATE_FINDING', 'NEW_REAL', 'RESOLVED']) {
    const analysis = minimalAnalysis({
      implementation_defects: [finding({ fate })],
    });
    const result = applyFateHistory(analysis, FIRST_ROUND, ROUND_KEY, TAXONOMY);
    assert.strictEqual(result.valid, false, fate);
    assert.strictEqual(result.analysis, null, fate);
    assert.match(result.problems[0], /not allowed in the first round/);
  }
  for (const fate of ['INITIAL', 'UNKNOWN', 'FALSE_FINDING']) {
    const analysis = minimalAnalysis({
      implementation_defects: [finding({ fate })],
    });
    const result = applyFateHistory(analysis, FIRST_ROUND, ROUND_KEY, TAXONOMY);
    assert.strictEqual(result.valid, true, fate);
  }
});

test('resolved requires previous finding id', () => {
  const previous = previousRound([finding({ finding_id: 'f-old' })]);
  for (const fate of ['RESOLVED', 'PERSISTING']) {
    const unknownId = minimalAnalysis({
      implementation_defects: [finding({ finding_id: 'f-new', fate })],
    });
    const rejected = applyFateHistory(unknownId, previous, ROUND_KEY, TAXONOMY);
    assert.strictEqual(rejected.valid, false, fate);
    assert.match(rejected.problems[0], /requires finding_id f-new/);

    const knownId = minimalAnalysis({
      implementation_defects: [finding({ finding_id: 'f-old', fate })],
    });
    const accepted = applyFateHistory(knownId, previous, ROUND_KEY, TAXONOMY);
    assert.strictEqual(accepted.valid, true, fate);
  }
});

test('a new defect cannot reuse a previous finding id', () => {
  const firstDetection = { round_key: PREVIOUS_ROUND_KEY, fate: 'INITIAL' };
  const previous = previousRound([
    finding({ finding_id: 'f-old', first_detection: firstDetection }),
  ]);
  for (const fate of ['NEW_REAL', 'LATE_FINDING', 'FIX_REGRESSION', 'INITIAL']) {
    const reused = minimalAnalysis({
      implementation_defects: [finding({ finding_id: 'f-old', fate })],
    });
    const result = applyFateHistory(reused, previous, ROUND_KEY, TAXONOMY);
    assert.strictEqual(result.valid, false, fate);
    assert.ok(
      result.problems.some((problem) => /reuses finding_id f-old/.test(problem)),
      fate,
    );
  }
  for (const fate of ['FALSE_FINDING', 'UNKNOWN']) {
    const judged = minimalAnalysis({
      implementation_defects: [finding({ finding_id: 'f-old', fate })],
    });
    const result = applyFateHistory(judged, previous, ROUND_KEY, TAXONOMY);
    assert.strictEqual(result.valid, true, fate);
    assert.deepStrictEqual(
      result.analysis.implementation_defects[0].first_detection,
      firstDetection,
    );
  }
});

test('unreadable previous round proves no earlier finding', () => {
  const previous = { status: 'unreadable', analysis: null };
  const resolved = minimalAnalysis({
    implementation_defects: [finding({ fate: 'RESOLVED' })],
  });
  const late = minimalAnalysis({
    implementation_defects: [finding({ fate: 'LATE_FINDING' })],
  });
  assert.strictEqual(
    applyFateHistory(resolved, previous, ROUND_KEY, TAXONOMY).valid,
    false,
  );
  assert.strictEqual(
    applyFateHistory(late, previous, ROUND_KEY, TAXONOMY).valid,
    true,
  );
});

test('allows several findings per criterion', () => {
  const analysis = minimalAnalysis({
    implementation_defects: [
      finding({ finding_id: 'f-1', criterion_id: 'AC-2' }),
      finding({ finding_id: 'f-2', criterion_id: 'AC-2' }),
    ],
  });
  assert.deepStrictEqual(validateAnalysis(analysis, TAXONOMY), {
    valid: true,
    problems: [],
  });
  const result = applyFateHistory(analysis, FIRST_ROUND, ROUND_KEY, TAXONOMY);
  assert.strictEqual(result.valid, true);
  const ids = result.analysis.implementation_defects.map(
    ({ finding_id: id }) => id,
  );
  assert.deepStrictEqual(ids, ['f-1', 'f-2']);
});

test('unknown history does not require confident class', () => {
  const analysis = minimalAnalysis({
    implementation_defects: [finding({ fate: 'UNKNOWN' })],
  });
  const result = applyFateHistory(analysis, FIRST_ROUND, ROUND_KEY, TAXONOMY);
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.analysis.implementation_defects[0].first_detection, {
    round_key: ROUND_KEY,
    fate: 'UNKNOWN',
  });
});

test('keeps first detection from the previous round', () => {
  const firstDetection = { round_key: PREVIOUS_ROUND_KEY, fate: 'LATE_FINDING' };
  const previous = previousRound([
    finding({ fate: 'PERSISTING', first_detection: firstDetection }),
  ]);
  const analysis = minimalAnalysis({
    implementation_defects: [finding({ fate: 'RESOLVED' })],
  });
  const result = applyFateHistory(analysis, previous, ROUND_KEY, TAXONOMY);
  assert.deepStrictEqual(
    result.analysis.implementation_defects[0].first_detection,
    firstDetection,
  );
  assert.strictEqual(analysis.implementation_defects[0].first_detection, undefined);
});

test('fails closed when taxonomy has no fate rules', () => {
  const withoutRules = { ...TAXONOMY };
  delete withoutRules.fate_requires_previous_finding;
  const analysis = minimalAnalysis({
    implementation_defects: [finding({ fate: 'UNKNOWN' })],
  });
  const result = applyFateHistory(analysis, FIRST_ROUND, ROUND_KEY, withoutRules);
  assert.deepStrictEqual(result, {
    valid: false,
    problems: ['taxonomy has no fate rules'],
    analysis: null,
  });
});

test('accepts a correct stage 1 (independent) result', () => {
  const result = validateIndependentResult(
    {
      independent_expected_verdict: 'PASS',
      requirements: [
        {
          id: 'AC-1',
          literal_requirement: 'taxonomy.json contains the listed values',
          evidence_expected: 'the file exists with the required keys',
          single_interpretation: true,
          verify_proves_requirement: true,
          status: 'SATISFIED',
          rationale: 'the file was read and every key matched',
        },
      ],
    },
    TAXONOMY,
  );
  assert.deepStrictEqual(result, { valid: true, problems: [] });
});

test('rejects a stage 1 result with a status outside taxonomy', () => {
  const result = validateIndependentResult(
    {
      independent_expected_verdict: 'PASS',
      requirements: [
        {
          id: 'AC-1',
          literal_requirement: 'x',
          evidence_expected: 'y',
          single_interpretation: true,
          verify_proves_requirement: true,
          status: 'NOT_A_REAL_STATUS',
          rationale: 'z',
        },
      ],
    },
    TAXONOMY,
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('status')));
});

test('rejects independent result without valid expected verdict', () => {
  const requirements = [
    {
      id: 'AC-1',
      literal_requirement: 'x',
      evidence_expected: 'y',
      single_interpretation: true,
      verify_proves_requirement: true,
      status: 'SATISFIED',
      rationale: 'z',
    },
  ];
  const missing = validateIndependentResult({ requirements }, TAXONOMY);
  assert.strictEqual(missing.valid, false);
  assert.ok(
    missing.problems.some((problem) => problem.includes('independent_expected_verdict')),
  );

  const outside = validateIndependentResult(
    { independent_expected_verdict: 'MAYBE', requirements },
    TAXONOMY,
  );
  assert.strictEqual(outside.valid, false);
  assert.ok(
    outside.problems.some((problem) => problem.includes('independent_expected_verdict')),
  );
});

test('accepts allowed judge model different from verifier', () => {
  const result = checkModel('judge-model', 'verifier-model', ['judge-model']);
  assert.deepStrictEqual(result, { allowed: true, reason: null });
});

test('accepts judge model equal to verifier model when allowlisted', () => {
  const result = checkModel('same-model', 'same-model', ['same-model']);
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.reason, null);
});

test('rejects judge model missing from allowlist', () => {
  const result = checkModel('judge-model', 'verifier-model', ['other-model']);
  assert.strictEqual(result.allowed, false);
  assert.match(result.reason, /not in allowlist/);
});

test('rejects judge model equal to verifier model when not in allowlist', () => {
  const result = checkModel('same-model', 'same-model', ['other-model']);
  assert.strictEqual(result.allowed, false);
  assert.match(result.reason, /not in allowlist/);
});

test('fails closed on unreadable allowlist or unknown verifier model', () => {
  const unreadable = checkModel('judge-model', 'verifier-model', null);
  assert.strictEqual(unreadable.allowed, false);
  assert.match(unreadable.reason, /allowlist was not checked/);

  const unknownVerifier = checkModel('judge-model', '', ['judge-model']);
  assert.strictEqual(unknownVerifier.allowed, false);
  assert.match(unknownVerifier.reason, /verifier model is unknown/);
});

test('rejects cause outside project taxonomy', () => {
  const analysis = minimalAnalysis({ primary_cause: 'NOT_A_REAL_CAUSE' });
  const result = validateAnalysis(analysis, REAL_TAXONOMY);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.problems, ['primary_cause is outside taxonomy: NOT_A_REAL_CAUSE']);

  const known = minimalAnalysis({ primary_cause: REAL_TAXONOMY.primary_cause[0] });
  assert.ok(!validateAnalysis(known, REAL_TAXONOMY).problems.some((problem) => problem.startsWith('primary_cause')));
});

// The reference inputs of the validation checks the Judge was transferred with, and the
// results they gave there.
test('preserves reference analysis validation results', () => {
  const reference = [
    { name: 'complete analysis', analysis: minimalAnalysis({ implementation_defects: [finding()] }), problems: [] },
    {
      name: 'unknown primary cause',
      analysis: minimalAnalysis({ primary_cause: 'NOT_A_REAL_CAUSE' }),
      problems: ['primary_cause is outside taxonomy: NOT_A_REAL_CAUSE'],
    },
    {
      name: 'unknown responsibility',
      analysis: minimalAnalysis({ responsibility: 'not_a_real_component' }),
      problems: ['responsibility is outside taxonomy: not_a_real_component'],
    },
    {
      name: 'finding without evidence',
      analysis: minimalAnalysis({ implementation_defects: [finding({ evidence: [] })] }),
      startsWith: 'implementation_defects',
    },
    {
      name: 'finding with a malformed criterion id',
      analysis: minimalAnalysis({ implementation_defects: [finding({ criterion_id: 'bad id' })] }),
      startsWith: 'implementation_defects',
    },
  ];
  for (const { name, analysis, problems, startsWith } of reference) {
    const result = validateAnalysis(analysis, TAXONOMY);
    if (problems !== undefined) {
      assert.deepStrictEqual(result.problems, problems, name);
      assert.strictEqual(result.valid, problems.length === 0, name);
    } else {
      assert.strictEqual(result.valid, false, name);
      assert.ok(result.problems.every((problem) => problem.startsWith(startsWith)), `${name}: ${result.problems}`);
    }
  }
});
