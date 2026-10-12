'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  countIssueItems,
  checkCoverage,
  checkIds,
  checkIssueCoverage,
} = require('./coverage');
const {
  criterion,
  report,
  ISSUE_MD,
  CI_ABSENCE_SPEC_ITEMS,
} = require('./test-helpers');

test('countIssueItems counts top-level items and prose Test Requirement', () => {
  assert.strictEqual(countIssueItems(ISSUE_MD), 5);
});

test('countIssueItems counts Test Requirement bullets individually', () => {
  const markdown = '## Test Requirement\n- a.spec.js\n- b.spec.js\n';
  assert.strictEqual(countIssueItems(markdown), 2);
});

test('checkCoverage reports a report with fewer entries than issue items', () => {
  const short = JSON.parse(
    report({ criteria: [criterion('PASS', 'a'), criterion('PASS', 'b')] }),
  );
  const problems = checkCoverage(short, ISSUE_MD);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('report covers 2 of 5 issue items'));
});

test('checkCoverage accepts as many or more entries than issue items', () => {
  const texts = ['a', 'b', 'c', 'd', 'e', 'f'];
  const full = JSON.parse(
    report({ criteria: texts.map((text) => criterion('PASS', text)) }),
  );
  assert.deepStrictEqual(checkCoverage(full, ISSUE_MD), []);
});

test('legacy report with empty ids uses count coverage, not id matching', () => {
  const legacy = { format: 'legacy', problems: [], items: [] };
  const short = JSON.parse(
    report({ criteria: [criterion('PASS', 'a'), criterion('PASS', 'b')] }),
  );
  const problems = checkIssueCoverage(short, {
    spec: legacy,
    issueMarkdown: ISSUE_MD,
  });
  assert.deepStrictEqual(problems, [
    'report covers 2 of 5 issue items ' +
      '(Acceptance Criteria, Definition of Done, Test Requirement)',
  ]);
  const texts = ['a', 'b', 'c', 'd', 'e'];
  const full = JSON.parse(
    report({ criteria: texts.map((text) => criterion('PASS', text)) }),
  );
  assert.deepStrictEqual(
    checkIssueCoverage(full, { spec: legacy, issueMarkdown: ISSUE_MD }),
    [],
  );
});

test('a model report without ci/absence entries does not fail on missing id', () => {
  const raw = report({
    criteria: [criterion('PASS', 'model text AC-1', { id: 'AC-1' })],
  });
  const problems = checkIds(JSON.parse(raw), CI_ABSENCE_SPEC_ITEMS);
  assert.deepStrictEqual(problems, []);
});
