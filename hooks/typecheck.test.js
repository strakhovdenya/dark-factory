'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');

const KIND = 'typecheck';
const OTHER = 'lint';
const HOOK = path.join(__dirname, `${KIND}.js`);
const APP_CWD = { monorepo: 'packages/billing', 'single-package': '.' };

/** A consumer root whose profile has distinct recorder commands in hooks.typecheck and hooks.lint. */
const consumer = (t, fixture, entries) => {
  const root = fs.realpathSync.native(profileCopy(t, fixture, (profile) => {
    profile.hooks = entries;
  }));
  fs.mkdirSync(path.join(root, ...APP_CWD[fixture].split('/')), { recursive: true });
  return root;
};

const recorder = (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${KIND}-hook-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'record.js');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    script,
    `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.argv[2] === 'fail') process.exit(1);\n`,
  );
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  const entry = (args, cwd = '.') => ({ paths: ['**/*.ts'], command: { argv: [process.execPath, script, ...args], cwd } });
  return { entry, calls };
};

/** Runs the real hook entrypoint with a Write event on stdin. */
const runHook = (root, file) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's', tool_name: 'Write', tool_input: { file_path: file } }),
    encoding: 'utf8',
    cwd: os.tmpdir(),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });

test('typecheck hook never blocks', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const rec = recorder(t);
    const root = consumer(t, fixture, {
      [KIND]: [
        { paths: ['**/*.ts'], command: { argv: ['factory-missing-binary-for-test', '{file}'], cwd: '.' } },
        rec.entry(['spawn-error'], 'directory-that-does-not-exist'),
        rec.entry(['fail', '{file}'], APP_CWD[fixture]),
        rec.entry(['after', '{file}'], APP_CWD[fixture]),
      ],
    });
    const file = path.join(root, 'src', 'a.ts');
    const result = runHook(root, file);
    assert.equal(result.status, 0, fixture);
    assert.equal(result.stdout, '', fixture);
    assert.match(result.stderr, new RegExp(`${KIND}: cannot run factory-missing-binary-for-test`));
    assert.match(result.stderr, new RegExp(`${KIND}: cannot run .* in .*directory-that-does-not-exist`));
    assert.match(result.stderr, new RegExp(`${KIND}: .* exited with code 1`));
    assert.deepEqual(rec.calls().map((call) => call.args), [['fail', file], ['after', file]], fixture);
  }
});

test('typecheck hook runs only profile typecheck entries in both profiles', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const rec = recorder(t);
    const cwd = APP_CWD[fixture];
    const root = consumer(t, fixture, {
      [KIND]: [rec.entry([`${KIND}-one`, '{file}'], cwd), rec.entry([`${KIND}-two`, '--strict'])],
      [OTHER]: [rec.entry([`${OTHER}-one`, '{file}'], cwd)],
    });
    const file = path.join(root, cwd, 'src', 'x.ts');
    const result = runHook(root, file);
    assert.equal(result.status, 0, result.stderr);
    const calls = rec.calls();
    assert.deepEqual(calls.map((call) => call.args), [[`${KIND}-one`, file], [`${KIND}-two`, '--strict']], fixture);
    assert.equal(fs.realpathSync.native(calls[0].cwd), path.join(root, cwd), fixture);
    assert.equal(fs.realpathSync.native(calls[1].cwd), root, fixture);
  }
});
