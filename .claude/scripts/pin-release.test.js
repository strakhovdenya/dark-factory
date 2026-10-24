'use strict';

// Real git on temporary repositories: a bare repository is origin, the script runs in a clone of it.
// npm and the scripts of the installed release (setup, doctor) are replaced at the process boundary,
// so nothing is downloaded. No network, no Docker, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, isolateGit, gitIn, writeFiles } = require('../../test/helpers/ralph');
const { main, parseArgs, WRAPPERS } = require('./pin-release');

const TAG = 'v0.1.1';
const OLD_SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const OLD_SPEC = 'github:acme/dark-factory#v0.1.0';
const packageText = (spec = OLD_SPEC) => `${JSON.stringify({ name: 'dark-factory', version: '0.1.0', devDependencies: { 'dark-factory': spec } }, null, 2)}\n`;
const lockText = (sha = OLD_SHA) => `${JSON.stringify({ packages: { 'node_modules/dark-factory': { resolved: `git+ssh://git@github.com/acme/dark-factory.git#${sha}` } } }, null, 2)}\n`;
const wrapperText = (usesSha = OLD_SHA, factorySha = usesSha, repository = 'acme/dark-factory') =>
  [
    'name: Wrapper',
    'jobs:',
    '  call:',
    `    uses: ${repository}/.github/workflows/reusable.yml@${usesSha}`,
    '    with:',
    `      factory-sha: ${factorySha}`,
    '',
  ].join('\n');

