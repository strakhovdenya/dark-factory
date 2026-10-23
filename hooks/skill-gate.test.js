'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
const { loadProfile } = require('../profile/load');
const { requiredSkillsFor, BASE_SKILLS } = require('../profile/skill-rules');
const { requiredSkillsForIssue } = require('../ralph/prompts');
const { markerPath } = require('./skill-marker');

const HOOK = path.join(__dirname, 'skill-gate.js');
const SESSION_PREFIX = `skill-gate-test-${process.pid}`;

let counter = 0;
const newSession = () => `${SESSION_PREFIX}-${counter++}`;
test.afterEach(() => {
  for (let index = 0; index < counter; index += 1) fs.rmSync(markerPath(`${SESSION_PREFIX}-${index}`), { force: true });
});

const withMarker = (skills, sessionId = newSession()) => {
  fs.writeFileSync(markerPath(sessionId), JSON.stringify(skills));
  return sessionId;
};

const envWith = (root) => {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  if (root !== undefined) env.CLAUDE_PROJECT_DIR = root;
  return env;
};

const edit = (filePath, sessionId = newSession()) => ({
  session_id: sessionId,
  tool_name: 'Edit',
  tool_input: { file_path: filePath },
});

/** @type {(input: object | string, options?: { root?: string, cwd?: string }) => import('node:child_process').SpawnSyncReturns<string>} */
const runHook = (input, { root, cwd } = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: cwd ?? os.tmpdir(),
    env: envWith(root),
  });

const RULE = { path: 'packages/storefront', extensions: ['.tsx'], label: 'shop UI', skills: ['ui-patterns'] };
// Both fixtures get the same project entry, so a test does not depend on one layout.
const withRule = (profile) => {
  profile.skillRules = [RULE];
};

const missingOf = (stderr) => {
  const match = stderr.match(/session yet: (.+)\. Load each/);
  return match ? match[1].split(', ') : null;
};

const assertPass = (result, label) => {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stdout, '', label);
  assert.doesNotMatch(result.stderr, /Blocked/, label);
};

test('hook and ralph require same skills for a path', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, withRule);
    const profile = loadProfile(root);
    const relative = 'packages/storefront/src/Cart.tsx';
    const body = `## Context\nWhy.\n\n## Affects\n- \`${relative}\`\n\n## Docs to Read\n- none\n`;
    const ralphSkills = requiredSkillsForIssue(profile, body);
    assert.deepEqual(ralphSkills, [...BASE_SKILLS, 'ui-patterns'], fixture);
    assert.deepEqual(requiredSkillsFor(profile, [relative]), ralphSkills, fixture);

    const file = path.join(root, ...relative.split('/'));
    const blocked = runHook(edit(file), { root });
    assert.equal(blocked.status, 2, fixture);
    assert.deepEqual(missingOf(blocked.stderr), ralphSkills, fixture);

    const partial = ralphSkills.filter((_, index) => index % 2 === 0);
    const partialResult = runHook(edit(file, withMarker(partial)), { root });
    assert.equal(partialResult.status, 2, fixture);
    assert.deepEqual(missingOf(partialResult.stderr), ralphSkills.filter((skill) => !partial.includes(skill)), fixture);
    assert.match(partialResult.stderr, /packages\/storefront\/src\/Cart\.tsx \(shop UI\)/, fixture);

    assertPass(runHook(edit(file, withMarker(ralphSkills)), { root }), fixture);
  }
});

test('works from root of temporary working copy', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, withRule);
    const cwd = path.join(root, 'packages', 'storefront', 'src');
    fs.mkdirSync(cwd, { recursive: true });
    const file = path.join(cwd, 'Cart.tsx');
    const required = requiredSkillsFor(loadProfile(root), ['packages/storefront/src/Cart.tsx']);

    const blocked = runHook(edit(file), { root, cwd });
    assert.equal(blocked.status, 2, fixture);
    assert.deepEqual(missingOf(blocked.stderr), required, fixture);
    assertPass(runHook(edit(file, withMarker(required)), { root, cwd }), fixture);
    // a relative file_path is resolved from the consumer root, not from the cwd
    assertPass(runHook(edit('packages/storefront/src/Cart.tsx', withMarker(required)), { root, cwd }), `${fixture} relative`);
    assert.equal(runHook(edit('packages/storefront/src/Cart.tsx'), { root, cwd }).status, 2, `${fixture} relative blocked`);
  }
});

test('blocks edit without required skills', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture);
    const file = path.join(root, 'src', 'index.ts');
    // the shared module returns nothing for an absolute path: the hook must not pass that on
    assert.deepEqual(requiredSkillsFor(loadProfile(root), [file]), []);
    const result = runHook(edit(file, withMarker(['js-conventions', 'plugin:js-gof'])), { root });
    assert.equal(result.status, 2, fixture);
    assert.deepEqual(missingOf(result.stderr), BASE_SKILLS.filter((skill) => !['js-conventions', 'js-gof'].includes(skill)), fixture);
    assert.match(result.stderr, /editing src\/index\.ts requires/, fixture);
  }
});

test('path outside table requires no skills', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, (profile) => {
      profile.docs = { adr: 'docs/decisions.md' };
    });
    for (const relative of ['notes.md', 'docs/decisions.txt', 'docs/decisions.md.bak', 'other/decisions.md']) {
      assertPass(runHook(edit(path.join(root, ...relative.split('/'))), { root }), `${fixture}: ${relative}`);
    }
    const adr = runHook(edit(path.join(root, 'docs', 'decisions.md')), { root });
    assert.equal(adr.status, 2, fixture);
    assert.deepEqual(missingOf(adr.stderr), ['adr'], fixture);
    // a file outside the consumer root requires nothing
    assertPass(runHook(edit(path.join(path.dirname(root), 'elsewhere', 'x.ts')), { root }), `${fixture}: outside`);
  }
});

test('blocks without profile with message', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-noprofile-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const invalid = profileCopy(t, 'monorepo', (profile) => {
    profile.skillRules = [{ path: 'x', extensions: ['ts'], label: 'x', skills: ['s'] }];
  });
  /** @type {Array<[string, RegExp]>} */
  const cases = [
    [empty, /Profile not found: expected/],
    [invalid, /Invalid profile [\s\S]*skillRules\[0\]\.extensions\[0\]/],
  ];
  for (const [root, pattern] of cases) {
    for (const relative of ['notes.md', 'src/a.ts']) {
      const result = runHook(edit(path.join(root, relative), withMarker([...BASE_SKILLS])), { root });
      assert.equal(result.status, 2, relative);
      assert.match(result.stderr, pattern, relative);
      assert.ok(result.stderr.includes(path.join(root, '.factory', 'profile.json')), relative);
    }
  }
});

test('drive letter case of the root does not change the decision on win32', { skip: process.platform !== 'win32' && 'win32 only' }, (t) => {
  const root = profileCopy(t, 'single-package');
  const flipped = root[0] === root[0].toLowerCase() ? root[0].toUpperCase() + root.slice(1) : root[0].toLowerCase() + root.slice(1);
  const file = path.join(flipped, 'src', 'a.ts');
  const result = runHook(edit(file), { root });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /editing src\/a\.ts requires/);
  assertPass(runHook(edit(file, withMarker([...BASE_SKILLS])), { root }), 'loaded');
  const otherDrive = `${root[0].toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\project\\src\\a.ts`;
  assertPass(runHook(edit(otherDrive), { root }), 'other drive');
});
