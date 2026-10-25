'use strict';

// The cache of fixture repository templates (test/helpers/repo-template.js) and makeConsumer on top
// of it. Real git on temporary repositories; no network, no Docker, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir, isolateGit, gitIn, makeConsumer, writeFiles } = require('./helpers/ralph');
const { copyTemplate, templateBuilds, templateRoot } = require('./helpers/repo-template');

const posix = (target) => target.split(path.sep).join('/');
const commitFile = (repo, file, text) => {
  writeFiles(repo, { [file]: text });
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-qm', `add ${file}`);
};

test('same consumer inputs give independent repositories', (t) => {
  isolateGit(t);
  const inputs = { files: { 'same.txt': 'same\n' } };
  const first = makeConsumer(t, inputs);
  const second = makeConsumer(t, inputs);
  assert.notEqual(first.scratch, second.scratch);
  assert.notEqual(first.origin, second.origin);
  assert.notEqual(first.consumerRoot, second.consumerRoot);
  for (const copy of [first, second]) {
    const url = gitIn(copy.consumerRoot, 'config', 'remote.origin.url');
    assert.equal(path.resolve(url), path.resolve(copy.origin), 'the clone points at its own origin');
  }
  commitFile(first.consumerRoot, 'pushed.txt', 'pushed\n');
  gitIn(first.consumerRoot, 'push', '-q', 'origin', 'HEAD');
  assert.equal(gitIn(first.origin, 'log', '-1', '--format=%s', 'trunk'), 'add pushed.txt');
  assert.equal(gitIn(second.origin, 'log', '-1', '--format=%s', 'trunk'), 'init', 'the other origin is untouched');
  assert.equal(gitIn(second.consumerRoot, 'log', '-1', '--format=%s'), 'init', 'the other clone is untouched');
});

test('repeated consumer inputs reuse the template', (t) => {
  isolateGit(t);
  makeConsumer(t, { files: { 'repeat.txt': 'repeat\n' }, defaultBranch: 'main' });
  const before = templateBuilds();
  makeConsumer(t, { files: { 'repeat.txt': 'repeat\n' }, defaultBranch: 'main' });
  makeConsumer(t, { defaultBranch: 'main', files: { 'repeat.txt': 'repeat\n' } });
  assert.equal(templateBuilds(), before);
});

test('different consumer inputs never reuse a template', (t) => {
  isolateGit(t);
  const base = { files: { 'base.txt': 'base\n' }, defaultBranch: 'trunk', profile: { name: 'one' } };
  makeConsumer(t, base);
  const built = (changes, check) => {
    const before = templateBuilds();
    const copy = makeConsumer(t, { ...base, ...changes });
    assert.equal(templateBuilds(), before + 1, JSON.stringify(changes));
    check(copy.consumerRoot);
  };
  built({ files: { 'base.txt': 'base\n', 'new.txt': 'new\n' } }, (root) => assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new\n'));
  built({ defaultBranch: 'other' }, (root) => assert.equal(gitIn(root, 'branch', '--show-current'), 'other'));
  built({ profile: { name: 'two' } }, (root) => assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.factory/profile.json'), 'utf8')).name, 'two'));
});

test('changes in one copy never reach the next copy', (t) => {
  isolateGit(t);
  const inputs = { files: { 'isolated.txt': 'isolated\n' } };
  const first = makeConsumer(t, inputs);
  writeFiles(first.consumerRoot, { 'isolated.txt': 'changed\n' });
  commitFile(first.consumerRoot, 'committed.txt', 'committed\n');
  writeFiles(first.consumerRoot, { 'extra.txt': 'extra\n' });
  const before = templateBuilds();
  const next = makeConsumer(t, inputs);
  assert.equal(templateBuilds(), before, 'the next copy comes from the same template');
  assert.equal(fs.readFileSync(path.join(next.consumerRoot, 'isolated.txt'), 'utf8'), 'isolated\n');
  assert.ok(!fs.existsSync(path.join(next.consumerRoot, 'extra.txt')));
  assert.ok(!fs.existsSync(path.join(next.consumerRoot, 'committed.txt')));
  assert.equal(gitIn(next.consumerRoot, 'log', '-1', '--format=%s'), 'init');
  assert.equal(gitIn(next.consumerRoot, 'status', '--porcelain'), '');
});

test('failed template build is never cached', (t) => {
  isolateGit(t);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = templateBuilds();
    assert.throws(() => makeConsumer(t, { defaultBranch: 'bad..branch' }), /Command failed|bad\.\.branch|invalid/i);
    assert.equal(templateBuilds(), before + 1, `attempt ${attempt} builds again`);
  }
  const good = makeConsumer(t, { defaultBranch: 'fine' });
  assert.equal(gitIn(good.consumerRoot, 'branch', '--show-current'), 'fine');
});

test('copy config never points into the template', (t) => {
  isolateGit(t);
  const build = (dir, git) => {
    const origin = path.join(dir, 'origin.git');
    const work = path.join(dir, 'work');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, work);
    git(work, 'config', `url.${posix(origin)}.insteadOf`, 'https://example.invalid/origin.git');
    git(work, 'config', 'remote.mirror.url', origin);
    git(work, 'config', 'remote.posix.url', posix(origin));
  };
  const dest = tempDir(t, 'fixture-copy-');
  copyTemplate('config-paths', {}, build, dest);
  const root = templateRoot();
  const forms = [root, posix(root), root.replaceAll(path.sep, path.sep.repeat(2))].map((form) => form.toLowerCase());
  for (const file of [path.join(dest, 'work', '.git', 'config'), path.join(dest, 'origin.git', 'config')]) {
    const text = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const form of forms) assert.ok(!text.includes(form), `${file} still names the template: ${form}`);
  }
  const work = path.join(dest, 'work');
  const originPath = path.join(dest, 'origin.git');
  assert.equal(path.resolve(gitIn(work, 'config', 'remote.origin.url')), originPath);
  assert.equal(path.resolve(gitIn(work, 'config', 'remote.mirror.url')), originPath);
  assert.equal(gitIn(work, 'config', 'remote.posix.url'), posix(originPath));
  assert.ok(gitIn(work, 'config', '--list').includes(`url.${posix(originPath)}.insteadof=https://example.invalid/origin.git`), 'the insteadOf section names the copy');
  assert.equal(gitIn(work, 'ls-remote', 'https://example.invalid/origin.git'), '');
});

test('templates are removed when the process exits', (t) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-exit-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  const script = [
    "const { copyTemplate, templateRoot } = require('./test/helpers/repo-template');",
    "copyTemplate('exit', {}, (dir, git) => git(dir, 'init', '-q'), process.argv[1]);",
    'process.stdout.write(templateRoot());',
  ].join('\n');
  const root = childProcess.execFileSync(process.execPath, ['-e', script, dest], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.ok(root.length > 0);
  assert.ok(fs.existsSync(path.join(dest, '.git')), 'the copy belongs to the test and stays');
  assert.ok(!fs.existsSync(root), 'the template directory is gone');
});
