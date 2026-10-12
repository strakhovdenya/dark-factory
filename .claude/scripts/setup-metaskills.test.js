'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SKILLS, setupMetaskills } = require('./setup-metaskills');

const silent = { log() {}, warn() {} };

const makeRoot = (t, packaged = SKILLS) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metaskills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of packaged) {
    const dir = path.join(root, 'node_modules', 'metaskills', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  return root;
};

const skillsDir = (root) => path.join(root, '.claude', 'skills');

test('copies listed metaskills into .claude/skills', (t) => {
  const root = makeRoot(t);
  setupMetaskills(root, silent);
  for (const name of SKILLS) {
    const dest = path.join(skillsDir(root), name);
    assert.ok(fs.lstatSync(dest).isDirectory(), `${name} is a plain directory`);
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  }
});

test('skips without error when metaskills package is absent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metaskills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'setup-metaskills.js'), root], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(skillsDir(root)), false);
});

test('copies remaining skills when one is missing in package', (t) => {
  const present = SKILLS.filter((name) => name !== 'js-gof');
  const root = makeRoot(t, present);
  const copied = setupMetaskills(root, silent);
  assert.deepEqual(copied, present);
  assert.equal(fs.existsSync(path.join(skillsDir(root), 'js-gof')), false);
});

test('leaves tracked modern-javascript untouched', (t) => {
  const root = makeRoot(t);
  const tracked = path.join(skillsDir(root), 'modern-javascript');
  fs.mkdirSync(path.join(tracked, 'references'), { recursive: true });
  fs.writeFileSync(path.join(tracked, 'SKILL.md'), 'tracked');
  fs.writeFileSync(path.join(tracked, 'references', 'A.md'), 'ref');
  setupMetaskills(root, silent);
  assert.deepEqual(fs.readdirSync(tracked).sort(), ['SKILL.md', 'references']);
  assert.equal(fs.readFileSync(path.join(tracked, 'SKILL.md'), 'utf8'), 'tracked');
  assert.equal(fs.readFileSync(path.join(tracked, 'references', 'A.md'), 'utf8'), 'ref');
});
