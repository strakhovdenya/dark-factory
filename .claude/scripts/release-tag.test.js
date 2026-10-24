'use strict';

// Real git on temporary repositories: a bare repository is origin, the script runs in a clone of
// it under its GitHub URL (rewritten to the bare repository by insteadOf). gh is replaced at the
// process boundary with the check runs of each scenario. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, isolateGit, gitIn, writeFiles } = require('../../test/helpers/ralph');
const { main, parseArgs, REQUIRED_CHECKS } = require('./release-tag');

const TAG = 'v0.1.0';
const PACKAGE = JSON.stringify({ name: 'dark-factory', version: '0.1.0' });
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-24\n\n- First release\n';
const GITHUB_URL = 'https://github.com/acme/dark-factory.git';
const ACTIONS = { slug: 'github-actions' };
const greenRuns = () => REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success', app: ACTIONS }));

/** origin with main at a release commit, and an operator clone that is one commit behind. */
const makeRepos = (t, { files = {} } = {}) => {
  isolateGit(t);
  const scratch = tempDir(t, 'release-tag-');
  const origin = path.join(scratch, 'origin.git');
  const author = path.join(scratch, 'author');
  const operator = path.join(scratch, 'operator');
  gitIn(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  gitIn(scratch, 'clone', '-q', origin, author);
  writeFiles(author, { 'README.md': 'before release\n' });
  gitIn(author, 'add', '-A');
  gitIn(author, 'commit', '-qm', 'before release');
  gitIn(author, 'push', '-q', 'origin', 'main');
  gitIn(scratch, 'clone', '-q', origin, operator);
  gitIn(operator, 'config', `url.${origin.replace(/\\/g, '/')}.insteadOf`, GITHUB_URL);
  gitIn(operator, 'remote', 'set-url', 'origin', GITHUB_URL);
  writeFiles(author, { 'package.json': PACKAGE, 'CHANGELOG.md': CHANGELOG, ...files });
  gitIn(author, 'add', '-A');
  gitIn(author, 'commit', '-qm', 'release');
  gitIn(author, 'push', '-q', 'origin', 'main');
  const releaseSha = gitIn(author, 'rev-parse', 'HEAD');
  const remoteTags = () => gitIn(operator, 'ls-remote', '--tags', 'origin');
  const localTags = () => gitIn(operator, 'tag', '--list');
  return { scratch, origin, author, operator, releaseSha, remoteTags, localTags };
};

/**
 * Runs the script in the operator clone; gh answers with `runs`, or as `gh` says.
 * @param {any} repos
 * @param {string[]} argv
 * @param {{ runs?: any[], gh?: (args: string[]) => any, confirm?: (tag: string, sha: string) => Promise<boolean> }} [options]
 */
const runScript = async (repos, argv, { runs = greenRuns(), gh = undefined, confirm = async () => false } = {}) => {
  const spawn = (tool, args, options) => {
    if (tool !== 'gh') return childProcess.spawnSync(tool, args, options);
    if (gh) return gh(args);
    const expected = `repos/acme/dark-factory/commits/${repos.releaseSha}/check-runs?per_page=100`;
    if (args[0] !== 'api' || args[1] !== expected) return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
    return { status: 0, stdout: JSON.stringify({ check_runs: runs }), stderr: '' };
  };
  const lines = [];
  const errors = [];
  const code = await main(argv, { root: repos.operator, spawn, confirm, log: (line) => lines.push(line), logError: (line) => errors.push(line) });
  return { code, out: lines.join('\n'), err: errors.join('\n') };
};

test('tags origin main after checks', async (t) => {
  for (const mode of ['--yes', 'typed confirmation']) {
    await t.test(mode, async () => {
      const repos = makeRepos(t);
      const headBefore = gitIn(repos.operator, 'rev-parse', 'HEAD');
      const asked = [];
      const confirm = async (tag, sha) => (asked.push([tag, sha]), true);
      const result = await runScript(repos, mode === '--yes' ? [TAG, '--yes'] : [TAG], { confirm });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(asked, mode === '--yes' ? [] : [[TAG, repos.releaseSha]]);
      gitIn(repos.author, 'fetch', '-q', '--tags', 'origin');
      assert.equal(gitIn(repos.author, 'rev-parse', `${TAG}^{commit}`), repos.releaseSha, 'the tag is on the commit of origin/main');
      assert.equal(gitIn(repos.author, 'cat-file', '-t', TAG), 'tag', 'an annotated tag');
      assert.ok(result.out.includes(`commit SHA for the wrappers: ${repos.releaseSha}`), result.out);
      assert.equal(gitIn(repos.operator, 'rev-parse', 'HEAD'), headBefore, 'the branch of the clone is not moved');
      assert.equal(gitIn(repos.operator, 'status', '--porcelain'), '');
    });
  }
});

test('refuses without tag when a precondition fails', async (t) => {
  const runsWith = (name, change) => greenRuns().map((run) => (run.name === name ? { ...run, ...change } : run));
  /** @type {[string, string, any, any?, any?][]} */
  const cases = [
    ['malformed tag', 'vX.Y.Z', {}, ['v0.1']],
    ['version mismatch', 'does not match package.json version', {}, ['v0.2.0', '--yes'], { 'CHANGELOG.md': `${CHANGELOG}\n## [0.2.0]\n` }],
    ['missing changelog section', 'missing section "## [0.1.0]"', {}, null, { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n' }],
    ['check missing', 'check "Typecheck" has no GitHub Actions run', { runs: greenRuns().filter((run) => run.name !== 'Typecheck') }],
    ['check of another app only', 'check "Lint" has no GitHub Actions run', { runs: runsWith('Lint', { app: { slug: 'other-app' } }) }],
    ['failed run next to a green one', 'check "Lint" concluded failure', { runs: [{ name: 'Lint', status: 'completed', conclusion: 'success', app: { slug: 'other-app' } }, ...runsWith('Lint', { conclusion: 'failure' })] }],
    ['check failed', 'check "Test (Windows)" concluded failure', { runs: runsWith('Test (Windows)', { conclusion: 'failure' }) }],
    ['check running', 'check "Lint" is in_progress', { runs: runsWith('Lint', { status: 'in_progress', conclusion: null }) }],
    ['gh unavailable', 'cannot run gh', { gh: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn gh ENOENT') }) }],
    ['gh garbage', 'check runs of', { gh: () => ({ status: 0, stdout: 'not json', stderr: '' }) }],
  ];
  for (const [label, mention, options, argv, files] of cases) {
    await t.test(label, async () => {
      const repos = makeRepos(t, { files });
      const result = await runScript(repos, argv || [TAG, '--yes'], options);
      assert.equal(result.code, 1, label);
      assert.ok(result.err.includes(mention), `${label}: ${result.err}`);
      assert.equal(repos.remoteTags(), '', 'no tag on origin');
      assert.equal(repos.localTags(), '', 'no tag in the clone');
    });
  }

  await t.test('origin is not on GitHub', async () => {
    const repos = makeRepos(t);
    gitIn(repos.operator, 'remote', 'set-url', 'origin', repos.origin);
    const result = await runScript(repos, [TAG, '--yes']);
    assert.equal(result.code, 1);
    assert.ok(result.err.includes('is not a GitHub repository'), result.err);
    assert.equal(repos.remoteTags(), '');
    assert.equal(repos.localTags(), '');
  });

  await t.test('push rejected by origin', async () => {
    const repos = makeRepos(t);
    writeFiles(repos.origin, { 'hooks/pre-receive': '#!/bin/sh\necho "tags are closed" >&2\nexit 1\n' });
    fs.chmodSync(path.join(repos.origin, 'hooks', 'pre-receive'), 0o755);
    const result = await runScript(repos, [TAG, '--yes']);
    assert.equal(result.code, 1);
    assert.ok(result.err.includes('tags are closed'), 'the push error is reported');
    assert.equal(repos.remoteTags(), '');
    assert.equal(repos.localTags(), '', 'the tag made for the push is removed again');
  });

  await t.test('tag already in the clone', async () => {
    const repos = makeRepos(t);
    gitIn(repos.operator, 'tag', TAG);
    const result = await runScript(repos, [TAG, '--yes']);
    assert.equal(result.code, 1);
    assert.ok(result.err.includes('already exists in this clone'), result.err);
    assert.equal(repos.remoteTags(), '');
  });
});

test('never moves an existing tag', async (t) => {
  const repos = makeRepos(t);
  const old = gitIn(repos.author, 'rev-parse', 'HEAD~1');
  gitIn(repos.author, 'tag', TAG, old);
  gitIn(repos.author, 'push', '-q', 'origin', `refs/tags/${TAG}`);
  const result = await runScript(repos, [TAG, '--yes']);
  assert.equal(result.code, 1);
  assert.ok(result.err.includes('already exists on origin'), result.err);
  assert.ok(repos.remoteTags().startsWith(old), 'the published tag still points to its commit');
  assert.equal(repos.localTags(), '');
});

test('creates no tag without confirmation', async (t) => {
  for (const [label, argv, confirm] of /** @type {[string, string[], () => Promise<boolean>][]} */ ([
    ['dry run', [TAG, '--dry-run', '--yes'], async () => true],
    ['declined', [TAG], async () => false],
  ])) {
    await t.test(label, async () => {
      const repos = makeRepos(t);
      const result = await runScript(repos, argv, { confirm });
      assert.equal(result.code, label === 'dry run' ? 0 : 1, result.err);
      assert.ok(result.out.includes('no tag created'), result.out);
      assert.ok(result.out.includes(repos.releaseSha), 'the target commit is reported');
      assert.equal(repos.remoteTags(), '');
      assert.equal(repos.localTags(), '');
    });
  }
});

test('rejects wrong arguments before any git call', () => {
  for (const argv of [[], ['v0.1'], ['0.1.0'], ['v0.1.0', 'v0.2.0'], ['v0.1.0', '--force']]) {
    assert.throws(() => parseArgs(argv), /usage|vX.Y.Z|unknown argument/, JSON.stringify(argv));
  }
  assert.deepEqual(parseArgs(['--dry-run', 'v1.2.3', '--yes']), { tag: 'v1.2.3', isDryRun: true, isConfirmed: true });
});
