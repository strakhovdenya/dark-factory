'use strict';

// Real file operations and real temporary git repositories; the setup runs as a separate Node
// process from an "installed" copy of this package. No network, no Docker, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const { tempDir, isolateGit, gitIn, writeFiles } = require('../test/helpers/ralph');
const { copyPackageEntries, skillNames, gitignoreText, baseDestinations, installFactoryPackage, runSetupScript, REPO_ROOT } = require('../test/helpers/factory-package');

const MANIFEST = '.claude/.factory-installed.json';
const PROFILES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'profiles');

const scenarioTest = (name, body) =>
  test(name, async (t) => {
    for (const fixture of FIXTURE_PROFILES) await t.test(fixture, (sub) => body(sub, fixture));
  });

/** Every file (content) and directory under `root`, links kept as links unless `follow`. */
const snapshot = (root, { follow = false, skip = ['.git', 'node_modules'] } = {}) => {
  const result = {};
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (prefix === '' && skip.includes(name)) continue;
      const full = path.join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const stat = follow ? fs.statSync(full) : fs.lstatSync(full);
      if (stat.isSymbolicLink()) result[rel] = `link:${fs.readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        result[rel] = 'dir';
        walk(full, rel);
      } else result[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root, '');
  return result;
};

const hasLink = (root) => Object.values(snapshot(root)).some((value) => value.startsWith('link:'));

const profileOf = (fixture, mutate) => {
  const profile = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, fixture, '.factory', 'profile.json'), 'utf8'));
  if (mutate) mutate(profile);
  return JSON.stringify(profile);
};

/**
 * A consumer git repository next to an installed factory package. `run()` executes the real setup
 * script of the package against it.
 */
/** @type {(...args: any[]) => any} */
const makeScenario = (t, fixture, { gitignore = gitignoreText(['extra-skill']), files = {}, metaskills = 'hoisted', extra, tracked = {} } = {}) => {
  isolateGit(t);
  const scratch = tempDir(t, 'setup-');
  const project = path.join(scratch, 'project');
  const nodeModules = path.join(scratch, 'pkg', 'node_modules');
  fs.mkdirSync(project);
  const pkg = installFactoryPackage(nodeModules, { metaskills });
  if (metaskills !== 'none') {
    const root = metaskills === 'nested' ? path.join(pkg.packageRoot, 'node_modules', 'metaskills') : path.join(nodeModules, 'metaskills');
    writeFiles(root, { 'skills/extra-skill/SKILL.md': 'extra skill\n' });
  }
  gitIn(project, 'init', '-q', '-b', 'main');
  writeFiles(project, { '.gitignore': gitignore, '.factory/profile.json': profileOf(fixture, extra ? (p) => (p.extraMetaskills = extra) : undefined), 'README.md': 'neutral\n', ...files });
  writeFiles(project, tracked);
  gitIn(project, 'add', '-f', '-A');
  gitIn(project, 'commit', '-qm', 'init');

  const run = ({ args = ['--consumer-root', project], env = {}, cwd = pkg.packageRoot } = {}) => runSetupScript(pkg.setupScript, { args, cwd, env });
  const setProfile = (mutate) => writeFiles(project, { '.factory/profile.json': profileOf(fixture, mutate) });
  const state = () => snapshot(project);
  const manifest = () => JSON.parse(fs.readFileSync(path.join(project, MANIFEST), 'utf8'));
  return { scratch, project, nodeModules, pkg, run, setProfile, state, manifest, metaskillsRoot: metaskills === 'nested' ? path.join(pkg.packageRoot, 'node_modules', 'metaskills') : path.join(nodeModules, 'metaskills') };
};

const ok = (result) => assert.equal(result.status, 0, result.stderr);

/** A failed run: non-zero, the message names `mention`, and the whole project is exactly as before. */
const assertStops = (scenario, mention, result = scenario.run(), before = scenario.state()) => {
  assert.notEqual(result.status, 0, 'setup must fail');
  assert.ok(result.stderr.includes(mention), `message must name ${mention}: ${result.stderr}`);
  assert.deepEqual(scenario.state(), before, 'nothing changed');
};

const installed = (fixture, t, options) => {
  const scenario = makeScenario(t, fixture, options);
  ok(scenario.run());
  return scenario;
};

// --- layout ---

scenarioTest('fresh install lays out whole base set', (t, fixture) => {
  const gitignore = [
    'node_modules/',
    '/.claude/.factory-installed.json',
    ...skillNames().map((name) => `/.claude/skills/${name}/`),
    ...['research', 'codebase-scan', 'verify', 'pr-writer'].map((name) => `/.claude/agents/${name}.md`),
    '',
  ].join('\n');
  const scenario = makeScenario(t, fixture, { gitignore });
  const source = path.join(scenario.pkg.packageRoot, 'skills', 'prd');
  writeFiles(source, { 'shared/rule.md': 'shared rule\n' });
  fs.symlinkSync(path.join(source, 'shared'), path.join(source, 'linked'), 'junction');
  ok(scenario.run());

  assert.deepEqual(scenario.manifest(), { format_version: 1, copies: baseDestinations() });
  const prd = path.join(scenario.project, '.claude', 'skills', 'prd');
  assert.equal(fs.readFileSync(path.join(prd, 'linked', 'rule.md'), 'utf8'), 'shared rule\n');
  assert.ok(!fs.lstatSync(path.join(prd, 'linked')).isSymbolicLink());
  assert.deepEqual(snapshot(prd), snapshot(source, { follow: true }));
  for (const destination of baseDestinations()) {
    const stat = fs.lstatSync(path.join(scenario.project, destination));
    assert.ok(!stat.isSymbolicLink(), destination);
    assert.equal(stat.isDirectory(), destination.includes('/skills/'), destination);
    if (stat.isDirectory()) assert.ok(!hasLink(path.join(scenario.project, destination)), destination);
  }
  const base = path.join(scenario.pkg.packageRoot, 'agents', 'verify.md');
  assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/agents/verify.md'), 'utf8'), fs.readFileSync(base, 'utf8'));
  const jsGof = path.join(scenario.metaskillsRoot, 'skills', 'js-gof');
  assert.deepEqual(snapshot(path.join(scenario.project, '.claude/skills/js-gof')), snapshot(jsGof));
  assert.ok(!fs.existsSync(path.join(scenario.project, '.claude/skills/code-review')));
});

scenarioTest('installs additional metaskills from profile', (t, fixture) => {
  const scenario = makeScenario(t, fixture, { extra: ['extra-skill', 'extra-skill', 'js-gof'] });
  ok(scenario.run());
  assert.deepEqual(scenario.manifest().copies, baseDestinations(['extra-skill']));
  assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/skills/extra-skill/SKILL.md'), 'utf8'), 'extra skill\n');
  const skills = fs.readdirSync(path.join(scenario.project, '.claude/skills')).sort();
  assert.deepEqual(skills, [...skillNames(), 'extra-skill'].sort());
});

scenarioTest('removes copy no longer in profile', (t, fixture) => {
  const scenario = installed(fixture, t, { extra: ['extra-skill'] });
  assert.ok(fs.existsSync(path.join(scenario.project, '.claude/skills/extra-skill')));
  scenario.setProfile((profile) => delete profile.extraMetaskills);
  ok(scenario.run());
  assert.ok(!fs.existsSync(path.join(scenario.project, '.claude/skills/extra-skill')));
  assert.deepEqual(scenario.manifest().copies, baseDestinations());
  for (const name of skillNames()) assert.ok(fs.existsSync(path.join(scenario.project, '.claude/skills', name, 'SKILL.md')), name);
});

scenarioTest('stops on name conflict with tracked file', (t, fixture) => {
  const scenario = installed(fixture, t);
  const trackedFile = '.claude/skills/issues/SKILL.md';
  gitIn(scenario.project, 'add', '-f', trackedFile);
  gitIn(scenario.project, 'commit', '-qm', 'track own issues skill');
  const content = fs.readFileSync(path.join(scenario.project, trackedFile), 'utf8');
  assertStops(scenario, 'issues');
  assert.equal(fs.readFileSync(path.join(scenario.project, trackedFile), 'utf8'), content);
});

scenarioTest('does not modify tracked project files', (t, fixture) => {
  const tracked = {
    '.claude/settings.json': '{"hooks":{}}\n',
    'CLAUDE.md': '# project rules\n',
    '.github/verifier/owners.json': '{"owners":[]}\n',
  };
  const scenario = makeScenario(t, fixture, { tracked });
  const files = ['.claude/settings.json', '.gitignore', 'CLAUDE.md', '.factory/profile.json', '.github/verifier/owners.json'];
  const before = Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(scenario.project, file), 'utf8')]));
  ok(scenario.run());
  for (const file of files) assert.equal(fs.readFileSync(path.join(scenario.project, file), 'utf8'), before[file], file);
  assert.equal(gitIn(scenario.project, 'status', '--porcelain'), '', 'only ignored files were written');
});

scenarioTest('does not install factory own skills', (t, fixture) => {
  const scenario = makeScenario(t, fixture);
  writeFiles(scenario.pkg.packageRoot, { '.claude/skills/factory-only/SKILL.md': 'factory only\n' });
  assert.ok(fs.existsSync(path.join(scenario.pkg.packageRoot, '.claude/skills/factory-only/SKILL.md')));
  ok(scenario.run());
  assert.ok(!fs.existsSync(path.join(scenario.project, '.claude/skills/factory-only')));
  assert.ok(!scenario.manifest().copies.some((copy) => copy.includes('factory-only')));
});

scenarioTest('uses installed package sources and explicit consumer root', (t, fixture) => {
  const scenario = makeScenario(t, fixture);
  const other = path.join(scenario.scratch, 'other');
  fs.mkdirSync(other);
  gitIn(other, 'init', '-q', '-b', 'main');
  writeFiles(scenario.pkg.packageRoot, { 'skills/prd/SKILL.md': 'prd from the installed package\n' });
  const packageBefore = snapshot(scenario.pkg.packageRoot, { skip: [] });
  ok(scenario.run({ env: { INIT_CWD: other } }));
  assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/skills/prd/SKILL.md'), 'utf8'), 'prd from the installed package\n');
  assert.deepEqual(fs.readdirSync(other).sort(), ['.git'], 'the project of INIT_CWD is untouched');
  assert.deepEqual(snapshot(scenario.pkg.packageRoot, { skip: [] }), packageBefore);
});

scenarioTest('repeated setup preserves installed set', (t, fixture) => {
  const scenario = installed(fixture, t, { extra: ['extra-skill'] });
  writeFiles(scenario.project, { '.claude/hooks/own.js': 'own hook\n', '.claude/skills/my-own/SKILL.md': 'mine\n' });
  const before = scenario.state();
  ok(scenario.run());
  assert.deepEqual(scenario.state(), before);
});

scenarioTest('updates owned copies and removes retired base entries', (t, fixture) => {
  const scenario = installed(fixture, t);
  writeFiles(scenario.project, { '.claude/hooks/own.js': 'own hook\n' });
  writeFiles(scenario.pkg.packageRoot, { 'skills/prd/SKILL.md': 'new prd\n' });
  const baseSetFile = path.join(scenario.pkg.packageRoot, 'skills', 'base-set.json');
  const baseSet = JSON.parse(fs.readFileSync(baseSetFile, 'utf8'));
  baseSet.processSkills = baseSet.processSkills.filter((entry) => entry.name !== 'adr');
  fs.writeFileSync(baseSetFile, JSON.stringify(baseSet));
  ok(scenario.run());
  assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/skills/prd/SKILL.md'), 'utf8'), 'new prd\n');
  assert.ok(!fs.existsSync(path.join(scenario.project, '.claude/skills/adr')));
  assert.deepEqual(scenario.manifest().copies, baseDestinations().filter((copy) => copy !== '.claude/skills/adr'));
  assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/hooks/own.js'), 'utf8'), 'own hook\n');
});

scenarioTest('finds consumer from init cwd during postinstall', (t, fixture) => {
  const scenario = makeScenario(t, fixture);
  const subdirectory = path.join(scenario.project, 'packages', 'app');
  fs.mkdirSync(subdirectory, { recursive: true });
  ok(scenario.run({ args: [], env: { INIT_CWD: subdirectory } }));
  assert.deepEqual(scenario.manifest().copies, baseDestinations());
  assert.ok(!fs.existsSync(path.join(subdirectory, '.claude')));
});

for (const layout of ['hoisted', 'nested']) {
  scenarioTest(`resolves metaskills from factory dependency (${layout})`, (t, fixture) => {
    const scenario = makeScenario(t, fixture, { metaskills: layout });
    writeFiles(scenario.metaskillsRoot, { 'skills/js-gof/SKILL.md': 'pinned js-gof\n' });
    const consumerCopy = path.join(scenario.project, 'node_modules', 'metaskills');
    writeFiles(consumerCopy, { 'package.json': JSON.stringify({ name: 'metaskills', version: '9.9.9' }), 'skills/js-gof/SKILL.md': 'consumer js-gof\n' });
    ok(scenario.run());
    assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/skills/js-gof/SKILL.md'), 'utf8'), 'pinned js-gof\n');
  });
}

test('package.json ships bin and wires postinstall and tests', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.postinstall, 'node bin/setup.js');
  assert.equal(pkg.bin['dark-factory-setup'], 'bin/setup.js');
  assert.ok(pkg.files.includes('bin/'));
  assert.ok(pkg.scripts.test.includes('"bin/**/*.test.js"'));
  assert.equal(pkg.dependencies.metaskills, '1.0.5');
  assert.ok(require('../tsconfig.json').include.includes('bin/**/*.js'));
});

// --- stops before any change ---

scenarioTest('stops when copy is not listed in gitignore', (t, fixture) => {
  const without = gitignoreText().split('\n').filter((line) => line !== '.claude/skills/js-gof').join('\n');
  const fresh = makeScenario(t, fixture, { gitignore: without });
  const result = fresh.run();
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('.claude/skills/js-gof'), result.stderr);
  assert.ok(!fs.existsSync(path.join(fresh.project, '.claude')), 'no copy and no list were created');

  const scenario = installed(fixture, t);
  writeFiles(scenario.project, { '.gitignore': without });
  assertStops(scenario, '.claude/skills/js-gof');
});

scenarioTest('keeps untracked directory not installed by setup', (t, fixture) => {
  const scenario = installed(fixture, t);
  writeFiles(scenario.project, { '.claude/skills/my-notes/SKILL.md': 'notes\n' });
  ok(scenario.run());
  assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/skills/my-notes/SKILL.md'), 'utf8'), 'notes\n');
  assert.ok(!scenario.manifest().copies.includes('.claude/skills/my-notes'));
});

scenarioTest('fails without profile', (t, fixture) => {
  const scenario = installed(fixture, t);
  fs.rmSync(path.join(scenario.project, '.factory'), { recursive: true });
  assertStops(scenario, 'Profile not found');
  const fresh = makeScenario(t, fixture);
  fs.rmSync(path.join(fresh.project, '.factory'), { recursive: true });
  assert.notEqual(fresh.run().status, 0);
  assert.ok(!fs.existsSync(path.join(fresh.project, '.claude')));
});

scenarioTest('rejects unmanaged destination without adopting it', (t, fixture) => {
  const scenario = installed(fixture, t, { extra: ['extra-skill'] });
  const list = scenario.manifest();
  list.copies = list.copies.filter((copy) => copy !== '.claude/agents/pr-writer.md');
  writeFiles(scenario.project, { [MANIFEST]: `${JSON.stringify(list)}\n`, '.claude/agents/pr-writer.md': 'foreign agent\n' });
  scenario.setProfile((profile) => delete profile.extraMetaskills);
  writeFiles(scenario.pkg.packageRoot, { 'skills/prd/SKILL.md': 'updated prd\n' });
  assertStops(scenario, '.claude/agents/pr-writer.md');
  assert.equal(fs.readFileSync(path.join(scenario.project, '.claude/agents/pr-writer.md'), 'utf8'), 'foreign agent\n');
});

scenarioTest('rejects tracked files inside owned destinations', (t, fixture) => {
  const track = (scenario, file) => {
    gitIn(scenario.project, 'add', '-f', file);
    gitIn(scenario.project, 'commit', '-qm', 'track');
  };
  const prepare = () => {
    const scenario = installed(fixture, t, { extra: ['extra-skill'] });
    writeFiles(scenario.pkg.packageRoot, { 'skills/prd/SKILL.md': 'updated prd\n' });
    return scenario;
  };

  const updated = prepare();
  track(updated, '.claude/skills/prd/SKILL.md');
  assertStops(updated, '.claude/skills/prd');

  const retired = prepare();
  retired.setProfile((profile) => delete profile.extraMetaskills);
  track(retired, '.claude/skills/extra-skill/SKILL.md');
  assertStops(retired, '.claude/skills/extra-skill');
  assert.ok(fs.existsSync(path.join(retired.project, '.claude/skills/extra-skill/SKILL.md')));

  const list = prepare();
  track(list, MANIFEST);
  assertStops(list, MANIFEST);
});

scenarioTest('rejects invalid installed copies manifest', (t, fixture) => {
  const valid = baseDestinations();
  const variants = {
    'not json': '{broken',
    'unknown version': JSON.stringify({ format_version: 2, copies: valid }),
    duplicate: JSON.stringify({ format_version: 1, copies: [...valid, valid[0]] }),
    'path outside recipients': JSON.stringify({ format_version: 1, copies: [...valid, '.claude/hooks/own.js'] }),
    'path leaving the project': JSON.stringify({ format_version: 1, copies: [...valid, '.claude/skills/../../x'] }),
    'copies not a list': JSON.stringify({ format_version: 1, copies: 'all' }),
  };
  for (const [label, text] of Object.entries(variants)) {
    const scenario = installed(fixture, t);
    fs.writeFileSync(path.join(scenario.project, MANIFEST), text);
    const result = scenario.run();
    assert.notEqual(result.status, 0, label);
    assert.ok(result.stderr.includes('.factory-installed.json'), `${label}: ${result.stderr}`);
    assert.equal(fs.readFileSync(path.join(scenario.project, MANIFEST), 'utf8'), text, label);
    for (const destination of valid) assert.ok(fs.existsSync(path.join(scenario.project, destination)), `${label}: ${destination}`);
  }
});

scenarioTest('rejects unavailable or invalid skill source before changes', (t, fixture) => {
  /** @type {[string, string, (s: any) => any][]} */
  const cases = [
    ['unknown extra', 'no-such-skill', (s) => s.setProfile((p) => (p.extraMetaskills = ['no-such-skill']))],
    ['unsafe extra', '../evil', (s) => s.setProfile((p) => (p.extraMetaskills = ['../evil']))],
    ['missing source', 'prd', (s) => fs.rmSync(path.join(s.pkg.packageRoot, 'skills', 'prd'), { recursive: true })],
    ['wrong version', 'metaskills', (s) => writeFiles(s.metaskillsRoot, { 'package.json': JSON.stringify({ name: 'metaskills', version: '0.0.1' }) })],
    ['missing package', 'metaskills', (s) => fs.rmSync(s.metaskillsRoot, { recursive: true })],
  ];
  for (const [label, mention, arrange] of cases) {
    const scenario = installed(fixture, t);
    arrange(scenario);
    assertStops(scenario, mention);
    assert.ok(label);
  }
});

scenarioTest('requires installed manifest to be ignored', (t, fixture) => {
  const without = gitignoreText().split('\n').filter((line) => line !== MANIFEST).join('\n');
  const scenario = makeScenario(t, fixture, { gitignore: without });
  const result = scenario.run();
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(MANIFEST), result.stderr);
  assert.ok(!fs.existsSync(path.join(scenario.project, '.claude')));
  const second = installed(fixture, t);
  writeFiles(second.project, { '.gitignore': without });
  assertStops(second, MANIFEST);
});

scenarioTest('requires named and effective gitignore entries', (t, fixture) => {
  const general = makeScenario(t, fixture, { gitignore: 'node_modules/\n.claude/skills/\n.claude/agents/\n.claude/.factory-installed.json\n' });
  const result = general.run();
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('.claude/skills/js-gof'), result.stderr);
  assert.ok(!fs.existsSync(path.join(general.project, '.claude/skills')));

  const scenario = installed(fixture, t);
  writeFiles(scenario.project, { '.gitignore': `${gitignoreText()}!.claude/skills/js-gof\n` });
  assertStops(scenario, '.claude/skills/js-gof');
});

scenarioTest('rejects unusable consumer root without fallback', (t, fixture) => {
  const scenario = makeScenario(t, fixture);
  const outside = path.join(scenario.scratch, 'not-a-repo');
  fs.mkdirSync(outside);
  const subdirectory = path.join(scenario.project, 'sub');
  fs.mkdirSync(subdirectory);
  const attempts = [
    { args: ['--consumer-root', path.join(scenario.scratch, 'missing')] },
    { args: ['--consumer-root', outside] },
    { args: ['--consumer-root', subdirectory] },
    { args: [], env: {} },
    { args: [], env: { INIT_CWD: outside } },
  ];
  for (const attempt of attempts) {
    for (const cwd of [scenario.pkg.packageRoot, scenario.project]) {
      const result = scenario.run({ ...attempt, cwd });
      assert.notEqual(result.status, 0, JSON.stringify(attempt));
      assert.ok(result.stderr.includes('dark-factory-setup'), result.stderr);
    }
  }
  assert.ok(!fs.existsSync(path.join(scenario.project, '.claude')), 'the project of the working directory was not used');
  assert.ok(!fs.existsSync(path.join(scenario.pkg.packageRoot, '.claude')));
  assert.deepEqual(fs.readdirSync(outside), []);
});

scenarioTest('fails on invalid profile before changes', (t, fixture) => {
  const scenario = installed(fixture, t);
  scenario.setProfile((profile) => (profile.unknownField = true));
  assertStops(scenario, 'unknownField: unknown field');
});

scenarioTest('rejects destination resolving outside consumer', (t, fixture) => {
  const scenario = installed(fixture, t);
  const outside = path.join(scenario.scratch, 'outside-skills');
  fs.renameSync(path.join(scenario.project, '.claude', 'skills'), outside);
  fs.symlinkSync(outside, path.join(scenario.project, '.claude', 'skills'), 'junction');
  const outsideBefore = snapshot(outside);
  assertStops(scenario, '.claude/skills');
  assert.deepEqual(snapshot(outside), outsideBefore);
});

test('does not lay out copies from sources in own repository', async (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    await t.test(fixture, () => {
      isolateGit(t);
      const scratch = tempDir(t, 'setup-own-');
      const bootstrap = "require('node:fs').writeFileSync(require('node:path').join(process.argv[2], 'bootstrap-called.txt'), process.argv[2]);\n";
      const fakeBootstrap = { '.claude/scripts/setup-metaskills.js': bootstrap, '.factory/profile.json': profileOf(fixture), 'package.json': JSON.stringify({ name: 'dark-factory', version: '0.0.0' }) };

      const own = path.join(scratch, 'own');
      copyPackageEntries(own);
      writeFiles(own, fakeBootstrap);
      gitIn(own, 'init', '-q', '-b', 'main');
      const result = runSetupScript(path.join(own, 'bin', 'setup.js'), { args: ['--consumer-root', own], cwd: own });
      ok(result);
      assert.equal(fs.readFileSync(path.join(own, 'bootstrap-called.txt'), 'utf8'), fs.realpathSync.native(own));
      assert.ok(!fs.existsSync(path.join(own, '.claude', 'skills')), 'no copy from skills/ sources');
      assert.ok(!fs.existsSync(path.join(own, MANIFEST)));

      const scenario = makeScenario(t, fixture, { files: { 'package.json': JSON.stringify({ name: 'dark-factory' }) } });
      writeFiles(scenario.pkg.packageRoot, fakeBootstrap);
      ok(scenario.run());
      assert.ok(!fs.existsSync(path.join(scenario.project, 'bootstrap-called.txt')));
      assert.deepEqual(scenario.manifest().copies, baseDestinations());
    });
  }
});