/** An origin with main (the pinned state) and the tag of the new release; an operator clone of it. */
const makeRepos = (t, { files = {}, tagOn = 'main', annotated = true, stale = false } = {}) => {
  isolateGit(t);
  const scratch = tempDir(t, 'pin-release-');
  const origin = path.join(scratch, 'origin.git');
  const author = path.join(scratch, 'author');
  const operator = path.join(scratch, 'operator');
  gitIn(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  gitIn(scratch, 'clone', '-q', origin, author);
  writeFiles(author, {
    'package.json': packageText(),
    'package-lock.json': lockText(),
    '.gitignore': 'node_modules/\n',
    [WRAPPERS[0]]: wrapperText(),
    [WRAPPERS[1]]: wrapperText(),
    ...files,
  });
  gitIn(author, 'add', '-A');
  gitIn(author, 'commit', '-qm', 'pinned to the first release');
  gitIn(author, 'push', '-q', 'origin', 'main');
  if (stale) gitIn(scratch, 'clone', '-q', origin, operator);

  writeFiles(author, { 'RELEASE.md': 'the new release\n' });
  gitIn(author, 'add', '-A');
  gitIn(author, 'commit', '-qm', 'the release commit');
  if (tagOn === 'main') gitIn(author, 'push', '-q', 'origin', 'main');
  else {
    gitIn(author, 'checkout', '-q', '-b', 'side');
    gitIn(author, 'push', '-q', 'origin', 'side');
  }
  const tagSha = gitIn(author, 'rev-parse', 'HEAD');
  if (tagOn !== 'none') {
    if (annotated) gitIn(author, 'tag', '-a', TAG, '-m', TAG);
    else gitIn(author, 'tag', TAG);
    gitIn(author, 'push', '-q', 'origin', `refs/tags/${TAG}`);
  }
  if (!stale) gitIn(scratch, 'clone', '-q', origin, operator);
  writeFiles(operator, {
    'node_modules/dark-factory/bin/setup.js': '// replaced at the process boundary\n',
    'node_modules/dark-factory/bin/doctor.js': '// replaced at the process boundary\n',
  });
  return { operator, origin, tagSha, head: () => gitIn(operator, 'rev-parse', 'HEAD') };
};

/** The files the script may touch, as text. */
const pinned = (operator) => Object.fromEntries(['package.json', 'package-lock.json', ...WRAPPERS].map((file) => [file, fs.readFileSync(path.join(operator, file), 'utf8')]));

/**
 * Runs the script in the operator clone. npm rewrites the pin like the real one would (the lock gets
 * `lockSha`, the tag commit by default); setup and doctor are recorded and answer with the given statuses.
 * @param {{ operator: string, tagSha: string }} repos
 * @param {string[]} argv
 * @param {{ lockSha?: string, npmFails?: boolean, setupStatus?: number, doctorStatus?: number, doctorStderr?: string, setupTouches?: string }} [options]
 */
const run = (repos, argv, { lockSha = repos.tagSha, npmFails = false, setupStatus = 0, doctorStatus = 0, doctorStderr = '', setupTouches = '' } = {}) => {
  const calls = [];
  /** @type {any} */
  const spawn = (file, args, options) => {
    if (file === 'git') return childProcess.spawnSync(file, args, options);
    const script = path.basename(args[0]);
    if (script === 'npm-cli.js') {
      calls.push(['npm', ...args.slice(1)]);
      if (npmFails) return { status: 1, stdout: '', stderr: 'npm failed' };
      const spec = args[args.length - 1];
      fs.writeFileSync(path.join(repos.operator, 'package.json'), packageText(spec));
      fs.writeFileSync(path.join(repos.operator, 'package-lock.json'), lockText(lockSha));
      return { status: 0, stdout: '', stderr: '' };
    }
    calls.push([script, ...args.slice(1)]);
    if (script === 'setup.js' && setupTouches !== '') fs.appendFileSync(path.join(repos.operator, setupTouches), 'changed by setup\n');
    return script === 'setup.js' ? { status: setupStatus, stdout: '', stderr: setupStatus === 0 ? '' : 'setup refused' } : { status: doctorStatus, stdout: doctorStatus === 0 ? 'No problems found.' : '- label: missing', stderr: doctorStderr };
  };
  const lines = [];
  const errors = [];
  const code = main(argv, { root: repos.operator, spawn, log: (line) => lines.push(line), logError: (line) => errors.push(line) });
  return { code, out: lines.join('\n'), err: errors.join('\n'), calls };
};

test('pins the tag in package.json and both wrappers', (t) => {
  for (const annotated of [true, false]) {
    const repos = makeRepos(t, { annotated });
    const headBefore = repos.head();
    const tagsBefore = gitIn(repos.operator, 'tag', '--list');
    const result = run(repos, [TAG]);
    assert.equal(result.code, 0, result.err);

    const after = pinned(repos.operator);
    assert.equal(JSON.parse(after['package.json']).devDependencies['dark-factory'], `github:acme/dark-factory#${TAG}`);
    assert.ok(after['package-lock.json'].includes(`#${repos.tagSha}"`));
    for (const wrapper of WRAPPERS) {
      assert.equal(after[wrapper], wrapperText(repos.tagSha), wrapper);
      assert.ok(!after[wrapper].includes(OLD_SHA), `${wrapper}: no old pin is left`);
    }
    assert.deepEqual(result.calls[0], ['npm', 'install', '--ignore-scripts', '--save-dev', `github:acme/dark-factory#${TAG}`]);
    assert.deepEqual(result.calls.slice(1), [['setup.js', '--consumer-root', repos.operator], ['doctor.js', 'doctor', repos.operator]]);
    assert.match(result.out, /No problems found\./);
    assert.match(result.out, new RegExp(`${TAG} is pinned`));

    assert.equal(repos.head(), headBefore, 'nothing is committed');
    assert.deepEqual(gitIn(repos.operator, 'diff', '--name-only').split('\n').sort(), ['.github/workflows/spec-approval-wrapper.yml', '.github/workflows/verifier-wrapper.yml', 'package-lock.json', 'package.json']);
    assert.equal(gitIn(repos.operator, 'tag', '--list'), tagsBefore, 'no tag is created or moved');
  }
});

test('refuses without changing files when a precondition fails', async (t) => {
  /** @type {[string, string, any, string[]?, any?][]} */
  const cases = [
    ['malformed tag', 'vX.Y.Z', {}, ['v0.1']],
    ['tag not published', 'does not exist on origin', { tagOn: 'none' }],
    ['tag not on origin main', 'not a commit of origin/main', { tagOn: 'side' }],
    ['already pinned', 'already pinned', {}, ['v0.1.0']],
    ['pin is not a tag', 'is not github:<owner>/<name>#vX.Y.Z', { files: { 'package.json': packageText('github:acme/dark-factory#main') } }],
    ['wrapper has no pin', 'must call acme/dark-factory with a full commit SHA', { files: { [WRAPPERS[1]]: wrapperText(OLD_SHA, OLD_SHA, 'other/project') } }],
  ];
  for (const [label, mention, repoOptions, argv] of cases) {
    await t.test(label, (sub) => {
      const repos = makeRepos(sub, repoOptions);
      const before = pinned(repos.operator);
      const result = run(repos, argv || [TAG]);
      assert.equal(result.code, 1, label);
      assert.ok(result.err.includes(mention), `${label}: ${result.err}`);
      assert.deepEqual(pinned(repos.operator), before);
      assert.deepEqual(result.calls, [], 'neither npm nor the release scripts ran');
    });
  }

  await t.test('dirty working tree', (sub) => {
    const repos = makeRepos(sub);
    writeFiles(repos.operator, { 'notes.txt': 'unrelated work\n' });
    const before = pinned(repos.operator);
    const result = run(repos, [TAG]);
    assert.equal(result.code, 1);
    assert.ok(result.err.includes('working tree is not clean'), result.err);
    assert.deepEqual(pinned(repos.operator), before);
    assert.deepEqual(result.calls, []);
  });
});

test('refuses wrappers whose pins disagree', async (t) => {
  /** @type {[string, Record<string, string>, string][]} */
  const cases = [
    ['uses and factory-sha differ', { [WRAPPERS[0]]: wrapperText(OLD_SHA, OTHER_SHA) }, 'uses 1111111111111111111111111111111111111111 but factory-sha is 2222222222222222222222222222222222222222'],
    ['the two wrappers pin different commits', { [WRAPPERS[1]]: wrapperText(OTHER_SHA) }, 'the wrappers pin different commits'],
  ];
  for (const [label, files, mention] of cases) {
    await t.test(label, (sub) => {
      const repos = makeRepos(sub, { files });
      const before = pinned(repos.operator);
      const result = run(repos, [TAG]);
      assert.equal(result.code, 1);
      assert.ok(result.err.includes(mention), result.err);
      assert.deepEqual(pinned(repos.operator), before);
      assert.deepEqual(result.calls, []);
    });
  }
});

test('restores the pin when npm fails or locks another commit', async (t) => {
  for (const [label, options, mention] of /** @type {[string, any, string][]} */ ([
    ['npm fails', { npmFails: true }, 'npm install'],
    ['lock holds another commit', { lockSha: OTHER_SHA }, `the lock holds ${OTHER_SHA}`],
  ])) {
    await t.test(label, (sub) => {
      const repos = makeRepos(sub);
      const before = pinned(repos.operator);
      const result = run(repos, [TAG], options);
      assert.equal(result.code, 1);
      assert.ok(result.err.includes(mention), result.err);
      assert.ok(result.err.includes('were restored'), result.err);
      assert.deepEqual(pinned(repos.operator), before, 'package.json, the lock and both wrappers are as before');
      assert.ok(!result.calls.some(([script]) => script === 'setup.js'), 'setup did not run');
    });
  }
});

test('changes no file in a dry run and reports a failing doctor', (t) => {
  const dry = makeRepos(t);
  const before = pinned(dry.operator);
  const dryResult = run(dry, [TAG, '--dry-run']);
  assert.equal(dryResult.code, 0, dryResult.err);
  assert.match(dryResult.out, /dry run, no file changed/);
  assert.deepEqual(pinned(dry.operator), before);
  assert.deepEqual(dryResult.calls, []);

  const failing = makeRepos(t);
  const failed = run(failing, [TAG], { doctorStatus: 1 });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /- label: missing/);
  assert.match(failed.err, /doctor exited with 1/);
  assert.equal(JSON.parse(pinned(failing.operator)['package.json']).devDependencies['dark-factory'], `github:acme/dark-factory#${TAG}`, 'the pin is moved; the problems are reported');

  const setupFails = makeRepos(t);
  const refused = run(setupFails, [TAG], { setupStatus: 1 });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /setup of the installed v0\.1\.1 failed/);
});

