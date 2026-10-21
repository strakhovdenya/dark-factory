'use strict';

const fs = require('node:fs');

// Every value in this list is itself drawn from the project's .github/calibration/taxonomy.json
//; the key names here only name which taxonomy entry is mandatory.
const REQUIRED_KEYS = [
  'primary_cause',
  'responsibility',
  'issue_defect_subtype',
  'verifier_defect_subtype',
  'recommended_change_target',
  'counterfactual_outcome',
  'verdict',
  'requirement_status',
  'confidence',
  'check_source',
];

const isNonEmptyStringArray = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === 'string' && item !== '');

// Fail closed: an unreadable file, invalid JSON, a non-object root, or
// a missing/malformed required key all throw rather than silently loading a
// partial taxonomy.
const loadTaxonomy = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('taxonomy must be a JSON object');
  }
  for (const key of REQUIRED_KEYS) {
    if (!isNonEmptyStringArray(data[key])) {
      throw new Error(`taxonomy is missing required key: ${key}`);
    }
  }
  return data;
};

module.exports = { REQUIRED_KEYS, loadTaxonomy };
