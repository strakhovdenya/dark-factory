'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
const { markerPath } = require('./skill-marker');

const HOOK = path.join(__dirname, 'closure-gate.js');
const SESSION_PREFIX = `closure-gate-test-${process.pid}`;

// Built at runtime so this file's own text never looks like a Git command to a closure hook.
const GIT = ['g', 'it'].join('');
const GH = ['g', 'h'].join('');
const COMMIT = `${GIT} commit -m x`;
const PUSH = `${GIT} push`;

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

/** @type {(input: object | string, options?: { root?: string, cwd?: string }) => import('node:child_process').SpawnSyncReturns<string>} */
const runHook = (input, { root, cwd } = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: cwd ?? os.tmpdir(),
    env: envWith(root),
  });

const validIssueBody = (extra = '') => `## Context
Description of the change.

## Affects
- \`src/x.js\`

## Docs to Read
- \`docs/x.md\`

## Key Invariants
- INV-1 The invariant holds.

## Acceptance Criteria
- [ ] AC-1 [behavior] Behavior is covered by a test. Verify: src/x.test.js "works"

## Test Requirement
- [ ] TR-1 [behavior] Regression is covered by a test. Verify: src/x.test.js "regression"

## Definition of Done
- [ ] DOD-1 [ci] CI check passes. Verify: ci "Test"

## Dependencies
None.
${extra}`;

// Missing every required section: invalid whatever the contract adds.
const invalidIssueBody = () => '## Acceptance Criteria\n- old criterion\n';

let bodies;
test.before(() => {
  bodies = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'closure-gate-bodies-')));
  fs.writeFileSync(path.join(bodies, 'ok.md'), validIssueBody());
  fs.writeFileSync(path.join(bodies, 'bad.md'), invalidIssueBody());
});
test.after(() => fs.rmSync(bodies, { recursive: true, force: true }));

const okBodyFile = () => path.join(bodies, 'ok.md');
const badBodyFile = () => path.join(bodies, 'bad.md');
const bash = (command, sessionId = newSession()) => ({
  session_id: sessionId,
  tool_name: 'Bash',
  cwd: bodies,
  tool_input: { command },
});
const mcp = (toolInput, sessionId = newSession()) => ({
  session_id: sessionId,
  tool_name: 'mcp__github__issue_write',
  cwd: bodies,
  tool_input: toolInput,
});
const ISSUE_CREATE_OK = () => `${GH} issue create --title t --body-file ${okBodyFile()}`;
const ISSUE_CREATE_BAD = () => `${GH} issue create --title t --body-file ${badBodyFile()}`;
const ISSUE_EDIT_OK = () => `${GH} issue edit 5 --body-file ${okBodyFile()}`;
const ISSUE_EDIT_BAD = () => `${GH} issue edit 5 --body-file ${badBodyFile()}`;

/** Runs `check(root, fixture)` on a temporary copy of each fixture profile. */
const forEachProfile = (t, check, mutate) => {
  for (const fixture of FIXTURE_PROFILES) check(profileCopy(t, fixture, mutate), fixture);
};

const assertAsk = (result, pattern, label) => {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Blocked/, label);
  const { hookSpecificOutput } = JSON.parse(result.stdout);
  assert.equal(hookSpecificOutput.hookEventName, 'PreToolUse', label);
  assert.equal(hookSpecificOutput.permissionDecision, 'ask', label);
  assert.match(hookSpecificOutput.permissionDecisionReason, pattern, label);
};

// The profile loader may print schema compiler warnings on stderr; a pass has no decision output.
const assertPass = (result, label) => {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stdout, '', label);
  assert.doesNotMatch(result.stderr, /Blocked/, label);
};

const assertSilentPass = (result, label) => {
  assertPass(result, label);
  assert.equal(result.stderr, '', label);
};

const assertBlocked = (result, pattern, label) => {
  assert.equal(result.status, 2, label);
  assert.equal(result.stdout, '', label);
  if (pattern) assert.match(result.stderr, pattern, label);
};

