'use strict';

// Processes are replaced at the child_process boundary (the `spawn` dependency of main); the archive
// logic runs on real temporary directories. No WSL, no Docker, no network, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../test/helpers/ralph');
const { main, KEEP_ARCHIVES } = require('./ralph-wsl');

const TOKEN = 'secret-token-value-123';
const DISTRO = 'TestDistro';
const CLONE = '/home/op/clone';
const RUNS = '/var/tmp/runs';
const WSL = { distro: DISTRO, clone: CLONE, runsRoot: RUNS };
const LOCK_A = 'blob-a';
const LOCK_B = 'blob-b';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-25T12:00:00Z');

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ status: 1, stdout: '', stderr });
const utf16 = (text) => Buffer.from(`﻿${text}`, 'utf16le');

/** @type {(t: any, config: any) => any} */
const writeConfig = (t, config) => {
  const dir = tempDir(t, 'ralph-wsl-');
  fs.mkdirSync(path.join(dir, '.ralph'));
  const file = path.join(dir, '.ralph', 'config.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return { dir, file };
};

/** Scripted wsl.exe: `answers` override the defaults by the git subcommand or the program. */
const makeSpawn = (answers = {}) => {
  const calls = [];
  const spawn = (file, args, options = {}) => {
    calls.push({ file, args, options });
    const rest = args[0] === '-d' ? args.slice(3) : args;
    const key = rest[0] === 'git' ? `git ${rest[3]}` : rest[0];
    if (args[0] === '-l') return { status: 0, stdout: utf16(`${DISTRO}\r\nOther\r\n`) };
    if (key in answers) {
      const answer = answers[key];
      return typeof answer === 'function' ? answer(calls.length) : answer;
    }
    const defaults = { 'git status': ok(''), 'git symbolic-ref': ok('origin/main'), 'git rev-parse': ok('main'), test: ok(), node: ok() };
    return defaults[key] || ok();
  };
  return { spawn, calls };
};

/** @type {(t: any, options?: any) => any} */
const runHost = (t, { config = { issues: [], wsl: WSL }, answers, env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, WSLENV: 'PATH/p' }, platform = 'win32' } = {}) => {
  const { dir } = writeConfig(t, config);
  const { spawn, calls } = makeSpawn(answers);
  const out = [];
  const code = main([], { cwd: dir, spawn, platform, env, log: (line) => out.push(line), logError: (line) => out.push(line) });
  return { code, calls, out, dir };
};

// git rev-parse answers the branch check first, then the lock blob before and after the merge.
const scriptedRevParse = (...locks) => {
  const queue = [...locks];
  const state = { branchSeen: false };
  const fn = () => {
    if (!state.branchSeen) {
      state.branchSeen = true;
      return ok('main');
    }
    return ok(queue.length > 1 ? queue.shift() : queue[0]);
  };
  return fn;
};

const subcommands = (calls) => calls.map(({ args }) => (args[0] === '-d' ? args.slice(3) : args)).map((rest) => (rest[0] === 'git' ? `git ${rest[3]}` : rest[0]));

test('refuses the host mode outside windows', (t) => {
  const { code, calls, out } = runHost(t, { platform: 'linux' });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /host mode/);
  assert.equal(calls.length, 0);
});

test('stops when the local config has no wsl section', (t) => {
  const { code, calls, out } = runHost(t, { config: { issues: [] } });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /"wsl" section/);
  assert.equal(calls.length, 0);
});

test('stops on an invalid local config before any process', (t) => {
  const { code, calls, out } = runHost(t, { config: '{ not json' });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /config\.json/);
  assert.equal(calls.length, 0);
});

test('stops when the wsl distribution is missing', (t) => {
  const { code, calls, out } = runHost(t, { config: { issues: [], wsl: { ...WSL, distro: 'Absent' } } });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /Absent/);
  assert.equal(subcommands(calls).includes('git fetch'), false);
});

test('updates the wsl clone and starts the inner mode through wsl.exe with argument arrays', (t) => {
  const { code, calls } = runHost(t, { answers: { 'git rev-parse': scriptedRevParse(LOCK_A) } });
  assert.equal(code, 0);
  const names = subcommands(calls);
  assert.ok(names.indexOf('git fetch') < names.indexOf('git merge'));
  assert.ok(names.indexOf('git merge') < names.indexOf('node'));
  for (const call of calls) {
    assert.equal(call.file, 'wsl.exe');
    assert.ok(Array.isArray(call.args));
    assert.notEqual(call.options.shell, true);
  }
  const merge = calls.find(({ args }) => args.includes('merge'));
  assert.deepEqual(merge.args, ['-d', DISTRO, '--exec', 'git', '-C', CLONE, 'merge', '--ff-only', 'origin/main']);
  const inner = calls.at(-1);
  assert.deepEqual(inner.args, ['-d', DISTRO, '--exec', 'node', `${CLONE}/node_modules/dark-factory/bin/ralph-wsl.js`, '--inner']);
});

