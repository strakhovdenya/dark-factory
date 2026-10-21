'use strict';

// Regression guard for a bug found live in production: OpenAI's
// structured-output API rejects any object-typed JSON Schema node that does
// not explicitly set `additionalProperties: false` — Codex then fails
// before producing any output (`codex exited with code 1`,
// "'additionalProperties' is required to be supplied and to be false").
// `.github/calibration/analysis.schema.json`'s `$defs.evidence` node was
// missing it while every sibling node already had it. This file reads the
// real config files (not a fixture copy) so a future edit that reintroduces
// the same gap, in either Judge schema file or in the schema built from
// them, fails here instead of only surfacing live against the OpenAI API.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { buildSchema } = require('./schema');
const { loadTaxonomy } = require('./taxonomy');

const ANALYSIS_SCHEMA_FILE = path.join(__dirname, 'analysis.schema.json');
const INDEPENDENT_SCHEMA_FILE = path.join(__dirname, 'independent.schema.json');
const TAXONOMY_FILE = path.join(__dirname, '..', 'test', 'fixtures', 'judge', 'taxonomy.json');

const isObjectNode = (node) =>
  node !== null && typeof node === 'object' && node.type === 'object';

// Walks the whole schema tree (root, $defs, and every nested object under
// `properties`/`items`/`$defs`) and, for every object-typed node found,
// checks both OpenAI strict-mode requirements: `additionalProperties:
// false`, and `required` listing exactly the same keys as `properties` (a
// "optional" field is expressed as a nullable type, still listed in
// `required` — the pattern already used for `criterion_id`/`sha`/`path`/
// `ref` in this file). Returns one problem string per violation, naming the
// path, so a failing assertion names exactly which node regressed.
const objectNodeProblems = (schema) => {
  const problems = [];
  const visit = (node, nodePath) => {
    if (node === null || typeof node !== 'object') return;
    if (isObjectNode(node)) {
      if (node.additionalProperties !== false) {
        problems.push(`${nodePath}: missing additionalProperties: false`);
      }
      const propertyKeys = Object.keys(node.properties ?? {});
      const requiredKeys = node.required ?? [];
      const missingFromRequired = propertyKeys.filter(
        (key) => !requiredKeys.includes(key),
      );
      if (missingFromRequired.length > 0) {
        problems.push(`${nodePath}: missing from required: ${missingFromRequired.join(', ')}`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      visit(value, `${nodePath}.${key}`);
    }
  };
  visit(schema, 'root');
  return problems;
};

test('every object node in analysis.schema.json sets additionalProperties: false and required', () => {
  const schema = require(ANALYSIS_SCHEMA_FILE);
  assert.deepStrictEqual(objectNodeProblems(schema), []);
});

test('every object node in independent.schema.json sets additionalProperties: false and required', () => {
  const schema = require(INDEPENDENT_SCHEMA_FILE);
  assert.deepStrictEqual(objectNodeProblems(schema), []);
});

test('built stage-2 schema has no object node missing additionalProperties or required', () => {
  const template = require(ANALYSIS_SCHEMA_FILE);
  const taxonomy = loadTaxonomy(TAXONOMY_FILE);
  const schema = buildSchema(template, taxonomy);
  assert.deepStrictEqual(objectNodeProblems(schema), []);
});