test('echo git commit is not intercepted', (t) => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-gate-broken-'));
  t.after(() => fs.rmSync(broken, { recursive: true, force: true }));
  fs.mkdirSync(path.join(broken, '.factory'));
  fs.writeFileSync(path.join(broken, '.factory', 'profile.json'), '{not json');
  const commands = [`echo ${COMMIT}`, `grep "${PUSH}" notes.md`, 'ls -la', `echo ${ISSUE_EDIT_OK()}`];
  // no root, a root without a profile and a root with an unreadable profile: none is read
  for (const root of [undefined, path.join(broken, 'missing'), broken]) {
    for (const command of commands) {
      assertSilentPass(runHook({ tool_name: 'Bash', tool_input: { command } }, { root }), `${root}: ${command}`);
      assertSilentPass(runHook(bash(command), { root }), `${root}: ${command} with session`);
    }
  }
});

test('commit without task-lifecycle is blocked', (t) => {
  forEachProfile(t, (root, fixture) => {
    for (const command of [COMMIT, PUSH]) {
      assertBlocked(runHook(bash(command), { root }), /task-lifecycle/, `${fixture}: ${command}`);
    }
    assertBlocked(runHook(bash(COMMIT, withMarker(['js-conventions'])), { root }), /task-lifecycle/, `${fixture}: other skill`);
  });
});

test('commit with task-lifecycle asks owner', (t) => {
  forEachProfile(t, (root, fixture) => {
    assertAsk(runHook(bash(COMMIT, withMarker(['task-lifecycle'])), { root }), /before committing/, `${fixture}: commit`);
    assertAsk(runHook(bash(PUSH, withMarker(['plugin:task-lifecycle'])), { root }), /Pre-push check/, `${fixture}: push`);
    assertAsk(runHook(bash(PUSH, withMarker(['task-lifecycle'])), { root }), /Pre-push check/, `${fixture}: plain push`);
  });
});

test('chained and option-prefixed invocations are still gated', (t) => {
  forEachProfile(t, (root) => {
    for (const command of [`cd repo && ${COMMIT}`, `${GIT} -C repo push origin main`, `FOO=1 ${COMMIT}`, `${GIT} add . ; ${COMMIT}`]) {
      assertBlocked(runHook(bash(command), { root }), /task-lifecycle/, command);
    }
  });
});

test('blocks without profile with message', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-gate-noprofile-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const invalid = profileCopy(t, 'single-package', (profile) => {
    profile.unknownField = true;
  });
  /** @type {Array<[string, RegExp]>} */
  const cases = [
    [empty, /Profile not found: expected .*profile\.json/],
    [invalid, /Invalid profile .*profile\.json[\s\S]*unknownField: unknown field/],
  ];
  for (const [root, pattern] of cases) {
    const events = [
      bash(COMMIT, withMarker(['task-lifecycle'])),
      bash(PUSH, withMarker(['task-lifecycle'])),
      bash(ISSUE_EDIT_OK(), withMarker(['issues'])),
      mcp({ method: 'create', body: validIssueBody() }, withMarker(['issues'])),
    ];
    for (const event of events) {
      const result = runHook(event, { root });
      assertBlocked(result, pattern, `${root}: ${event.tool_input.command ?? event.tool_name}`);
      assert.ok(result.stderr.includes(path.join(root, '.factory', 'profile.json')));
      assert.ok(!result.stdout.includes('permissionDecision'));
    }
  }
});

test('target operations need the consumer root and a session id', (t) => {
  const root = profileCopy(t, 'monorepo');
  assertBlocked(runHook(bash(COMMIT, withMarker(['task-lifecycle']))), /CLAUDE_PROJECT_DIR/, 'commit without root');
  assertBlocked(runHook(bash(ISSUE_EDIT_OK(), withMarker(['issues']))), /CLAUDE_PROJECT_DIR/, 'issue without root');
  assertBlocked(runHook({ tool_input: { command: COMMIT } }, { root }), /session_id/, 'commit without session');
  assertBlocked(runHook({ tool_input: { command: ISSUE_EDIT_OK() } }, { root }), /session_id/, 'issue without session');
  assertBlocked(runHook('{not json', { root }), /could not decide/, 'unparsable event');
});

test('issue create/edit without the issues skill is blocked', (t) => {
  forEachProfile(t, (root) => {
    for (const command of [ISSUE_EDIT_OK(), ISSUE_CREATE_OK()]) {
      assertBlocked(runHook(bash(command), { root }), /issues skill/, command);
      assertBlocked(runHook(bash(command, withMarker(['task-lifecycle'])), { root }), /issues skill/, `${command} other skill`);
    }
    assertBlocked(runHook(mcp({ method: 'create', body: validIssueBody() }), { root }), /issues skill/, 'mcp');
  });
});