test('runs npm ci when the lockfile changed', (t) => {
  const { code, calls } = runHost(t, { answers: { 'git rev-parse': scriptedRevParse(LOCK_A, LOCK_B) } });
  assert.equal(code, 0);
  const names = subcommands(calls);
  assert.ok(names.indexOf('npm') > names.indexOf('git merge'));
  assert.ok(names.indexOf('npm') < names.indexOf('node'));
});

test('skips npm ci when the lockfile did not change', (t) => {
  const { code, calls } = runHost(t, { answers: { 'git rev-parse': scriptedRevParse(LOCK_A, LOCK_A) } });
  assert.equal(code, 0);
  assert.equal(subcommands(calls).includes('npm'), false);
  assert.equal(subcommands(calls).includes('node'), true);
});

test('stops on a dirty wsl clone before any change', (t) => {
  const { code, calls } = runHost(t, { answers: { 'git status': ok(' M file.js') } });
  assert.equal(code, 1);
  const names = subcommands(calls);
  assert.equal(names.some((name) => ['git fetch', 'git merge', 'npm', 'node'].includes(name)), false);
});

test('stops on an off-branch wsl clone before any change', (t) => {
  const { code, calls } = runHost(t, { answers: { 'git rev-parse': ok('feature') } });
  assert.equal(code, 1);
  const names = subcommands(calls);
  assert.equal(names.some((name) => ['git fetch', 'git merge', 'npm', 'node'].includes(name)), false);
});

test('stops when the wsl clone cannot fast-forward', (t) => {
  const { code, calls } = runHost(t, { answers: { 'git rev-parse': scriptedRevParse(LOCK_A), 'git merge': fail('not possible') } });
  assert.equal(code, 1);
  const names = subcommands(calls);
  assert.equal(names.includes('npm') || names.includes('node'), false);
});

test('passes the agent token through WSLENV and never in arguments or output', (t) => {
  const { code, calls, out } = runHost(t, { answers: { 'git rev-parse': scriptedRevParse(LOCK_A) } });
  assert.equal(code, 0);
  const inner = calls.at(-1);
  assert.deepEqual(inner.options.env.WSLENV.split(':'), ['PATH/p', 'CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(JSON.stringify(calls.map(({ args }) => args)).includes(TOKEN), false);
  assert.equal(String(inner.options.input).includes(TOKEN), false);
  assert.equal(out.join('\n').includes(TOKEN), false);
});

test('leaves WSLENV without the token name when the token is not set on windows', (t) => {
  const { code, calls } = runHost(t, { env: { WSLENV: 'PATH/p' }, answers: { 'git rev-parse': scriptedRevParse(LOCK_A) } });
  assert.equal(code, 0);
  const inner = calls.at(-1);
  assert.equal(inner.options.env.WSLENV.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.equal(inner.args.at(-1), '--inner');
});

// --- inner mode ---

/** @type {(t: any, options?: any) => any} */
const makeInner = (t, { files = {}, dirs = [], archives = [], lock, env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } } = {}) => {
  const root = tempDir(t, 'ralph-wsl-inner-');
  const clone = path.join(root, 'clone');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(clone);
  fs.mkdirSync(runsRoot);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(runsRoot, name), content);
  for (const name of dirs) {
    fs.mkdirSync(path.join(runsRoot, name), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, name, 'data.txt'), `data of ${name}`);
  }
  for (const [name, ageDays] of archives) {
    const dir = path.join(runsRoot, 'archive', name);
    fs.mkdirSync(dir, { recursive: true });
    const when = new Date(NOW.getTime() - ageDays * DAY_MS);
    fs.utimesSync(dir, when, when);
  }
  if (lock !== undefined) fs.writeFileSync(path.join(runsRoot, 'run.lock'), JSON.stringify({ pid: lock }));
  const config = { issues: [{ id: 7, dependsOn: [] }], maxTurns: 5, wsl: { distro: DISTRO, clone, runsRoot } };
  const calls = [];
  const out = [];
  const run = (exitCode = 0, isAlive = (pid) => pid === lock && lock !== 'dead') => {
    const spawn = (file, args, options) => {
      calls.push({ file, args, options });
      return { status: exitCode };
    };
    const code = main(['--inner'], {
      spawn,
      env,
      now: () => NOW,
      isAlive,
      readInput: () => JSON.stringify(config),
      log: (line) => out.push(line),
      logError: (line) => out.push(line),
    });
    return code;
  };
  return { clone, runsRoot, config, calls, out, run };
};

const archiveNames = (runsRoot) => (fs.existsSync(path.join(runsRoot, 'archive')) ? fs.readdirSync(path.join(runsRoot, 'archive')).sort() : []);

test('writes the clone config with the wsl runsRoot and leaves the windows config unchanged', (t) => {
  const { file } = writeConfig(t, { issues: [], wsl: WSL });
  const before = fs.readFileSync(file);
  const inner = makeInner(t);
  assert.equal(inner.run(), 0);
  const written = JSON.parse(fs.readFileSync(path.join(inner.clone, '.ralph', 'config.json'), 'utf8'));
  assert.equal('wsl' in written, false);
  assert.equal(written.runsRoot, inner.runsRoot);
  assert.equal(written.maxTurns, 5);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(inner.calls[0].args[0], path.join(inner.clone, 'node_modules', 'dark-factory', 'ralph', 'run.js'));
});

