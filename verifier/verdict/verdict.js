'use strict';

const {
  STATUS_PASS,
  STATUS_FAIL,
  STATUS_UNVERIFIABLE,
  labelOf,
  specItemsOf,
  isSpecInvalid,
} = require('./common');
const { parseReport } = require('./inputs');
const { notesByKey } = require('./refs');
const { REASON_CODES: CODE } = require('./result');

const SPEC_NOT_CHECKED = 'spec was not checked';
const SCOPE_NOT_CHECKED = 'scope was not checked';
const APPROVAL_NOT_CHECKED = 'spec approval was not checked';
const TAMPERING_SCAN_NOT_RUN = 'tampering scan was not run';
const PROVENANCE_MISSING = 'provenance missing';
const ALLOWED_MODELS_NOT_CHECKED = 'allowed models were not checked';
const modelNotAllowed = (model) =>
  `VERIFIER_MODEL is not in allowed-models.json: ${model}`;
const SPEC_NOT_APPROVED = 'spec not approved';
const SPEC_CHANGED = 'spec changed after approval';
const LEGACY_NOT_APPROVED = 'Spec approval: not approved (legacy)';

// Where a FAIL reason comes from: the model's
// own judgement, or a check computed by code. second-run.js decides on this
// source, never on the reason text.
const SOURCE_MODEL = 'model';
const SOURCE_DETERMINISTIC = 'deterministic';

// Every reason carries a code from result.js's closed list and the issue ID
// it is about (null when it is about no single item). Both are set here,
// where the reason is created, never parsed back out of the text.
const createReason = (source) => (code, text, id = null) => ({
  text,
  source,
  code,
  id,
});
const modelReason = createReason(SOURCE_MODEL);
const deterministicReason = createReason(SOURCE_DETERMINISTIC);
const textsOf = (reasons) => reasons.map((reason) => reason.text);

const describeLoss = ({ path: file, lost }) =>
  `${file}: ${lost} assertion line(s) removed without a matching added line`;

// Applies only to v2 issues: a legacy issue keeps relying on the model's own
// out_of_scope_files, handled in collectFailures.
const checkScope = (scopeResult, specFormat) => {
  if (specFormat !== 'v2') return [];
  if (scopeResult === undefined || scopeResult === null) {
    return [deterministicReason(CODE.SCOPE_NOT_CHECKED, SCOPE_NOT_CHECKED)];
  }
  return scopeResult.out_of_scope.map((file) =>
    deterministicReason(
      CODE.OUT_OF_SCOPE_FILE,
      `out of scope file (computed): ${file}`,
    ),
  );
};

// A changed spec fails for every format; a missing approval fails unless the
// issue is known to be legacy, where it is only noted in the comment.
const checkApproval = (approval, specFormat) => {
  const result = (failures, note = null) => ({ failures, note });
  const failWith = (code, text) => result([deterministicReason(code, text)]);
  if (approval === undefined) return result([]);
  if (approval === null) {
    return failWith(CODE.APPROVAL_NOT_CHECKED, APPROVAL_NOT_CHECKED);
  }
  if (approval.approved_hash === null) {
    if (specFormat === 'legacy') return result([], LEGACY_NOT_APPROVED);
    return failWith(CODE.SPEC_NOT_APPROVED, SPEC_NOT_APPROVED);
  }
  if (approval.approved_hash !== approval.current_hash) {
    return failWith(CODE.SPEC_CHANGED, SPEC_CHANGED);
  }
  return result([]);
};

const scanReasons = ({
  tamperingFindings,
  assertionLosses,
  testRemovalApproved,
}) => {
  if (tamperingFindings === null) {
    return [
      deterministicReason(CODE.TAMPERING_SCAN_NOT_RUN, TAMPERING_SCAN_NOT_RUN),
    ];
  }
  const reasons = tamperingFindings.map((item) =>
    deterministicReason(
      CODE.TAMPERING_SCAN_FINDING,
      `test tampering (scan): ${item}`,
    ),
  );
  // The owner's approval excuses only assertion losses, never the other
  // scanner findings, the model's test_tampering or UNVERIFIABLE.
  if (!testRemovalApproved) {
    for (const loss of assertionLosses) {
      const text = `test tampering (scan): ${describeLoss(loss)}`;
      reasons.push(deterministicReason(CODE.ASSERTION_LOSS, text));
    }
  }
  return reasons;
};

const ciReasons = (ciFailures) => {
  if (ciFailures === null) {
    return [
      deterministicReason(CODE.CI_NOT_CHECKED, 'CI results were not checked'),
    ];
  }
  return ciFailures.map((text) =>
    deterministicReason(CODE.CI_CHECK_FAILED, text),
  );
};

