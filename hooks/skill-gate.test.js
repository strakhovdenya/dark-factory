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
const { REPO_ROOT } = require('../test/helpers/factory-package');
const { makeFactoryProject } = require('../test/helpers/factory-project');
const { findBash } = require('../test/helpers/bash');
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

// --- the factory on its own release: the installed gate, the real profile and the real settings ---

const FACTORY_FILE = 'verifier/x.js';
const requiredByRelease = (installed) => JSON.parse(fs.readFileSync(path.join(installed, 'skills', 'base-set.json'), 'utf8')).requiredJsSkills;
const factoryEdit = (project, sessionId = newSession()) => edit(path.join(project.root, ...FACTORY_FILE.split('/')), sessionId);

/** The gate script of the installed release, run directly. */
const runInstalledGate = (project, input) =>
  spawnSync(process.execPath, [path.join(project.installed, 'hooks', 'skill-gate.js')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd: os.tmpdir(),
    env: envWith(project.root),
  });

/** The Write|Edit gate command of the real settings of the factory. */
const settingsGateCommand = (root) => {
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const group = settings.hooks.PreToolUse.find((entry) => entry.matcher === 'Write|Edit');
  assert.equal(group.hooks.length, 1);
  return group.hooks[0].command;
};

/** Runs a settings command in Bash from `cwd`, with the event on stdin and CLAUDE_PROJECT_DIR as Claude Code sets it. */
const runSettingsCommand = (command, { root, cwd, input, env = {} }) =>
  spawnSync(findBash(), ['-c', command], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root.split(path.sep).join('/'), ...env },
  });

// Records the script path of every Node process started with it: the proof of which module ran.
const tracerFor = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tracer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const trace = path.join(dir, 'trace.txt');
  const tracer = path.join(dir, 'tracer.js');
  fs.writeFileSync(tracer, `require('node:fs').appendFileSync(${JSON.stringify(trace)}, process.argv[1] + '\\n');\n`);
  const executed = () => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((script) => path.resolve(script)) : []);
  return { env: { NODE_OPTIONS: `--require=${tracer.split(path.sep).join('/')}` }, executed };
};

test('factory profile requires skills for factory code', (t) => {
  const project = makeFactoryProject(t);
  const required = requiredByRelease(project.installed);
  assert.ok(required.length > 0);
  const result = runInstalledGate(project, factoryEdit(project));
  assert.equal(result.status, 2);
  assert.deepEqual(missingOf(result.stderr), required);
  assert.match(result.stderr, /editing verifier\/x\.js requires/);

  const partial = required.slice(0, 2);
  const partialResult = runInstalledGate(project, factoryEdit(project, withMarker(partial)));
  assert.equal(partialResult.status, 2);
  assert.deepEqual(missingOf(partialResult.stderr), required.slice(2));
});

test('factory installed gate accepts loaded skills', (t) => {
  const project = makeFactoryProject(t);
  const required = requiredByRelease(project.installed);
  assertPass(runInstalledGate(project, factoryEdit(project, withMarker(required))), 'all loaded');
  assertPass(runInstalledGate(project, factoryEdit(project, withMarker(required.map((skill) => `plugin:${skill}`)))), 'with plugin prefix');
  // a file that the table does not cover needs nothing
  assertPass(runInstalledGate(project, edit(path.join(project.root, 'notes.md'))), 'not code');
});

test('factory gate fails closed without installed release', (t) => {
  /** @type {[string, (project: any) => void][]} */
  const damages = [
    ['installed release missing', (project) => fs.rmSync(project.installed, { recursive: true })],
    ['installed gate does not load', (project) => fs.rmSync(path.join(project.installed, 'profile'), { recursive: true })],
  ];
  for (const [label, damage] of damages) {
    const project = makeFactoryProject(t);
    const required = requiredByRelease(project.installed);
    damage(project);
    const trace = tracerFor(t);
    const command = settingsGateCommand(project.root);
    assert.ok(command.includes('node_modules/dark-factory/hooks/skill-gate.js') && command.endsWith('|| exit 2'), command);
    // all skills are loaded: only the missing release can be the reason
    const result = runSettingsCommand(command, { root: project.root, cwd: project.root, input: factoryEdit(project, withMarker(required)), env: trace.env });
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.ok(trace.executed().every((script) => !script.startsWith(path.join(REPO_ROOT, 'hooks'))), `${label}: no hook of the working copy ran`);
  }
});

test('factory settings run the installed gate', (t) => {
  const project = makeFactoryProject(t);
  const required = requiredByRelease(project.installed);
  const command = settingsGateCommand(project.root);
  const subdirectory = path.join(project.root, 'verifier');
  fs.mkdirSync(subdirectory, { recursive: true });

  const trace = tracerFor(t);
  const allowed = runSettingsCommand(command, { root: project.root, cwd: subdirectory, input: factoryEdit(project, withMarker(required)), env: trace.env });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
  const scripts = trace.executed();
  assert.ok(scripts.includes(path.join(project.installed, 'hooks', 'skill-gate.js')), `the installed module ran: ${scripts.join(', ')}`);
  assert.ok(scripts.every((script) => !script.startsWith(path.join(REPO_ROOT, 'hooks'))), 'not the working copy');

  const blocked = runSettingsCommand(command, { root: project.root, cwd: subdirectory, input: factoryEdit(project) });
  assert.equal(blocked.status, 2);
  assert.deepEqual(missingOf(blocked.stderr), required);
});

test('factory settings hold the six installed entries and no working copy hook', (t) => {
  const project = makeFactoryProject(t);
  const text = fs.readFileSync(path.join(project.root, '.claude', 'settings.json'), 'utf8');
  const release = JSON.parse(/```json\r?\n([\s\S]*?)\r?\n```/.exec(fs.readFileSync(path.join(project.installed, 'hooks', 'README.md'), 'utf8'))[1]);
  assert.deepEqual(JSON.parse(text), release, 'the settings are the ones of the installed release');
  const commands = Object.values(JSON.parse(text).hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
  assert.equal(commands.length, 6);
  assert.equal(commands.filter((command) => command.endsWith('|| exit 2')).length, 3);
  assert.equal(commands.filter((command) => command.endsWith('|| true')).length, 3);
  assert.ok(commands.every((command) => command.startsWith('node "$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/')), commands.join('\n'));
  assert.ok(!text.includes('.claude/hooks/') && !text.includes('CLAUDE_PROJECT_DIR/hooks/'));
});
