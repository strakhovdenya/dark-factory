'use strict';

// Keeps the record of the Docker scenarios of the reference controller suites honest: each one
// names a test that exists in its verbatim source snapshot, stays "not-run" until the integration
// task, and a named portable counterpart exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'ralph-controller');
const { cases } = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'integration-cases.json'), 'utf8'));

test('docker scenarios of the reference suites are recorded and never claimed as passed', () => {
  assert.ok(cases.length > 0);
  for (const entry of cases) {
    const source = fs.readFileSync(path.join(FIXTURE_DIR, 'source', entry.source), 'utf8');
    assert.ok(source.includes(`test('${entry.test}'`), `${entry.source}: no test "${entry.test}"`);
    assert.ok(entry.assertions.length > 0, entry.test);
    assert.equal(entry.status, 'not-run', entry.test);
    if (entry.portable === null) continue;
    const match = /^(\S+) "([^"]+)"$/.exec(entry.portable);
    assert.ok(match, entry.portable);
    const portable = fs.readFileSync(path.join(__dirname, '..', match[1]), 'utf8');
    assert.ok(portable.includes(`'${match[2]}'`) || portable.includes(`\`${match[2]} (`), `${entry.portable} exists`);
  }
});