test('valid issue body passes', (t) => {
  forEachProfile(t, (root, fixture) => {
    for (const skills of [['issues'], ['plugin:issues']]) {
      for (const command of [ISSUE_EDIT_OK(), ISSUE_CREATE_OK(), `${GH} issue edit 5 -F${okBodyFile()}`]) {
        assertPass(runHook(bash(command, withMarker(skills)), { root }), `${fixture}: ${command}`);
      }
      assertPass(runHook(mcp({ method: 'create', body: validIssueBody() }, withMarker(skills)), { root }), 'mcp create');
      assertPass(runHook(mcp({ method: 'update', body: validIssueBody() }, withMarker(skills)), { root }), 'mcp update');
    }
    // metadata only: no body is sent, so none is checked
    assertPass(runHook(bash(`${GH} issue edit 5 --add-label x`, withMarker(['issues'])), { root }), 'edit labels');
    assertPass(runHook(mcp({ method: 'update', labels: ['x'] }, withMarker(['issues'])), { root }), 'mcp update labels');
  });
});

test('invalid issue body is blocked', (t) => {
  forEachProfile(t, (root, fixture) => {
    for (const command of [ISSUE_CREATE_BAD(), ISSUE_EDIT_BAD(), `${GH} issue edit 5 -F${badBodyFile()}`]) {
      const result = runHook(bash(command, withMarker(['issues'])), { root });
      assertBlocked(result, /issue-lint[\s\S]*legacy format is not allowed/, `${fixture}: ${command}`);
    }
    for (const toolInput of [
      { method: 'create', body: invalidIssueBody() },
      { method: 'create' },
      { method: 'update', body: invalidIssueBody() },
      { method: 'update', body: '' },
    ]) {
      assertBlocked(runHook(mcp(toolInput, withMarker(['issues'])), { root }), /issue-lint/, JSON.stringify(toolInput));
    }
  });
});

test('uses consumer overlay independently of cwd', (t) => {
  const writeOverlay = (root, text) => {
    fs.mkdirSync(path.join(root, '.github', 'verifier'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'verifier', 'issue-contract.overlay.json'), text);
  };
  const overlay = JSON.stringify({ sections: [{ title: 'Rollout', required: true }] });
  forEachProfile(t, (root, fixture) => {
    writeOverlay(root, overlay);
    const cwd = path.join(root, 'nested', 'dir');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'with.md'), validIssueBody('\n## Rollout\nStep by step.\n'));
    fs.writeFileSync(path.join(cwd, 'without.md'), validIssueBody());
    const event = (file) => ({ ...bash(`${GH} issue create --title t --body-file ${file}`, withMarker(['issues'])), cwd });

    assertBlocked(runHook(event('without.md'), { root, cwd }), /Rollout/, `${fixture}: missing overlay section`);
    assertPass(runHook(event('with.md'), { root, cwd }), `${fixture}: overlay section present`);
    const mcpEvent = mcp({ method: 'create', body: validIssueBody() }, withMarker(['issues']));
    assertBlocked(runHook(mcpEvent, { root, cwd }), /Rollout/, `${fixture}: mcp without section`);

    for (const [text, pattern] of [
      ['{not json', /overlay .*issue-contract\.overlay\.json is invalid.*not valid JSON/],
      [JSON.stringify({ removeSections: ['Affects'] }), /overlay .* is invalid: cannot remove base section: Affects/],
    ]) {
      writeOverlay(root, text);
      assertBlocked(runHook(event('with.md'), { root, cwd }), pattern, `${fixture}: ${text}`);
      assertBlocked(runHook(event('without.md'), { root, cwd }), pattern, `${fixture}: ${text}, core-only body`);
    }
    // a metadata-only edit does not need the contract
    assertPass(runHook({ ...bash(`${GH} issue edit 5 --add-label x`, withMarker(['issues'])), cwd }, { root, cwd }), 'labels');
  });
});

