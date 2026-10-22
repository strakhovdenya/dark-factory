'use strict';

// Keeps the map of the reference sandbox suite honest: every source test is listed, every
// scenario that needs Docker stays "not run" until the integration task, and every portable
// destination names a test that exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'ralph-sandbox');
const cases = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'cases.json'), 'utf8'));
const sourceText = fs.readFileSync(path.join(FIXTURE_DIR, 'source', 'sandbox.test.js.txt'), 'utf8');
const portableText = fs.readFileSync(path.join(__dirname, 'sandbox.test.js'), 'utf8');

const sourceNames = [...sourceText.matchAll(/^test\('([^']+)'/gm)].map((match) => match[1]);

test('cases map lists every source test exactly once', () => {
  assert.equal(sourceNames.length, 26);
  assert.deepEqual(
    cases.cases.map((entry) => entry.source),
    sourceNames,
  );
});

test('cases keep assertions and never claim Docker scenarios passed', () => {
  for (const entry of cases.cases) {
    assert.ok(entry.assertions.length > 0, entry.source);
    assert.ok(['portable', 'integration', 'both'].includes(entry.destination), entry.source);
    if (entry.destination === 'portable') {
      assert.match(entry.status, /^ported/, entry.source);
    } else {
      assert.match(entry.status, /not-run/, entry.source);
      assert.doesNotMatch(entry.status, /^(passed|ported)$/, entry.source);
    }
    if (entry.destination === 'integration') assert.equal(entry.portable, null, entry.source);
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
