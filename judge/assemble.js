'use strict';

const {
  validateAnalysis,
  applyFateHistory,
  validateIndependentResult,
} = require('./validate');

// Names of the pipeline stages an analysis error can point at. They are the
// same words the validate subcommand takes for --stage, plus the two checks
// that run before any model output exists; none of them is a taxonomy value.
const STAGE_INDEPENDENT = 'independent';
const STAGE_ANALYSIS = 'analysis';
const STAGE_MANIFEST = 'manifest';
const STAGE_MODEL = 'model';

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRoundKeyPart = (value) =>
  (typeof value === 'string' && value !== '') || typeof value === 'number';

const isRoundKey = (value) =>
  isObject(value) &&
  isRoundKeyPart(value.repository) &&
  isRoundKeyPart(value.verifier_run_id) &&
  isRoundKeyPart(value.verifier_run_attempt);

const roundOf = (manifest) => {
  const source = isObject(manifest) ? manifest : {};
  return {
    round_key: isRoundKey(source.round_key) ? structuredClone(source.round_key) : null,
    head_sha: typeof source.head_sha === 'string' ? source.head_sha : null,
    inputs: isObject(source.inputs) ? structuredClone(source.inputs) : {},
  };
};

// Script results about the round as a whole: how it compares with the
// previous round and how each criterion's status moved. They sit next to the
// model's analysis, never inside a finding.
const roundContextOf = (comparison, transitions) => ({
  round_comparison: isObject(comparison) ? structuredClone(comparison) : null,
  transitions: isObject(transitions) ? structuredClone(transitions) : null,
});

// Every assembled analysis has the same shape: a failed one keeps the round
// identity, the input statuses and the script's round context, but carries
// no model values at all, so a missing stage is never filled with invented
// content.
const buildAnalysisError = (
  manifest,
  stage,
  problems,
  comparison = null,
  transitions = null,
) => ({
  ...roundOf(manifest),
  error: { stage, problems: [...problems] },
  independent: null,
  analysis: null,
  ...roundContextOf(comparison, transitions),
});

const checkStage = (output, stage, validator, taxonomy) => {
  if (output === null || output === undefined) {
    return [`${stage} stage output is missing`];
  }
  const { valid, problems } = validator(output, taxonomy);
  return valid ? [] : problems.map((problem) => `${stage}: ${problem}`);
};

// Stage 1 is copied as a deep clone and never merged with Stage 2:
// the requirement statuses live only under `independent`, and the single
// field both stages could carry, independent_expected_verdict, is always
// taken from Stage 1 — whatever Stage 2 returned for it is discarded.
// previous ({ status, analysis }) is the previous round's analysis; without
// it the round is treated as the first observed one.
const assemble = ({
  manifest,
  stage1,
  stage2,
  taxonomy,
  previous = null,
  comparison = null,
  transitions = null,
}) => {
  const fail = (stage, problems) =>
    buildAnalysisError(manifest, stage, problems, comparison, transitions);
  if (!isRoundKey(isObject(manifest) ? manifest.round_key : null)) {
    return fail(STAGE_MANIFEST, ['manifest has no round key']);
  }

  const stage1Problems = checkStage(
    stage1,
    STAGE_INDEPENDENT,
    validateIndependentResult,
    taxonomy,
  );
  if (stage1Problems.length > 0) {
    return fail(STAGE_INDEPENDENT, stage1Problems);
  }

  const independent = structuredClone(stage1);
  const verdict = independent.independent_expected_verdict;
  const analysis = isObject(stage2)
    ? { ...structuredClone(stage2), independent_expected_verdict: verdict }
    : stage2;
  const stage2Problems = checkStage(
    analysis,
    STAGE_ANALYSIS,
    validateAnalysis,
    taxonomy,
  );
  if (stage2Problems.length > 0) {
    return fail(STAGE_ANALYSIS, stage2Problems);
  }

  const history = applyFateHistory(
    analysis,
    previous,
    manifest.round_key,
    taxonomy,
  );
  if (!history.valid) {
    const problems = history.problems.map(
      (problem) => `${STAGE_ANALYSIS}: ${problem}`,
    );
    return fail(STAGE_ANALYSIS, problems);
  }

  return {
    ...roundOf(manifest),
    error: null,
    independent,
    analysis: history.analysis,
    ...roundContextOf(comparison, transitions),
  };
};

module.exports = {
  STAGE_INDEPENDENT,
  STAGE_ANALYSIS,
  STAGE_MANIFEST,
  STAGE_MODEL,
  buildAnalysisError,
  assemble,
};
