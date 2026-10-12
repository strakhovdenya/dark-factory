'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { RunFailure, applyMutation } = require('./golden-mutation');

const SCRIPT = path.join(__dirname, 'golden-mutation.js');
const WORKFLOW = path.join(
  __dirname,
  '..',
  '.github',
  'workflows',
  'acceptance-verifier-eval.yml',
);

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

const writeFile = (repo, name, content) => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
};

const commitAll = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

// base commit, then head commit that changes one file; the checkout is left
// at head, like the eval workflow's "case head (data only)" checkout.
const makeRepo = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-mutation-spec-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'spec@example.test');
  git(repo, 'config', 'user.name', 'spec');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFile(repo, 'keep.txt', 'one\ntwo\nthree\n');
  writeFile(repo, 'drop.txt', 'to be dropped\n');
  writeFile(repo, 'move.txt', 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
  const base = commitAll(repo, 'base');
  writeFile(repo, 'keep.txt', 'one\ntwo changed\nthree\n');
  const head = commitAll(repo, 'head');
  return { repo, base, head };
};

// Builds a patch by editing the head checkout, capturing the staged diff, and
// restoring the checkout, so the returned patch applies cleanly to head.
const makePatch = (repo, mutate) => {
  mutate(repo);
  git(repo, 'add', '-A');
  const patch = git(repo, 'diff', '--cached', '--binary', '-M');
  git(repo, 'reset', '-q', '--hard', 'HEAD');
  return patch + '\n';
};

const setup = (mutate) => {
  const fixture = makeRepo();
  const patchFile = path.join(fixture.repo, '..', `${path.basename(fixture.repo)}.patch`);
  fs.writeFileSync(patchFile, makePatch(fixture.repo, mutate));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-mutation-out-'));
  return { ...fixture, patchFile, outDir };
};

const run = ({ repo, base, head, patchFile, outDir }) =>
  applyMutation({ repo, base, head, patchFile, outDir });

const editKeep = (repo) => writeFile(repo, 'keep.txt', 'one\nMUTATED\nthree\n');

test('applies patch and rebuilds diff from base', () => {
  const fixture = setup(editKeep);
  run(fixture);
  const diff = fs.readFileSync(path.join(fixture.outDir, 'diff.patch'), 'utf8');
  assert.match(diff, /^\+MUTATED$/m);
  assert.match(diff, /^-two$/m);
  const baseToHead = git(fixture.repo, 'diff', `${fixture.base}...HEAD`);
  assert.notStrictEqual(diff, baseToHead);
  const worktree = fs.readFileSync(path.join(fixture.repo, 'keep.txt'), 'utf8');
  assert.strictEqual(worktree, 'one\nMUTATED\nthree\n');
});

test('lists files added by the patch', () => {
  const fixture = setup((repo) => {
    writeFile(repo, 'added.txt', 'brand new line\n');
    fs.rmSync(path.join(repo, 'drop.txt'));
    fs.renameSync(path.join(repo, 'move.txt'), path.join(repo, 'moved.txt'));
  });
  run(fixture);
  const files = fs.readFileSync(path.join(fixture.outDir, 'files.txt'), 'utf8');
  const lines = files.trim().split('\n');
  assert.ok(lines.some((line) => /^A\tadded\.txt$/.test(line)), files);
  assert.ok(lines.some((line) => /^D\tdrop\.txt$/.test(line)), files);
  assert.ok(
    lines.some((line) => /^R\d*\tmove\.txt\tmoved\.txt$/.test(line)),
    files,
  );
  const diff = fs.readFileSync(path.join(fixture.outDir, 'diff.patch'), 'utf8');
  assert.match(diff, /^\+brand new line$/m);
});

test('reports conflicting patch as run failure', () => {
  const fixture = setup(editKeep);
  const conflicting = fs
    .readFileSync(fixture.patchFile, 'utf8')
    .replace('-two', '-not in head');
  fs.writeFileSync(fixture.patchFile, conflicting);
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--repo', fixture.repo,
      '--base', fixture.base,
      '--head', fixture.head,
      '--patch', fixture.patchFile,
      '--out-dir', fixture.outDir,
    ],
    { encoding: 'utf8' },
  );
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /run failure/);
  assert.deepStrictEqual(fs.readdirSync(fixture.outDir), []);
  const worktree = fs.readFileSync(path.join(fixture.repo, 'keep.txt'), 'utf8');
  assert.strictEqual(worktree, 'one\ntwo changed\nthree\n');
});

test('records head sha patch hash and tree hash separately', () => {
  const fixture = setup(editKeep);
  const metadata = run(fixture);
  const written = JSON.parse(
    fs.readFileSync(path.join(fixture.outDir, 'mutation.json'), 'utf8'),
  );
  const expectedHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(fixture.patchFile))
    .digest('hex');
  assert.deepStrictEqual(written, metadata);
  assert.strictEqual(metadata.head_sha, fixture.head);
  assert.strictEqual(metadata.base_sha, fixture.base);
  assert.strictEqual(metadata.patch_sha256, expectedHash);
  assert.match(metadata.tree_sha, /^[0-9a-f]{40}$/);
  assert.notStrictEqual(metadata.tree_sha, fixture.head);
  assert.strictEqual(git(fixture.repo, 'cat-file', '-t', metadata.tree_sha), 'tree');
});

test('rejects empty or malformed patch', () => {
  const fixture = setup(editKeep);
  for (const content of ['', '   \n', 'this is not a diff\n']) {
    fs.writeFileSync(fixture.patchFile, content);
    assert.throws(() => run(fixture), RunFailure);
  }
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--repo', fixture.repo,
      '--base', fixture.base,
      '--head', fixture.head,
      '--patch', fixture.patchFile,
      '--out-dir', fixture.outDir,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /run failure/);
  assert.deepStrictEqual(fs.readdirSync(fixture.outDir), []);
});

test('rejects a patch that changes nothing', () => {
  const fixture = setup(editKeep);
  const noop = [
    'diff --git a/keep.txt b/keep.txt',
    '--- a/keep.txt',
    '+++ b/keep.txt',
    '',
  ].join('\n');
  fs.writeFileSync(fixture.patchFile, noop);
  assert.throws(() => run(fixture), RunFailure);
});

test('rejects a sha that is not 40 hex characters', () => {
  const fixture = setup(editKeep);
  assert.throws(() => run({ ...fixture, base: '--output=x' }), RunFailure);
  assert.throws(() => run({ ...fixture, head: 'HEAD' }), RunFailure);
});

test('leaves cases without mutation unchanged', () => {
  const lines = fs
    .readFileSync(WORKFLOW, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));
  const text = lines.join('\n');
  const mutationSteps = text.match(/golden-mutation\.js/g) ?? [];
  const guards = text.match(/if: steps\.patch\.outputs\.present == 'true'/g) ?? [];
  assert.ok(mutationSteps.length >= 2);
  assert.ok(guards.length >= 2);
  const unguarded = text.match(
    /if \[ ! -f \.verifier\/mutation\.json \]; then\n\s+git diff --name-status "\$\{\{ steps\.case\.outputs\.base_sha \}\}"\.\.\."\$HEAD_SHA" > \.verifier\/files\.txt\n\s+git diff "\$\{\{ steps\.case\.outputs\.base_sha \}\}"\.\.\."\$HEAD_SHA" > \.verifier\/diff\.patch\n\s+fi/,
  );
  assert.ok(unguarded, 'plain base...head diff kept for cases without a patch');
});