test('archives previous runs without deleting them', (t) => {
  const inner = makeInner(t, { files: { 'state.json': '{"a":1}' }, dirs: ['issue-7', 'issue-7-sessions'] });
  assert.equal(inner.run(), 0);
  const [stamp] = archiveNames(inner.runsRoot);
  assert.equal(stamp, '20261025-120000');
  const target = path.join(inner.runsRoot, 'archive', stamp);
  assert.equal(fs.readFileSync(path.join(target, 'state.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(target, 'issue-7', 'data.txt'), 'utf8'), 'data of issue-7');
  assert.equal(fs.readFileSync(path.join(target, 'issue-7-sessions', 'data.txt'), 'utf8'), 'data of issue-7-sessions');
  for (const name of ['issue-7', 'issue-7-sessions', 'state.json']) assert.equal(fs.existsSync(path.join(inner.runsRoot, name)), false);
  assert.equal(inner.calls.length, 1);
});

test('archives only sessions and state after a clean run', (t) => {
  const inner = makeInner(t, { files: { 'state.json': '{}' }, dirs: ['issue-7-sessions'] });
  assert.equal(inner.run(), 0);
  const target = path.join(inner.runsRoot, 'archive', archiveNames(inner.runsRoot)[0]);
  assert.deepEqual(fs.readdirSync(target).sort(), ['issue-7-sessions', 'state.json']);
});

test('refuses to archive while a live run holds the lock', (t) => {
  const inner = makeInner(t, { files: { 'state.json': '{}' }, dirs: ['issue-7'], lock: 4242 });
  assert.equal(inner.run(), 1);
  assert.equal(fs.existsSync(path.join(inner.runsRoot, 'issue-7')), true);
  assert.equal(fs.existsSync(path.join(inner.runsRoot, 'state.json')), true);
  assert.equal(archiveNames(inner.runsRoot).length, 0);
  assert.equal(inner.calls.length, 0);
});

test('archives over a stale lock of a dead process', (t) => {
  const inner = makeInner(t, { dirs: ['issue-7'], lock: 4242 });
  assert.equal(inner.run(0, () => false), 0);
  assert.equal(archiveNames(inner.runsRoot).length, 1);
  assert.equal(inner.calls.length, 1);
});

test('stops when the agent token is missing', (t) => {
  const inner = makeInner(t, { dirs: ['issue-7'], env: {} });
  assert.equal(inner.run(), 1);
  assert.match(inner.out.join('\n'), /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(inner.calls.length, 0);
  assert.equal(fs.existsSync(path.join(inner.runsRoot, 'issue-7')), true);
});

test('returns exit code zero of a successful ralph run', (t) => {
  assert.equal(makeInner(t).run(0), 0);
});

test('returns a non-zero exit code of a failed ralph run', (t) => {
  assert.equal(makeInner(t).run(3), 3);
});

test('keeps only the five newest archives', (t) => {
  const names = ['20261001-000000', '20261002-000000', '20261003-000000', '20261004-000000', '20261005-000000', '20261006-000000'];
  const inner = makeInner(t, { dirs: ['issue-7'], archives: names.map((name) => [name, 1]) });
  assert.equal(KEEP_ARCHIVES, 5);
  assert.equal(inner.run(), 0);
  assert.deepEqual(archiveNames(inner.runsRoot), [...names.slice(2), '20261025-120000']);
});

test('removes archives older than fourteen days', (t) => {
  const inner = makeInner(t, { dirs: ['issue-7'], archives: [['20260901-000000', 30], ['20261020-000000', 5]] });
  assert.equal(inner.run(), 0);
  assert.deepEqual(archiveNames(inner.runsRoot), ['20261020-000000', '20261025-120000']);
});

test('never deletes anything outside timestamped archive directories', (t) => {
  const old = ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000', '20260105-000000', '20260106-000000'];
  const inner = makeInner(t, { dirs: ['issue-7'], archives: old.map((name) => [name, 60]) });
  fs.writeFileSync(path.join(inner.runsRoot, 'archive', 'notes.txt'), 'keep');
  fs.mkdirSync(path.join(inner.runsRoot, 'archive', 'foreign'));
  const foreignClone = path.join(inner.runsRoot, 'archive', 'foreign', 'x');
  fs.writeFileSync(foreignClone, 'keep');
  assert.equal(inner.run(), 0);
  assert.equal(fs.readFileSync(path.join(inner.runsRoot, 'archive', 'notes.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(foreignClone, 'utf8'), 'keep');
  assert.deepEqual(archiveNames(inner.runsRoot).filter((name) => /^\d{8}-\d{6}$/.test(name)), ['20261025-120000']);
});

test('does not prune archives while a live run holds the lock', (t) => {
  const names = ['20261001-000000', '20261002-000000', '20261003-000000', '20261004-000000', '20261005-000000', '20261006-000000', '20261007-000000'];
  const inner = makeInner(t, { archives: names.map((name) => [name, 1]), lock: 4242 });
  assert.equal(inner.run(), 1);
  assert.deepEqual(archiveNames(inner.runsRoot), names);
});
