'use strict';

// Real git on temporary repositories: the factory is a bare repository that holds the tags (the
// project's pin names it through a git insteadOf rule), the project has its own bare origin. npm and
// the scripts of the installed release (setup, doctor) are replaced at the process boundary, so
// nothing is downloaded. No network, no Docker, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const { REPO_ROOT } = require('../test/helpers/factory-package');
const { tempDir, isolateGit, gitIn, writeFiles } = require('../test/helpers/ralph');
const { main, parseArgs } = require('./pin');

const TAG = 'v0.1.1';
const OLD_SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const REPOSITORY = 'acme/dark-factory';
const OLD_SPEC = `github:${REPOSITORY}#v0.1.0`;
const VERIFIER = '.github/workflows/acceptance-verifier.yml';
const APPROVAL = '.github/workflows/spec-approval.yml';
const PROFILES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'profiles');

const NEW_BASE_SET = { processSkills: [{ name: 'prd' }, { name: 'issues' }], jsMetaskills: [{ name: 'js-gof' }], agents: [{ name: 'verify' }, { name: 'research' }] };
const IGNORE_OLD = ['node_modules/', '# copies of the factory', '.claude/.factory-installed.json', '.claude/skills/prd', '.claude/skills/js-gof', '.claude/agents/verify.md', ''].join('\n');

const packageText = (spec = OLD_SPEC, field = 'devDependencies') => `${JSON.stringify({ name: 'consumer', version: '1.0.0', [field]: { 'dark-factory': spec } }, null, 2)}\n`;
const lockText = (sha = OLD_SHA) => `${JSON.stringify({ packages: { 'node_modules/dark-factory': { resolved: `git+ssh://git@github.com/${REPOSITORY}.git#${sha}` } } }, null, 2)}\n`;
const workflowText = (usesSha = OLD_SHA, factorySha = usesSha, repository = REPOSITORY) =>
  ['name: Wrapper', 'jobs:', '  call:', `    uses: ${repository}/.github/workflows/reusable.yml@${usesSha}`, '    with:', `      factory-sha: ${factorySha}`, ''].join('\n');
const profileOf = (fixture, mutate) => {
  const profile = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, fixture, '.factory', 'profile.json'), 'utf8'));
  if (mutate) mutate(profile);
  return JSON.stringify(profile);
};
const posix = (target) => target.split(path.sep).join('/');

/**
 * The factory repository (bare, with the tag of the new release), a project with its own origin, and
 * the operator's clone of the project whose git config sends the pin's GitHub URL to the factory.
 */
