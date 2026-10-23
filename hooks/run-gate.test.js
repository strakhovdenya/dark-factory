'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { profileCopy } = require('../test/helpers/profiles');
const { allow, block, ask, evaluateGate } = require('./run-gate');
const { markerPath } = require('./skill-marker');

const RUN_GATE = path.join(__dirname, 'run-gate.js');
const COMMIT = `${['g', 'it'].join('')} commit -m x`;
const SESSION = `run-gate-test-${process.pid}`;
test.after(() => fs.rmSync(markerPath(SESSION), { force: true }));

/** Runs runGate in a separate process with the handler given as source code. */
const runEntrypoint = (handlerSource, input = '{}') =>
  spawnSync(process.execPath, ['-e', `require(${JSON.stringify(RUN_GATE)}).runGate('demo', ${handlerSource});`], {
    input,
    encoding: 'utf8',
  });

const envWithout = () => {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  return env;
};

test('gate failure becomes exit code 2', () => {
  const failed = evaluateGate('demo', () => {
    throw new Error('profile exploded');
  }, '{}', {});
  assert.deepEqual(failed, { status: 2, stdout: '', stderr: 'Blocked: demo could not decide (profile exploded).\n' });
  assert.equal(evaluateGate('demo', () => /** @type {any} */ (undefined), '{}', {}).status, 2);
  assert.deepEqual(evaluateGate('demo', allow, '{}', {}), { status: 0, stdout: '', stderr: '' });
  assert.equal(evaluateGate('demo', () => block('no'), '{}', {}).status, 2);

  const thrown = runEntrypoint('() => { throw new Error("boom"); }');
  assert.equal(thrown.status, 2);
  assert.equal(thrown.stdout, '');
  assert.match(thrown.stderr, /Blocked: demo could not decide \(boom\)/);

  const allowed = runEntrypoint('(raw) => (JSON.parse(raw), { status: 0, stdout: "", stderr: "" })');
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
  assert.equal(allowed.stderr, '');

  const asked = runEntrypoint(`() => require(${JSON.stringify(RUN_GATE)}).ask('confirm the checks')`);
  assert.equal(asked.status, 0);
  assert.equal(asked.stdout.trim().split('\n').length, 1, 'one JSON line, nothing else');
  assert.deepEqual(JSON.parse(asked.stdout), JSON.parse(ask('confirm the checks').stdout));
  assert.deepEqual(JSON.parse(asked.stdout).hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: 'confirm the checks',
  });
});

test('malformed gate events and missing required context block', (t) => {
  const root = profileCopy(t, 'monorepo');
  fs.writeFileSync(markerPath(SESSION), JSON.stringify(['task-lifecycle', 'js-conventions']));
  const run = (hook, input, { withRoot = true } = {}) =>
    spawnSync(process.execPath, [path.join(__dirname, hook)], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      // the cwd is a valid consumer root: it must never stand in for CLAUDE_PROJECT_DIR
      cwd: root,
      env: withRoot ? { ...process.env, CLAUDE_PROJECT_DIR: root } : envWithout(),
    });
  const file = path.join(root, 'src', 'a.ts');
  /** @type {Array<[string, object | string, { withRoot?: boolean }, RegExp]>} */
  const cases = [
    ['closure-gate.js', '{not json', {}, /could not decide/],
    ['closure-gate.js', '', {}, /could not decide/],
    ['closure-gate.js', { session_id: SESSION, tool_input: { command: COMMIT } }, { withRoot: false }, /CLAUDE_PROJECT_DIR/],
    ['closure-gate.js', { tool_input: { command: COMMIT } }, {}, /session_id/],
    ['closure-gate.js', { session_id: '', tool_name: 'mcp__github__issue_write', tool_input: {} }, {}, /session_id/],
    ['skill-gate.js', '{not json', {}, /could not decide/],
    ['skill-gate.js', { session_id: SESSION, tool_input: { file_path: file } }, { withRoot: false }, /CLAUDE_PROJECT_DIR/],
    ['skill-gate.js', { tool_input: { file_path: file } }, {}, /session_id/],
    ['skill-gate.js', { session_id: SESSION, tool_input: {} }, {}, /file_path/],
    ['skill-gate.js', { session_id: SESSION, tool_input: { file_path: '' } }, {}, /file_path/],
    ['skill-gate.js', { session_id: SESSION, tool_input: { file_path: path.join(root, 'notes.md') } }, { withRoot: false }, /CLAUDE_PROJECT_DIR/],
  ];
  for (const [hook, input, options, pattern] of cases) {
    const result = run(hook, input, options);
    const label = `${hook}: ${typeof input === 'string' ? input : JSON.stringify(input)}`;
    assert.equal(result.status, 2, label);
    assert.equal(result.stdout, '', label);
    assert.match(result.stderr, pattern, label);
  }
  // an empty CLAUDE_PROJECT_DIR is missing too
  const empty = spawnSync(process.execPath, [path.join(__dirname, 'skill-gate.js')], {
    input: JSON.stringify({ session_id: SESSION, tool_input: { file_path: file } }),
    encoding: 'utf8',
    cwd: os.tmpdir(),
    env: { ...envWithout(), CLAUDE_PROJECT_DIR: '' },
  });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /CLAUDE_PROJECT_DIR/);
});
