'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseSnapshot,
  checkSnapshotOrigin,
  STATE_SAVED,
} = require('../verifier/policy-snapshot');

// The rules of a past round, rebuilt from the policy snapshot that round
// stored. A snapshot is data: it is read, checked and copied into the analysis
// package, never run, and it never replaces Judge's own code or its current
// trusted settings. When no trustworthy snapshot exists the round has no
// historical policy: the status says so and no current setting stands in.
//
// Statuses are the words the input entries of collect.js use:
//   present     the snapshot was found, is intact and belongs to the round;
//   absent      there is no snapshot (an older round, an expired artifact, a
//               snapshot that was never formed);
//   unreadable  a snapshot exists but cannot be trusted (damaged, an unknown
//               format, or not from this round).

const STATUS_PRESENT = 'present';
const STATUS_ABSENT = 'absent';
const STATUS_UNREADABLE = 'unreadable';

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const missing = (status, reason) => ({
  status,
  reason,
  attempt: null,
  format_version: null,
  origin: null,
  parts: {},
  files: {},
});

/**
 * @param {{ snapshotText: string|null, missingReason?: string, failureReason?: string }} source
 *   snapshotText is null when no snapshot file reached Judge.
 * @param {{ runId: number, runAttempt: number, headSha: string, verifierCommit: string }} round
 * @param {{ policy: { parts: Record<string, string> } }} config the inputs config
 */
const readRoundPolicy = (source, round, config) => {
  if (source.snapshotText === null) {
    return source.failureReason === undefined
      ? missing(STATUS_ABSENT, source.missingReason ?? 'the round has no policy snapshot')
      : missing(STATUS_UNREADABLE, source.failureReason);
  }
  const parsed = parseSnapshot(source.snapshotText);
  if (!parsed.ok) return missing(STATUS_UNREADABLE, `snapshot rejected: ${parsed.reason}`);
  const { snapshot } = parsed;
  const origin = checkSnapshotOrigin(snapshot, round);
  if (!origin.ok) return missing(STATUS_UNREADABLE, `snapshot rejected: ${origin.reason}`);

  const parts = {};
  const files = {};
  for (const [partName, packagePath] of Object.entries(config.policy.parts)) {
    const part = snapshot.parts[partName];
    if (!isObject(part)) {
      return missing(STATUS_UNREADABLE, `snapshot rejected: part ${partName} is not in the snapshot`);
    }
    if (part.state === STATE_SAVED) {
      parts[packagePath] = { state: part.state, sha256: part.sha256 };
      files[packagePath] = part.content;
    } else {
      parts[packagePath] = { state: part.state, reason: part.reason };
    }
  }
  return {
    status: STATUS_PRESENT,
    reason: null,
    attempt: origin.attempt,
    format_version: snapshot.format_version,
    origin: structuredClone(snapshot.origin),
    parts,
    files,
  };
};

/** The status record stored next to the raw inputs; it carries no file content. */
const statusRecordOf = ({ status, reason, attempt, format_version, origin, parts }) => ({
  status,
  reason,
  attempt,
  format_version,
  origin,
  parts,
});

/** Writes the saved parts of a round policy under `dir`, at their package paths. */
const writePolicyFiles = (policy, dir) => {
  for (const [packagePath, content] of Object.entries(policy.files)) {
    const file = path.join(dir, packagePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};

/**
 * The policy of a round as the workflow stored it in its raw directory: the
 * status record next to the saved files. A missing or damaged record is an
 * absent policy, never a guess from other files.
 */
const loadStoredPolicy = (rawDir, config) => {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(rawDir, config.policy.statusFile), 'utf8'));
  } catch (error) {
    return missing(STATUS_ABSENT, `no policy record for the round (${error.code ?? error.message})`);
  }
  if (!isObject(record) || record.status !== STATUS_PRESENT || !isObject(record.parts)) {
    return missing(
      isObject(record) && record.status === STATUS_UNREADABLE ? STATUS_UNREADABLE : STATUS_ABSENT,
      isObject(record) && typeof record.reason === 'string' ? record.reason : 'the policy record has no usable status',
    );
  }
  const known = new Set(Object.values(config.policy.parts));
  const files = {};
  for (const [packagePath, part] of Object.entries(record.parts)) {
    if (!known.has(packagePath) || !isObject(part)) {
      return missing(STATUS_UNREADABLE, `the policy record names a part that is not a rule: ${packagePath}`);
    }
    if (part.state !== STATE_SAVED) continue;
    try {
      files[packagePath] = fs.readFileSync(path.join(rawDir, config.trustedConfigsRoot, packagePath), 'utf8');
    } catch (error) {
      return missing(STATUS_UNREADABLE, `saved rule file is not readable: ${packagePath} (${error.code ?? error.message})`);
    }
  }
  return { ...record, files };
};

