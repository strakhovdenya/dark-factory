'use strict';

// Real file operations and real temporary git repositories; the setup runs as a separate Node
// process from an "installed" copy of this package. The npm lifecycle tests run the real npm on a
// local git tag, offline. No network, no Docker, no model.

const childProcess = require('node:child_process');
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { npmCli } = require('../test/helpers/npm');
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

// --- the factory's own package ---

const BOOTSTRAP_MARKER = 'bootstrap-called.txt';
// A stand-in for the old bootstrap: if anything still ran it, it would leave a marker.
const FAKE_BOOTSTRAP = `require('node:fs').writeFileSync(require('node:path').join(process.argv[2] || process.cwd(), '${BOOTSTRAP_MARKER}'), 'called');\n`;
const NO_COPIES = 'no copies laid out';
const PREPARATION_ENV = { _PACOTE_NO_PREPARE_: 'git+file:///prepared/dark-factory#0000000000000000000000000000000000000000' };

/** A tree of the factory sources: package directories, the real package.json, the old bootstrap file, an own tool and a profile. */
const ownTree = (dir, fixture, { git = true } = {}) => {
  copyPackageEntries(dir);
  writeFiles(dir, { '.claude/scripts/setup-metaskills.js': FAKE_BOOTSTRAP, '.claude/skills/release/SKILL.md': 'own tool\n', '.factory/profile.json': profileOf(fixture), '.gitignore': gitignoreText() });
  if (git) {
    gitIn(dir, 'init', '-q', '-b', 'main');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-qm', 'sources');
  }
  return dir;
};

/** The run succeeded and left the tree exactly as it was: no copy, no list of copies, no bootstrap. */
const assertOwnSkip = (result, dir, before) => {
  ok(result);
  assert.ok(result.stdout.includes(NO_COPIES), result.stdout);
  assert.deepEqual(snapshot(dir), before, 'nothing changed');
  assert.ok(!fs.existsSync(path.join(dir, MANIFEST)));
  assert.ok(!fs.existsSync(path.join(dir, BOOTSTRAP_MARKER)), 'the old bootstrap was not called');
};

scenarioTest('own postinstall skips copies including git preparation', (t, fixture) => {
  isolateGit(t);
  const scratch = tempDir(t, 'setup-own-');

  const sources = ownTree(path.join(scratch, 'sources'), fixture);
  const sourcesSetup = path.join(sources, 'bin', 'setup.js');
  const before = snapshot(sources);
  for (const start of [sources, path.join(sources, 'verifier')]) {
    assertOwnSkip(runSetupScript(sourcesSetup, { cwd: sources, env: { INIT_CWD: start } }), sources, before);
  }

  // npm prepares a git dependency by an `npm install` in the unpacked tag: INIT_CWD is the package root, no .git.
  const prepared = ownTree(path.join(scratch, 'prepared'), fixture, { git: false });
  assert.ok(!fs.existsSync(path.join(prepared, '.git')));
  const preparedBefore = snapshot(prepared);
  assertOwnSkip(runSetupScript(path.join(prepared, 'bin', 'setup.js'), { cwd: prepared, env: { INIT_CWD: prepared, ...PREPARATION_ENV } }), prepared, preparedBefore);

  // In that preparation the tree's own pinned release is installed as its dependency and runs its postinstall.
  for (const git of [false, true]) {
    const tree = ownTree(path.join(scratch, `prepared-with-release-${git}`), fixture, { git });
    const release = installFactoryPackage(path.join(tree, 'node_modules'));
    const treeBefore = snapshot(tree);
    const releaseBefore = snapshot(release.packageRoot, { skip: [] });
    assertOwnSkip(runSetupScript(release.setupScript, { cwd: release.packageRoot, env: { INIT_CWD: tree, ...PREPARATION_ENV } }), tree, treeBefore);
    assert.deepEqual(snapshot(release.packageRoot, { skip: [] }), releaseBefore);
  }
});

/** A consumer named like the factory, with the installed package in its own node_modules/dark-factory. */
const namesakeConsumer = (t, fixture, { git = true, profile = profileOf(fixture) } = {}) => {
  isolateGit(t);
  const project = path.join(tempDir(t, 'setup-namesake-'), 'dark-factory');
  const files = { 'package.json': JSON.stringify({ name: 'dark-factory', version: '0.0.0', devDependencies: { 'dark-factory': '*' } }), '.gitignore': gitignoreText(), 'README.md': 'neutral\n' };
  writeFiles(project, profile === null ? files : { ...files, '.factory/profile.json': profile });
  if (git) {
    gitIn(project, 'init', '-q', '-b', 'main');
    gitIn(project, 'add', '-A');
    gitIn(project, 'commit', '-qm', 'init');
  }
  const pkg = installFactoryPackage(path.join(project, 'node_modules'));
  const run = (options = {}) => runSetupScript(pkg.setupScript, { cwd: pkg.packageRoot, env: { INIT_CWD: project, _PACOTE_NO_PREPARE_: '' }, ...options });
  return { project, pkg, run, state: () => snapshot(project) };
};