// VERIFIER_MODEL is only checked against provenanceModel when provenance
// itself was read successfully; a missing provenance already fails via
// PROVENANCE_MISSING and this would only duplicate that reason.
const modelAllowedReasons = (allowedModels, provenanceModel) => {
  if (allowedModels === null) {
    return [
      deterministicReason(
        CODE.ALLOWED_MODELS_NOT_CHECKED,
        ALLOWED_MODELS_NOT_CHECKED,
      ),
    ];
  }
  const isNotAllowed =
    provenanceModel !== null && !allowedModels.includes(provenanceModel);
  if (!isNotAllowed) return [];
  const text = modelNotAllowed(provenanceModel);
  return [deterministicReason(CODE.MODEL_NOT_ALLOWED, text)];
};

const criterionReasons = (criterion, manualVerified) => {
  const reasons = [];
  const label = labelOf(criterion);
  const id = criterion.id === '' ? null : criterion.id;
  // A computed ci/absence entry is decided by code, not by the model.
  const create = criterion.computed ? deterministicReason : modelReason;
  if (criterion.status === STATUS_FAIL) {
    const code = criterion.computed
      ? CODE.COMPUTED_ITEM_FAILED
      : CODE.CRITERION_FAILED;
    reasons.push(create(code, `criterion failed: ${label}`, id));
  }
  const isBlockingUnverifiable =
    criterion.status === STATUS_UNVERIFIABLE && !manualVerified;
  if (isBlockingUnverifiable) {
    const text = `criterion unverifiable: ${label}`;
    reasons.push(create(CODE.CRITERION_UNVERIFIABLE, text, id));
  }
  const isUnsupportedPass =
    !criterion.computed &&
    criterion.status === STATUS_PASS &&
    criterion.refs.length === 0;
  if (isUnsupportedPass) {
    const text = `criterion passed without references: ${label}`;
    reasons.push(modelReason(CODE.CRITERION_PASS_WITHOUT_REFS, text, id));
  }
  return reasons;
};

const invariantReasons = ({ id, status, refs }) => {
  const reasons = [];
  if (status === STATUS_FAIL) {
    reasons.push(modelReason(CODE.INVARIANT_FAILED, `invariant failed: ${id}`, id));
  }
  if (status === STATUS_PASS && refs.length === 0) {
    const text = `invariant passed without references: ${id}`;
    reasons.push(modelReason(CODE.INVARIANT_PASS_WITHOUT_REFS, text, id));
  }
  return reasons;
};

const refsReasons = (refsProblems) => {
  if (refsProblems === null) {
    return [modelReason(CODE.REFS_NOT_CHECKED, 'references were not checked')];
  }
  return refsProblems.map((item) =>
    modelReason(CODE.BAD_REFERENCE, `bad reference: ${item}`),
  );
};

const collectFailures = (
  report,
  {
    manualVerified,
    refsProblems,
    ciFailures,
    specFormat,
    tamperingFindings,
    assertionLosses,
    testRemovalApproved,
    allowedModels,
    provenanceModel,
  },
) => {
  const reasons = [];
  if (report.criteria.length === 0) {
    reasons.push(modelReason(CODE.NO_CRITERIA, 'no criteria were checked'));
  }
  for (const criterion of report.criteria) {
    reasons.push(...criterionReasons(criterion, manualVerified));
  }
  for (const invariant of report.invariants) {
    reasons.push(...invariantReasons(invariant));
  }
  for (const item of report.test_tampering) {
    const text = `test tampering: ${item}`;
    reasons.push(modelReason(CODE.MODEL_TEST_TAMPERING, text));
  }
  reasons.push(
    ...scanReasons({ tamperingFindings, assertionLosses, testRemovalApproved }),
  );
  if (specFormat !== 'v2') {
    for (const file of report.out_of_scope_files) {
      const text = `out of scope file: ${file}`;
      reasons.push(modelReason(CODE.MODEL_OUT_OF_SCOPE_FILE, text));
    }
  }
  reasons.push(...refsReasons(refsProblems));
  reasons.push(...ciReasons(ciFailures));
  reasons.push(...modelAllowedReasons(allowedModels, provenanceModel));
  return reasons;
};

// The deterministic inputs that do not depend on the model report; also
// checked when there is no report, so a missing report next to a red check
// is never mistaken for a model-only FAIL.
const inputReasons = (options) => [
  ...options.computedItems
    .filter(({ status }) => status === STATUS_FAIL)
    .map(({ id }) =>
      deterministicReason(
        CODE.COMPUTED_ITEM_FAILED,
        `criterion failed: ${id}`,
        id,
      ),
    ),
  ...scanReasons(options),
  ...ciReasons(options.ciFailures),
  ...modelAllowedReasons(options.allowedModels, options.provenanceModel),
];

