'use strict';

const STATUS_PASS = 'PASS';
const STATUS_FAIL = 'FAIL';
const STATUS_UNVERIFIABLE = 'UNVERIFIABLE';
const STATUS_NOT_APPLICABLE = 'N/A';
const CRITERION_STATUSES = new Set([
  STATUS_PASS,
  STATUS_FAIL,
  STATUS_UNVERIFIABLE,
]);
const INVARIANT_STATUSES = new Set([
  STATUS_PASS,
  STATUS_FAIL,
  STATUS_NOT_APPLICABLE,
]);

const RISK_NONE = 'none';
const RISK_ZONES = new Set([
  'auth',
  'secrets',
  'ci',
  'migrations',
  'fs_shell_sinks',
  'state_machine',
  'dependencies',
  'adr_034_manual_note',
  RISK_NONE,
]);

const REF_KINDS = new Set(['impl', 'test', 'doc', 'config', 'ci']);
const BEHAVIOR_TYPE = 'behavior';
const BEHAVIOR_REQUIRED_KINDS = ['impl', 'test'];
const DETERMINISTIC_TYPES = new Set(['ci', 'absence']);

const isObject = (value) => value !== null && typeof value === 'object';

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isReference = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.path === 'string' &&
  value.path !== '' &&
  Number.isInteger(value.line) &&
  value.line >= 1 &&
  typeof value.quote === 'string' &&
  value.quote.trim() !== '' &&
  typeof value.kind === 'string' &&
  REF_KINDS.has(value.kind);

const isCriterion = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.id === 'string' &&
  typeof value.text === 'string' &&
  CRITERION_STATUSES.has(value.status) &&
  typeof value.summary === 'string' &&
  Array.isArray(value.refs) &&
  value.refs.every(isReference);

const isInvariant = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.id === 'string' &&
  INVARIANT_STATUSES.has(value.status) &&
  typeof value.summary === 'string' &&
  Array.isArray(value.refs) &&
  value.refs.every(isReference);

// A v2 report names its entries by issue ID; a legacy one leaves id empty.
const labelOf = ({ id, text = '' }) => (id !== '' ? id : text);

const isRiskZones = (value) =>
  isStringArray(value) &&
  value.length > 0 &&
  value.every((zone) => RISK_ZONES.has(zone)) &&
  (!value.includes(RISK_NONE) || value.length === 1);

const isSpecItem = (value) =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.text === 'string' &&
  (value.type === null || typeof value.type === 'string');

// items is optional: without it a v2 spec expects no IDs, so every reported
// ID is foreign to the issue and the verdict still fails closed.
const isSpecShape = (value) =>
  isObject(value) &&
  (value.format === 'v2' || value.format === 'legacy') &&
  isStringArray(value.problems) &&
  (value.items === undefined ||
    (Array.isArray(value.items) && value.items.every(isSpecItem)));

const isV2Spec = (spec) => isObject(spec) && spec.format === 'v2';

const specItemsOf = (spec) => (isV2Spec(spec) ? (spec.items ?? []) : null);

// A genuinely invalid v2 spec is the only case where the model report is not
// worth reading at all (AC-5): the issue itself fails the contract, so no
// report could satisfy it. A merely unreadable spec (readSpecResult() -> null)
// is an unrelated infra concern and must not hide real report/CI diagnostics,
// so it is folded into the normal failure list instead (see evaluate()).
const isSpecInvalid = (spec) =>
  spec !== null && spec.format === 'v2' && spec.problems.length > 0;

// items is optional: without it (legacy issues) nothing is a computed item,
// matching TR-1.
const deterministicIdsOf = (items) =>
  new Set(
    (items ?? [])
      .filter((item) => DETERMINISTIC_TYPES.has(item.type))
      .map((item) => item.id),
  );

module.exports = {
  STATUS_PASS,
  STATUS_FAIL,
  STATUS_UNVERIFIABLE,
  STATUS_NOT_APPLICABLE,
  CRITERION_STATUSES,
  INVARIANT_STATUSES,
  RISK_NONE,
  RISK_ZONES,
  REF_KINDS,
  BEHAVIOR_TYPE,
  BEHAVIOR_REQUIRED_KINDS,
  DETERMINISTIC_TYPES,
  isObject,
  isStringArray,
  isReference,
  isCriterion,
  isInvariant,
  labelOf,
  isRiskZones,
  isSpecItem,
  isSpecShape,
  isV2Spec,
  specItemsOf,
  isSpecInvalid,
  deterministicIdsOf,
};
