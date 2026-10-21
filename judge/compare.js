'use strict';

// Compares two rounds (collect.js's manifest.json, plus any raw input
// content the caller already loaded) to answer two separate questions
//: did the task itself change (classifyTaskChange, from head_sha /
// issue_body_sha256 alone), and were the conditions the verifier ran under
// comparable (compareRounds' fingerprint, from every other significant
// input). Neither is derived from the other. This module does no filesystem
// or network I/O — every value it reads comes from the round
// objects the caller passes in; loading manifest.json and the raw input
// files from a round's package directory is the CLI layer's job
// (judge/calibration-judge.js).
//
// A "round" here is collect.js's manifest shape (round_key, base_sha,
// head_sha, issue_body_sha256, verifier_commit, model, codex_version,
// trusted_config_hashes, inputs: { <key>: { status, historical } }),
// extended with `contents: { <inputKey>: <parsed content or null> }` for
// whichever raw inputs the fingerprint config asks for (e.g. "ci",
// "specApproval", "verifierComment" — the same keys collect.js already uses
// in `inputs`).
//
// Which inputs are significant, and which CI-snapshot fields are technical
// noise to ignore, come only from `judge/inputs.json`'s
// `fingerprint` section — this module contains no project literal
// (path, CI check name, login, model name). The config
// schema's own field names (manifestField, inputKey, statusKey,
// stripIgnoredFields) are generic structure, not project literals, the same
// distinction collect.js's own config already draws for its own field names.

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => isNonEmptyString(item));

const isSignificantInputEntry = (entry) =>
  isObject(entry) &&
  isNonEmptyString(entry.key) &&
  (isNonEmptyString(entry.manifestField) || isNonEmptyString(entry.inputKey)) &&
  !(isNonEmptyString(entry.manifestField) && isNonEmptyString(entry.inputKey)) &&
  (entry.statusKey === undefined || isNonEmptyString(entry.statusKey)) &&
  (entry.stripIgnoredFields === undefined ||
    typeof entry.stripIgnoredFields === 'boolean') &&
  (entry.extractLinesContaining === undefined ||
    isStringArray(entry.extractLinesContaining)) &&
  (entry.presentByFile === undefined || typeof entry.presentByFile === 'boolean');

// Validates and normalizes the `fingerprint` section of the already-parsed
// judge/inputs.json object. Fails closed (mirroring
// collect.js's loadInputsConfig): a missing section, a malformed entry or a
// duplicate key all throw rather than silently comparing against a partial
// list.
const loadFingerprintConfig = (data) => {
  if (!isObject(data) || !isObject(data.fingerprint)) {
    throw new Error('inputs config: fingerprint is missing');
  }
  const { significantInputs, ciSnapshotIgnoredFields = [] } = data.fingerprint;
  if (
    !Array.isArray(significantInputs) ||
    significantInputs.length === 0 ||
    !significantInputs.every(isSignificantInputEntry)
  ) {
    throw new Error('inputs config: fingerprint.significantInputs is invalid');
  }
  if (!isStringArray(ciSnapshotIgnoredFields)) {
    throw new Error('inputs config: fingerprint.ciSnapshotIgnoredFields is invalid');
  }

  const keys = new Set();
  for (const entry of significantInputs) {
    if (keys.has(entry.key)) {
      throw new Error(`inputs config: duplicate fingerprint input key: ${entry.key}`);
    }
    keys.add(entry.key);
  }

  return { significantInputs, ciSnapshotIgnoredFields };
};

const getPath = (object, dottedPath) =>
  dottedPath
    .split('.')
    .reduce((acc, part) => (acc === null || acc === undefined ? null : acc[part]), object);

// Removes every key named in `fields` at any depth (technical
// per-check timestamps/ids are not part of the comparison).
const stripFields = (value, fields) => {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, fields));
  if (isObject(value)) {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (fields.includes(key)) continue;
      result[key] = stripFields(nested, fields);
    }
    return result;
  }
  return value;
};

// Normalizes object key order and array element order (a CI snapshot
// with the same checks in a different order is the same snapshot) so two
// structurally-equal values serialize identically regardless of the order
// either source produced them in.
const sortDeep = (value) => {
  if (Array.isArray(value)) {
    return value
      .map(sortDeep)
      .toSorted((left, right) => {
        const leftText = JSON.stringify(left);
        const rightText = JSON.stringify(right);
        return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
      });
  }
  if (isObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = sortDeep(value[key]);
    return result;
  }
  return value;
};

const resolveEntryValue = (round, entry) => {
  if (entry.manifestField) return getPath(round, entry.manifestField) ?? null;
  return round.contents?.[entry.inputKey] ?? null;
};

// Keeps only the lines of a text input that contain one of the configured
// substrings (e.g. the verifier comment's "manual-verified ignored: ..." /
// "test removal approval ignored: ..." lines), discarding everything else —
// in particular the Provenance block's head_sha, which would otherwise make
// the whole comment change on every code-changed round even when nothing
// about the verifier's own conditions changed. The substrings themselves
// come only from config; this function is generic over
// whatever substrings it is given.
const extractRelevantLines = (text, substrings) => {
  if (typeof text !== 'string') return null;
  return text.split(/\r?\n/).filter((line) => substrings.some((s) => line.includes(s)));
};

