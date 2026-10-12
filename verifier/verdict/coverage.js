'use strict';

const {
  isV2Spec,
  specItemsOf,
  deterministicIdsOf,
  DETERMINISTIC_TYPES,
} = require('./common');

const ITEM_SECTIONS = [
  'acceptance criteria',
  'definition of done',
  'test requirement',
];
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const TOP_LEVEL_ITEM = /^ ?(?:[-*+]|\d+[.)])\s+\S/;

const sectionOf = (title) => {
  const name = title.toLowerCase();
  return ITEM_SECTIONS.find((section) => name.startsWith(section)) ?? null;
};

// Lower bound of report entries the prompt requires: one per top-level list
// item under Acceptance Criteria / Definition of Done / Test Requirement, and
// one for a Test Requirement written as prose. The model may split further.
const countIssueItems = (markdown) => {
  const counts = new Map(ITEM_SECTIONS.map((section) => [section, 0]));
  const hasText = new Set();
  let current = null;
  let isFenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) isFenced = !isFenced;
    const heading = isFenced ? null : HEADING.exec(line);
    if (heading !== null) {
      current = sectionOf(heading[1]);
      continue;
    }
    if (current === null || line.trim() === '') continue;
    hasText.add(current);
    if (!isFenced && TOP_LEVEL_ITEM.test(line)) {
      counts.set(current, counts.get(current) + 1);
    }
  }
  const testRequirement = 'test requirement';
  if (counts.get(testRequirement) === 0 && hasText.has(testRequirement)) {
    counts.set(testRequirement, 1);
  }
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
};

const checkCoverage = (report, issueMarkdown) => {
  const expected = countIssueItems(issueMarkdown);
  const actual = report.criteria.length;
  if (actual >= expected) return [];
  return [
    `report covers ${actual} of ${expected} issue items ` +
      '(Acceptance Criteria, Definition of Done, Test Requirement)',
  ];
};

const compareIds = (kind, reportedIds, issueIds) => {
  const problems = [];
  const seen = new Set();
  for (const id of reportedIds) {
    const name = JSON.stringify(id);
    if (seen.has(id)) {
      problems.push(`duplicate ${kind} id in report: ${name}`);
      continue;
    }
    seen.add(id);
    if (!issueIds.has(id)) problems.push(`${kind} id not in issue: ${name}`);
  }
  for (const id of issueIds) {
    if (seen.has(id)) continue;
    const name = JSON.stringify(id);
    problems.push(`issue ${kind} id missing from report: ${name}`);
  }
  return problems;
};

// The linter gives invariants type null; every other item has a type.
// ci/absence ids are excluded from the required criterion set (INV-4): the
// script computes them, so the model report is never required to carry them.
const idsOf = (items, isInvariantKind) =>
  new Set(
    items
      .filter((item) => (item.type === null) === isInvariantKind)
      .filter((item) => !DETERMINISTIC_TYPES.has(item.type))
      .map((item) => item.id),
  );

const checkIds = (report, items) => {
  const skip = deterministicIdsOf(items);
  const criteria = report.criteria.filter((entry) => !skip.has(entry.id));
  return [
    ...compareIds(
      'criterion',
      criteria.map((entry) => entry.id),
      idsOf(items, false),
    ),
    ...compareIds(
      'invariant',
      report.invariants.map((entry) => entry.id),
      idsOf(items, true),
    ),
  ];
};

// v2: exact ID sets replace the count; legacy: the count as before.
const checkIssueCoverage = (report, { spec = null, issueMarkdown = null }) => {
  if (isV2Spec(spec)) return checkIds(report, specItemsOf(spec));
  if (issueMarkdown === null) return [];
  return checkCoverage(report, issueMarkdown);
};

module.exports = {
  countIssueItems,
  checkCoverage,
  compareIds,
  idsOf,
  checkIds,
  checkIssueCoverage,
};
