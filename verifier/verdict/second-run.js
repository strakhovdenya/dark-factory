'use strict';

const { STATUS_PASS, STATUS_FAIL, deterministicIdsOf } = require('./common');
const { SOURCE_MODEL } = require('./verdict');

// A FAIL made only of model judgement is
// re-run once; two runs that disagree are decided by a human.
const VERDICT_NEEDS_HUMAN = 'NEEDS_HUMAN';
const TEST_TAMPERING_KEY = 'test_tampering';

const verdictOf = (result) => (result.passed ? STATUS_PASS : STATUS_FAIL);

// Only a v2 issue has IDs to compare two reports by (INV-4), and any
// deterministic reason would fail the second run the same way (INV-1).
const needsSecondRun = (result) =>
  result.specFormat === 'v2' &&
  !result.passed &&
  result.reasons.length > 0 &&
  result.reasons.every((reason) => reason.source === SOURCE_MODEL);

const addStatuses = (entries, statuses) => {
  for (const { id, status } of entries) {
    if (id === '') continue;
    const known = statuses.get(id);
    statuses.set(id, known === undefined ? [status] : [...known, status]);
  }
};

// Computed ci/absence ids are decided by code for both runs alike (INV-2).
const modelStatusesOf = (report, computedIds) => {
  const statuses = new Map();
  const criteria = report.criteria.filter(({ id }) => !computedIds.has(id));
  addStatuses(criteria, statuses);
  addStatuses(report.invariants, statuses);
  return statuses;
};

const statusKeyOf = (statuses) => [...statuses].sort().join(',');

// An id missing from one report is not a divergence: the second report's own
// coverage check fails it if it is incomplete.
const divergingIds = (first, second, specItems) => {
  const computedIds = deterministicIdsOf(specItems);
  const firstStatuses = modelStatusesOf(first, computedIds);
  const secondStatuses = modelStatusesOf(second, computedIds);
  const ids = [];
  for (const [id, statuses] of firstStatuses) {
    const other = secondStatuses.get(id);
    if (other === undefined) continue;
    if (statusKeyOf(statuses) !== statusKeyOf(other)) ids.push(id);
  }
  const isFirstTampered = first.test_tampering.length > 0;
  const isSecondTampered = second.test_tampering.length > 0;
  if (isFirstTampered !== isSecondTampered) ids.push(TEST_TAMPERING_KEY);
  return ids;
};

const entriesOf = (report) => {
  if (report === null) return null;
  const entries = [...report.criteria, ...report.invariants];
  return entries.map(({ id, status }) => ({ id, status }));
};

const createOutcome = (verdict, result, { diverged = [], secondRun = null }) =>
  ({ verdict, result, diverged, secondRun });

const singleRun = (result) => createOutcome(verdictOf(result), result, {});

// first and second are evaluate() results built from the same deterministic
// inputs; only the report and its refs-problems differ.
const reconcile = (first, second) => {
  const secondRun = {
    firstFailures: first.failures,
    firstEntries: entriesOf(first.report),
  };
  if (second.report === null) {
    return createOutcome(STATUS_FAIL, second, { secondRun });
  }
  if (first.report === null) {
    return createOutcome(verdictOf(second), second, { secondRun });
  }
  const diverged = divergingIds(first.report, second.report, second.specItems);
  if (diverged.length > 0) {
    return createOutcome(VERDICT_NEEDS_HUMAN, second, { diverged, secondRun });
  }
  return createOutcome(verdictOf(second), second, { secondRun });
};

module.exports = {
  VERDICT_NEEDS_HUMAN,
  TEST_TAMPERING_KEY,
  needsSecondRun,
  divergingIds,
  singleRun,
  reconcile,
};