// Merges deterministically computed ci/absence entries into the model's own
// criteria: a computed id always wins over whatever the model reported for
// it (AC-8 — a stray model entry for that id is discarded, not compared).
const mergeComputed = (report, computedItems) => {
  if (computedItems.length === 0) return report;
  const computedIds = new Set(computedItems.map((entry) => entry.id));
  const criteria = [
    ...report.criteria.filter((entry) => !computedIds.has(entry.id)),
    ...computedItems,
  ];
  return { ...report, criteria };
};

const evaluate = (
  raw,
  {
    manualVerified = false,
    refsProblems = null,
    refsNotes = [],
    ciFailures = null,
    tamperingFindings = null,
    assertionLosses = [],
    assertionMoved = 0,
    testRemovalApproved = false,
    provenance = null,
    allowedModels = null,
    spec,
    approval,
    scope,
    computedItems = [],
  } = {},
) => {
  const assertions = {
    losses: assertionLosses,
    moved: assertionMoved,
    isApproved: testRemovalApproved,
  };
  const specFormat =
    spec !== undefined && spec !== null ? spec.format : undefined;
  const specItems = specItemsOf(spec);
  const approvalCheck = checkApproval(approval, specFormat);
  const approvalNote = approvalCheck.note;
  // Checked before any report-parsing branch (including the earliest
  // isSpecInvalid return) so a missing/malformed provenance.json is never
  // silently skipped regardless of which path the verdict takes (INV-6).
  const provenanceFailures =
    provenance === null
      ? [deterministicReason(CODE.PROVENANCE_MISSING, PROVENANCE_MISSING)]
      : [];
  const fail = (reasons) => {
    const all = [...provenanceFailures, ...reasons];
    return {
      passed: false,
      report: null,
      failures: textsOf(all),
      reasons: all,
      specFormat,
      specItems,
      approvalNote,
      assertions,
      provenance,
      refsNotesByKey: new Map(),
    };
  };
  if (spec !== undefined && isSpecInvalid(spec)) {
    const invalid = spec.problems.map((problem) =>
      deterministicReason(CODE.SPEC_INVALID, `spec invalid: ${problem}`),
    );
    return fail(invalid);
  }
  const specNotChecked =
    spec === null
      ? [deterministicReason(CODE.SPEC_NOT_CHECKED, SPEC_NOT_CHECKED)]
      : [];
  const preFailures = [
    ...specNotChecked,
    ...approvalCheck.failures,
    ...checkScope(scope, specFormat),
  ];
  const provenanceModel = provenance === null ? null : provenance.model;
  const failWithoutReport = (text) =>
    fail([
      ...preFailures,
      modelReason(CODE.REPORT_MISSING, text),
      ...inputReasons({
        computedItems,
        tamperingFindings,
        assertionLosses,
        testRemovalApproved,
        ciFailures,
        allowedModels,
        provenanceModel,
      }),
    ]);
  if (raw === null) return failWithoutReport('no report');
  const { report: parsed, problem } = parseReport(raw);
  if (parsed === null) return failWithoutReport(problem);
  const report = mergeComputed(parsed, computedItems);
  const reasons = [
    ...provenanceFailures,
    ...preFailures,
    ...collectFailures(report, {
      manualVerified,
      refsProblems,
      ciFailures,
      tamperingFindings,
      assertionLosses,
      testRemovalApproved,
      specFormat,
      allowedModels,
      provenanceModel,
    }),
  ];
  return {
    passed: reasons.length === 0,
    report,
    failures: textsOf(reasons),
    reasons,
    specFormat,
    specItems,
    approvalNote,
    assertions,
    provenance,
    refsNotesByKey: notesByKey(parsed, refsNotes),
  };
};

module.exports = {
  SOURCE_MODEL,
  SOURCE_DETERMINISTIC,
  SPEC_NOT_CHECKED,
  SCOPE_NOT_CHECKED,
  APPROVAL_NOT_CHECKED,
  TAMPERING_SCAN_NOT_RUN,
  PROVENANCE_MISSING,
  ALLOWED_MODELS_NOT_CHECKED,
  SPEC_NOT_APPROVED,
  SPEC_CHANGED,
  LEGACY_NOT_APPROVED,
  checkScope,
  checkApproval,
  collectFailures,
  mergeComputed,
  evaluate,
};
