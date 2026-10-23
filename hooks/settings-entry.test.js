'use strict';

// The settings JSON of hooks/README.md, executed as Claude Code runs it: each command is a shell
// string run by Bash (Linux) or Git Bash (Windows) with CLAUDE_PROJECT_DIR set, from a consumer
// root with spaces in its path that has the package installed at node_modules/dark-factory.
// There is no skip when the shell is missing: the hooks are documented for this shell only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
const { REPO_ROOT, installFactoryPackage } = require('../test/helpers/factory-package');
const { BASE_SKILLS } = require('../profile/skill-rules');
const { markerPath } = require('./skill-marker');
const { HOOK_ENTRIES, commandFor } = require('./entries');

const README = path.join(__dirname, 'README.md');
const SESSION_PREFIX = `settings-entry-test-${process.pid}`;
const COMMIT = `${['g', 'it'].join('')} commit -m x`;
const EXPECTED = HOOK_ENTRIES.map(({ event, matcher, script, kind }) => [event, matcher, script, kind]);

let counter = 0;
const newSession = () => `${SESSION_PREFIX}-${counter++}`;
test.afterEach(() => {
  for (let index = 0; index < counter; index += 1) fs.rmSync(markerPath(`${SESSION_PREFIX}-${index}`), { force: true });
});

/** Bash on Linux; Git Bash on Windows (as Claude Code finds it), never the WSL bash of System32. */
const findBash = () => {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (git.status === 0) candidates.push(path.resolve(git.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe'));
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, `Git Bash not found (tried: ${candidates.join(', ')}); the hooks need Bash/Git Bash`);
  return found;
};

/** The hook entries of the README settings JSON, flattened to { event, matcher, command }. */
const readmeEntries = () => {
  const blocks = [...fs.readFileSync(README, 'utf8').matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)];
  assert.equal(blocks.length, 1, 'the README has one settings JSON block');
  const settings = JSON.parse(blocks[0][1]);
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher, type: hook.type, command: hook.command }))),
  );
};

const scriptOf = (command, root) => {
  const match = command.match(/^node "\$CLAUDE_PROJECT_DIR\/([^"]+)"/);
  assert.ok(match, command);
  return path.join(root, ...match[1].split('/'));
};

/** A consumer root with a space in its path, the fixture profile and, optionally, the installed package. */
/** @type {(t: any, fixture: string, options?: { installed?: boolean, hooks?: object }) => string} */
const consumer = (t, fixture, { installed = true, hooks = undefined } = {}) => {
  const base = profileCopy(t, fixture, (profile) => {
    if (hooks !== undefined) profile.hooks = hooks;
  });
  const root = path.join(fs.realpathSync.native(base), 'consumer root');
  fs.cpSync(path.join(base, '.factory'), path.join(root, '.factory'), { recursive: true });
  if (installed) installFactoryPackage(path.join(root, 'node_modules'), { metaskills: 'none' });
  return root;
};

let bash;
let elsewhere;
test.before(() => {
  bash = findBash();
  elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-cwd-')));
});
test.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));

/** Runs one settings command in Bash with the event on stdin, from a cwd outside the root. */
const runEntry = (entry, root, input) => {
  const nodePath = [path.join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return spawnSync(bash, ['-c', entry.command], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: elsewhere,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, NODE_PATH: nodePath },
  });
};

const entryFor = (entries, matcher, script) => entries.find((entry) => entry.matcher === matcher && entry.command.includes(`/hooks/${script}`));

