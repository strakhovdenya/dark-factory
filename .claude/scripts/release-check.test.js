'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkRelease, checkRepository, extractNotes } =require('./release-check');

const pkg = (version) => JSON.stringify({ name: 'dark-factory', version });
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-12\n\n- First release\n';

test('accepts tag matching version with changelog section', () => {
  assert.deepEqual(checkRelease('v0.1.0', pkg('0.1.0'), CHANGELOG), []);
});

test('rejects tag not matching package version', () => {
  const changelog = `${CHANGELOG}\n## [0.2.0]\n`;
  const errors = checkRelease('v0.2.0', pkg('0.1.0'), changelog);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('v0.2.0') && errors[0].includes('0.1.0'), errors[0]);
});

test('rejects missing changelog section', () => {
  const errors = checkRelease('v0.3.0', pkg('0.3.0'), CHANGELOG);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('## [0.3.0]'), errors[0]);
});

test('rejects malformed tag', () => {
  for (const tag of ['release-1', 'v1.0', '0.1.0', 'v0.1.0-rc1', 'v01.2.3', '', undefined]) {
    const errors = checkRelease(tag, pkg('0.1.0'), CHANGELOG);
    assert.equal(errors.length, 1, String(tag));
    assert.ok(errors[0].includes('vX.Y.Z'), errors[0]);
  }
});

test('rejects changelog without bracketed version heading', () => {
  for (const changelog of ['## 0.1.0\n', '## [Unreleased]\n', '## [0.1.01]\n', '## [10.1.0]\n']) {
    const errors = checkRelease('v0.1.0', pkg('0.1.0'), changelog);
    assert.equal(errors.length, 1, changelog);
    assert.ok(errors[0].includes('## [0.1.0]'), errors[0]);
  }
});

test('extracts only the section of the requested version as release notes', () => {
  const changelog = '## [Unreleased]\n\nnext\n\n## [0.2.0] - d\n\n- two\n\n## [0.1.0] - d\r\n\r\n- one\r\n';
  assert.equal(extractNotes(changelog, '0.2.0'), '- two');
  assert.equal(extractNotes(changelog, '0.1.0'), '- one');
  assert.equal(extractNotes(changelog, '0.3.0'), '');
});

test('rejects invalid package.json', () => {
  const errors = checkRelease('v0.1.0', '{', CHANGELOG);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('package.json'), errors[0]);
});

test('accepts the repository package.json and CHANGELOG.md for the current version', () => {
  const root = path.resolve(__dirname, '..', '..');
  const { version } = require(path.join(root, 'package.json'));
  assert.deepEqual(checkRepository(root, `v${version}`), []);
});