test('rejects wrong arguments before any git call', () => {
  for (const argv of [[], ['v0.1'], ['0.1.1'], ['v0.1.1', 'v0.1.2'], ['v0.1.1', '--force']]) {
    assert.throws(() => parseArgs(argv), /usage|vX\.Y\.Z|unknown argument/, JSON.stringify(argv));
  }
  assert.deepEqual(parseArgs(['--dry-run', 'v1.2.3']), { tag: 'v1.2.3', isDryRun: true });
});

test('moves every workflow that calls the release and reads quoted pins with comments', (t) => {
  const quoted = ['name: Eval', 'jobs:', '  call:', `    uses: "acme/dark-factory/.github/workflows/eval.yml@${OLD_SHA}" # release v0.1.0`, '    with:', `      factory-sha: '${OLD_SHA}' # same commit`, ''].join('\n');
  const repos = makeRepos(t, { files: { '.github/workflows/eval.yml': quoted, '.github/workflows/ci.yml': 'name: CI\njobs: {}\n' } });
  const result = run(repos, [TAG]);
  assert.equal(result.code, 0, result.err);
  const eval_ = fs.readFileSync(path.join(repos.operator, '.github/workflows/eval.yml'), 'utf8');
  assert.equal(eval_, quoted.replaceAll(OLD_SHA, repos.tagSha));
  assert.match(result.out, /3 wrappers/);
  assert.equal(fs.readFileSync(path.join(repos.operator, '.github/workflows/ci.yml'), 'utf8'), 'name: CI\njobs: {}\n', 'a workflow that does not call the release is left alone');
});