const makeProject = (t, fixture, { files = {}, tag = 'annotated', stale = false, detachedHead = false } = {}) => {
  isolateGit(t);
  const scratch = tempDir(t, 'pin-');
  const factory = path.join(scratch, 'factory.git');
  const factoryWork = path.join(scratch, 'factory-work');
  gitIn(scratch, 'init', '-q', '--bare', '-b', 'main', factory);
  gitIn(scratch, 'clone', '-q', factory, factoryWork);
  writeFiles(factoryWork, { 'package.json': '{}\n' });
  gitIn(factoryWork, 'add', '-A');
  gitIn(factoryWork, 'commit', '-qm', 'the release');
  gitIn(factoryWork, 'push', '-q', 'origin', 'main');
  const tagSha = gitIn(factoryWork, 'rev-parse', 'HEAD');
  if (tag !== 'none') {
    if (tag === 'annotated') gitIn(factoryWork, 'tag', '-a', TAG, '-m', TAG);
    else gitIn(factoryWork, 'tag', TAG);
    gitIn(factoryWork, 'push', '-q', 'origin', `refs/tags/${TAG}`);
  }

  const origin = path.join(scratch, 'origin.git');
  const author = path.join(scratch, 'author');
  const operator = path.join(scratch, 'operator');
  gitIn(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  gitIn(scratch, 'clone', '-q', origin, author);
  writeFiles(author, {
    'package.json': packageText(),
    'package-lock.json': lockText(),
    '.gitignore': IGNORE_OLD,
    '.factory/profile.json': profileOf(fixture),
    [VERIFIER]: workflowText(),
    [APPROVAL]: workflowText(),
    ...(fixture === 'monorepo' ? { 'packages/api/package.json': '{}\n', 'packages/web/package.json': '{}\n' } : { 'src/index.js': '\n' }),
    ...files,
  });
  gitIn(author, 'add', '-A');
  gitIn(author, 'commit', '-qm', 'pinned to the first release');
  gitIn(author, 'push', '-q', 'origin', 'main');
  gitIn(scratch, 'clone', '-q', origin, operator);
  if (stale) {
    writeFiles(author, { 'newer.txt': 'a newer commit on the default branch\n' });
    gitIn(author, 'add', '-A');
    gitIn(author, 'commit', '-qm', 'newer');
    gitIn(author, 'push', '-q', 'origin', 'main');
  }
  gitIn(operator, 'config', `url.${posix(factory)}.insteadOf`, `https://github.com/${REPOSITORY}.git`);
  if (detachedHead) gitIn(operator, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  return { operator, tagSha, head: () => gitIn(operator, 'rev-parse', 'HEAD') };
};

/**
 * The setup module of the new release as the command loads it: its planner lists the copies the base
 * set and the profile's extraMetaskills ask for.
 */
const plannerStub = (operator, fails) => {
  let extra = [];
  try {
    extra = JSON.parse(fs.readFileSync(path.join(operator, '.factory', 'profile.json'), 'utf8')).extraMetaskills || [];
  } catch {
    // no profile: no extra skills
  }
  const skills = [...NEW_BASE_SET.processSkills, ...NEW_BASE_SET.jsMetaskills].map((entry) => entry.name).concat(extra);
  const wanted = [...skills.map((name) => ({ destination: `.claude/skills/${name}`, kind: 'skill' })), ...NEW_BASE_SET.agents.map((entry) => ({ destination: `.claude/agents/${entry.name}.md`, kind: 'agent' }))];
  const body = fails ? "throw new Error('Profile not found: expected the planner to fail');" : `module.exports = { MANIFEST_PATH: '.claude/.factory-installed.json', inspectPlan: () => ({ wanted: ${JSON.stringify(wanted)}, problems: [] }) };`;
  return `'use strict';
${body}
`;
};

/** Text of the files the command may touch. */
const pinned = (operator, extra = []) =>
  Object.fromEntries(['package.json', 'package-lock.json', '.gitignore', VERIFIER, APPROVAL, ...extra].map((file) => [file, fs.readFileSync(path.join(operator, file), 'utf8')]));

/**
 * Runs the command in the project. npm rewrites the pin like the real one would (the lock gets
 * `lockSha`, the tag commit by default, and the new release's base set is installed); setup and
 * doctor are recorded and answer with the given statuses.
 * @param {{ operator: string, tagSha: string }} project
 * @param {string[]} argv
 * @param {{ lockSha?: string, npmFails?: boolean, setupStatus?: number, doctorStatus?: number, doctorStderr?: string, setupTouches?: string, plannerFails?: boolean }} [options]
 */
const run = (project, argv, { lockSha = project.tagSha, npmFails = false, setupStatus = 0, doctorStatus = 0, doctorStderr = '', setupTouches = '', plannerFails = false } = {}) => {
  const calls = [];
  /** @type {any} */
  const spawn = (file, args, options) => {
    if (file === 'git') return childProcess.spawnSync(file, args, options);
    const script = path.basename(args[0]);
    if (script === 'npm-cli.js') {
      calls.push(['npm', ...args.slice(1)]);
      if (npmFails) return { status: 1, stdout: '', stderr: 'npm failed' };
      const spec = args[args.length - 1];
      const field = args.includes('--save-prod') ? 'dependencies' : 'devDependencies';
      fs.writeFileSync(path.join(project.operator, 'package.json'), packageText(spec, field));
      fs.writeFileSync(path.join(project.operator, 'package-lock.json'), lockText(lockSha));
      writeFiles(project.operator, { 'node_modules/dark-factory/bin/setup.js': plannerStub(project.operator, plannerFails) });
      return { status: 0, stdout: '', stderr: '' };
    }
    calls.push([script, ...args.slice(1)]);
    if (script === 'setup.js') {
      if (setupTouches !== '') fs.appendFileSync(path.join(project.operator, setupTouches), 'changed by setup\n');
      return { status: setupStatus, stdout: '', stderr: setupStatus === 0 ? '' : 'setup refused' };
    }
    return { status: doctorStatus, stdout: doctorStatus === 0 ? 'No problems found.' : '- label: missing', stderr: doctorStderr };
  };
  const lines = [];
  const errors = [];
  const code = main(argv, { cwd: project.operator, spawn, log: (line) => lines.push(line), logError: (line) => errors.push(line) });
  return { code, out: lines.join('\n'), err: errors.join('\n'), calls };
};

const scenarioTest = (name, body) =>
  test(name, async (t) => {
    for (const fixture of FIXTURE_PROFILES) await t.test(fixture, (sub) => body(sub, fixture));
  });

scenarioTest('pins the tag in both project forms', (t, fixture) => {
  for (const tag of ['annotated', 'lightweight']) {
    const project = makeProject(t, fixture, { tag });
    const headBefore = project.head();
    const tagsBefore = gitIn(project.operator, 'tag', '--list');
    const result = run(project, [TAG]);
    assert.equal(result.code, 0, result.err);

    const after = pinned(project.operator);
    assert.equal(JSON.parse(after['package.json']).devDependencies['dark-factory'], `github:${REPOSITORY}#${TAG}`);
    assert.ok(after['package-lock.json'].includes(`#${project.tagSha}"`));
    for (const workflow of [VERIFIER, APPROVAL]) {
      assert.equal(after[workflow], workflowText(project.tagSha), workflow);
      assert.ok(!after[workflow].includes(OLD_SHA), `${workflow}: no old pin is left`);
    }
    assert.equal(after['.gitignore'], `${IGNORE_OLD}.claude/skills/issues\n.claude/agents/research.md\n`, 'the lines of the new base set are added');
    assert.deepEqual(result.calls[0], ['npm', 'install', '--ignore-scripts', '--save-dev', `github:${REPOSITORY}#${TAG}`]);
    assert.deepEqual(result.calls.slice(1), [['setup.js', '--consumer-root', project.operator], ['doctor.js', 'doctor', project.operator]]);
    assert.match(result.out, /No problems found\./);
    assert.match(result.out, new RegExp(`${TAG} is pinned`));
    assert.match(result.out, /added to \.gitignore: \.claude\/skills\/issues, \.claude\/agents\/research\.md/);

    assert.equal(project.head(), headBefore, 'nothing is committed');
    assert.equal(gitIn(project.operator, 'tag', '--list'), tagsBefore, 'no tag is created or moved');
    assert.deepEqual(gitIn(project.operator, 'diff', '--name-only').split('\n').sort(), ['.gitignore', APPROVAL, VERIFIER, 'package-lock.json', 'package.json'].sort());
  }
});

scenarioTest('refuses without changing files when a precondition fails', async (t, fixture) => {
  /** @type {[string, string, any, string[]?][]} */
  const cases = [
    ['malformed tag', 'vX.Y.Z', {}, ['v0.1']],
    ['already pinned', 'already pinned', {}, ['v0.1.0']],
    ['pin is not a tag', 'is not github:<owner>/<name>#vX.Y.Z', { files: { 'package.json': packageText(`github:${REPOSITORY}#main`) } }],
    ['no workflow calls the release', 'no workflow in .github/workflows calls acme/dark-factory', { files: { [VERIFIER]: workflowText(OLD_SHA, OLD_SHA, 'other/project'), [APPROVAL]: workflowText(OLD_SHA, OLD_SHA, 'other/project') } }],
    ['default branch unknown', 'default branch of origin is unknown', { detachedHead: true }],
    ['branch behind origin', 'does not contain origin/main', { stale: true }],
    ['tag not published', `tag ${TAG} is not published in ${REPOSITORY}`, { tag: 'none' }],
  ];
  for (const [label, mention, options, argv] of cases) {
    await t.test(label, (sub) => {
      const project = makeProject(sub, fixture, options);
      const before = pinned(project.operator);
      const result = run(project, argv || [TAG]);
      assert.equal(result.code, 1, label);
      assert.ok(result.err.includes(mention), `${label}: ${result.err}`);
      assert.deepEqual(pinned(project.operator), before);
      assert.deepEqual(result.calls, [], 'neither npm nor the release scripts ran');
    });
  }

  await t.test('dirty working tree', (sub) => {
    const project = makeProject(sub, fixture);
    writeFiles(project.operator, { 'notes.txt': 'unrelated work\n' });
    const before = pinned(project.operator);
    const result = run(project, [TAG]);
    assert.equal(result.code, 1);
    assert.ok(result.err.includes('working tree is not clean'), result.err);
    assert.deepEqual(pinned(project.operator), before);
    assert.deepEqual(result.calls, []);
  });

  await t.test('not a git repository', (sub) => {
    const outside = tempDir(sub, 'pin-outside-');
    const errors = [];
    assert.equal(main([TAG], { cwd: outside, log: () => {}, logError: (line) => errors.push(line) }), 1);
    assert.match(errors.join('\n'), /is not inside a git repository/);
  });
});

scenarioTest('refuses a tag that is not published', (t, fixture) => {
  const project = makeProject(t, fixture, { tag: 'none' });
  const before = pinned(project.operator);
  const result = run(project, [TAG]);
  assert.equal(result.code, 1);
  assert.ok(result.err.includes(`tag ${TAG} is not published in ${REPOSITORY}`), result.err);
  assert.deepEqual(pinned(project.operator), before);
  assert.deepEqual(result.calls, []);
  assert.equal(run(project, [TAG, '--base', 'main']).code, 1, 'an explicit base does not skip the check');
});

scenarioTest('refuses workflows whose pins disagree', async (t, fixture) => {
  /** @type {[string, Record<string, string>, string][]} */
  const cases = [
    ['uses and factory-sha differ', { [VERIFIER]: workflowText(OLD_SHA, OTHER_SHA) }, `uses ${OLD_SHA} but factory-sha is ${OTHER_SHA}`],
    ['the workflows pin different commits', { [APPROVAL]: workflowText(OTHER_SHA) }, 'the workflows pin different commits'],
    ['a call without factory-sha', { [APPROVAL]: workflowText().replace(/\n {6}factory-sha: [0-9a-f]{40}/, '') }, 'each call needs one'],
  ];
  for (const [label, files, mention] of cases) {
    await t.test(label, (sub) => {
      const project = makeProject(sub, fixture, { files });
      const before = pinned(project.operator);
      const result = run(project, [TAG]);
      assert.equal(result.code, 1);
      assert.ok(result.err.includes(mention), result.err);
      assert.deepEqual(pinned(project.operator), before);
      assert.deepEqual(result.calls, []);
    });
  }
});

scenarioTest('restores the pin when npm fails or locks another commit', async (t, fixture) => {
  for (const [label, options, mention] of /** @type {[string, any, string][]} */ ([
    ['npm fails', { npmFails: true }, 'npm install'],
    ['lock holds another commit', { lockSha: OTHER_SHA }, `the lock holds ${OTHER_SHA}`],
  ])) {
    await t.test(label, (sub) => {
      const project = makeProject(sub, fixture);
      const before = pinned(project.operator);
      const result = run(project, [TAG], options);
      assert.equal(result.code, 1);
      assert.ok(result.err.includes(mention), result.err);
      assert.ok(result.err.includes('restored: package.json, package-lock.json') && result.err.includes('npm ci'), result.err);
      assert.deepEqual(pinned(project.operator), before, 'package.json, the lock, .gitignore and the workflows are as before');
      assert.ok(!result.calls.some(([script]) => script === 'setup.js'), 'setup did not run');
    });
  }
});

scenarioTest('adds only missing gitignore lines of the base set', (t, fixture) => {
  // existing lines in another form, a custom line and no trailing newline: nothing is rewritten or duplicated
  const custom = 'node_modules/\n/.claude/.factory-installed.json\n.claude/skills/prd/\n/.claude/skills/js-gof\n.claude/agents/verify.md\n!keep-me\n# my own\n.cache/';
  const project = makeProject(t, fixture, { files: { '.gitignore': custom, '.factory/profile.json': profileOf(fixture, (profile) => (profile.extraMetaskills = ['extra-skill'])) } });
  const result = run(project, [TAG]);
  assert.equal(result.code, 0, result.err);
  assert.equal(fs.readFileSync(path.join(project.operator, '.gitignore'), 'utf8'), `${custom}\n.claude/skills/issues\n.claude/skills/extra-skill\n.claude/agents/research.md\n`);

  const complete = makeProject(t, fixture, { files: { '.gitignore': `${IGNORE_OLD}.claude/skills/issues\n.claude/agents/research.md\n` } });
  const quiet = run(complete, [TAG]);
  assert.equal(quiet.code, 0, quiet.err);
  assert.ok(!quiet.out.includes('added to .gitignore'), quiet.out);
  assert.ok(!gitIn(complete.operator, 'diff', '--name-only').includes('.gitignore'), 'an up-to-date .gitignore is not touched');
});

scenarioTest('moves every workflow that calls the release and reads quoted pins with comments', (t, fixture) => {
  const quoted = ['name: Eval', 'jobs:', '  call:', `    uses: "${REPOSITORY}/.github/workflows/eval.yml@${OLD_SHA}" # release v0.1.0`, '    with:', `      factory-sha: '${OLD_SHA}' # same commit`, ''].join('\n');
  const project = makeProject(t, fixture, { files: { '.github/workflows/eval.yml': quoted, '.github/workflows/ci.yml': 'name: CI\njobs: {}\n' } });
  const result = run(project, [TAG]);
  assert.equal(result.code, 0, result.err);
  assert.equal(fs.readFileSync(path.join(project.operator, '.github/workflows/eval.yml'), 'utf8'), quoted.replaceAll(OLD_SHA, project.tagSha));
  assert.match(result.out, /3 workflow\(s\)/);
  assert.equal(fs.readFileSync(path.join(project.operator, '.github/workflows/ci.yml'), 'utf8'), 'name: CI\njobs: {}\n', 'a workflow that does not call the release is left alone');
});

scenarioTest('installs into the field that holds the pin and takes an explicit base', (t, fixture) => {
  const project = makeProject(t, fixture, { files: { 'package.json': packageText(OLD_SPEC, 'dependencies') } });
  const result = run(project, [TAG, '--base', 'main']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.calls[0].slice(0, 4), ['npm', 'install', '--ignore-scripts', '--save-prod']);
  assert.equal(run(makeProject(t, fixture), [TAG, '--base', 'no-such-branch']).code, 1, 'an unknown base branch is an error');
});

scenarioTest('reports files outside the pin and the output of a failing doctor', (t, fixture) => {
  const touched = makeProject(t, fixture, { files: { 'README.md': 'readme\n' } });
  const result = run(touched, [TAG], { setupTouches: 'README.md' });
  assert.equal(result.code, 1);
  assert.ok(result.err.includes('files outside the pin changed (README.md)'), result.err);

  const crashed = makeProject(t, fixture);
  const doctor = run(crashed, [TAG], { doctorStatus: 2, doctorStderr: 'doctor crashed: boom' });
  assert.equal(doctor.code, 1);
  assert.ok(doctor.err.includes('doctor crashed: boom') && doctor.err.includes('doctor exited with 2'), doctor.err);
  assert.equal(JSON.parse(pinned(crashed.operator)['package.json']).devDependencies['dark-factory'], `github:${REPOSITORY}#${TAG}`, 'the pin is moved; the problem is reported');

  const refused = run(makeProject(t, fixture), [TAG], { setupStatus: 1 });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /setup of the installed v0\.1\.1 failed/);
});

scenarioTest('changes no file in a dry run', (t, fixture) => {
  const project = makeProject(t, fixture);
  const before = pinned(project.operator);
  const result = run(project, [TAG, '--dry-run']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /dry run, no project file changed/);
  assert.deepEqual(pinned(project.operator), before);
  assert.deepEqual(result.calls, []);
});

test('rejects wrong arguments before any git call', () => {
  for (const argv of [[], ['v0.1'], ['0.1.1'], ['v0.1.1', 'v0.1.2'], ['v0.1.1', '--force'], ['v0.1.1', '--base']]) {
    assert.throws(() => parseArgs(argv), /usage|vX\.Y\.Z|unknown argument|--base needs/, JSON.stringify(argv));
  }
  assert.deepEqual(parseArgs(['--dry-run', 'v1.2.3', '--base', 'develop']), { tag: 'v1.2.3', isDryRun: true, isOlderAllowed: false, base: 'develop' });
});

test('install never runs the pin command', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.bin['dark-factory-pin'], 'bin/pin.js');
  assert.equal(manifest.scripts.postinstall, 'node bin/setup.js');
  for (const [name, script] of Object.entries(manifest.scripts)) {
    if (/^(pre|post)?(install|prepare|prepublish|publish)/.test(name)) assert.ok(!/pin/.test(String(script)), `${name} does not run the pin command`);
  }
  // nothing in the package calls it: it is started only by its owner
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.js$/.test(entry.name) && !entry.name.endsWith('.test.js') && relative !== 'bin/pin.js') {
        if (/require\(['"][^'"]*\/pin['"]\)|bin\/pin\.js/.test(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'))) callers.push(relative);
      }
    }
  };
  for (const dir of ['bin', 'doctor', 'hooks', 'profile', 'verifier', 'judge', 'ralph', 'skills', 'agents']) walk(dir);
  assert.deepEqual(callers, []);
});

