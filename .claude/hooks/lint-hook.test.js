'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { handle } = require('./lint-hook');

const makeRepo = (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-hook-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const bin = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  return { repoRoot, bin };
};

const event = (filePath) => JSON.stringify({ tool_input: { file_path: filePath } });

const recorder = () => {
  const calls = [];
  return { calls, spawn: (bin, args, options) => (calls.push({ bin, args, options }), { status: 0 }) };
};

test('runs eslint fix for edited js file', (t) => {
  const { repoRoot, bin } = makeRepo(t);
  const { calls, spawn } = recorder();
  const file = path.join(repoRoot, 'scripts', 'a.js');
  handle(event(file), { repoRoot, spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, bin);
  assert.deepEqual(calls[0].args, ['--fix', file]);
  assert.equal(calls[0].options.cwd, repoRoot);
});

test('ignores non-javascript or outside file', (t) => {
  const { repoRoot } = makeRepo(t);
  const { calls, spawn } = recorder();
  const outside = path.join(path.dirname(repoRoot), 'elsewhere', 'a.js');
  for (const file of [path.join(repoRoot, 'README.md'), outside, path.join(repoRoot, 'node_modules', 'x', 'a.js')]) {
    handle(event(file), { repoRoot, spawn });
  }
  assert.equal(calls.length, 0);
});

test('skips eslint on invalid input', (t) => {
  const { repoRoot } = makeRepo(t);
  const { calls, spawn } = recorder();
  for (const raw of ['not json', '{}', JSON.stringify({ tool_input: {} }), '']) {
    handle(raw, { repoRoot, spawn });
  }
  assert.equal(calls.length, 0);
});

test('exits zero when eslint fails', (t) => {
  const { repoRoot } = makeRepo(t);
  // A fake eslint that fails, launched through the real hook process
  fs.writeFileSync(path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js'), 'process.exit(1);');
  const hookCopy = path.join(repoRoot, '.claude', 'hooks');
  fs.mkdirSync(hookCopy, { recursive: true });
  for (const name of ['lint-hook.js', 'hook-common.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(hookCopy, name));
  }
  const result = spawnSync(process.execPath, [path.join(hookCopy, 'lint-hook.js')], {
    input: event(path.join(repoRoot, 'a.js')),
    encoding: 'utf8',
    cwd: os.tmpdir(),
  });
  assert.equal(result.status, 0);
});
