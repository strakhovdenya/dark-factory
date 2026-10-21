'use strict';

const CRITERION_ID_PATTERN = /^(AC|INV|TR|DOD)-\d+$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;

// Not a taxonomy value (the trusted-config requirement covers
// primary_cause/responsibility/subtypes/recommended_change_target/
// counterfactual/verdict/requirement_status/confidence/check_source): this is
// the shape of one evidence item, the same kind of hardcoded structural enum
// as verifier/verdict/common.js's REF_KINDS.
const EVIDENCE_TYPES = new Set(['code', 'input', 'log']);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// An input or log item names its source in path (the input file) or ref (a
// place inside it, or a named log); the schema lets either be null, so a
// reference to a whole input file (path set, ref null) is valid too.
const isEvidence = (value) => {
  if (!isObject(value)) return false;
  if (!EVIDENCE_TYPES.has(value.type)) return false;
  if (!isNonEmptyString(value.note)) return false;
  if (value.type === 'code') {
    return (
      typeof value.sha === 'string' &&
      SHA1_HEX.test(value.sha) &&
      isNonEmptyString(value.path)
    );
  }
  return isNonEmptyString(value.path) || isNonEmptyString(value.ref);
};

const checkEnum = (problems, container, field, allowedValues) => {
  if (!Array.isArray(allowedValues) || !allowedValues.includes(container[field])) {
    problems.push(`${field} is outside taxonomy: ${container[field]}`);
  }
};

const validateEvidence = (finding, label, problems) => {
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    problems.push(`${label}.evidence must be a non-empty array`);
    return;
  }
  finding.evidence.forEach((item, index) => {
    if (!isEvidence(item)) problems.push(`${label}.evidence[${index}] is invalid`);
  });
};

const validateFinding = (
  finding,
  label,
  { subtypeKey, requireChangeTarget, taxonomy, seenFindingIds },
) => {
  const problems = [];
  if (!isObject(finding)) {
    problems.push(`${label} must be an object`);
    return problems;
  }

  if (!isNonEmptyString(finding.finding_id)) {
    problems.push(`${label}.finding_id is required`);
  } else if (seenFindingIds.has(finding.finding_id)) {
    problems.push(`duplicate finding_id: ${finding.finding_id}`);
  } else {
    seenFindingIds.add(finding.finding_id);
  }

  if (!('criterion_id' in finding)) {
    problems.push(`${label}.criterion_id is required`);
  } else if (
    finding.criterion_id !== null &&
    !CRITERION_ID_PATTERN.test(finding.criterion_id)
  ) {
    problems.push(`${label}.criterion_id is malformed: ${finding.criterion_id}`);
  }

  if (
    'check_source' in finding &&
    finding.check_source !== null &&
    !taxonomy.check_source.includes(finding.check_source)
  ) {
    problems.push(`${label}.check_source is outside taxonomy: ${finding.check_source}`);
  }

  checkEnum(problems, finding, 'fate', taxonomy.defect_fate);

  if (subtypeKey !== null) {
    checkEnum(problems, finding, 'subtype', taxonomy[subtypeKey]);
  }

  if (requireChangeTarget) {
    checkEnum(
      problems,
      finding,
      'recommended_change_target',
      taxonomy.recommended_change_target,
    );
  }

  validateEvidence(finding, label, problems);
  return problems;
};

const validateFindings = (list, field, options) => {
  const problems = [];
  if (!Array.isArray(list)) {
    problems.push(`${field} must be an array`);
    return problems;
  }
  list.forEach((finding, index) => {
    problems.push(...validateFinding(finding, `${field}[${index}]`, options));
  });
  return problems;
};

const validateCounterfactual = (counterfactual, taxonomy) => {
  const problems = [];
  if (!isObject(counterfactual)) {
    problems.push('counterfactual must be an object');
    return problems;
  }
  for (const field of [
    'fix_issue_only',
    'fix_implementation_only',
    'fix_verifier_only',
  ]) {
    checkEnum(problems, counterfactual, field, taxonomy.counterfactual_outcome);
  }
  return problems;
};

