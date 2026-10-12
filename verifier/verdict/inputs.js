'use strict';

const fs = require('node:fs');
const {
  isObject,
  isStringArray,
  isCriterion,
  isInvariant,
  isRiskZones,
  isSpecShape,
} = require('./common');

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;

// Fail closed: undefined means --spec was not passed (no effect on the
// verdict); null means a spec file was expected but could not be read or
// parsed, or did not match the linter's output shape.
const readSpecResult = (file) => {
  if (file === null) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isSpecShape(data) ? data : null;
  } catch {
    return null;
  }
};

const isSha = (value) => typeof value === 'string' && SHA256_HEX.test(value);
const isSha1 = (value) => typeof value === 'string' && SHA1_HEX.test(value);
const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

const isApprovalShape = (value) =>
  isObject(value) &&
  (value.approved_hash === null || isSha(value.approved_hash)) &&
  isSha(value.current_hash);

// Written by spec-hash.js check. undefined means --approval was not passed
// (no effect on the verdict); null means the file was expected but could not
// be read or parsed, or lacks approved_hash/current_hash (fail closed).
const readApproval = (file) => {
  if (file === null) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isApprovalShape(data) ? data : null;
  } catch {
    return null;
  }
};

// Written by the trusted .github/verifier/required-checks.json. undefined
// means --required-checks was not passed (no effect on the verdict); null
// means the file was expected but could not be read, parsed, or is not a
// string array (fail closed).
const readRequiredChecks = (file) => {
  if (file === null) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isStringArray(data) ? data : null;
  } catch {
    return null;
  }
};

const isCount = (value, min) => Number.isInteger(value) && value >= min;

const isAssertionLoss = (value) =>
  isObject(value) && typeof value.path === 'string' && isCount(value.lost, 1);

const isTamperingScanShape = (value) =>
  isObject(value) &&
  isStringArray(value.findings) &&
  Array.isArray(value.assertion_losses) &&
  value.assertion_losses.every(isAssertionLoss) &&
  isCount(value.assertion_moved, 0);

// Written by test-tampering-scan.js. null means the file could not be read,
// parsed, or match the expected shape (fail closed, same as --ci): unlike
// --spec/--scope/--approval this check is not optional, so there is no
// "argument omitted" case distinct from "could not be read".
const parseTamperingScan = (raw) => {
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw);
    if (!isTamperingScanShape(data)) return null;
    return {
      findings: data.findings,
      assertionLosses: data.assertion_losses,
      assertionMoved: data.assertion_moved,
    };
  } catch {
    return null;
  }
};

const isProvenanceShape = (value) =>
  isObject(value) &&
  isSha1(value.head_sha) &&
  isSha(value.issue_body_sha256) &&
  isSha1(value.verifier_commit) &&
  isNonEmptyString(value.model) &&
  isNonEmptyString(value.codex_version);

// Written by the "Write provenance" workflow step. null means the file could
// not be read, parsed, or match the expected shape (fail closed, same
// mandatory pattern as --tampering-scan: there is no "argument omitted" case
// distinct from "could not be read").
const parseProvenance = (raw) => {
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw);
    return isProvenanceShape(data) ? data : null;
  } catch {
    return null;
  }
};

// Written by the trusted .github/verifier/allowed-models.json. null means the
// file could not be read, parsed, or is not a string array (fail closed,
// same mandatory pattern as --tampering-scan/--provenance: there is no
// "argument omitted" case distinct from "could not be read").
const parseAllowedModels = (raw) => {
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw);
    return isStringArray(data) ? data : null;
  } catch {
    return null;
  }
};

const isScopeShape = (value) => isObject(value) && isStringArray(value.out_of_scope);

// Written by affects-scope.js. undefined means --scope was not passed (no
// effect on the verdict); null means the file was expected but could not be
// read, parsed, or match the expected shape (fail closed for a v2 issue).
const readScopeResult = (file) => {
  if (file === null) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isScopeShape(data) ? data : null;
  } catch {
    return null;
  }
};

const parseReport = (raw) => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { report: null, problem: `invalid JSON: ${error.message}` };
  }
  const isValid =
    data !== null &&
    typeof data === 'object' &&
    Array.isArray(data.criteria) &&
    data.criteria.every(isCriterion) &&
    Array.isArray(data.invariants) &&
    data.invariants.every(isInvariant) &&
    isStringArray(data.test_tampering) &&
    isRiskZones(data.risk_zones) &&
    isStringArray(data.out_of_scope_files);
  if (!isValid) return { report: null, problem: 'report violates schema' };
  return { report: data, problem: null };
};

const readReport = (file) => {
  try {
    return { raw: fs.readFileSync(file, 'utf8'), problem: null };
  } catch (error) {
    return { raw: null, problem: `report not readable: ${error.code}` };
  }
};

const readRefsProblems = (file) => {
  if (file === null) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isStringArray(data) ? data : null;
  } catch {
    return null;
  }
};

const isRefNote = (value) =>
  isObject(value) &&
  (value.list === 'criteria' || value.list === 'invariants') &&
  isCount(value.entry, 0) &&
  isCount(value.ref, 0) &&
  isCount(value.cited, 1) &&
  isCount(value.found, 1);

// Written by --check-refs (--notes-out). Fail-open to [] (INV-5): a missing,
// unreadable or malformed notes file never affects the verdict, only the
// comment's shift display falls back to the report's own line numbers.
const readRefsNotes = (file) => {
  if (file === null) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.filter(isRefNote) : [];
  } catch {
    return [];
  }
};

const readRawFile = (file) => {
  if (file === null) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// Written by --check-refs (--absence-out), which alone has --root.
const readAbsenceItems = (file) => {
  if (file === null) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};

module.exports = {
  readSpecResult,
  readApproval,
  readRequiredChecks,
  parseTamperingScan,
  parseProvenance,
  parseAllowedModels,
  readScopeResult,
  parseReport,
  readReport,
  readRefsProblems,
  readRefsNotes,
  readRawFile,
  readAbsenceItems,
};
