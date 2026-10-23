'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
const { BASE_SKILLS } = require('../profile/skill-rules');
const { markerPath, readLoaded, isLoaded } = require('./skill-marker');

const MARKER = path.join(__dirname, 'skill-marker.js');
const SKILL_GATE = path.join(__dirname, 'skill-gate.js');
const CLOSURE_GATE = path.join(__dirname, 'closure-gate.js');
const SESSION_PREFIX = `skill-marker-test-${process.pid}`;
const COMMIT = `${['g', 'it'].join('')} commit -m x`;

let counter = 0;
const newSession = () => `${SESSION_PREFIX}-${counter++}`;
test.afterEach(() => {
  for (let index = 0; index < counter; index += 1) fs.rmSync(markerPath(`${SESSION_PREFIX}-${index}`), { force: true });
});

const run = (script, input, root) => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  return spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: os.tmpdir(),
    env,
  });
};

const loadSkill = (sessionId, skill, root) => {
  const result = run(MARKER, { session_id: sessionId, tool_name: 'Skill', tool_input: { skill } }, root);
  assert.equal(result.status, 0, result.stderr);
  return result;
};

const editFile = (sessionId, root) =>
  run(SKILL_GATE, { session_id: sessionId, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'a.ts') } }, root);
const commit = (sessionId, root) => run(CLOSURE_GATE, { session_id: sessionId, tool_name: 'Bash', tool_input: { command: COMMIT } }, root);

const assertAsk = (result, label) => {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask', label);
};

const CORRUPT = ['{not json', JSON.stringify({ 'task-lifecycle': true }), JSON.stringify(['task-lifecycle', 7, ...BASE_SKILLS])];

test('marker records skill seen by skill gate', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture);
    const sessionId = newSession();
    assert.equal(editFile(sessionId, root).status, 2, fixture);
    BASE_SKILLS.forEach((skill, index) => loadSkill(sessionId, index % 2 === 0 ? skill : `metaskills:${skill}`, root));
    loadSkill(sessionId, BASE_SKILLS[0], root);
    assert.equal(readLoaded(sessionId).length, BASE_SKILLS.length, 'no duplicates');
    const edit = editFile(sessionId, root);
    assert.equal(edit.status, 0, `${fixture}: ${edit.stderr}`);

    assert.equal(commit(sessionId, root).status, 2, `${fixture}: commit before task-lifecycle`);
    loadSkill(sessionId, 'plugin:task-lifecycle', root);
    assertAsk(commit(sessionId, root), fixture);
  }
});

test('corrupt marker blocks gates until repaired', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture);
    for (const text of CORRUPT) {
      const sessionId = newSession();
      fs.writeFileSync(markerPath(sessionId), text);
      assert.throws(() => readLoaded(sessionId), /skill marker/);
      const blockedCommit = commit(sessionId, root);
      assert.equal(blockedCommit.status, 2, `${fixture}: ${text}`);
      assert.match(blockedCommit.stderr, /skill marker/);
      assert.equal(blockedCommit.stdout, '');
      const blockedEdit = editFile(sessionId, root);
      assert.equal(blockedEdit.status, 2, `${fixture}: ${text}`);
      assert.match(blockedEdit.stderr, /skill marker/);
    }
  }
});

test('loading a skill repairs a corrupt marker', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture);
    for (const text of CORRUPT) {
      const sessionId = newSession();
      fs.writeFileSync(markerPath(sessionId), text);
      const repaired = loadSkill(sessionId, 'task-lifecycle', root);
      assert.match(repaired.stderr, /rebuilding damaged marker/);
      // only the skill loaded now: earlier entries of the damaged file are not trusted
      assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(sessionId), 'utf8')), ['task-lifecycle']);
      assertAsk(commit(sessionId, root), `${fixture}: ${text}`);
      assert.equal(editFile(sessionId, root).status, 2, `${fixture}: base skills not restored`);
      for (const skill of BASE_SKILLS) loadSkill(sessionId, skill, root);
      assert.equal(editFile(sessionId, root).status, 0, `${fixture}: ${text}`);
    }
    const leftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`claude-loaded-skills-${SESSION_PREFIX}`) && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  }
});

test('markers do not grant skills across sessions or partial loads', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture);
    const other = newSession();
    for (const skill of [...BASE_SKILLS, 'task-lifecycle']) loadSkill(other, skill, root);
    const sessionId = newSession();
    assert.equal(editFile(sessionId, root).status, 2, `${fixture}: other session`);
    assert.equal(commit(sessionId, root).status, 2, `${fixture}: other session commit`);

    for (const skill of BASE_SKILLS.slice(0, -1)) loadSkill(sessionId, skill, root);
    const partial = editFile(sessionId, root);
    assert.equal(partial.status, 2, fixture);
    assert.match(partial.stderr, new RegExp(`session yet: ${BASE_SKILLS.at(-1)}\\.`));
    loadSkill(sessionId, BASE_SKILLS.at(-1), root);
    assert.equal(editFile(sessionId, root).status, 0, fixture);
  }
});

test('unusable Skill events write nothing and never block', (t) => {
  const root = profileCopy(t, 'monorepo');
  const sessionId = newSession();
  for (const input of [
    '{not json',
    { session_id: sessionId, tool_input: {} },
    { session_id: sessionId, tool_input: { skill: '' } },
    { tool_input: { skill: 'issues' } },
    { session_id: '../escape', tool_input: { skill: 'issues' } },
  ]) {
    const result = run(MARKER, input, root);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /skill-marker:/);
  }
  assert.equal(fs.existsSync(markerPath(sessionId)), false);
  fs.writeFileSync(markerPath(sessionId), '["issues"]');
  run(MARKER, '{not json', root);
  assert.equal(fs.readFileSync(markerPath(sessionId), 'utf8'), '["issues"]');
});

test('a skill counts under its own name or a namespace', () => {
  assert.ok(isLoaded(['issues'], 'issues'));
  assert.ok(isLoaded(['plugin:issues'], 'issues'));
  assert.ok(!isLoaded(['my-issues'], 'issues'));
  assert.ok(!isLoaded(['issues:other'], 'issues'));
});