// Validates a complete Stage 2 analysis against the trusted taxonomy
//: every enum-like field is checked against taxonomy.json, never
// against a value literal in this module. primary_cause and each
// finding's check_source are validated independently — neither is
// derived from the other.
const validateAnalysis = (analysis, taxonomy) => {
  if (!isObject(analysis)) {
    return { valid: false, problems: ['analysis must be an object'] };
  }

  const problems = [];
  checkEnum(problems, analysis, 'observed_verdict', taxonomy.verdict);
  checkEnum(problems, analysis, 'independent_expected_verdict', taxonomy.verdict);
  checkEnum(problems, analysis, 'primary_cause', taxonomy.primary_cause);
  checkEnum(problems, analysis, 'responsibility', taxonomy.responsibility);
  checkEnum(problems, analysis, 'confidence', taxonomy.confidence);

  const seenFindingIds = new Set();
  problems.push(
    ...validateFindings(analysis.issue_defects, 'issue_defects', {
      subtypeKey: 'issue_defect_subtype',
      requireChangeTarget: false,
      taxonomy,
      seenFindingIds,
    }),
    ...validateFindings(analysis.implementation_defects, 'implementation_defects', {
      subtypeKey: null,
      requireChangeTarget: false,
      taxonomy,
      seenFindingIds,
    }),
    ...validateFindings(analysis.verifier_defects, 'verifier_defects', {
      subtypeKey: 'verifier_defect_subtype',
      requireChangeTarget: true,
      taxonomy,
      seenFindingIds,
    }),
    ...validateFindings(
      analysis.correct_verifier_findings,
      'correct_verifier_findings',
      {
        subtypeKey: null,
        requireChangeTarget: false,
        taxonomy,
        seenFindingIds,
      },
    ),
    ...validateCounterfactual(analysis.counterfactual, taxonomy),
  );

  if (!isStringArray(analysis.systemic_lessons)) {
    problems.push('systemic_lessons must be a string array');
  }
  if (
    analysis.golden_case_recommendation !== null &&
    typeof analysis.golden_case_recommendation !== 'string'
  ) {
    problems.push('golden_case_recommendation must be a string or null');
  }

  return { valid: problems.length === 0, problems };
};

// The analysis fields that hold findings (schema structure, not taxonomy).
const FINDING_LISTS = [
  'issue_defects',
  'implementation_defects',
  'verifier_defects',
  'correct_verifier_findings',
];

// Statuses of the previous round's analysis, the same words collect.js uses
// for an input: absent means this is the first observed round.
const PREVIOUS_PRESENT = 'present';
const PREVIOUS_ABSENT = 'absent';

const findingsOf = (analysis) =>
  FINDING_LISTS.flatMap((field) =>
    isObject(analysis) && Array.isArray(analysis[field]) ? analysis[field] : [],
  );

const previousFindingsById = (previous) => {
  const byId = new Map();
  if (!isObject(previous) || previous.status !== PREVIOUS_PRESENT) return byId;
  for (const finding of findingsOf(previous.analysis)) {
    if (isObject(finding) && isNonEmptyString(finding.finding_id)) {
      byId.set(finding.finding_id, finding);
    }
  }
  return byId;
};

const isFirstDetection = (value) =>
  isObject(value) && 'round_key' in value && 'fate' in value;

// A finding already known in the previous round keeps its first
// detection exactly as recorded there; only a finding first seen now gets
// the current round and its current fate. A previous record written before
// first_detection existed has no round to copy, so the round stays null.
const firstDetectionOf = (finding, previousFinding, roundKey) => {
  if (previousFinding === undefined) {
    return { round_key: structuredClone(roundKey), fate: finding.fate };
  }
  if (isFirstDetection(previousFinding.first_detection)) {
    return structuredClone(previousFinding.first_detection);
  }
  return { round_key: null, fate: previousFinding.fate ?? null };
};

const fateRules = (taxonomy) => {
  const withoutPrevious = taxonomy.fate_without_previous_round;
  const requiresPrevious = taxonomy.fate_requires_previous_finding;
  const requiresNew = taxonomy.fate_requires_new_finding;
  const lists = [withoutPrevious, requiresPrevious, requiresNew];
  if (!lists.every(isStringArray)) return null;
  return { withoutPrevious, requiresPrevious, requiresNew };
};

const fateHistoryProblems = (finding, label, context) => {
  const { rules, isFirstRound, previousById } = context;
  const problems = [];
  if (isFirstRound && !rules.withoutPrevious.includes(finding.fate)) {
    problems.push(`${label}.fate ${finding.fate} is not allowed in the first round`);
  }
  const isKnown = previousById.has(finding.finding_id);
  const needsPrevious = rules.requiresPrevious.includes(finding.fate);
  if (needsPrevious && !isKnown) {
    problems.push(
      `${label}.fate ${finding.fate} requires finding_id ` +
        `${finding.finding_id} in the previous round`,
    );
  }
  // A defect first seen now must not take over an earlier finding_id: it
  // would inherit that finding's first detection.
  if (rules.requiresNew.includes(finding.fate) && isKnown) {
    problems.push(
      `${label}.fate ${finding.fate} reuses finding_id ` +
        `${finding.finding_id} of the previous round`,
    );
  }
  return problems;
};

