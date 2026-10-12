'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { handle } = require('./typecheck-hook');

const makeRepo = (t, { withTsc = true } = {}) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-hook-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const bin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (withTsc) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '');
  }
  return { repoRoot, bin };
};

const event = (filePath) => JSON.stringify({ tool_input: { file_path: filePath } });

test('runs tsc in repository root for edited js file', (t) => {
  const { repoRoot, bin } = makeRepo(t);
  const calls = [];
  const spawn = (b, args, options) => (calls.push({ b, args, options }), { status: 0 });
  // The process cwd differs from the repository root
  assert.notEqual(path.resolve(process.cwd()), path.resolve(repoRoot));
  handle(event(path.join(repoRoot, '.claude', 'scripts', 'a.js')), { repoRoot, spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].b, bin);
  assert.deepEqual(calls[0].args, ['--noEmit']);
  assert.equal(calls[0].options.cwd, repoRoot);
});

test('exits zero when tsc is missing or input is invalid', (t) => {
  const { repoRoot } = makeRepo(t, { withTsc: false });
  const calls = [];
  const spawn = () => (calls.push(1), { status: 0 });
  handle(event(path.join(repoRoot, 'a.js')), { repoRoot, spawn });
  assert.equal(calls.length, 0);

  const hookCopy = path.join(repoRoot, '.claude', 'hooks');
  fs.mkdirSync(hookCopy, { recursive: true });
  for (const name of ['typecheck-hook.js', 'hook-common.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(hookCopy, name));
  }
  for (const input of [event(path.join(repoRoot, 'a.js')), 'not json']) {
    const result = spawnSync(process.execPath, [path.join(hookCopy, 'typecheck-hook.js')], {
      input,
      encoding: 'utf8',
      cwd: os.tmpdir(),
    });
    assert.equal(result.status, 0);
  }
});