scenarioTest('refuses a call that is not pinned to a full commit SHA', async (t, fixture) => {
  for (const ref of ['main', 'v0.1.0', 'abc1234']) {
    await t.test(ref, (sub) => {
      const project = makeProject(sub, fixture, { files: { [APPROVAL]: workflowText().replace(OLD_SHA, ref) } });
      const before = pinned(project.operator);
      const result = run(project, [TAG]);
      assert.equal(result.code, 1);
      assert.ok(result.err.includes(`at "${ref}", which is not a full commit SHA`), result.err);
      assert.deepEqual(pinned(project.operator), before);
      assert.deepEqual(result.calls, []);
    });
  }
});

scenarioTest('refuses an older tag unless it is allowed', (t, fixture) => {
  const project = makeProject(t, fixture, { files: { 'package.json': packageText(`github:${REPOSITORY}#v0.2.0`) } });
  const before = pinned(project.operator);
  const refused = run(project, [TAG]);
  assert.equal(refused.code, 1);
  assert.ok(refused.err.includes('older than the pinned v0.2.0') && refused.err.includes('--allow-older'), refused.err);
  assert.deepEqual(pinned(project.operator), before);
  assert.deepEqual(refused.calls, []);

  const allowed = run(project, [TAG, '--allow-older']);
  assert.equal(allowed.code, 0, allowed.err);
  assert.equal(JSON.parse(pinned(project.operator)['package.json']).devDependencies['dark-factory'], `github:${REPOSITORY}#${TAG}`);
});

