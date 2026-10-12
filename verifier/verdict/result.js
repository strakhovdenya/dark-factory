'use strict';

// The machine-readable result of one verifier round (--result-out): the final
// verdict, the final status of every issue ID with where it came from, and
// every FAIL reason with a code from the closed list below. It is built from
// what the verdict already computed and changes nothing in it.

// The closed list of reason codes. Every branch in verdict.js that creates a
// reason names one of these; a code is never derived from the reason text.
const REASON_CODES = Object.freeze({
  PROVENANCE_MISSING: 'provenance_missing',
  SPEC_INVALID: 'spec_invalid',
  SPEC_NOT_CHECKED: 'spec_not_checked',
  APPROVAL_NOT_CHECKED: 'approval_not_checked',
  SPEC_NOT_APPROVED: 'spec_not_approved',
  SPEC_CHANGED: 'spec_changed',
  SCOPE_NOT_CHECKED: 'scope_not_checked',
  OUT_OF_SCOPE_FILE: 'out_of_scope_file',
  MODEL_OUT_OF_SCOPE_FILE: 'model_out_of_scope_file',
  REPORT_MISSING: 'report_missing',
  NO_CRITERIA: 'no_criteria',
  CRITERION_FAILED: 'criterion_failed',
  COMPUTED_ITEM_FAILED: 'computed_item_failed',
  CRITERION_UNVERIFIABLE: 'criterion_unverifiable',
  CRITERION_PASS_WITHOUT_REFS: 'criterion_pass_without_refs',
  INVARIANT_FAILED: 'invariant_failed',
  INVARIANT_PASS_WITHOUT_REFS: 'invariant_pass_without_refs',
  MODEL_TEST_TAMPERING: 'model_test_tampering',
  TAMPERING_SCAN_NOT_RUN: 'tampering_scan_not_run',
  TAMPERING_SCAN_FINDING: 'tampering_scan_finding',
  ASSERTION_LOSS: 'assertion_loss',
  REFS_NOT_CHECKED: 'refs_not_checked',
  BAD_REFERENCE: 'bad_reference',
  CI_NOT_CHECKED: 'ci_not_checked',
  CI_CHECK_FAILED: 'ci_check_failed',
  ALLOWED_MODELS_NOT_CHECKED: 'allowed_models_not_checked',
  MODEL_NOT_ALLOWED: 'model_not_allowed',
});

const REASON_CODE_SET = new Set(Object.values(REASON_CODES));

const ITEM_SOURCE_MODEL = 'model';
const ITEM_SOURCE_COMPUTED = 'computed';

const refsOf = (entry) =>
  entry.refs.map(({ path, quote }) => ({ path, quote }));

const createItem = (entry, source, statuses) => ({
  id: entry.id,
  source,
  statuses,
  refs: refsOf(entry),
});

// Model entries come from the final report; computed ci/absence entries come
// from code, so they are present even when there is no model report (AC-5).
// A legacy report names entries by text only and has no IDs to record.
const itemsOf = (outcome, computedItems) => {
  const { report } = outcome.result;
  const diverged = new Set(outcome.diverged);
  const firstEntries = outcome.secondRun?.firstEntries ?? [];
  const firstStatuses = new Map(
    firstEntries.map(({ id, status }) => [id, status]),
  );
  const items = [];
  const modelEntries =
    report === null
      ? []
      : [...report.criteria, ...report.invariants].filter(
          (entry) => !entry.computed && entry.id !== '',
        );
  for (const entry of modelEntries) {
    const first = firstStatuses.get(entry.id);
    const isDiverged = diverged.has(entry.id) && first !== undefined;
    const statuses = isDiverged ? [first, entry.status] : [entry.status];
    items.push(createItem(entry, ITEM_SOURCE_MODEL, statuses));
  }
  for (const entry of computedItems) {
    items.push(createItem(entry, ITEM_SOURCE_COMPUTED, [entry.status]));
  }
  return items;
};

const reasonsOf = (result) =>
  result.reasons.map(({ code, id, source, text }) => ({
    code,
    id,
    source,
    text,
  }));

// outcome is singleRun()/reconcile() from second-run.js; computedItems are
// the ci/absence entries computed for this round.
const buildResult = (outcome, computedItems = []) => ({
  verdict: outcome.verdict,
  spec_format: outcome.result.specFormat ?? null,
  items: itemsOf(outcome, computedItems),
  reasons: reasonsOf(outcome.result),
});

module.exports = {
  REASON_CODES,
  REASON_CODE_SET,
  ITEM_SOURCE_MODEL,
  ITEM_SOURCE_COMPUTED,
  buildResult,
};
