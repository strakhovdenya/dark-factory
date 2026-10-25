'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  readFactoryTag,
  readFactoryTagFile,
  checkTagMatchesSha,
  verifyPin,
  parseArgs,
} = require('./factory-version.js');

const SCRIPT = path.join(__dirname, 'factory-version.js');
const REPOSITORY = 'factory-owner/dark-factory';
const REPO = `github:${REPOSITORY}`;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const withFactory = (spec, field = 'dependencies') => ({
  name: 'consumer',
  [field]: { 'left-pad': '^1.3.0', 'dark-factory': spec },
});

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const tempPackage = (t, content) => {
  const file = path.join(tempDir(t), 'package.json');
  fs.writeFileSync(file, content);
  return file;
};

const git = (dir, ...args) =>
  execFileSync(
    'git',
    [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
      '-C', dir, ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

// A local "factory" origin with tag v1.0.0 on its first commit and a second
// commit after it, and a clone of it standing in for the workflow checkout.
const factoryRepos = (t) => {
  const root = tempDir(t);
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', 'a.txt');
  git(origin, 'commit', '--quiet', '-m', 'first');
  git(origin, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  const tagged = git(origin, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(origin, 'b.txt'), 'b\n');
  git(origin, 'add', 'b.txt');
  git(origin, 'commit', '--quiet', '-m', 'second');
  const later = git(origin, 'rev-parse', 'HEAD');
  const checkout = path.join(root, 'checkout');
  execFileSync('git', ['clone', '--quiet', '--no-tags', origin, checkout], { stdio: 'ignore' });
  return { checkout, tagged, later };
};

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const verifyArgs = (packageFile, factoryDir, wrapperSha) => [
  'verify',
  '--package', packageFile,
  '--repository', REPOSITORY,
  '--factory-dir', factoryDir,
  '--wrapper-sha', wrapperSha,
];

test('reads factory tag from default branch package.json', (t) => {
  assert.equal(readFactoryTag(withFactory(`${REPO}#v1.2.3`)), 'v1.2.3');
  assert.equal(readFactoryTag(withFactory(`${REPO}#v2.0.1`, 'devDependencies')), 'v2.0.1');
  const sources = [
    `${REPO}#v0.10.0`,
    `${REPOSITORY}#v0.10.0`,
    `git+https://github.com/${REPOSITORY}.git#v0.10.0`,
    `https://github.com/${REPOSITORY}#v0.10.0`,
    `git+ssh://git@github.com/${REPOSITORY}.git#v0.10.0`,
    `git@github.com:${REPOSITORY}.git#v0.10.0`,
    'github:Factory-Owner/Dark-Factory#v0.10.0',
  ];
  for (const spec of sources) {
    assert.equal(readFactoryTag(withFactory(spec), { repository: REPOSITORY }), 'v0.10.0', spec);
  }

  const file = tempPackage(t, `﻿${JSON.stringify(withFactory(`${REPO}#v1.2.3`))}`);
  assert.equal(readFactoryTagFile(file, { repository: REPOSITORY }), 'v1.2.3');
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
  const cli = run(verifyArgs(file, tempDir(t), SHA_A));
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /floating factory reference .*#main/);
});

test('rejects a factory dependency from another repository', () => {
  for (const spec of [
    'github:someone/dark-factory-fork#v1.2.3',
    'github:someone/dark-factory#v1.2.3',
    'https://example.com/factory-owner/dark-factory.git#v1.2.3',
  ]) {
    assert.throws(
      () => readFactoryTag(withFactory(spec), { repository: REPOSITORY }),
      /does not install from factory-owner\/dark-factory/,
      spec,
    );
  }
});

test('rejects tag not matching wrapper sha', (t) => {
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

  const { checkout, tagged, later } = factoryRepos(t);
  const file = tempPackage(t, JSON.stringify(withFactory(`${REPO}#v1.0.0`)));
  const mismatch = run(verifyArgs(file, checkout, later));
  assert.equal(mismatch.status, 1);
  assert.ok(
    ['v1.0.0', tagged, later].every((part) => mismatch.stderr.includes(part)),
    mismatch.stderr,
  );

  const match = run(verifyArgs(file, checkout, tagged));
  assert.equal(match.status, 0, match.stderr);
  assert.equal(match.stdout, `factory pin: v1.0.0 (${tagged})\n`);
});

test('fails when the pinned tag does not exist in the factory', (t) => {
  const { checkout, tagged } = factoryRepos(t);
  const file = tempPackage(t, JSON.stringify(withFactory(`${REPO}#v9.9.9`)));
  assert.throws(
    () =>
      verifyPin({ packageFile: file, repository: REPOSITORY, factoryDir: checkout, wrapperSha: tagged }),
    /factory tag v9\.9\.9 cannot be resolved in factory-owner\/dark-factory/,
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
  const cli = run(verifyArgs(file, tempDir(t), SHA_A));
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /no "dark-factory" dependency/);

  const missing = run(verifyArgs(path.join(path.dirname(file), 'absent.json'), tempDir(t), SHA_A));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not readable JSON/);
});

test('rejects two different pins of the factory', () => {
  const packageJson = {
    dependencies: { 'dark-factory': `${REPO}#v1.0.0` },
    devDependencies: { 'dark-factory': `${REPO}#v1.1.0` },
  };
  assert.throws(() => readFactoryTag(packageJson), /pins "dark-factory" twice/);
});

test('parses only complete verify commands', () => {
  const args = verifyArgs('p.json', 'factory', SHA_A);
  assert.deepEqual(parseArgs(args), {
    packageFile: 'p.json',
    repository: REPOSITORY,
    factoryDir: 'factory',
    wrapperSha: SHA_A,
  });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['tag', ...args.slice(1)]), null);
  assert.equal(parseArgs(args.slice(0, -2)), null);
  assert.equal(parseArgs([...args, 'constructor', 'x']), null);
  assert.equal(parseArgs([...args, '__proto__', 'x']), null);
  assert.equal(parseArgs(['verify', '--package', '--repository']), null);
  assert.equal(run([]).status, 2);
});

// Origin with two releases: v1.0.0 and v1.1.0 (a later commit).
const upgradeRepos = (t) => {
  const { checkout, tagged, later } = factoryRepos(t);
  const origin = path.join(path.dirname(checkout), 'origin');
  git(origin, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0', later);
  return { checkout, oldSha: tagged, newSha: later };
};

const pinFile = (t, tag) => tempPackage(t, JSON.stringify(withFactory(`${REPO}#${tag}`)));

const upgradeArgs = (trusted, head, checkout, wrapperSha) => [
  ...verifyArgs(trusted, checkout, wrapperSha),
  '--head-package', head,
];

test('accepts a pin moved together with the wrapper', (t) => {
  const { checkout, oldSha, newSha } = upgradeRepos(t);
  const trusted = pinFile(t, 'v1.0.0');
  const head = pinFile(t, 'v1.1.0');
  const upgrade = run(upgradeArgs(trusted, head, checkout, newSha));
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.equal(upgrade.stdout, `factory pin: v1.1.0 (${newSha})\n`);

  const unchanged = run(upgradeArgs(trusted, trusted, checkout, oldSha));
  assert.equal(unchanged.status, 0, unchanged.stderr);
  const unmoved = run(upgradeArgs(trusted, trusted, checkout, newSha));
  assert.equal(unmoved.status, 1, 'a head that keeps the pin still needs the anchor SHA');
});

test('rejects a wrapper SHA changed without the tag', (t) => {
  const { checkout, oldSha, newSha } = upgradeRepos(t);
  const trusted = pinFile(t, 'v1.0.0');
  const result = run(upgradeArgs(trusted, trusted, checkout, newSha));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /factory pin mismatch/);
  assert.ok([oldSha, newSha].every((sha) => result.stderr.includes(sha)), result.stderr);
});

test('rejects a tag changed without the wrapper SHA', (t) => {
  const { checkout, oldSha } = upgradeRepos(t);
  const trusted = pinFile(t, 'v1.0.0');
  const head = pinFile(t, 'v1.1.0');
  const result = run(upgradeArgs(trusted, head, checkout, oldSha));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /factory pin mismatch: tag v1.1.0/);
});

test('rejects an upgrade head with a floating or foreign pin, or a broken anchor', (t) => {
  const { checkout, newSha } = upgradeRepos(t);
  const trusted = pinFile(t, 'v1.0.0');
  const floating = pinFile(t, 'main');
  assert.match(run(upgradeArgs(trusted, floating, checkout, newSha)).stderr, /floating factory reference/);
  const foreign = tempPackage(t, JSON.stringify(withFactory('github:someone/dark-factory#v1.1.0')));
  assert.match(run(upgradeArgs(trusted, foreign, checkout, newSha)).stderr, /does not install from/);
  const head = pinFile(t, 'v1.1.0');
  assert.match(run(upgradeArgs(floating, head, checkout, newSha)).stderr, /floating factory reference/);
});