scenarioTest('own postinstall does not bypass consumer validation', (t, fixture) => {
  /** @type {[string, string, () => any][]} */
  const cases = [
    ['profile missing', 'Profile not found', () => namesakeConsumer(t, fixture, { profile: null })],
    ['profile invalid', 'unknownField: unknown field', () => namesakeConsumer(t, fixture, { profile: profileOf(fixture, (p) => (p.unknownField = true)) })],
  ];
  for (const [label, mention, arrange] of cases) {
    const consumer = arrange();
    const before = consumer.state();
    const result = consumer.run();
    assert.notEqual(result.status, 0, label);
    assert.ok(result.stderr.includes(mention), `${label}: ${result.stderr}`);
    assert.deepEqual(consumer.state(), before, label);
  }

  const outside = namesakeConsumer(t, fixture, { git: false });
  const before = outside.state();
  for (const options of [{ args: ['--consumer-root', outside.project] }, {}]) {
    const result = outside.run(options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.ok(result.stderr.includes('is not inside a git repository'), result.stderr);
  }
  assert.deepEqual(outside.state(), before);

  const sources = ownTree(path.join(tempDir(t, 'setup-own-'), 'sources'), fixture);
  const sourcesBefore = snapshot(sources);
  const explicit = runSetupScript(path.join(sources, 'bin', 'setup.js'), { args: ['--consumer-root', sources], cwd: sources });
  assert.notEqual(explicit.status, 0);
  assert.ok(explicit.stderr.includes('copies come only from an installed release'), explicit.stderr);
  assert.deepEqual(snapshot(sources), sourcesBefore);
});

scenarioTest('release setup still installs in both consumer forms', (t, fixture) => {
  for (const isExplicit of [false, true]) {
    const consumer = namesakeConsumer(t, fixture);
    const run = () => consumer.run(isExplicit ? { args: ['--consumer-root', consumer.project] } : {});
    const result = run();
    ok(result);
    assert.ok(!result.stdout.includes(NO_COPIES), result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(consumer.project, MANIFEST), 'utf8'));
    assert.deepEqual(manifest, { format_version: 1, copies: baseDestinations() });
    for (const name of ['issues', 'prd']) {
      assert.deepEqual(snapshot(path.join(consumer.project, '.claude/skills', name)), snapshot(path.join(consumer.pkg.packageRoot, 'skills', name)), name);
    }
    assert.equal(fs.readFileSync(path.join(consumer.project, '.claude/agents/verify.md'), 'utf8'), fs.readFileSync(path.join(consumer.pkg.packageRoot, 'agents', 'verify.md'), 'utf8'));
    assert.equal(gitIn(consumer.project, 'status', '--porcelain'), '', 'only ignored files were written');
    const before = consumer.state();
    ok(run());
    assert.deepEqual(consumer.state(), before, 'a repeated run keeps the set');
  }
});

// --- npm lifecycle of the factory on its own pinned release, offline ---

// npm needs no registry and no cache: the trees below have no registry dependencies (see `hermeticManifest`).
// ajv and minimatch, which the setup of the installed package requires, come from this repository.
// The cache is empty and private, so a hidden registry dependency fails here instead of passing on a warm machine.
const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-npm-cache-'));
after(() => fs.rmSync(npmCache, { recursive: true, force: true }));

const runNpm = (cwd, args) => {
  const inherited = Object.entries(process.env).filter(([name]) => !/^(npm_.*|init_cwd|node_path|node_options|node_test_context|_pacote_no_prepare_)$/i.test(name));
  const env = { ...Object.fromEntries(inherited), NODE_PATH: path.join(REPO_ROOT, 'node_modules'), npm_config_cache: npmCache, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_foreground_scripts: 'true' };
  const result = childProcess.spawnSync(process.execPath, [npmCli(), ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
};

const RELEASE_ISSUES = 'issues skill of the release\n';
const RELEASE_VERIFY = 'verify agent of the release\n';
const WORKING_ISSUES = 'issues skill of the working copy\n';
const WORKING_VERIFY = 'verify agent of the working copy\n';

// Neither tree may need a registry: no dev tooling, no lock file and no registry dependencies. The
// package under test is pinned as a git tag, and metaskills (the only runtime source of the base set)
// is a `file:` dependency of the factory tree, so npm links it from this repository's node_modules.
const hermeticManifest = (dir, { dependencies = {}, devDependencies = {} } = {}) => {
  const file = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, dependencies, devDependencies }, null, 2)}
