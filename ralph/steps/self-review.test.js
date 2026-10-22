'use strict';

// The self-review step under the controller: its fix budget comes from the profile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { selfReview, reviewOutcome } = require('./self-review');
const { FIXTURE_PROFILES } = require('../../test/helpers/profiles');
const { BLOCK_LABEL } = require('../config');
const { APP_FILE, SELF_REPORT_FULL, done, scenario } = require('../../test/helpers/ralph');

test('maps review verdicts to step outcomes', () => {
  assert.deepEqual(reviewOutcome({ kind: 'pass' }), { kind: 'passed' });
  assert.deepEqual(reviewOutcome({ kind: 'fail', reason: 'x' }), { kind: 'failed', reason: 'x' });
  assert.deepEqual(reviewOutcome({ kind: 'pass-out-of-scope', reason: 'y' }), { kind: 'passed-out-of-scope', reason: 'y' });
  assert.deepEqual(reviewOutcome({ kind: 'unknown' }), { kind: 'unparseable' });
  assert.equal(selfReview.mode, 'read-only');
  assert.equal(selfReview.permissions, 'reviewer');
  assert.equal(selfReview.fix.permissions, 'implementer');
  assert.equal(selfReview.fix.budget, 2);
});

for (const fixture of FIXTURE_PROFILES) {
  test(`honours attempt budget from profile (${fixture})`, async (t) => {
    const run = await scenario(t, fixture, {
      mutate: (profile) => {
        profile.ralph.stepBudgets = { 'self-review': 4 };
      },
      onAgent: ({ pass, runDir }) => {
        if (pass === 'self-review') return 'REVIEW: FAIL: a.ts misses a check';
        if (pass === 'code-review') return 'CODEREVIEW: PASS';
        const file = path.join(runDir, APP_FILE[fixture]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `// ${pass}\n`);
        return done('feat', `${pass} summary`, SELF_REPORT_FULL(2));
      },
    });
    const passes = run.box.agents.map((agent) => agent.pass);
    assert.equal(passes.filter((pass) => pass === 'review-fix').length, 4);
    assert.equal(passes.filter((pass) => pass === 'self-review').length, 5);
    assert.equal(passes.filter((pass) => pass === 'code-review').length, 0);
    assert.equal(run.result.status, 'review_blocked');
    assert.match(run.result.reason, /after 4 fix attempt\(s\)/);
    assert.deepEqual(run.result.steps.at(-1), { name: 'self-review', outcome: 'failed' });
    assert.ok(run.labelsSet.includes(BLOCK_LABEL));
    assert.equal(run.prs.length, 0);
  });
}
