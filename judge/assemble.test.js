'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { loadTaxonomy } = require('./taxonomy');
const { assemble, buildAnalysisError } = require('./assemble');

const TAXONOMY = loadTaxonomy(
  path.join(__dirname, '..', 'test', 'fixtures', 'judge', 'taxonomy.json'),
);

const manifest = () => ({
  round_key: {
    repository: 'owner/repo',
    verifier_run_id: 101,
    verifier_run_attempt: 2,
  },
  head_sha: 'a'.repeat(40),
  inputs: {
    issue: { status: 'present', historical: true },
    verdict: { status: 'absent', historical: null },
  },
});

const stage1 = () => ({
  independent_expected_verdict: 'FAIL',
  requirements: [
    {
      id: 'AC-1',
      literal_requirement: 'the CLI rejects an empty name',
      evidence_expected: 'a negative test',
      single_interpretation: true,
      verify_proves_requirement: true,
      status: 'NOT_SATISFIED',
      rationale: 'no test exercises the empty name',
    },
  ],
});

const stage2 = () => ({
  observed_verdict: 'FAIL',
  independent_expected_verdict: 'FAIL',
  primary_cause: 'IMPLEMENTATION_DEFECT',
  responsibility: 'implementation',
  confidence: 'HIGH',
  issue_defects: [],
  implementation_defects: [
    {
      finding_id: 'F-1',
      criterion_id: 'AC-1',
      fate: 'INITIAL',
      check_source: 'model',
      description: 'empty name is accepted',
      evidence: [
        { type: 'code', sha: 'a'.repeat(40), path: 'x.js', note: 'no check' },
      ],
    },
  ],
  verifier_defects: [],
  correct_verifier_findings: [],
  counterfactual: {
    fix_issue_only: 'DOES_NOT_RESOLVE',
    fix_implementation_only: 'RESOLVES',
    fix_verifier_only: 'DOES_NOT_RESOLVE',
  },
  systemic_lessons: [],
  golden_case_recommendation: null,
});

// The analysis assemble returns for a first round: every finding records
// this round as its first detection, with its own fate.
const withFirstDetection = (analysis) => {
  const result = structuredClone(analysis);
  for (const item of result.implementation_defects) {
    item.first_detection = { round_key: manifest().round_key, fate: item.fate };
  }
  return result;
};

const PREVIOUS_ROUND_KEY = { ...manifest().round_key, verifier_run_id: 90 };

const previousRound = (findings) => ({
  status: 'present',
  analysis: { ...stage2(), implementation_defects: findings },
});

test('keeps stage one result unchanged', () => {
  const input = stage1();
  const result = assemble({
    manifest: manifest(),
    stage1: input,
    stage2: stage2(),
    taxonomy: TAXONOMY,
  });

  assert.strictEqual(result.error, null);
  assert.deepStrictEqual(result.independent, stage1());
  assert.notStrictEqual(result.independent, input);
  assert.deepStrictEqual(result.analysis, withFirstDetection(stage2()));
  assert.deepStrictEqual(result.round_key, manifest().round_key);
  assert.strictEqual(result.head_sha, manifest().head_sha);
  assert.deepStrictEqual(result.inputs, manifest().inputs);
});

test('ignores stage two override of independent verdict', () => {
  const override = { ...stage2(), independent_expected_verdict: 'PASS' };
  const result = assemble({
    manifest: manifest(),
    stage1: stage1(),
    stage2: override,
    taxonomy: TAXONOMY,
  });

  assert.strictEqual(result.error, null);
  assert.strictEqual(result.analysis.independent_expected_verdict, 'FAIL');
  assert.deepStrictEqual(result.independent, stage1());
  assert.strictEqual(override.independent_expected_verdict, 'PASS');
});

test('stage two cannot replace stage one requirement statuses', () => {
  const sneaky = { ...stage2(), independent: { requirements: [] } };
  const result = assemble({
    manifest: manifest(),
    stage1: stage1(),
    stage2: sneaky,
    taxonomy: TAXONOMY,
  });

  assert.deepStrictEqual(result.independent, stage1());
});

