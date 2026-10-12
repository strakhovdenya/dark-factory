'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readRequiredChecks,
  readSpecResult,
  parseProvenance,
  parseAllowedModels,
} = require('./inputs');
const { PROVENANCE } = require('./test-helpers');

test('readRequiredChecks distinguishes omitted, unreadable and valid files', () => {
  assert.strictEqual(readRequiredChecks(null), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'required-checks-'));
  assert.strictEqual(readRequiredChecks(path.join(dir, 'absent.json')), null);
  const notArray = path.join(dir, 'not-array.json');
  fs.writeFileSync(notArray, JSON.stringify({ foo: 'bar' }));
  assert.strictEqual(readRequiredChecks(notArray), null);
  const valid = path.join(dir, 'valid.json');
  fs.writeFileSync(valid, JSON.stringify(['Lint', 'Build']));
  assert.deepStrictEqual(readRequiredChecks(valid), ['Lint', 'Build']);
  fs.rmSync(dir, { recursive: true });
});

test('readSpecResult returns null for a file that does not match the linter shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-shape-'));
  const file = path.join(dir, 'spec-lint.json');
  fs.writeFileSync(file, JSON.stringify({ notFormat: 'v2' }));
  assert.strictEqual(readSpecResult(file), null);
  fs.rmSync(dir, { recursive: true });
});

test('parseProvenance accepts a well-formed provenance object', () => {
  assert.deepStrictEqual(
    parseProvenance(JSON.stringify(PROVENANCE)),
    PROVENANCE,
  );
});

test('parseProvenance rejects an absent or unparsable file', () => {
  assert.strictEqual(parseProvenance(null), null);
  assert.strictEqual(parseProvenance('{oops'), null);
});

test('rejects a provenance object with a malformed issue_body_sha256', () => {
  const bad = { ...PROVENANCE, issue_body_sha256: 'not-a-hash' };
  assert.strictEqual(parseProvenance(JSON.stringify(bad)), null);
});

test('rejects a provenance object with a malformed head_sha', () => {
  const upper = { ...PROVENANCE, head_sha: PROVENANCE.head_sha.toUpperCase() };
  assert.strictEqual(parseProvenance(JSON.stringify(upper)), null);
  const short = { ...PROVENANCE, head_sha: PROVENANCE.head_sha.slice(0, 39) };
  assert.strictEqual(parseProvenance(JSON.stringify(short)), null);
});

test('rejects a provenance object missing verifier_commit', () => {
  const bad = { ...PROVENANCE };
  delete bad.verifier_commit;
  assert.strictEqual(parseProvenance(JSON.stringify(bad)), null);
});

test('rejects a provenance object with an empty model field', () => {
  const bad = { ...PROVENANCE, model: '' };
  assert.strictEqual(parseProvenance(JSON.stringify(bad)), null);
});

test('rejects a provenance object with an empty codex_version field', () => {
  const bad = { ...PROVENANCE, codex_version: '' };
  assert.strictEqual(parseProvenance(JSON.stringify(bad)), null);
});

test('parseAllowedModels accepts a well-formed string array', () => {
  assert.deepStrictEqual(parseAllowedModels(JSON.stringify(['gpt-6-luna'])), [
    'gpt-6-luna',
  ]);
});

test('parseAllowedModels fails closed when allowed-models file is missing', () => {
  assert.strictEqual(parseAllowedModels(null), null);
});

test('parseAllowedModels fails closed when allowed-models file is invalid JSON', () => {
  assert.strictEqual(parseAllowedModels('{oops'), null);
});

test('parseAllowedModels fails closed when allowed-models file is not an array of strings', () => {
  assert.strictEqual(
    parseAllowedModels(JSON.stringify({ not: 'an array' })),
    null,
  );
  assert.strictEqual(parseAllowedModels(JSON.stringify([1, 2])), null);
});
