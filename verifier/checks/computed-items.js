'use strict';

const { STATUS_FAIL } = require('../verdict/common');
const { deterministicReason } = require('../verdict/reason');
const { REASON_CODES: CODE } = require('../verdict/result');

// Merges deterministically computed ci/absence entries into the model's own
// criteria: a computed id always wins over whatever the model reported for
// it (a stray model entry for that id is discarded, not compared).
const mergeComputed = (report, computedItems) => {
  if (computedItems.length === 0) return report;
  const computedIds = new Set(computedItems.map((entry) => entry.id));
  const criteria = [
    ...report.criteria.filter((entry) => !computedIds.has(entry.id)),
    ...computedItems,
  ];
  return { ...report, criteria };
};

// With a report the computed entries are merged into its criteria and judged
// there; without one they still fail on their own, so a missing report next
// to a failed computed item is never mistaken for a model-only FAIL.
const failedItemReasons = (computedItems) =>
  computedItems
    .filter(({ status }) => status === STATUS_FAIL)
    .map(({ id }) =>
      deterministicReason(
        CODE.COMPUTED_ITEM_FAILED,
        `criterion failed: ${id}`,
        id,
      ),
    );

// Computed items (computed.js): issue items of type ci and absence, decided
// by code instead of the model.
module.exports = {
  name: 'computed-items',
  stage: 'report',
  codes: [CODE.COMPUTED_ITEM_FAILED],
  prepareReport: (report, { computedItems }) =>
    mergeComputed(report, computedItems),
  run: ({ report, computedItems }) =>
    report === null ? failedItemReasons(computedItems) : [],
  mergeComputed,
};