test('installed README entries resolve hooks and preserve gate decisions', (t) => {
  const entries = readmeEntries();
  assert.deepEqual(
    entries.map((entry) => [entry.event, entry.matcher, path.basename(entry.command.match(/hooks\/([\w-]+\.js)/)[1])]),
    EXPECTED.map(([event, matcher, script]) => [event, matcher, script]),
  );
  for (const [index, [, , , kind]] of EXPECTED.entries()) {
    assert.equal(entries[index].type, 'command');
    assert.ok(entries[index].command.endsWith(kind === 'gate' ? ' || exit 2' : ' || true'), entries[index].command);
    assert.equal(entries[index].command, commandFor(HOOK_ENTRIES[index]));
  }

  for (const fixture of FIXTURE_PROFILES) {
    const root = consumer(t, fixture);
    assert.ok(root.includes(' '));
    for (const [index, entry] of entries.entries()) {
      const script = scriptOf(entry.command, root);
      assert.ok(fs.existsSync(script), script);
      assert.equal(path.basename(script), EXPECTED[index][2]);
    }
    const bashGate = entryFor(entries, 'Bash', 'closure-gate.js');
    const issueGate = entryFor(entries, 'mcp__github__issue_write', 'closure-gate.js');
    const skillGate = entryFor(entries, 'Write|Edit', 'skill-gate.js');
    const marker = entryFor(entries, 'Skill', 'skill-marker.js');

    const plain = runEntry(bashGate, root, { session_id: newSession(), tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    assert.equal(plain.status, 0, `${fixture}: ${plain.stderr}`);
    assert.equal(plain.stdout, '');

    const sessionId = newSession();
    const blocked = runEntry(bashGate, root, { session_id: sessionId, tool_name: 'Bash', tool_input: { command: COMMIT } });
    assert.equal(blocked.status, 2, fixture);
    assert.match(blocked.stderr, /task-lifecycle/);

    for (const skill of ['task-lifecycle', ...BASE_SKILLS]) {
      const loaded = runEntry(marker, root, { session_id: sessionId, tool_name: 'Skill', tool_input: { skill } });
      assert.equal(loaded.status, 0, loaded.stderr);
    }
    const asked = runEntry(bashGate, root, { session_id: sessionId, tool_name: 'Bash', tool_input: { command: COMMIT } });
    assert.equal(asked.status, 0, `${fixture}: ${asked.stderr}`);
    assert.equal(asked.stdout.trim().split('\n').length, 1);
    const { hookSpecificOutput } = JSON.parse(asked.stdout);
    assert.equal(hookSpecificOutput.permissionDecision, 'ask');
    assert.match(hookSpecificOutput.permissionDecisionReason, /before committing/);

    const issue = runEntry(issueGate, root, { session_id: sessionId, tool_name: 'mcp__github__issue_write', tool_input: { method: 'update' } });
    assert.equal(issue.status, 2, fixture);
    assert.match(issue.stderr, /issues skill/);

    const file = path.join(root, 'src', 'a.ts');
    const editBlocked = runEntry(skillGate, root, { session_id: newSession(), tool_name: 'Edit', tool_input: { file_path: file } });
    assert.equal(editBlocked.status, 2, fixture);
    const editAllowed = runEntry(skillGate, root, { session_id: sessionId, tool_name: 'Edit', tool_input: { file_path: file } });
    assert.equal(editAllowed.status, 0, `${fixture}: ${editAllowed.stderr}`);
  }
});

test('installed lint and typecheck entries run their profile commands', (t) => {
  const entries = readmeEntries();
  for (const fixture of FIXTURE_PROFILES) {
    const log = path.join(elsewhere, `${fixture}-calls.txt`);
    const record = (tag) => ({
      paths: ['**/*.ts'],
      command: { argv: [process.execPath, '-e', `require('node:fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')`, log, `${tag} {file}`], cwd: '.' },
    });
    const root = consumer(t, fixture, { hooks: { lint: [record('lint')], typecheck: [record('typecheck')] } });
    const file = path.join(root, 'src', 'a b.ts');
    for (const script of ['lint.js', 'typecheck.js']) {
      const result = runEntry(entryFor(entries, 'Write|Edit', script), root, { session_id: 's', tool_name: 'Write', tool_input: { file_path: file } });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [`lint ${file}`, `typecheck ${file}`], fixture);
  }
});

test('gate entry blocks when package is missing', (t) => {
  const entries = readmeEntries();
  const gates = entries.filter((entry) => entry.command.endsWith('|| exit 2'));
  assert.equal(gates.length, 3);
  for (const fixture of FIXTURE_PROFILES) {
    const root = consumer(t, fixture, { installed: false });
    for (const command of ['ls', 'npm install']) {
      for (const gate of gates) {
        const result = runEntry(gate, root, { session_id: newSession(), tool_name: 'Bash', tool_input: { command, file_path: path.join(root, 'a.md') } });
        assert.equal(result.status, 2, `${fixture}: ${gate.matcher} ${command}`);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Cannot find module/);
      }
    }
  }
});

test('non-gate README entries never block on setup or marker errors', (t) => {
  const entries = readmeEntries();
  const helpers = entries.filter((entry) => entry.command.endsWith('|| true'));
  assert.equal(helpers.length, 3);
  for (const fixture of FIXTURE_PROFILES) {
    const missing = consumer(t, fixture, { installed: false });
    for (const helper of helpers) {
      const sessionId = newSession();
      const result = runEntry(helper, missing, { session_id: sessionId, tool_name: 'Skill', tool_input: { skill: 'issues', file_path: path.join(missing, 'a.ts') } });
      assert.equal(result.status, 0, `${fixture}: ${helper.command}`);
      assert.match(result.stderr, /Cannot find module/);
      assert.equal(fs.existsSync(markerPath(sessionId)), false);
    }

    const root = consumer(t, fixture);
    const marker = entryFor(entries, 'Skill', 'skill-marker.js');
    const fresh = newSession();
    for (const input of ['{not json', JSON.stringify({ session_id: fresh, tool_input: {} })]) {
      const result = runEntry(marker, root, input);
      assert.equal(result.status, 0);
      assert.match(result.stderr, /skill-marker:/);
    }
    assert.equal(fs.existsSync(markerPath(fresh)), false);
    const existing = newSession();
    fs.writeFileSync(markerPath(existing), '["issues"]');
    runEntry(marker, root, JSON.stringify({ session_id: existing, tool_input: { skill: 42 } }));
    assert.equal(fs.readFileSync(markerPath(existing), 'utf8'), '["issues"]');
  }
});
