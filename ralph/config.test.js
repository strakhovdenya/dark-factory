'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { acquireLock, releaseLock, validateLocalConfig, loadLocalConfig, protectedPatternsFor, CORE_PROTECTED_PATHS } = require('./config');
const { tempDir } = require('../test/helpers/ralph');

const alive = () => true;
const dead = () => false;
const lockIn = (t) => path.join(tempDir(t), 'runs', 'run.lock');

test('creates and releases the lock', (t) => {
  const lockPath = lockIn(t);
  acquireLock(lockPath, dead);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
  releaseLock(lockPath);
  assert.equal(fs.existsSync(lockPath), false);
});

test('refuses to overwrite a lock of a live process', (t) => {
  const lockPath = lockIn(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const original = JSON.stringify({ pid: 4242, startedAt: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(lockPath, original);
  assert.throws(() => acquireLock(lockPath, alive), /already active \(PID 4242/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), original);
});

test('treats EPERM as a live process', (t) => {
  const lockPath = lockIn(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, startedAt: 'x' }));
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  });
  assert.throws(() => acquireLock(lockPath), /already active/);
});

test('takes over the lock of a dead process or a corrupt lock file', (t) => {
  for (const content of [JSON.stringify({ pid: 4242, startedAt: 'x' }), '{ not json']) {
    const lockPath = lockIn(t);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, content);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, old, old);
    t.mock.method(console, 'log', () => {});
    acquireLock(lockPath, content.startsWith('{ not') ? alive : dead);
    t.mock.restoreAll();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
  }
});

test('validates the local run config by field', () => {
  assert.deepEqual(validateLocalConfig({ issues: [{ id: 3 }, { id: 4, dependsOn: [3] }], maxTurns: 10, runsRoot: '../runs' }).issues, [
    { id: 3, dependsOn: [] },
    { id: 4, dependsOn: [3] },
  ]);
  const cases = [
    [{ issues: [], branchPrefix: 'x' }, /branchPrefix.*branchTemplate/],
    [{ issues: [], sandbox: {} }, /sandbox: unknown field/],
    [{}, /issues: must be an array/],
    [{ issues: [{ id: 0 }] }, /issues\[0\]\.id/],
    [{ issues: [{ id: 1, dependsOn: ['2'] }] }, /issues\[0\]\.dependsOn/],
    [{ issues: [], taskMaxUsd: -1 }, /taskMaxUsd/],
    [[], /JSON object/],
  ];
  for (const [config, pattern] of cases) assert.throws(() => validateLocalConfig(config), pattern);
});

test('reads the local config file and names it on errors', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '﻿{"issues": []}');
  assert.deepEqual(loadLocalConfig(file), { issues: [] });
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => loadLocalConfig(file), new RegExp('not valid JSON'));
  assert.throws(() => loadLocalConfig(path.join(dir, 'missing.json')), /Cannot read the local run config/);
});

test('core protections cannot be removed by the profile', () => {
  assert.deepEqual(protectedPatternsFor({}), [...CORE_PROTECTED_PATHS]);
  assert.deepEqual(protectedPatternsFor({ protectedPaths: ['scripts/'] }), [...CORE_PROTECTED_PATHS, 'scripts/']);
});

test('does not take over a lock file that another starter has just created', (t) => {
  const lockPath = lockIn(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');
  assert.throws(() => acquireLock(lockPath, dead), /is starting/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '');
});
