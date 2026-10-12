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
const { REASON_CODES: CODE, CONFIG_REASON_CODES } = require('./result');
const {
  SOURCE_MODEL,
  SOURCE_DETERMINISTIC,
  modelReason,
  deterministicReason,
} = require('./reason');
const { coreRegistry } = require('../checks');
const { baseRiskZones, zoneNames } = require('../risk-zones');

const SPEC_NOT_CHECKED = 'spec was not checked';
const PROVENANCE_MISSING = 'provenance missing';

const BASE_ZONE_NAMES = zoneNames(baseRiskZones());

const textsOf = (reasons) => reasons.map((reason) => reason.text);

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

// The model's own judgement in the report. Deterministic checks are not
// called from here: they run through the registry (runStage).
const collectFailures = (report, { manualVerified, specFormat }) => {
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
  // A v2 issue's scope is computed by the affects-scope check; a legacy
  // issue keeps relying on the model's list.
  if (specFormat !== 'v2') {
    for (const file of report.out_of_scope_files) {
      const text = `out of scope file: ${file}`;
      reasons.push(modelReason(CODE.MODEL_OUT_OF_SCOPE_FILE, text));
    }
  }
  return reasons;
};

// Picks the checks the profile enables. An unknown name fails the verdict:
// a check the project relies on must never be skipped silently.
const selectChecks = (registry, enabled) => {
  const { checks, unknown } = registry.select(enabled);
  const reasons = unknown.map((name) =>
    deterministicReason(
      CONFIG_REASON_CODES.UNKNOWN_CHECK,
      `unknown check in profile: ${name}`,
    ),
  );
  return { checks, reasons };
};

const runStage = (registry, checks, stage, context) =>
  checks
    .filter((check) => check.stage === stage)
    .flatMap((check) => registry.runCheck(check, context));

const prepareReport = (checks, report, context) =>
  checks.reduce(
    (current, check) =>
      check.prepareReport === undefined
        ? current
        : check.prepareReport(current, context),
    report,
  );

const noteOf = (checks, context) => {
  for (const check of checks) {
    const note = check.note === undefined ? null : check.note(context);
    if (note !== null) return note;
  }
  return null;
};

// registry: the checks that exist (core checks by default); checks: the
// names the project profile enables (every registered check by default, the
// strictest choice); configProblems: problems found in the profile or a
// trusted config, each a FAIL; riskZones: the merged zone names the report
// may use (core base zones by default).
/**
 * @param {string | null} raw the model report text
 * @param {Record<string, any>} [options]
 */
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
    registry = coreRegistry,
    checks: enabled = registry.names(),
    configProblems = [],
    riskZones = BASE_ZONE_NAMES,
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
  const selection = selectChecks(registry, enabled);
  const context = {
    report: null,
    manualVerified,
    specFormat,
    specItems,
    approval,
    scope,
    refsProblems,
    ciFailures,
    tamperingFindings,
    assertionLosses,
    testRemovalApproved,
    allowedModels,
    provenanceModel: provenance === null ? null : provenance.model,
    computedItems,
  };
  const approvalNote = noteOf(selection.checks, context);
  // Checked before any report-parsing branch (including the earliest
  // isSpecInvalid return) so a missing/malformed provenance.json, a broken
  // configuration or an unknown check is never silently skipped regardless
  // of which path the verdict takes.
  const provenanceFailures =
    provenance === null
      ? [deterministicReason(CODE.PROVENANCE_MISSING, PROVENANCE_MISSING)]
      : [];
  const configFailures = [
    ...configProblems.map((problem) =>
      deterministicReason(CONFIG_REASON_CODES.CONFIG_INVALID, problem),
    ),
    ...selection.reasons,
  ];
  const fail = (reasons) => {
    const all = [...provenanceFailures, ...configFailures, ...reasons];
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
    ...runStage(registry, selection.checks, 'spec', context),
  ];
  // Without a report the report-stage checks still run, so a missing report
  // next to a red check is never mistaken for a model-only FAIL.
  const failWithoutReport = (text) =>
    fail([
      ...preFailures,
      modelReason(CODE.REPORT_MISSING, text),
      ...runStage(registry, selection.checks, 'report', context),
    ]);
  if (raw === null) return failWithoutReport('no report');
  const { report: parsed, problem } = parseReport(raw, { riskZones });
  if (parsed === null) return failWithoutReport(problem);
  const report = prepareReport(selection.checks, parsed, context);
  const reportContext = { ...context, report };
  const reasons = [
    ...provenanceFailures,
    ...configFailures,
    ...preFailures,
    ...collectFailures(report, { manualVerified, specFormat }),
    ...runStage(registry, selection.checks, 'report', reportContext),
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
  PROVENANCE_MISSING,
  collectFailures,
  evaluate,
};
