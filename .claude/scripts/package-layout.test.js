'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkPackageLayout, checkRepository } = require('./package-layout');

const GOOD = ['skills/', 'agents/', 'hooks/', 'profile/', 'verifier/', 'judge/'];

test('accepts files field of the repository package.json', () => {
  assert.deepEqual(checkRepository(path.resolve(__dirname, '..', '..')), []);
});

test('rejects files entry under .claude or .factory', () => {
  for (const bad of ['.claude', '.claude/scripts/', './.factory/']) {
    const errors = checkPackageLayout({ files: [...GOOD, bad] });
    assert.equal(errors.length, 1, bad);
    assert.ok(errors[0].includes(`"${bad}"`), errors[0]);
  }
});

test('rejects files field missing a package directory', () => {
  for (const dir of ['skills', 'agents', 'hooks', 'profile', 'verifier', 'judge']) {
    const files = GOOD.filter((entry) => entry !== `${dir}/`);
    const errors = checkPackageLayout({ files });
    assert.equal(errors.length, 1, dir);
    assert.ok(errors[0].includes(`"${dir}/"`), errors[0]);
  }
});

test('rejects missing or non-array files field', () => {
  for (const pkg of [{}, { files: 'skills/' }, { files: null }]) {
    const errors = checkPackageLayout(pkg);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"files"'), errors[0]);
  }
});
