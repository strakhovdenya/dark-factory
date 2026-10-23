'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkPackageLayout, checkRepository } = require('./package-layout');

const GOOD = ['bin/', 'doctor/', 'skills/', 'agents/', 'hooks/', 'profile/', 'verifier/', 'judge/', 'ralph/'];

const SCRIPTS = { test: 'node --test "bin/**/*.test.js" "doctor/**/*.test.js"' };

test('accepts files field of the repository package.json', () => {
  assert.deepEqual(checkRepository(path.resolve(__dirname, '..', '..')), []);
});

test('rejects files entry under .claude or .factory', () => {
  for (const bad of ['.claude', '.claude/scripts/', './.factory/']) {
    const errors = checkPackageLayout({ files: [...GOOD, bad], scripts: SCRIPTS });
    assert.equal(errors.length, 1, bad);
    assert.ok(errors[0].includes(`"${bad}"`), errors[0]);
  }
});

test('rejects files field missing a package directory', () => {
  for (const dir of ['bin', 'doctor', 'skills', 'agents', 'hooks', 'profile', 'verifier', 'judge', 'ralph']) {
    const files = GOOD.filter((entry) => entry !== `${dir}/`);
    const errors = checkPackageLayout({ files, scripts: SCRIPTS });
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

test('npm test runs portable ralph tests and no real integrations', () => {
  const pkg = require('../../package.json');
  assert.ok(pkg.scripts.test.includes('"ralph/**/*.test.js"'), 'ralph tests are in the test glob');
  assert.ok(!pkg.scripts.test.includes('test/integration'), 'Docker integrations are not run by npm test');
  assert.ok(pkg.files.includes('ralph/'));
  const tsconfig = require('../../tsconfig.json');
  assert.ok(tsconfig.include.includes('ralph/**/*.js'), 'tsconfig checks ralph, proxy.js included');
});

test('ralph controller modules ship with their runtime dependency', () => {
  const pkg = require('../../package.json');
  assert.ok(pkg.dependencies.minimatch, 'profile/path-patterns.js needs minimatch at runtime');
  assert.ok(pkg.scripts.test.includes('"ralph/**/*.test.js"'), 'tests of ralph and its subdirectories');
});

test('requires setup payload and automated checks', () => {
  const pkg = { files: GOOD, scripts: { test: 'node --test "bin/**/*.test.js" "doctor/**/*.test.js" "ralph/**/*.test.js"' } };
  const tsconfig = { include: ['bin/**/*.js', 'doctor/**/*.js', 'ralph/**/*.js'] };
  assert.deepEqual(checkPackageLayout(pkg, tsconfig), []);

  const withoutBin = checkPackageLayout({ ...pkg, files: GOOD.filter((entry) => entry !== 'bin/') }, tsconfig);
  assert.equal(withoutBin.length, 1);
  assert.ok(withoutBin[0].includes('"bin/"'), withoutBin[0]);

  const withoutTests = checkPackageLayout({ ...pkg, scripts: { test: 'node --test "ralph/**/*.test.js"' } }, tsconfig);
  assert.equal(withoutTests.length, 2);
  assert.ok(withoutTests[0].includes('bin/**/*.test.js'), withoutTests[0]);
  assert.ok(withoutTests[1].includes('doctor/**/*.test.js'), withoutTests[1]);

  const withoutTypecheck = checkPackageLayout(pkg, { include: ['ralph/**/*.js'] });
  assert.equal(withoutTypecheck.length, 2);
  assert.ok(withoutTypecheck[0].includes('bin/**/*.js'), withoutTypecheck[0]);
  assert.ok(withoutTypecheck[1].includes('doctor/**/*.js'), withoutTypecheck[1]);

  const withoutDoctor = checkPackageLayout({ ...pkg, files: GOOD.filter((entry) => entry !== 'doctor/') }, tsconfig);
  assert.equal(withoutDoctor.length, 1);
  assert.ok(withoutDoctor[0].includes('"doctor/"'), withoutDoctor[0]);
});