test('reports missing or invalid stage output as analysis error', () => {
  const cases = [
    { stage1: null, stage2: stage2(), stage: 'independent' },
    {
      stage1: { ...stage1(), independent_expected_verdict: 'MAYBE' },
      stage2: stage2(),
      stage: 'independent',
    },
    { stage1: stage1(), stage2: null, stage: 'analysis' },
    {
      stage1: stage1(),
      stage2: { ...stage2(), primary_cause: 'NOT_A_CAUSE' },
      stage: 'analysis',
    },
  ];
  for (const item of cases) {
    const result = assemble({
      manifest: manifest(),
      stage1: item.stage1,
      stage2: item.stage2,
      taxonomy: TAXONOMY,
    });
    assert.strictEqual(result.error.stage, item.stage);
    assert.ok(result.error.problems.length > 0);
    assert.strictEqual(result.independent, null);
    assert.strictEqual(result.analysis, null);
    assert.deepStrictEqual(result.round_key, manifest().round_key);
  }
});

test('reports a manifest without round key as analysis error', () => {
  const result = assemble({
    manifest: { inputs: {} },
    stage1: stage1(),
    stage2: stage2(),
    taxonomy: TAXONOMY,
  });

  assert.strictEqual(result.error.stage, 'manifest');
  assert.strictEqual(result.round_key, null);
  assert.strictEqual(result.analysis, null);
});

test('builds an analysis error for a rejected model', () => {
  const result = buildAnalysisError(manifest(), 'model', [
    'judge model equals verifier model',
  ]);

  assert.deepStrictEqual(result.error, {
    stage: 'model',
    problems: ['judge model equals verifier model'],
  });
  assert.deepStrictEqual(result.round_key, manifest().round_key);
  assert.strictEqual(result.independent, null);
});

test('keeps first detection class', () => {
  const firstDetection = { round_key: PREVIOUS_ROUND_KEY, fate: 'LATE_FINDING' };
  const [defect] = stage2().implementation_defects;
  const previous = previousRound([
    { ...defect, fate: 'LATE_FINDING', first_detection: firstDetection },
  ]);
  const current = {
    ...stage2(),
    implementation_defects: [{ ...defect, fate: 'RESOLVED' }],
  };
  const result = assemble({
    manifest: manifest(),
    stage1: stage1(),
    stage2: current,
    taxonomy: TAXONOMY,
    previous,
  });

  assert.strictEqual(result.error, null);
  const [assembled] = result.analysis.implementation_defects;
  assert.strictEqual(assembled.fate, 'RESOLVED');
  assert.deepStrictEqual(assembled.first_detection, firstDetection);
});

test('rejects a fate the round makes impossible', () => {
  const [defect] = stage2().implementation_defects;
  const current = {
    ...stage2(),
    implementation_defects: [{ ...defect, fate: 'LATE_FINDING' }],
  };
  const result = assemble({
    manifest: manifest(),
    stage1: stage1(),
    stage2: current,
    taxonomy: TAXONOMY,
    previous: { status: 'absent', analysis: null },
    comparison: { taskChange: { type: 'code' } },
  });

  assert.strictEqual(result.error.stage, 'analysis');
  assert.match(result.error.problems[0], /^analysis: .*first round/);
  assert.strictEqual(result.analysis, null);
  assert.deepStrictEqual(result.round_comparison, {
    taskChange: { type: 'code' },
  });
});

test('stores transitions separately from fate', () => {
  const comparison = {
    taskChange: { type: 'code' },
    comparability: 'COMPARABLE',
  };
  const transitions = {
    transitions: [{ id: 'AC-1', from: 'FAIL', to: 'PASS' }],
  };
  const result = assemble({
    manifest: manifest(),
    stage1: stage1(),
    stage2: stage2(),
    taxonomy: TAXONOMY,
    comparison,
    transitions,
  });

  assert.strictEqual(result.error, null);
  assert.deepStrictEqual(result.round_comparison, comparison);
  assert.deepStrictEqual(result.transitions, transitions);
  assert.notStrictEqual(result.transitions, transitions);
  const [finding] = result.analysis.implementation_defects;
  assert.strictEqual(finding.fate, 'INITIAL');
  assert.strictEqual('transitions' in finding, false);
  assert.strictEqual('transitions' in result.analysis, false);
  assert.strictEqual('round_comparison' in result.analysis, false);

  const firstRound = assemble({
    manifest: manifest(),
    stage1: stage1(),
    stage2: stage2(),
    taxonomy: TAXONOMY,
  });
  assert.strictEqual(firstRound.round_comparison, null);
  assert.strictEqual(firstRound.transitions, null);
});