// A line diff in unified form, one hunk for the whole file.
const MAX_DIFF_CELLS = 4_000_000;

const unifiedDiff = (previousText, currentText, previousLabel, currentLabel) => {
  const before = previousText.split('\n');
  const after = currentText.split('\n');
  if (before.length * after.length > MAX_DIFF_CELLS) {
    return `# not compared: ${currentLabel} is too large to diff (${before.length} and ${after.length} lines)`;
  }
  const table = Array.from({ length: before.length + 1 }, () => new Array(after.length + 1).fill(0));
  for (let row = before.length - 1; row >= 0; row--) {
    for (let column = after.length - 1; column >= 0; column--) {
      table[row][column] =
        before[row] === after[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }
  const lines = [];
  let row = 0;
  let column = 0;
  while (row < before.length || column < after.length) {
    if (row < before.length && column < after.length && before[row] === after[column]) {
      lines.push(` ${before[row]}`);
      row++;
      column++;
    } else if (column < after.length && (row === before.length || table[row][column + 1] >= table[row + 1][column])) {
      lines.push(`+${after[column++]}`);
    } else {
      lines.push(`-${before[row++]}`);
    }
  }
  return [
    `--- ${previousLabel}`,
    `+++ ${currentLabel}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...lines,
  ].join('\n');
};

const describeState = (policy, path) => {
  const part = policy.parts[path];
  return part.reason === undefined ? part.state : `${part.state}: ${part.reason}`;
};

const comparePart = (previous, current, path) => {
  const before = previous.parts[path];
  const after = current.parts[path];
  if (before === undefined || after === undefined) {
    return `# not compared: ${path} (not part of both snapshots)`;
  }
  const states = new Set([before.state, after.state]);
  if (states.has('unavailable')) {
    return `# not compared: ${path} (previous ${describeState(previous, path)}; current ${describeState(current, path)})`;
  }
  if (before.state === STATE_SAVED && after.state === STATE_SAVED) {
    if (before.sha256 === after.sha256) return `# unchanged: ${path}`;
    return unifiedDiff(previous.files[path], current.files[path], `previous/${path}`, `current/${path}`);
  }
  if (before.state === after.state) return `# unchanged: ${path} (${before.state})`;
  return `# changed state: ${path} (previous ${describeState(previous, path)}; current ${describeState(current, path)})`;
};

/**
 * What changed in the rules between two rounds. Only rounds with a trustworthy
 * snapshot are compared; otherwise the text says the comparison is not
 * possible and draws no conclusion about equality.
 * @param {ReturnType<typeof readRoundPolicy>} previous
 * @param {ReturnType<typeof readRoundPolicy>} current
 * @param {{ trustedConfigs: string[] }} config
 */
const policyDiff = (previous, current, config) => {
  const unusable = [
    { name: 'previous', policy: previous },
    { name: 'current', policy: current },
  ].filter(({ policy }) => policy.status !== STATUS_PRESENT);
  if (unusable.length > 0) {
    return [
      '# policy comparison unavailable: no conclusion about changed or unchanged rules',
      ...unusable.map(({ name, policy }) => `# ${name} round: ${policy.status} (${policy.reason})`),
      '',
    ].join('\n');
  }
  return `${config.trustedConfigs.map((path) => comparePart(previous, current, path)).join('\n')}\n`;
};

module.exports = {
  STATUS_PRESENT,
  STATUS_ABSENT,
  STATUS_UNREADABLE,
  readRoundPolicy,
  statusRecordOf,
  writePolicyFiles,
  loadStoredPolicy,
  policyDiff,
  unifiedDiff,
};
