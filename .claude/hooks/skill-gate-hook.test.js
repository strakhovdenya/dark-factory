'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decide } = require('./skill-gate-hook');
const { markerPath, record } = require('./skill-marker-hook');
const { BASE_SKILLS } = require('./required-skills');

const repoRoot = path.join(os.tmpdir(), 'gate-repo');
const event = (filePath, sessionId = 's1') =>
  JSON.stringify({ session_id: sessionId, tool_input: { file_path: filePath } });
const jsFile = path.join(repoRoot, 'verifier', 'a.js');

test('blocks a js edit until the skills are loaded', () => {
  const result = decide(event(jsFile), { repoRoot, read: () => ['js-conventions'] });
  assert.equal(result.block, true);
  assert.match(result.message, /modern-javascript/);
  assert.doesNotMatch(result.message, /js-conventions/);
});

test('allows a js edit when all skills are loaded, with or without plugin prefix', () => {
  const loaded = BASE_SKILLS.map((name, index) => (index === 0 ? `plugin:${name}` : name));
  assert.equal(decide(event(jsFile), { repoRoot, read: () => loaded }).block, false);
});

test('ignores files that are not javascript, outside the repository or in node_modules', () => {
  const read = () => [];
  const outside = path.join(path.dirname(repoRoot), 'elsewhere', 'a.js');
  const files = [path.join(repoRoot, 'README.md'), outside, path.join(repoRoot, 'node_modules', 'x', 'a.js')];
  for (const file of files) {
    assert.equal(decide(event(file), { repoRoot, read }).block, false, file);
  }
});

test('fails closed on unparsable input, missing session and unreadable marker', () => {
  assert.equal(decide('not json', { repoRoot }).block, true);
  assert.equal(decide(JSON.stringify({ tool_input: { file_path: jsFile } }), { repoRoot }).block, true);
  const read = () => {
    throw new Error('cannot read marker');
  };
  assert.equal(decide(event(jsFile), { repoRoot, read }).block, true);
});

test('marker records loaded skills once per session', (t) => {
  const sessionId = `gate-test-${process.pid}-${Date.now()}`;
  t.after(() => fs.rmSync(markerPath(sessionId), { force: true }));
  const raw = JSON.stringify({ session_id: sessionId, tool_input: { skill: 'js-gof' } });
  record(raw);
  record(raw);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(sessionId), 'utf8')), ['js-gof']);
});

test('command exits 2 with the reason when blocked', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'skill-gate-hook.js')], {
    input: event(path.join(__dirname, '..', '..', 'verifier', 'a.js'), `no-such-session-${process.pid}`),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Blocked/);
});

test('a damaged marker is rebuilt when the next skill is loaded', (t) => {
  const sessionId = `gate-damaged-${process.pid}-${Date.now()}`;
  t.after(() => fs.rmSync(markerPath(sessionId), { force: true }));
  fs.writeFileSync(markerPath(sessionId), '{ truncated');
  assert.equal(decide(event(jsFile, sessionId), { repoRoot }).block, true);
  record(JSON.stringify({ session_id: sessionId, tool_input: { skill: 'js-gof' } }));
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(sessionId), 'utf8')), ['js-gof']);
});
