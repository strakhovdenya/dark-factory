'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { REQUIRED_KEYS, loadTaxonomy } = require('./taxonomy');

const FULL_TAXONOMY = {
  primary_cause: ['A', 'B'],
  responsibility: ['a', 'b'],
  issue_defect_subtype: ['X'],
  verifier_defect_subtype: ['Y'],
  recommended_change_target: ['none'],
  counterfactual_outcome: ['UNKNOWN'],
  verdict: ['PASS', 'FAIL', 'UNDECIDABLE'],
  requirement_status: ['SATISFIED', 'NOT_SATISFIED'],
  confidence: ['LOW', 'HIGH'],
  check_source: ['model', 'deterministic'],
};

const writeTaxonomy = (data) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tax-')), 't.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
};

test('loads a taxonomy that has every required key', () => {
  const file = writeTaxonomy(FULL_TAXONOMY);
  assert.deepStrictEqual(loadTaxonomy(file), FULL_TAXONOMY);
});

test('rejects taxonomy without a required key', () => {
  for (const missing of REQUIRED_KEYS) {
    const partial = { ...FULL_TAXONOMY };
    delete partial[missing];
    const file = writeTaxonomy(partial);
    assert.throws(() => loadTaxonomy(file), new RegExp(missing));
  }
});

test('rejects taxonomy where a required key is not a non-empty string array', () => {
  const broken = { ...FULL_TAXONOMY, primary_cause: [] };
  const file = writeTaxonomy(broken);
  assert.throws(() => loadTaxonomy(file), /primary_cause/);
});

test('rejects an unreadable taxonomy file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tax-')), 'missing.json');
  assert.throws(() => loadTaxonomy(file));
});

test('rejects a taxonomy file whose root is not an object', () => {
  const file = writeTaxonomy(['not', 'an', 'object']);
  assert.throws(() => loadTaxonomy(file), /must be a JSON object/);
});
