'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findLiterals, formatFinding } = require('./core-literals');

const PKG_FILES = ['skills/', 'agents/', 'hooks/', 'profile/'];

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Creates a temporary git repo; `untracked` files are written but not added. */
function makeRepo(t, files, { pkgFiles = PKG_FILES, untracked = {}, pkgExtra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-literals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  const all = { 'package.json': JSON.stringify({ files: pkgFiles, ...pkgExtra }), ...files };
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  for (const [rel, content] of Object.entries(all)) write(rel, content);
  git(dir, 'add', '-A');
  for (const [rel, content] of Object.entries(untracked)) write(rel, content);
  return dir;
}

test('reports project literal in core file', (t) => {
  const dir = makeRepo(t, { 'hooks/example.js': 'const a = 1;\nconst p = "apps/api";\n' });
  const findings = findLiterals(dir);
  assert.deepEqual(findings, [{ file: 'hooks/example.js', line: 2, literal: 'apps/api' }]);
  assert.equal(formatFinding(findings[0]), 'hooks/example.js:2: project literal "apps/api"');
});

test('ignores literals outside package directories', (t) => {
  const profile = '{"path":"apps/api"}';
  const dir = makeRepo(t, {
    'test/fixtures/profiles/x/.factory/profile.json': profile,
    'examples/profiles/x/.factory/profile.json': profile,
    'CLAUDE.md': 'jobflow and cards are consumers\n',
  });
  assert.deepEqual(findLiterals(dir), []);
});

test('scans directories taken from package files field', (t) => {
  const dir = makeRepo(t, { 'verifier/check.js': 'use prisma\n' }, { pkgFiles: [...PKG_FILES, 'verifier/'] });
  assert.deepEqual(findLiterals(dir), [{ file: 'verifier/check.js', line: 1, literal: 'prisma' }]);
});

test('allows owner login only in package metadata', (t) => {
  const dir = makeRepo(
    t,
    { 'README.md': 'github.com/strakhovdenya/dark-factory\n', 'profile/load.js': '// strakhovdenya\n' },
    { pkgExtra: { repository: 'strakhovdenya/dark-factory' } },
  );
  assert.deepEqual(findLiterals(dir), [{ file: 'profile/load.js', line: 1, literal: 'strakhovdenya' }]);
});

test('repository core has no project literals', () => {
  const findings = findLiterals(path.resolve(__dirname, '..', '..'));
  assert.deepEqual(findings.map(formatFinding), []);
});

test('matches literals case-insensitively', (t) => {
  const dir = makeRepo(t, { 'skills/a.md': 'Uses Supabase here\n' });
  assert.deepEqual(findLiterals(dir), [{ file: 'skills/a.md', line: 1, literal: 'supabase' }]);
});

test('skips untracked files', (t) => {
  const dir = makeRepo(t, { 'hooks/tracked.js': 'jobflow\n' }, { untracked: { 'hooks/untracked.js': 'jobflow\n' } });
  assert.deepEqual(findLiterals(dir), [{ file: 'hooks/tracked.js', line: 1, literal: 'jobflow' }]);
});

test('does not match literal inside another word', (t) => {
  const dir = makeRepo(t, { 'hooks/a.js': 'discards scorecards cards2\nok apps/api/x\n' });
  assert.deepEqual(findLiterals(dir), [{ file: 'hooks/a.js', line: 2, literal: 'apps/api' }]);
});

test('reports every finding', (t) => {
  const dir = makeRepo(t, { 'hooks/a.js': 'prisma\ncards jobflow\n' });
  assert.equal(findLiterals(dir).length, 3);
});

test('fails instead of returning empty result without git or files field', (t) => {
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'core-literals-nogit-'));
  t.after(() => fs.rmSync(noGit, { recursive: true, force: true }));
  fs.writeFileSync(path.join(noGit, 'package.json'), JSON.stringify({ files: PKG_FILES }));
  assert.throws(() => findLiterals(noGit), /cannot list tracked files/);

  const noFiles = makeRepo(t, {});
  fs.writeFileSync(path.join(noFiles, 'package.json'), '{}');
  assert.throws(() => findLiterals(noFiles), /"files"/);
});
