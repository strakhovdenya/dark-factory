'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('./load');

const SINGLE_PACKAGE = {
  branchTemplate: 'task/ISSUE-{issue}-{slug}',
  apps: [{ name: 'main', path: '.', gate: [{ argv: ['npm', 'test'], cwd: '.' }] }],
};

const MONOREPO = {
  branchTemplate: 'feature/{issue}-{slug}',
  githubProject: 3,
  apps: [
    { name: 'api', path: 'packages/api', install: [{ argv: ['npm', 'ci'], cwd: 'packages/api' }] },
    { name: 'web', path: 'packages/web' },
  ],
  skillRules: [{ path: 'packages/web', extensions: ['.tsx'], label: 'web UI', skills: ['ui'] }],
  ralph: { enabled: true, techDebtTrackerIssue: 12, enabledSteps: [] },
};

function makeProject(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(root, '.factory'));
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    fs.writeFileSync(path.join(root, '.factory', 'profile.json'), text);
  }
  return root;
}

function loadError(content) {
  const root = makeProject(content);
  try {
    assert.throws(() => loadProfile(root));
    try {
      loadProfile(root);
    } catch (error) {
      return error.message;
    }
    return '';
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('loads valid profile from project root', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-cwd-'));
  const previous = process.cwd();
  try {
    process.chdir(elsewhere);
    for (const profile of [SINGLE_PACKAGE, MONOREPO]) {
      const root = makeProject(profile);
      try {
        assert.deepEqual(loadProfile(root), profile);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    process.chdir(previous);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('rejects profile missing required field naming it', () => {
  for (const base of [SINGLE_PACKAGE, MONOREPO]) {
    const profile = { ...base };
    delete profile.branchTemplate;
    assert.match(loadError(profile), /branchTemplate/);
  }
});

test('rejects wrong field type naming its path', () => {
  const profile = { ...MONOREPO, ralph: { ...MONOREPO.ralph, techDebtTrackerIssue: '334' } };
  assert.match(loadError(profile), /ralph\.techDebtTrackerIssue/);
});

test('rejects unknown field excludeSkills', () => {
  for (const base of [SINGLE_PACKAGE, MONOREPO]) {
    assert.match(loadError({ ...base, excludeSkills: ['x'] }), /excludeSkills/);
  }
});

test('fails with path when profile file is missing', () => {
  const root = makeProject();
  try {
    assert.throws(
      () => loadProfile(root),
      (/** @type {Error} */ error) => error.message.includes(path.join(root, '.factory', 'profile.json')),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts profile with ralph disabled', () => {
  for (const base of [SINGLE_PACKAGE, MONOREPO]) {
    const profile = { ...base, ralph: { enabled: false } };
    const root = makeProject(profile);
    try {
      assert.deepEqual(loadProfile(root), profile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects malformed json naming the profile file', () => {
  const message = loadError('{ "branchTemplate": ');
  assert.match(message, /profile\.json/);
  assert.match(message, /not valid JSON/);
});

test('rejects skill rule entry without skills', () => {
  const rule = { path: 'src', extensions: ['.js'], label: 'src' };
  assert.match(loadError({ ...SINGLE_PACKAGE, skillRules: [rule] }), /skillRules\[0\]\.skills/);
});

test('rejects unknown nested field naming its path', () => {
  const rule = { path: 'src', extensions: ['.js'], label: 'src', skills: ['a'], exclude: true };
  assert.match(loadError({ ...SINGLE_PACKAGE, skillRules: [rule] }), /skillRules\[0\]\.exclude/);
});

test('rejects enabled ralph without step settings', () => {
  const message = loadError({ ...SINGLE_PACKAGE, ralph: { enabled: true } });
  assert.match(message, /ralph\.techDebtTrackerIssue/);
  assert.match(message, /ralph\.enabledSteps/);
});