// Decides whether one significant input is usable for comparison. A
// `presentByFile: true` entry (config-driven — compare.js does not
// hardcode which manifest field this applies to) is checked structurally:
// its value is a map of files to { present, sha256 }, and any file marked
// present: false makes that whole input incomplete. Any other entry falls
// back on the matching manifest.inputs status/historical pair, via
// statusKey when the input isn't named after itself (e.g. the
// provenance-derived fields all share the "provenance" status).
// A file recorded as not present is an unknown, unless the round's policy
// snapshot confirmed it: the file was not in the checkout, or was not used.
const CONFIRMED_ABSENCE = new Set(['absent', 'unused']);

const entryIncompleteReason = (round, entry) => {
  if (entry.presentByFile === true) {
    const value = resolveEntryValue(round, entry);
    if (!isObject(value)) return 'absent';
    const hasMissingFile = Object.values(value).some(
      (file) =>
        isObject(file) && file.present === false && !CONFIRMED_ABSENCE.has(file.state),
    );
    return hasMissingFile ? 'absent' : null;
  }

  const value = resolveEntryValue(round, entry);
  if (value === null || value === undefined) return 'absent';

  const statusKey = entry.statusKey ?? entry.inputKey;
  if (statusKey) {
    const status = round.inputs?.[statusKey];
    if (!isObject(status) || status.status !== 'present') {
      return isObject(status) && isNonEmptyString(status.status)
        ? status.status
        : 'absent';
    }
    if (status.historical === false) return 'historical: false';
  }
  return null;
};

// Pure: computes the comparable, normalized value of every significant
// input for one round, and which ones could not be computed.
const computeFingerprint = (round, config) => {
  const values = {};
  const incomplete = [];
  for (const entry of config.significantInputs) {
    const problem = entryIncompleteReason(round, entry);
    if (problem !== null) {
      incomplete.push(entry.key);
      continue;
    }
    let value = resolveEntryValue(round, entry);
    if (entry.stripIgnoredFields === true) {
      value = stripFields(value, config.ciSnapshotIgnoredFields);
    }
    if (entry.extractLinesContaining !== undefined) {
      value = extractRelevantLines(value, entry.extractLinesContaining);
    }
    values[entry.key] = sortDeep(value);
  }
  return { values, incomplete };
};

const changedKeys = (previousValues, currentValues, keys) =>
  keys.filter(
    (key) => JSON.stringify(previousValues[key]) !== JSON.stringify(currentValues[key]),
  );

// Task-identity change only: head_sha and issue_body_sha256
// alone, never run identifiers, never any other significant input.
const classifyTaskChange = (previous, current) => {
  const previousHead = previous.head_sha;
  const currentHead = current.head_sha;
  if (!isNonEmptyString(previousHead) || !isNonEmptyString(currentHead)) {
    return { type: null, reason: 'head_sha is missing' };
  }

  const previousIssue = previous.issue_body_sha256;
  const currentIssue = current.issue_body_sha256;
  if (!isNonEmptyString(previousIssue) || !isNonEmptyString(currentIssue)) {
    return { type: null, reason: 'issue_body_sha256 is missing' };
  }

  const headChanged = previousHead !== currentHead;
  const issueChanged = previousIssue !== currentIssue;
  if (headChanged && issueChanged) return { type: 'both', reason: null };
  if (headChanged) return { type: 'code', reason: null };
  if (issueChanged) return { type: 'issue', reason: null };
  return { type: 'none', reason: null };
};

// Compares the previous round to the current one. `previous` is null for a
// round's first comparison: both fields come back null with the
// same "first round" reason, not an error. Otherwise task-change type and
// comparability are always computed independently — a `none` task
// change can still be INPUTS_CHANGED, and a `code`/`issue`/`both`
// task change can still be COMPARABLE if every significant input happens to
// match.
const compareRounds = (previous, current, config) => {
  if (previous === null) {
    return {
      taskChange: { type: null, reason: 'first round' },
      comparability: {
        result: null,
        reason: 'first round',
        changedInputs: [],
        incompleteInputs: [],
      },
    };
  }

  const taskChange = classifyTaskChange(previous, current);

  const previousFingerprint = computeFingerprint(previous, config);
  const currentFingerprint = computeFingerprint(current, config);
  const incompleteInputs = [
    ...new Set([...previousFingerprint.incomplete, ...currentFingerprint.incomplete]),
  ];
  if (incompleteInputs.length > 0) {
    return {
      taskChange,
      comparability: {
        result: 'UNKNOWN',
        reason: null,
        changedInputs: [],
        incompleteInputs,
      },
    };
  }

  const keys = config.significantInputs.map((entry) => entry.key);
  const changedInputs = changedKeys(
    previousFingerprint.values,
    currentFingerprint.values,
    keys,
  );
  return {
    taskChange,
    comparability: {
      result: changedInputs.length === 0 ? 'COMPARABLE' : 'INPUTS_CHANGED',
      reason: null,
      changedInputs,
      incompleteInputs: [],
    },
  };
};

module.exports = {
  loadFingerprintConfig,
  classifyTaskChange,
  computeFingerprint,
  compareRounds,
};