`);
};

/**
 * A local release (a git repository of the package with tag v0.1.0) and a factory working copy
 * that pins it as devDependency `dark-factory`; skills/issues and agents/verify of the working copy
 * differ from the release. Built inside `scratch`, which the caller keeps.
 */
const buildOwnFactory = (scratch, fixture) => {
  const release = ownTree(path.join(scratch, 'release'), fixture, { git: false });
  hermeticManifest(release);
  writeFiles(release, { 'skills/issues/SKILL.md': RELEASE_ISSUES, 'agents/verify.md': RELEASE_VERIFY });
  gitIn(release, 'init', '-q', '-b', 'main');
  gitIn(release, 'add', '-A');
  gitIn(release, 'commit', '-qm', 'release');
  gitIn(release, 'tag', 'v0.1.0');

  const factory = ownTree(path.join(scratch, 'factory'), fixture, { git: false });
  hermeticManifest(factory, {
    dependencies: { metaskills: `file:${path.join(REPO_ROOT, 'node_modules', 'metaskills').replaceAll(path.sep, '/')}` },
    devDependencies: { 'dark-factory': `git+${pathToFileURL(release).href}#v0.1.0` },
  });
  writeFiles(factory, { 'skills/issues/SKILL.md': WORKING_ISSUES, 'agents/verify.md': WORKING_VERIFY });
  gitIn(factory, 'init', '-q', '-b', 'main');
  gitIn(factory, 'add', '-A');
  gitIn(factory, 'commit', '-qm', 'working copy');
  return factory;
};

/** Every call that went through `runNpm` in this process, for the tests that count installs. */
const npmLog = [];
const npm = (cwd, args) => {
  npmLog.push({ cwd, args });
  return runNpm(cwd, args);
};

// One real `npm install` per fixture profile and test process, made lazily by the first scenario that
// needs it. The release repository stays where it was built: the lock of the installed tree names it.
/** @type {string | null} */
let sharedRoot = null;
after(() => sharedRoot && fs.rmSync(sharedRoot, { recursive: true, force: true }));
/** @type {Map<string, { factory: string, output: string }>} */
const sharedInstalls = new Map();

const sharedInstall = (fixture) => {
  const known = sharedInstalls.get(fixture);
  if (known) return known;
  sharedRoot ??= fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-shared-install-')));
  const scratch = fs.mkdtempSync(path.join(sharedRoot, `${fixture}-`));
  try {
    const factory = buildOwnFactory(scratch, fixture);
    const install = npm(factory, ['install']);
    assert.equal(install.status, 0, install.output);
    const created = { factory, output: install.output };
    sharedInstalls.set(fixture, created);
    return created;
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
};

/**
 * An independent copy of the shared install for one scenario: the whole factory tree with its
 * `node_modules`. Links stay links (`metaskills` is a `file:` dependency, a junction on Windows).
 * `installOutput` is the output of the install, naming the copy instead of the shared tree.
 */
const makeOwnFactory = (t, fixture) => {
  isolateGit(t);
  const shared = sharedInstall(fixture);
  // The lock names the `file:` dependency by a path relative to the tree, so a copy sits at the depth of the shared tree.
  const factory = path.join(tempDir(t, 'setup-lifecycle-'), 'copy', 'factory');
  fs.cpSync(shared.factory, factory, { recursive: true, verbatimSymlinks: true });
  return { factory, installed: path.join(factory, 'node_modules', 'dark-factory'), installOutput: shared.output.replaceAll(shared.factory, factory) };
};

/** The copies are the release's, laid out by the installed package; the root postinstall changed nothing. */
const assertReleaseCopies = ({ factory, installed }, output) => {
  assert.equal(fs.readFileSync(path.join(installed, 'skills/issues/SKILL.md'), 'utf8'), RELEASE_ISSUES, 'the dependency is the release');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(factory, MANIFEST), 'utf8')), { format_version: 1, copies: baseDestinations() });
  assert.equal(fs.readFileSync(path.join(factory, '.claude/skills/issues/SKILL.md'), 'utf8'), RELEASE_ISSUES);
  assert.equal(fs.readFileSync(path.join(factory, '.claude/agents/verify.md'), 'utf8'), RELEASE_VERIFY);
  assert.deepEqual(snapshot(path.join(factory, '.claude/skills/prd')), snapshot(path.join(installed, 'skills/prd')));
  assert.equal(fs.readFileSync(path.join(factory, '.claude/skills/release/SKILL.md'), 'utf8'), 'own tool\n');
  assert.ok(output.includes(`copies installed, 0 removed (${factory})`), output);
  assert.ok(output.includes(`${NO_COPIES} (${factory})`), output);
  for (const dir of [factory, installed]) assert.ok(!fs.existsSync(path.join(dir, BOOTSTRAP_MARKER)), `bootstrap called in ${dir}`);
  const changed = gitIn(factory, 'status', '--porcelain').split('\n').filter(Boolean);
  assert.deepEqual(changed, ['?? package-lock.json'], 'the lock npm wrote is the only change');
};