scenarioTest('keeps the line ending of gitignore', (t, fixture) => {
  const crlf = IGNORE_OLD.replaceAll('\n', '\r\n');
  const project = makeProject(t, fixture, { files: { '.gitignore': crlf } });
  const result = run(project, [TAG]);
  assert.equal(result.code, 0, result.err);
  assert.equal(fs.readFileSync(path.join(project.operator, '.gitignore'), 'utf8'), `${crlf}.claude/skills/issues\r\n.claude/agents/research.md\r\n`);
});

scenarioTest('restores every pin file when the new release cannot plan its copies', (t, fixture) => {
  const project = makeProject(t, fixture);
  const before = pinned(project.operator);
  const result = run(project, [TAG], { plannerFails: true });
  assert.equal(result.code, 1);
  assert.ok(result.err.includes('cannot plan the copies of skills and agents'), result.err);
  assert.ok(result.err.includes('restored: package.json, package-lock.json, .gitignore, .github/workflows/acceptance-verifier.yml, .github/workflows/spec-approval.yml'), result.err);
  assert.deepEqual(pinned(project.operator), before);
  assert.ok(!result.calls.some(([script]) => script === 'setup.js'), 'setup did not run');
});

scenarioTest('reports a new untracked file outside the pin', (t, fixture) => {
  const project = makeProject(t, fixture);
  const result = run(project, [TAG], { setupTouches: 'stray.log' });
  assert.equal(result.code, 1);
  assert.ok(result.err.includes('files outside the pin changed (stray.log)'), result.err);
});

test('takes the base branch as --base value or --base=value and never swallows a flag', () => {
  assert.equal(parseArgs(['v1.0.0', '--base=develop']).base, 'develop');
  assert.throws(() => parseArgs(['v1.0.0', '--base', '--dry-run']), /--base needs a branch name/);
  assert.throws(() => parseArgs(['v1.0.0', '--base=']), /--base needs a branch name/);
  assert.equal(parseArgs(['v1.0.0', '--allow-older']).isOlderAllowed, true);
});