// Checks each finding's fate against the round it belongs to and records its
// first detection. The model decides the fate; this only rejects a fate the
// round makes impossible. Which fates are allowed without a previous round,
// which need the same finding_id there and which need a new one come from
// the taxonomy.
// previous is { status, analysis }: status absent marks the first observed
// round; an unreadable previous round is not a first round, but it proves no
// earlier finding_id either. The fate itself is never derived from the
// status transitions.
const applyFateHistory = (analysis, previous, roundKey, taxonomy) => {
  const rules = fateRules(taxonomy);
  if (rules === null) {
    return {
      valid: false,
      problems: ['taxonomy has no fate rules'],
      analysis: null,
    };
  }
  const context = {
    rules,
    isFirstRound: !isObject(previous) || previous.status === PREVIOUS_ABSENT,
    previousById: previousFindingsById(previous),
  };

  const problems = [];
  const result = structuredClone(analysis);
  for (const field of FINDING_LISTS) {
    const list = Array.isArray(result[field]) ? result[field] : [];
    for (const [index, finding] of list.entries()) {
      if (!isObject(finding)) continue;
      const label = `${field}[${index}]`;
      problems.push(...fateHistoryProblems(finding, label, context));
      const previousFinding = context.previousById.get(finding.finding_id);
      finding.first_detection = firstDetectionOf(
        finding,
        previousFinding,
        roundKey,
      );
    }
  }

  const valid = problems.length === 0;
  return { valid, problems, analysis: valid ? result : null };
};

const validateRequirement = (item, label, taxonomy) => {
  const problems = [];
  if (!isObject(item)) {
    problems.push(`${label} must be an object`);
    return problems;
  }
  if (typeof item.id !== 'string' || !CRITERION_ID_PATTERN.test(item.id)) {
    problems.push(`${label}.id is malformed: ${item.id}`);
  }
  if (!isNonEmptyString(item.literal_requirement)) {
    problems.push(`${label}.literal_requirement is required`);
  }
  if (!isNonEmptyString(item.evidence_expected)) {
    problems.push(`${label}.evidence_expected is required`);
  }
  if (typeof item.single_interpretation !== 'boolean') {
    problems.push(`${label}.single_interpretation must be boolean`);
  }
  if (typeof item.verify_proves_requirement !== 'boolean') {
    problems.push(`${label}.verify_proves_requirement must be boolean`);
  }
  checkEnum(problems, item, 'status', taxonomy.requirement_status);
  if (!isNonEmptyString(item.rationale)) {
    problems.push(`${label}.rationale is required`);
  }
  return problems;
};

// Validates a Stage 1 ("independent") result: the contract-reconstruction
// pass that runs before any verifier report is read (see PRD Step 1-2).
// independent_expected_verdict belongs to this stage: the assembled analysis
// takes it from here, never from Stage 2.
const validateIndependentResult = (result, taxonomy) => {
  if (!isObject(result) || !Array.isArray(result.requirements)) {
    return { valid: false, problems: ['requirements must be an array'] };
  }
  const problems = [];
  checkEnum(problems, result, 'independent_expected_verdict', taxonomy.verdict);
  result.requirements.forEach((item, index) => {
    problems.push(...validateRequirement(item, `requirements[${index}]`, taxonomy));
  });
  return { valid: problems.length === 0, problems };
};

// Fail closed: an unreadable/non-array allowlist or an empty
// verifier model reject rather than permit. judgeModel/verifierModel/
// allowlist are all already-parsed values; reading the trusted
// allowlist file is the caller's responsibility. judgeModel is not required
// to differ from verifierModel (a recorded owner decision): verifierModel is
// read only to detect an unknown verifier model, not to reject an equal
// judge model.
const checkModel = (judgeModel, verifierModel, allowlist) => {
  if (!Array.isArray(allowlist)) {
    return { allowed: false, reason: 'allowlist was not checked' };
  }
  if (!isNonEmptyString(verifierModel)) {
    return { allowed: false, reason: 'verifier model is unknown' };
  }
  if (!isNonEmptyString(judgeModel)) {
    return { allowed: false, reason: 'judge model is empty' };
  }
  if (!allowlist.includes(judgeModel)) {
    return { allowed: false, reason: `judge model is not in allowlist: ${judgeModel}` };
  }
  return { allowed: true, reason: null };
};

module.exports = {
  CRITERION_ID_PATTERN,
  SHA1_HEX,
  isEvidence,
  validateAnalysis,
  applyFateHistory,
  validateIndependentResult,
  checkModel,
};