scenarioTest('npm install in factory does not take copies from working copy', (t, fixture) => {
  const own = makeOwnFactory(t, fixture);
  assertReleaseCopies(own, own.installOutput);
  assert.equal(JSON.parse(fs.readFileSync(path.join(own.factory, 'package-lock.json'), 'utf8')).packages['node_modules/dark-factory'].dev, true);

  for (const destination of baseDestinations()) fs.rmSync(path.join(own.factory, destination), { recursive: true });
  fs.rmSync(path.join(own.factory, MANIFEST));
  const ci = npm(own.factory, ['ci']);
  assert.equal(ci.status, 0, ci.output);
  assertReleaseCopies(own, ci.output);
});

scenarioTest('failed release setup never falls back to working sources', (t, fixture) => {
  const own = makeOwnFactory(t, fixture);
  writeFiles(own.factory, { '.factory/profile.json': profileOf(fixture, (p) => (p.unknownField = true)) });
  const before = snapshot(path.join(own.factory, '.claude'));

  const ci = npm(own.factory, ['ci']);
  assert.notEqual(ci.status, 0, ci.output);
  assert.ok(ci.output.includes('dark-factory-setup: '), ci.output);
  assert.ok(ci.output.includes('unknownField: unknown field'), 'the release setup itself refused');
  assert.ok(ci.output.includes(path.join('node_modules', 'dark-factory')), 'the refusing setup is the installed one');
  assert.ok(!ci.output.includes(NO_COPIES), 'the root postinstall did not run after the refusal');
  assert.deepEqual(snapshot(path.join(own.factory, '.claude')), before, 'existing copies were not rewritten');
  assert.equal(fs.readFileSync(path.join(own.factory, '.claude/skills/issues/SKILL.md'), 'utf8'), RELEASE_ISSUES);
  assert.ok(!fs.existsSync(path.join(own.factory, BOOTSTRAP_MARKER)));
});


scenarioTest('shared npm install serves independent copies', (t, fixture) => {
  const first = makeOwnFactory(t, fixture);
  const second = makeOwnFactory(t, fixture);
  const installs = npmLog.filter(({ cwd, args }) => args[0] === 'install' && cwd.startsWith(path.dirname(sharedInstall(fixture).factory)));
  assert.equal(installs.length, 1, 'npm install ran once for the profile');
  assert.equal(npmLog.filter(({ cwd, args }) => args[0] === 'install' && cwd === first.factory).length, 0);
  assert.notEqual(first.factory, second.factory);
  for (const copy of [first, second]) {
    assert.equal(fs.readFileSync(path.join(copy.installed, 'skills/issues/SKILL.md'), 'utf8'), RELEASE_ISSUES, 'the dependency is the release');
    assert.ok(fs.existsSync(path.join(copy.installed, 'bin/setup.js')));
  }
  assert.notEqual(first.installed, second.installed);
});

scenarioTest('a changed install copy never reaches the next copy', (t, fixture) => {
  const profile = path.join('.factory', 'profile.json');
  const first = makeOwnFactory(t, fixture);
  writeFiles(first.factory, { [profile]: profileOf(fixture, (p) => (p.unknownField = true)) });
  fs.rmSync(path.join(first.factory, 'node_modules', 'dark-factory', 'skills'), { recursive: true });
  const next = makeOwnFactory(t, fixture);
  assert.equal(fs.readFileSync(path.join(next.factory, profile), 'utf8'), profileOf(fixture));
  assert.ok(fs.existsSync(path.join(next.installed, 'skills')), 'the installed release is whole in the next copy');
});
