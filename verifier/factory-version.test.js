'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  readFactoryTag,
  readFactoryTagFile,
  checkTagMatchesSha,
  parseArgs,
} = require('./factory-version.js');

const SCRIPT = path.join(__dirname, 'factory-version.js');
const REPO = 'github:factory-owner/dark-factory';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const withFactory = (spec, field = 'dependencies') => ({
  name: 'consumer',
  [field]: { 'left-pad': '^1.3.0', 'dark-factory': spec },
});

const tempPackage = (t, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, content);
  return file;
};

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('reads factory tag from default branch package.json', (t) => {
  assert.equal(readFactoryTag(withFactory(`${REPO}#v1.2.3`)), 'v1.2.3');
  assert.equal(
    readFactoryTag(withFactory('git+https://github.com/factory-owner/dark-factory.git#v0.10.0')),
    'v0.10.0',
  );
  assert.equal(readFactoryTag(withFactory(`${REPO}#v2.0.1`, 'devDependencies')), 'v2.0.1');

  const file = tempPackage(t, `﻿${JSON.stringify(withFactory(`${REPO}#v1.2.3`))}`);
  assert.equal(readFactoryTagFile(file), 'v1.2.3');
  const cli = run(['tag', '--package', file]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, 'v1.2.3\n');
});

test('rejects floating factory reference', (t) => {
  const floating = [
    `${REPO}#main`,
    `${REPO}#release-candidate`,
    `${REPO}#semver:^1.0.0`,
    `${REPO}#${SHA_A}`,
    `${REPO}#v1.2`,
    `${REPO}#`,
    REPO,
    'latest',
    '^1.2.3',
    '1.2.3',
  ];
  for (const spec of floating) {
    assert.throws(
      () => readFactoryTag(withFactory(spec)),
      /floating factory reference/,
      `spec ${spec} must be rejected`,
    );
  }

  const file = tempPackage(t, JSON.stringify(withFactory(`${REPO}#main`)));
  const cli = run(['tag', '--package', file]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /floating factory reference .*#main/);
});

test('rejects tag not matching wrapper sha', () => {
  assert.doesNotThrow(() =>
    checkTagMatchesSha({ tag: 'v1.2.3', tagSha: SHA_A, wrapperSha: SHA_A }),
  );
  assert.throws(
    () => checkTagMatchesSha({ tag: 'v1.2.3', tagSha: SHA_A, wrapperSha: SHA_B }),
    (error) =>
      error instanceof Error &&
      error.message.includes('v1.2.3') &&
      error.message.includes(SHA_A) &&
      error.message.includes(SHA_B),
  );

  const cli = run(['check', '--tag', 'v1.2.3', '--tag-sha', SHA_A, '--wrapper-sha', SHA_B]);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /v1\.2\.3/);
  assert.ok(cli.stderr.includes(SHA_A) && cli.stderr.includes(SHA_B), cli.stderr);
  assert.equal(
    run(['check', '--tag', 'v1.2.3', '--tag-sha', SHA_A, '--wrapper-sha', SHA_A]).status,
    0,
  );
});

test('rejects a wrapper ref that is not a full commit SHA', () => {
  for (const wrapperSha of ['main', 'v1.2.3', SHA_A.slice(0, 7), SHA_A.toUpperCase(), '']) {
    assert.throws(
      () => checkTagMatchesSha({ tag: 'v1.2.3', tagSha: SHA_A, wrapperSha }),
      /not a full 40-character commit SHA/,
    );
  }
  assert.throws(
    () => checkTagMatchesSha({ tag: 'v1.2.3', tagSha: 'v1.2.3', wrapperSha: SHA_A }),
    /not a full commit SHA/,
  );
});

test('fails when factory dependency is missing', (t) => {
  assert.throws(
    () => readFactoryTag({ name: 'consumer', dependencies: { 'left-pad': '^1.3.0' } }),
    /no "dark-factory" dependency/,
  );
  assert.throws(() => readFactoryTag({ name: 'consumer' }), /no "dark-factory" dependency/);
  assert.throws(() => readFactoryTag([]), /not a JSON object/);

  const file = tempPackage(t, JSON.stringify({ name: 'consumer' }));
  const cli = run(['tag', '--package', file]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /no "dark-factory" dependency/);

  const missing = run(['tag', '--package', path.join(path.dirname(file), 'absent.json')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
});

test('rejects two different pins of the factory', () => {
  const packageJson = {
    dependencies: { 'dark-factory': `${REPO}#v1.0.0` },
    devDependencies: { 'dark-factory': `${REPO}#v1.1.0` },
  };
  assert.throws(() => readFactoryTag(packageJson), /pins "dark-factory" twice/);
});

test('parses only complete commands', () => {
  assert.deepEqual(parseArgs(['tag', '--package', 'p.json']), {
    command: 'tag',
    packageFile: 'p.json',
  });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['tag']), null);
  assert.equal(parseArgs(['constructor', '--package', 'p.json']), null);
  assert.equal(parseArgs(['check', '--tag', 'v1.0.0', '--tag-sha', SHA_A]), null);
  assert.equal(parseArgs(['tag', '--package', '--tag']), null);
  assert.equal(run([]).status, 2);
});
