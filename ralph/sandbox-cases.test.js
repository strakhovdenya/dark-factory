'use strict';

// Keeps the map of the reference sandbox suite honest: every source test is listed with its
// assertions, every scenario that needs Docker names an existing test of the Docker integration
// (which npm test does not run) and never claims a run result, and every portable destination
// names a test that exists. No Docker is used here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const coverage = require('../test/fixtures/ralph-sandbox/lib/coverage');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'ralph-sandbox');
const cases = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'cases.json'), 'utf8'));
const sourceText = fs.readFileSync(path.join(FIXTURE_DIR, 'source', 'sandbox.test.js.txt'), 'utf8');
const portableText = fs.readFileSync(path.join(__dirname, 'sandbox.test.js'), 'utf8');
const integrationText = fs.readFileSync(path.join(REPO_ROOT, coverage.INTEGRATION_FILE), 'utf8');

const sourceNames = coverage.sourceTestNames(sourceText);

test('cases map lists every source test exactly once', () => {
  assert.equal(sourceNames.length, 26);
  assert.deepEqual(
    cases.cases.map((entry) => entry.source),
    sourceNames,
  );
  const count = (destination) => cases.cases.filter((entry) => entry.destination === destination).length;
  assert.deepEqual([count('portable'), count('integration'), count('both')], [13, 10, 3]);
});

test('sandbox map links preserved scenarios to executable tests', () => {
  const testNames = coverage.integrationTestNames(integrationText);
  assert.ok(testNames.length > 0, 'the integration file names its tests');
  assert.deepEqual(coverage.checkSandboxMap(cases, { sourceNames, testNames }), []);
  for (const entry of cases.cases) {
    if (entry.destination === 'portable') {
      assert.match(entry.status, /^ported/, entry.source);
      continue;
    }
    if (entry.destination === 'integration') assert.equal(entry.portable, null, entry.source);
    assert.ok(coverage.referencedTests(entry.integration).length > 0, entry.source);
    assert.doesNotMatch(entry.status, /passed|not-run/, entry.source);
  }
});

test('portable destinations name existing tests', () => {
  for (const entry of cases.cases.filter((item) => item.portable)) {
    const names = [...entry.portable.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(names.length > 0, entry.source);
    for (const name of names) {
      assert.ok(portableText.includes(`test('${name}'`), `${entry.source}: no test "${name}"`);
    }
  }
});
