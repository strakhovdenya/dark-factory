'use strict';

// Keeps the record of the Docker scenarios of the reference controller suites honest: all 11 are
// listed with their assertions, each names a test that exists in its verbatim source snapshot and
// an existing test of the Docker integration (which npm test does not run), never claims a run
// result, and a named portable counterpart exists. No Docker is used here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const coverage = require('../test/fixtures/ralph-sandbox/lib/coverage');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'ralph-controller');
const map = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'integration-cases.json'), 'utf8'));
const { cases } = map;
const sources = Object.fromEntries(fs.readdirSync(path.join(FIXTURE_DIR, 'source')).map((name) => [name, fs.readFileSync(path.join(FIXTURE_DIR, 'source', name), 'utf8')]));

test('controller map links preserved scenarios to executable tests', () => {
  assert.equal(cases.length, 11);
  const testNames = coverage.integrationTestNames(fs.readFileSync(path.join(REPO_ROOT, coverage.INTEGRATION_FILE), 'utf8'));
  assert.deepEqual(coverage.checkControllerMap(map, { sources, testNames }), []);
  for (const entry of cases) {
    assert.ok(sources[entry.source].includes(`test('${entry.test}'`), `${entry.source}: no test "${entry.test}"`);
    assert.ok(entry.assertions.length > 0, entry.test);
    assert.equal(entry.status, coverage.MAPPED, entry.test);
    if (entry.portable === null) continue;
    const match = /^(\S+) "([^"]+)"$/.exec(entry.portable);
    assert.ok(match, entry.portable);
    const portable = fs.readFileSync(path.join(REPO_ROOT, match[1]), 'utf8');
    assert.ok(portable.includes(`'${match[2]}'`) || portable.includes(`\`${match[2]} (`), `${entry.portable} exists`);
  }
});
