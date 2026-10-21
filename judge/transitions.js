'use strict';

const {
  isCriterion,
  isInvariant,
} = require('../verifier/verdict/common');

// Per-ID status transitions between two neighbouring rounds of one PR. A
// transition is only "previous status -> current status": it says nothing
// about whether a defect was fixed; that is a separate dimension
// decided elsewhere. This module does no filesystem or network I/O — the CLI
// (judge/calibration-judge.js) loads each round's files and passes their
// parsed content in.
//
// A round here is { result, verdict2, verdict, spec }: the verifier's machine
// result.json, its second and first model reports, and the issue linter's
// output, each parsed JSON or null when absent/unreadable.

const NOT_REPORTED = 'NOT_REPORTED';
const NOT_TRACKED = 'NOT_TRACKED';
const TASK_CHANGE_NONE = 'none';

const SOURCE_RESULT = 'result';
const SOURCE_VERDICT2 = 'verdict2';
const SOURCE_VERDICT = 'verdict';

// Item types whose status only the verifier's own computation knows: it
// discards any model entry for them, so an old round's model report cannot
// say anything about them, even when the model wrote an entry anyway.
const UNTRACKED_TYPES = new Set(['ci', 'absence']);

// Diverging runs of one round record two statuses (result.json, NEEDS_HUMAN);
// they are shown as one status value, "first/second".
const STATUS_SEPARATOR = '/';

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

const isRef = (value) =>
  isObject(value) &&
  typeof value.path === 'string' &&
  typeof value.quote === 'string';

const isResultItem = (value) =>
  isObject(value) &&
  isNonEmptyString(value.id) &&
  Array.isArray(value.statuses) &&
  value.statuses.length > 0 &&
  value.statuses.every(isNonEmptyString) &&
  Array.isArray(value.refs) &&
  value.refs.every(isRef);

const isResult = (value) =>
  isObject(value) &&
  Array.isArray(value.items) &&
  value.items.every(isResultItem);

// The same report schema the verifier itself validates a model report
// against (isCriterion/isInvariant, verifier/verdict/common.js): a shallow
// shape check here (id/status/refs only, no real status enum) would accept a
// verdict2.json the verifier's own parseReport rejects, letting an invalid
// second report be picked over a valid first one.
const isModelReport = (value) =>
  isObject(value) &&
  Array.isArray(value.criteria) &&
  value.criteria.every(isCriterion) &&
  Array.isArray(value.invariants) &&
  value.invariants.every(isInvariant);

const refsOf = (refs) => refs.map(({ path, quote }) => ({ path, quote }));

const createRoundStatuses = (source, items, notTracked) => ({
  source,
  isPartial: source !== SOURCE_RESULT,
  hasData: source !== null,
  notTracked,
  items,
});

const fromResult = (result) => {
  const items = new Map();
  for (const { id, statuses, refs } of result.items) {
    items.set(id, { statuses: [...statuses], refs: refsOf(refs) });
  }
  return createRoundStatuses(SOURCE_RESULT, items, []);
};

const untrackedIdsOf = (spec) => {
  const specItems = isObject(spec) && Array.isArray(spec.items) ? spec.items : [];
  return specItems
    .filter((item) => isObject(item) && UNTRACKED_TYPES.has(item.type))
    .map((item) => item.id)
    .filter(isNonEmptyString);
};

// A legacy report names its entries by text only (id ''), so it has nothing
// to compare by ID.
const fromModelReport = (source, report, spec) => {
  const notTracked = untrackedIdsOf(spec);
  const items = new Map();
  for (const { id, status, refs } of [...report.criteria, ...report.invariants]) {
    if (id === '' || notTracked.includes(id)) continue;
    items.set(id, { statuses: [status], refs: refsOf(refs) });
  }
  return createRoundStatuses(source, items, notTracked);
};

// Picks where a round's statuses come from: the machine result.json,
// else a valid second-run report, else the first-run report; a round with
// none of them has no data, which is a normal outcome, not an error.
const roundStatuses = (round) => {
  const { result = null, verdict2 = null, verdict = null, spec = null } =
    round ?? {};
  if (isResult(result)) return fromResult(result);
  if (isModelReport(verdict2)) {
    return fromModelReport(SOURCE_VERDICT2, verdict2, spec);
  }
  if (isModelReport(verdict)) {
    return fromModelReport(SOURCE_VERDICT, verdict, spec);
  }
  return createRoundStatuses(null, new Map(), []);
};

// The same whitespace rule the verifier applies when it matches a quote
// against a line (verifier/verdict/refs.js).
const normalizeSpaces = (text) => text.replace(/\s+/g, ' ').trim();

const refKey = ({ path, quote }) => `${path}\u0000${normalizeSpaces(quote)}`;

const refsMissingFrom = (refs, other) => {
  const otherKeys = new Set(other.map(refKey));
  const seen = new Set();
  const missing = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (otherKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(ref);
  }
  return missing;
};

const statusOf = (round, id) => {
  const item = round.items.get(id);
  if (item !== undefined) return item.statuses.join(STATUS_SEPARATOR);
  if (round.notTracked.includes(id)) return NOT_TRACKED;
  return NOT_REPORTED;
};

const isReported = (status) => status !== NOT_REPORTED && status !== NOT_TRACKED;

// FLIP marks only a status change of an item reported in both rounds, and
// only when neither the code nor the issue body changed between them
//. It is a property of the transition, not a diagnosis.
const transitionOf = (id, previous, current, taskChangeType) => {
  const from = statusOf(previous, id);
  const to = statusOf(current, id);
  const isChanged = isReported(from) && isReported(to) && from !== to;
  const previousRefs = previous.items.get(id)?.refs ?? [];
  const currentRefs = current.items.get(id)?.refs ?? [];
  return {
    id,
    from,
    to,
    changed: isChanged,
    flip: isChanged && taskChangeType === TASK_CHANGE_NONE,
    refs: {
      added: refsMissingFrom(currentRefs, previousRefs),
      removed: refsMissingFrom(previousRefs, currentRefs),
    },
  };
};

const idsOf = (previous, current) => [
  ...new Set([
    ...previous.items.keys(),
    ...previous.notTracked,
    ...current.items.keys(),
    ...current.notTracked,
  ]),
];

const describeRound = (round) => ({
  source: round.source,
  partial: round.isPartial,
  no_data: !round.hasData,
  not_tracked: round.notTracked,
});

// previousRound is null for the first round of a PR: there is nothing to
// compare with, so no transitions are produced. taskChangeType comes from
// compare.js's classifyTaskChange (null when unknown).
const computeTransitions = (previousRound, currentRound, taskChangeType) => {
  const current = roundStatuses(currentRound);
  const taskChange = taskChangeType ?? null;
  if (previousRound === null) {
    return {
      task_change: taskChange,
      reason: 'first round',
      partial: current.isPartial,
      previous: null,
      current: describeRound(current),
      transitions: [],
    };
  }
  const previous = roundStatuses(previousRound);
  const transitions = idsOf(previous, current).map((id) =>
    transitionOf(id, previous, current, taskChange),
  );
  return {
    task_change: taskChange,
    reason: null,
    partial: previous.isPartial || current.isPartial,
    previous: describeRound(previous),
    current: describeRound(current),
    transitions,
  };
};

module.exports = {
  NOT_REPORTED,
  NOT_TRACKED,
  SOURCE_RESULT,
  SOURCE_VERDICT2,
  SOURCE_VERDICT,
  roundStatuses,
  computeTransitions,
};
