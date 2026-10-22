'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { issueNumberOfBranch, branchNameFor, slugify, MAX_SLUG_LENGTH, parseArgs } = require('./branch');

const SCRIPT = path.join(__dirname, 'branch.js');
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'profiles');
const FIXTURE_PROFILES = ['monorepo', 'single-package'];

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

for (const fixture of FIXTURE_PROFILES) {
  test(`reads the issue number of a task branch from the profile template (${fixture})`, () => {
    const project = path.join(FIXTURES, fixture);
    const task = run(['--project', project, '--branch', 'task/ISSUE-42-add-thing']);
    assert.equal(task.status, 0, task.stderr);
    assert.equal(task.stdout, '42\n');

    for (const branch of ['main', 'dependabot/npm_and_yarn/x', 'task/ISSUE-x-y', 'task/ISSUE-7-']) {
      const other = run(['--project', project, '--branch', branch]);
      assert.equal(other.status, 0, other.stderr);
      assert.equal(other.stdout, '', branch);
    }
  });
}

test('matches template text literally', () => {
  assert.equal(issueNumberOfBranch('fix.{issue}+{slug}', 'fix.12+a-b'), 12);
  assert.equal(issueNumberOfBranch('fix.{issue}+{slug}', 'fixX12+a-b'), null);
  assert.equal(issueNumberOfBranch('fix.{issue}+{slug}', 'fix.12a-b'), null);
  assert.equal(issueNumberOfBranch('[{issue}]', '[5]'), 5);
  assert.equal(issueNumberOfBranch('issue-{issue}', 'issue-5-extra'), null);
  assert.equal(issueNumberOfBranch('b/{issue}', 'b/7'), 7);
});

test('a repeated issue placeholder must repeat the same number', () => {
  assert.equal(issueNumberOfBranch('{issue}/{slug}-{issue}', '3/x-3'), 3);
  assert.equal(issueNumberOfBranch('{issue}/{slug}-{issue}', '3/x-4'), null);
});

test('rejects a template without an issue placeholder', () => {
  assert.throws(() => issueNumberOfBranch('task/{slug}', 'task/x'), /no \{issue\} placeholder/);
});

test('fails closed on an invalid profile', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = run(['--project', root, '--branch', 'task/ISSUE-1-a']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');

  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory', 'profile.json'), '{"apps": []}');
  const invalid = run(['--project', root, '--branch', 'task/ISSUE-1-a']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});

test('parses only complete arguments', () => {
  assert.deepEqual(parseArgs(['--project', '.', '--branch', 'b']), { project: '.', branch: 'b' });
  assert.equal(parseArgs(['--project', '.']), null);
  assert.equal(parseArgs(['--project', '.', '--branch']), null);
  assert.equal(parseArgs(['--project', '.', '--other', 'x', '--branch', 'b']), null);
  assert.equal(run([]).status, 2);
});

test('builds branch name from template', () => {
  const templates = ['task/ISSUE-{issue}-{slug}', 'fix.{issue}+{slug}', '[{issue}]/{slug}', 'b/{issue}'];
  for (const template of templates) {
    const name = branchNameFor(template, 42, 'Add Thing (v2)');
    assert.equal(issueNumberOfBranch(template, name), 42, name);
  }
  assert.equal(branchNameFor('fix.{issue}+{slug}', 42, 'Add Thing (v2)'), 'fix.42+add-thing-v2');
  assert.equal(branchNameFor('task/ISSUE-{issue}-{slug}', 7, 'Hello, World!'), 'task/ISSUE-7-hello-world');
});

test('normalizes slug for empty or long titles', () => {
  const template = 'task/ISSUE-{issue}-{slug}';
  for (const title of ['', '!!!', 'Только кириллица', null]) {
    const name = branchNameFor(template, 3, title);
    assert.equal(name, 'task/ISSUE-3-issue', String(title));
    assert.equal(issueNumberOfBranch(template, name), 3);
  }
  const long = `${'a'.repeat(49)} ${'b'.repeat(30)}`;
  const slug = slugify(long);
  assert.equal(slug, 'a'.repeat(49));
  assert.ok(slug.length <= MAX_SLUG_LENGTH);
  const exact = slugify('x'.repeat(80));
  assert.equal(exact.length, MAX_SLUG_LENGTH);
  const name = branchNameFor(template, 9, long);
  assert.ok(!name.endsWith('-'));
  assert.equal(issueNumberOfBranch(template, name), 9);
});

test('rejects a template that cannot recognize its own branch', () => {
  assert.throws(() => branchNameFor('{issue}{slug}', 12, '3 apples'), /does not recognize/);
  assert.throws(() => branchNameFor('task/{slug}', 1, 'x'), /no \{issue\} placeholder/);
});
