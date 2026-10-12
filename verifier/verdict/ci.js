'use strict';

const { isObject } = require('./common');

const REQUIRED_CHECKS_NOT_CHECKED = 'required checks were not checked';

const OWN_CHECKS = new Set(['Verify', 'Report', 'Acceptance Verifier']);
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
]);
const FAILED_STATES = new Set(['failure', 'error']);

// conclusion is null while a check is still running
const isCheckRun = (value) =>
  isObject(value) &&
  typeof value.name === 'string' &&
  typeof value.status === 'string' &&
  (value.conclusion === null || typeof value.conclusion === 'string');

const isCommitStatus = (value) =>
  isObject(value) &&
  typeof value.name === 'string' &&
  typeof value.state === 'string';

// ci.json is GitHub API data gathered by the workflow, not model output.
const parseCiData = (raw) => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const isValid =
    data !== null &&
    typeof data === 'object' &&
    typeof data.head_sha === 'string' &&
    data.head_sha !== '' &&
    typeof data.ci_workflow_conclusion === 'string' &&
    Array.isArray(data.checks) &&
    data.checks.every(isCheckRun) &&
    Array.isArray(data.statuses) &&
    data.statuses.every(isCommitStatus);
  return isValid ? data : null;
};

// requiredChecks is undefined when --required-checks was not passed (no
// enforcement), null when the trusted file could not be read (fail closed),
// or the list of required check-run names to enforce against data.checks.
const requiredCheckFailures = (checks, requiredChecks) => {
  if (requiredChecks === undefined) return [];
  if (requiredChecks === null) return [REQUIRED_CHECKS_NOT_CHECKED];
  const failures = [];
  for (const name of requiredChecks) {
    const matches = checks.filter((check) => check.name === name);
    if (matches.length === 0) {
      failures.push(`required check missing: ${name}`);
      continue;
    }
    if (matches.length > 1) {
      failures.push(
        `required check ambiguous: ${name} (${matches.length} matches)`,
      );
      continue;
    }
    const [match] = matches;
    if (match.status !== 'completed') {
      failures.push(`required check not completed: ${name}`);
    } else if (match.conclusion !== 'success') {
      failures.push(`required check failed: ${name} (${match.conclusion})`);
    }
  }
  return failures;
};

const ciFailuresOf = (data, requiredChecks) => {
  const failures = [];
  if (data.ci_workflow_conclusion !== 'success') {
    failures.push(
      `CI workflow did not succeed (${data.ci_workflow_conclusion})`,
    );
  }

  failures.push(...requiredCheckFailures(data.checks, requiredChecks));

  for (const { name, conclusion } of data.checks) {
    if (OWN_CHECKS.has(name) || !FAILED_CONCLUSIONS.has(conclusion)) continue;
    failures.push(`ci check failed: ${name} (${conclusion})`);
  }
  for (const { name, state } of data.statuses) {
    if (OWN_CHECKS.has(name) || !FAILED_STATES.has(state)) continue;
    failures.push(`ci status failed: ${name} (${state})`);
  }
  return failures;
};

const parseCiFailures = (raw, requiredChecks) => {
  const data = parseCiData(raw);
  return data === null ? null : ciFailuresOf(data, requiredChecks);
};

module.exports = {
  REQUIRED_CHECKS_NOT_CHECKED,
  parseCiData,
  requiredCheckFailures,
  ciFailuresOf,
  parseCiFailures,
};