test('preserves transferred issue body restrictions', (t) => {
  const root = profileCopy(t, 'monorepo');
  const run = (command) => runHook(bash(command, withMarker(['issues'])), { root });

  // inline body, no body file, stdin
  for (const command of [
    `${GH} issue create --title t --body "inline text"`,
    `${GH} issue create --title t`,
    `${GH} issue create --title t --body-file -`,
    `${GH} issue create --title t -bSomeInlineText`,
    `${GH} issue edit 5 --body "inline text"`,
    `${GH} issue create --title t --body-file ${okBodyFile()} --body "inline text"`,
    `${GH} issue edit 5 --body-file ${okBodyFile()} --body "inline text"`,
    `${GH} issue edit 5 --body-file=${okBodyFile()} --body=inline`,
  ]) {
    assertBlocked(run(command), /--body-file/, command);
  }

  // gh.exe and absolute gh paths are recognized
  for (const command of [`${GH}.exe issue edit 1 -F${badBodyFile()}`, `/usr/bin/${GH} issue create --title t`, `C:\\tools\\${GH}.exe issue edit 1 -b x`]) {
    assertBlocked(run(command), null, command);
    assertBlocked(runHook(bash(command), { root }), /issues skill/, `${command} without skill`);
  }
  assertPass(run(`${GH}.exe issue edit 1 --body-file=${okBodyFile()}`), 'gh.exe with --body-file=');

  // chained and env-prefixed issue writes are still gated
  for (const command of [`cd repo && ${ISSUE_EDIT_OK()}`, `FOO=1 ${ISSUE_CREATE_OK()}`, `${GH} issue view 1 | cat ; ${ISSUE_EDIT_OK()}`]) {
    assertBlocked(runHook(bash(command), { root }), /issues skill/, command);
    assertPass(run(command), `${command} with skill`);
  }

  // other issue commands and mere mentions pass through
  for (const command of [`${GH} issue comment 1 --body x`, `${GH} issue view 1`, `${GH} issue list --state open`, `grep "${ISSUE_CREATE_OK()}" notes.md`]) {
    assertSilentPass(runHook(bash(command), { root }), command);
  }

  // a missing file and a file outside the cwd and the temp directory
  assertBlocked(run(`${GH} issue create --title t --body-file ${path.join(bodies, 'missing.md')}`), /could not verify/, 'missing');
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
  assertBlocked(run(`${GH} issue create --title t --body-file ${outside}`), /outside the allowed roots/, 'outside');
});

test('a symlink inside an allowed root pointing outside it is blocked', (t) => {
  const root = profileCopy(t, 'single-package');
  const outsideDir = fs.mkdtempSync(path.join(os.homedir(), 'closure-gate-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outsideFile = path.join(outsideDir, 'secret.md');
  fs.writeFileSync(outsideFile, validIssueBody());
  const link = path.join(bodies, `outside-link-${process.pid}.md`);
  t.after(() => fs.rmSync(link, { force: true }));
  try {
    fs.symlinkSync(outsideFile, link, 'file');
  } catch (error) {
    t.skip(`symlinks cannot be created here: ${error.message}`);
    return;
  }
  const result = runHook(bash(`${GH} issue create --title t --body-file ${link}`, withMarker(['issues'])), { root });
  assertBlocked(result, /outside the allowed roots/, 'symlink');
});

test('a Git-Bash POSIX-style --body-file path is normalized on win32', { skip: process.platform !== 'win32' && 'win32 only' }, (t) => {
  const root = profileCopy(t, 'monorepo');
  const file = okBodyFile();
  const posixPath = `/${file[0].toLowerCase()}${file.slice(2).replace(/\\/g, '/')}`;
  const result = runHook(bash(`${GH} issue create --title t --body-file ${posixPath}`, withMarker(['issues'])), { root });
  assertPass(result, posixPath);
});

test('a damaged marker blocks closure operations', (t) => {
  const root = profileCopy(t, 'monorepo');
  for (const text of ['{not json', JSON.stringify({ issues: true, 'task-lifecycle': true }), JSON.stringify(['issues', 5, 'task-lifecycle'])]) {
    for (const event of [bash(COMMIT), bash(ISSUE_EDIT_OK()), mcp({ method: 'create', body: validIssueBody() })]) {
      fs.writeFileSync(markerPath(event.session_id), text);
      assertBlocked(runHook(event, { root }), /skill marker/, `${text}: ${event.tool_input.command ?? 'mcp'}`);
    }
  }
});
