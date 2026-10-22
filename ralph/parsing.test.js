'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  changedFilePathsFromPorcelain,
  hasCodeChanges,
  parseVerdict,
  parseReviewVerdict,
  parseCodeReviewVerdict,
  extractAcceptanceCriteriaItems,
  extractAffectsSection,
  parseAcceptanceCriteriaSelfReport,
  reconcileAcceptanceCriteria,
  summarizeSelfReportedCoverage,
} = require('./parsing');
const { gitPorcelainStatus } = require('./github');
const { issueNumberOfBranch, branchNameFor } = require('../profile/branch');
const { isolateGit, gitIn, tempDir } = require('../test/helpers/ralph');

test('returns no paths for empty status', () => {
  assert.deepEqual(changedFilePathsFromPorcelain(''), []);
  assert.equal(hasCodeChanges('', ['**/*.md']), false);
});

test('parses -z status with renames, spaces and untracked directories', (t) => {
  isolateGit(t);
  const dir = tempDir(t);
  gitIn(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'old-name.js'), 'const value = 1;\n');
  fs.writeFileSync(path.join(dir, 'kept.js'), 'const kept = 1;\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'init');
  gitIn(dir, 'mv', 'old-name.js', 'new-name.js');
  fs.writeFileSync(path.join(dir, 'kept.js'), 'const kept = 2;\n');
  fs.writeFileSync(path.join(dir, 'файл с пробелом.md'), 'text\n');
  fs.mkdirSync(path.join(dir, 'fresh-dir'));
  fs.writeFileSync(path.join(dir, 'fresh-dir', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'fresh-dir', 'b.js'), 'b\n');
  const paths = changedFilePathsFromPorcelain(gitPorcelainStatus({ cwd: dir }));
  assert.deepEqual([...paths].sort(), ['fresh-dir/a.js', 'fresh-dir/b.js', 'kept.js', 'new-name.js', 'файл с пробелом.md']);
  assert.deepEqual(changedFilePathsFromPorcelain(' M package.json\0'), ['package.json']);
});

test('classifies doc-only diff by every changed path', () => {
  const patterns = ['**/*.md', '**/docs/'];
  assert.equal(hasCodeChanges(' M README.md\0?? docs/new.txt\0?? pkg/docs/deep/x.png\0', patterns), false);
  assert.equal(hasCodeChanges(' M README.md\0 M src/app.js\0', patterns), true);
  assert.equal(hasCodeChanges('R  docs/moved.js\0src/moved.js\0', patterns), true, 'a rename of code into a doc directory');
  assert.equal(hasCodeChanges(' D src/old.js\0 M README.md\0', patterns), true, 'a deleted code file');
  assert.equal(hasCodeChanges(' M assets/logo.png\0 M README.md\0', patterns), true, 'a binary file outside doc patterns');
  assert.equal(hasCodeChanges(' M README.MD\0', patterns), true, 'case-sensitive');
  assert.equal(hasCodeChanges(' M README.md\0', []), true, 'no patterns: nothing is doc-only');
});

test('matches profile verdict and branch literally', () => {
  const verdict = 'NEEDS.HUMAN+';
  assert.deepEqual(parseVerdict('work\nNEEDS.HUMAN+: owner must decide\n', verdict), { kind: 'human-needed', reason: 'owner must decide' });
  for (const other of ['NEEDSXHUMAN+: x', 'NEEDS.HUMANN: x', 'NEEDS.HUMAN: x', 'xNEEDS.HUMAN+: x']) {
    assert.equal(parseVerdict(`${other}\n`, verdict).kind, 'unknown', other);
  }
  assert.equal(parseVerdict('NEEDS.HUMAN+: x\n', undefined).kind, 'unknown', 'no verdict configured, nothing assumed');
  assert.equal(parseVerdict('BLOCKED: plain\n', verdict).kind, 'blocked');

  const template = 'fix.{issue}+{slug}';
  assert.equal(issueNumberOfBranch(template, branchNameFor(template, 12, 'Hello')), 12);
  for (const foreign of ['fixX12+hello', 'fix.12hello', 'fix.12+', 'task/ISSUE-12-hello']) {
    assert.equal(issueNumberOfBranch(template, foreign), null, foreign);
  }
});

test('the last sentinel wins, emphasis is ignored', () => {
  const output = 'BLOCKED: maybe later\n**DONE**\nTYPE: fix\nSUMMARY: did it\n';
  assert.deepEqual(parseVerdict(output, 'HUMAN'), { kind: 'done', type: 'fix', summary: 'did it' });
  assert.equal(parseReviewVerdict('REVIEW: PASS\nREVIEW: FAIL: x').kind, 'fail');
  assert.equal(parseCodeReviewVerdict('CODEREVIEW: PASS-OUT-OF-SCOPE: a.js:1').kind, 'pass-out-of-scope');
});

test('reads sections by contract names and reconciles the self-report', () => {
  const body = '## Context\nx\n## Affects\n- `a.js`\n## Acceptance Criteria\n- [ ] AC-1 one\n- [x] AC-2 two\n## Dependencies\n- [ ] not an AC\n';
  assert.match(extractAffectsSection(body), /a\.js/);
  const items = extractAcceptanceCriteriaItems(body);
  assert.deepEqual(items, ['AC-1 one', 'AC-2 two']);
  const report = parseAcceptanceCriteriaSelfReport('=== ACCEPTANCE CRITERIA SELF-REPORT ===\n1. COVERED: a\n2. NOT VERIFIED: b\n=== END ACCEPTANCE CRITERIA SELF-REPORT ===');
  assert.equal(reconcileAcceptanceCriteria(items, report).allCovered, false);
  assert.deepEqual(summarizeSelfReportedCoverage(items, report), { covered: 1, total: 2 });
});