test('refuses a branch that does not contain origin main', (t) => {
  const repos = makeRepos(t, { stale: true });
  const before = pinned(repos.operator);
  const result = run(repos, [TAG]);
  assert.equal(result.code, 1);
  assert.ok(result.err.includes('does not contain origin/main'), result.err);
  assert.deepEqual(pinned(repos.operator), before);
  assert.deepEqual(result.calls, []);
});

test('installs into the field that holds the pin', (t) => {
  const prod = JSON.stringify({ name: 'dark-factory', dependencies: { 'dark-factory': OLD_SPEC } }, null, 2);
  const repos = makeRepos(t, { files: { 'package.json': `${prod}\n` } });
  const result = run(repos, [TAG]);
  assert.deepEqual(result.calls[0].slice(0, 4), ['npm', 'install', '--ignore-scripts', '--save-prod']);
});

test('reports files outside the pin and the output of a failing doctor', (t) => {
  const touched = makeRepos(t, { files: { 'README.md': 'readme\n' } });
  const result = run(touched, [TAG], { setupTouches: 'README.md' });
  assert.equal(result.code, 1);
  assert.ok(result.err.includes('files outside the pin changed (README.md)'), result.err);

  const crashed = makeRepos(t);
  const doctor = run(crashed, [TAG], { doctorStatus: 2, doctorStderr: 'doctor crashed: boom' });
  assert.equal(doctor.code, 1);
  assert.ok(doctor.err.includes('doctor crashed: boom'), doctor.err);
  assert.ok(doctor.err.includes('doctor exited with 2'), doctor.err);
});
