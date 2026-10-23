'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
const { consumerPath, substituteFile } = require('./commands');
const lintHook = require('./lint');
const typecheckHook = require('./typecheck');

// Command working directory per fixture: an app of the monorepo, the root of the single package.
const APP_CWD = { monorepo: 'packages/billing', 'single-package': '.' };

/** A recorder program: appends its arguments and cwd to calls.jsonl, exits with RECORDER_EXIT for "fail". */
const makeRecorder = (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-recorder-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'recorder.js');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    script,
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'fail') { process.stderr.write('recorder failed on purpose'); process.exit(3); }
`,
  );
  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const entry = (paths, args, cwd = '.') => ({ paths, command: { argv: [process.execPath, script, ...args], cwd } });
  return { calls, entry, log };
};

/** A consumer root with the given hooks section and the app directory of the fixture. */
const consumer = (t, fixture, hooks) => {
  const root = fs.realpathSync.native(
    profileCopy(t, fixture, (profile) => {
      if (hooks !== undefined) profile.hooks = hooks;
    }),
  );
  fs.mkdirSync(path.join(root, ...APP_CWD[fixture].split('/')), { recursive: true });
  return root;
};

const event = (filePath) => JSON.stringify({ session_id: 's', tool_name: 'Edit', tool_input: { file_path: filePath } });

/** Runs a hook handler in-process with real child processes and collects its diagnostics. */
const runHandler = (hook, root, filePath) => {
  const reports = [];
  hook.handle(event(filePath), { env: { CLAUDE_PROJECT_DIR: root }, report: (line) => reports.push(line) });
  return reports;
};

const real = (value) => fs.realpathSync.native(value);

test('substitutes absolute file path in every argv occurrence', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const recorder = makeRecorder(t);
    const cwd = APP_CWD[fixture];
    const root = consumer(t, fixture, {
      lint: [recorder.entry(['**/*.ts'], ['lint', '{file}', '--file={file}', 'x{file}y{file}', '{file}'], cwd)],
    });
    const file = path.join(root, 'src', 'a.ts');
    assert.deepEqual(runHandler(lintHook, root, file), []);
    const [call] = recorder.calls();
    assert.deepEqual(call.args, ['lint', file, `--file=${file}`, `x${file}y${file}`, file], fixture);
    assert.equal(real(call.cwd), real(path.join(root, cwd)), fixture);
    assert.deepEqual(substituteFile(['{file}{file}', 'plain'], 'P'), ['PP', 'plain']);
  }
});

test('leaves project command arguments unchanged', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const recorder = makeRecorder(t);
    const cwd = APP_CWD[fixture];
    const root = consumer(t, fixture, { typecheck: [recorder.entry(['**/*.ts'], ['tc', '--noEmit', '-p', 'tsconfig.json'], cwd)] });
    assert.deepEqual(runHandler(typecheckHook, root, path.join(root, cwd, 'src', 'b.ts')), []);
    const calls = recorder.calls();
    assert.equal(calls.length, 1, fixture);
    assert.deepEqual(calls[0].args, ['tc', '--noEmit', '-p', 'tsconfig.json'], fixture);
    assert.equal(real(calls[0].cwd), real(path.join(root, cwd)), fixture);
  }
});

test('runs all matching entries once and continues after failure', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const recorder = makeRecorder(t);
    const root = consumer(t, fixture, {
      lint: [
        recorder.entry(['**/*.ts', 'src/**', 'src/*.ts'], ['first']),
        { paths: ['**/*.ts'], command: { argv: ['factory-missing-binary-for-test', '{file}'], cwd: '.' } },
        recorder.entry(['src/*.ts'], ['fail']),
        recorder.entry(['docs/**'], ['not-matching']),
        recorder.entry(['src/{a,b}.ts'], ['last']),
      ],
    });
    const reports = runHandler(lintHook, root, path.join(root, 'src', 'a.ts'));
    assert.deepEqual(recorder.calls().map((call) => call.args[0]), ['first', 'fail', 'last'], fixture);
    assert.equal(reports.length, 2, reports.join('\n'));
    assert.match(reports[0], /^lint: cannot run factory-missing-binary-for-test in /);
    assert.match(reports[1], /^lint: .* exited with code 3 in [\s\S]*recorder failed on purpose/);
  }
});

test('matches declared glob dialect in both fixture profiles', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const recorder = makeRecorder(t);
    const root = consumer(t, fixture, {
      lint: [
        recorder.entry(['*.ts'], ['root-only']),
        recorder.entry(['src/**/*.ts'], ['src-deep']),
        recorder.entry(['{lib,tools}/*.{js,cjs}'], ['brace']),
        recorder.entry(['**/*.ts'], ['any-ts']),
        recorder.entry(['packages/billing/**'], ['billing']),
      ],
    });
    /** @type {Array<[string, string[]]>} */
    const cases = [
      ['x.ts', ['root-only', 'any-ts']],
      ['src/a.ts', ['src-deep', 'any-ts']],
      ['src/deep/er/b.ts', ['src-deep', 'any-ts']],
      ['.config/hidden.ts', ['any-ts']],
      ['src/.hidden/c.ts', ['src-deep', 'any-ts']],
      ['lib/x.js', ['brace']],
      ['tools/y.cjs', ['brace']],
      ['lib/deep/x.js', []],
      ['lib/x.mjs', []],
      ['x.tsx', []],
      ['SRC/a.ts', ['any-ts']],
      ['packages/billing/a.md', ['billing']],
      ['packages/storefront/a.md', []],
    ];
    for (const [relative, expected] of cases) {
      const before = recorder.calls().length;
      runHandler(lintHook, root, path.join(root, ...relative.split('/')));
      assert.deepEqual(recorder.calls().slice(before).map((call) => call.args[0]), expected, `${fixture}: ${relative}`);
    }
  }
});

test('preserves special characters in file arguments', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const recorder = makeRecorder(t);
    const root = consumer(t, fixture, { lint: [recorder.entry(['**'], ['lint', '{file}', '--path={file}'])] });
    const names = [['dir with spaces', 'a b.ts'], ['## Definition of Done', 'it; echo $HOME `x`.md'], ['q', "it's \"quoted\" & | > <.ts"]];
    if (process.platform === 'win32') names.pop();
    for (const parts of names) {
      const file = path.join(root, ...parts);
      runHandler(lintHook, root, file);
      const call = recorder.calls().at(-1);
      assert.deepEqual(call.args, ['lint', file, `--path=${file}`], `${fixture}: ${file}`);
    }
    if (process.platform === 'win32') {
      const flipped = root[0] === root[0].toLowerCase() ? root[0].toUpperCase() + root.slice(1) : root[0].toLowerCase() + root.slice(1);
      const file = `${flipped}\\sub dir\\c.ts`;
      runHandler(lintHook, root, file);
      assert.deepEqual(recorder.calls().at(-1).args, ['lint', file, `--path=${file}`], `${fixture}: drive case`);
    }
  }
});

test('ignores file outside consumer root', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const recorder = makeRecorder(t);
    const root = consumer(t, fixture, {
      lint: [recorder.entry(['**'], ['lint', '{file}', 'Keep-Case'])],
      typecheck: [recorder.entry(['**'], ['typecheck'])],
    });
    const outside = [path.join(path.dirname(root), 'other', 'a.ts'), `${root}-sibling${path.sep}a.ts`];
    if (process.platform === 'win32') outside.push(`${root[0].toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\project\\a.ts`);
    for (const file of outside) {
      for (const hook of [lintHook, typecheckHook]) assert.deepEqual(runHandler(hook, root, file), [], file);
      assert.equal(consumerPath(root, file), null, file);
    }
    assert.deepEqual(recorder.calls(), [], fixture);

    // the same root spelled with the other drive letter case is still inside on win32
    if (process.platform === 'win32') {
      const flipped = root[0] === root[0].toLowerCase() ? root[0].toUpperCase() + root.slice(1) : root[0].toLowerCase() + root.slice(1);
      const file = path.join(flipped, 'src', 'Mixed.ts');
      runHandler(lintHook, root, file);
      assert.deepEqual(recorder.calls().at(-1).args, ['lint', file, 'Keep-Case']);
      assert.equal(consumerPath(root, file).relative, 'src/Mixed.ts');
    }
  }
});

test('inactive or invalid hook configuration never runs commands', (t) => {
  const listFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  const packageFilesBefore = listFiles(__dirname);
  for (const fixture of FIXTURE_PROFILES) {
    const recorder = makeRecorder(t);
    const variants = [
      ['no hooks', consumer(t, fixture)],
      ['empty arrays', consumer(t, fixture, { lint: [], typecheck: [] })],
      ['no match', consumer(t, fixture, { lint: [recorder.entry(['docs/**'], ['x'])], typecheck: [recorder.entry(['*.md'], ['y'])] })],
    ];
    const missing = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-noprofile-')));
    t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
    variants.push(['missing profile', missing]);
    const invalid = consumer(t, fixture, { lint: [recorder.entry(['**'], ['x'])] });
    fs.writeFileSync(path.join(invalid, '.factory', 'profile.json'), JSON.stringify({ hooks: { lint: [recorder.entry(['**'], ['x'])] } }));
    variants.push(['invalid profile', invalid]);
    variants.push(['no root', undefined]);

    for (const [label, root] of variants) {
      const filesBefore = root ? listFiles(root) : [];
      for (const hook of ['lint.js', 'typecheck.js']) {
        const env = { ...process.env };
        delete env.CLAUDE_PROJECT_DIR;
        if (root) env.CLAUDE_PROJECT_DIR = root;
        const file = path.join(root ?? os.tmpdir(), 'src', 'a.ts');
        const result = spawnSync(process.execPath, [path.join(__dirname, hook)], { input: event(file), encoding: 'utf8', cwd: os.tmpdir(), env });
        assert.equal(result.status, 0, `${fixture} ${label} ${hook}`);
        assert.equal(result.stdout, '', `${fixture} ${label} ${hook}`);
        if (['missing profile', 'invalid profile', 'no root'].includes(label)) assert.match(result.stderr, /not run/);
      }
      if (root) assert.deepEqual(listFiles(root), filesBefore, `${fixture} ${label}: no diagnostic files`);
    }
    assert.deepEqual(recorder.calls(), [], fixture);
  }
  assert.deepEqual(listFiles(__dirname), packageFilesBefore, 'no diagnostic files in the package');
});
