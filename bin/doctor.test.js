'use strict';

// The public command `factory doctor`, run as its own Node process against temporary projects of
// the two neutral shapes (monorepo, single package). `git` is real; `gh` is replaced at the
// child_process boundary by a stub that answers only the three allowed reads and records every
// git and gh call (argv and cwd). No network, no Docker, no model. The delivery tests run the CLI
// from a real `npm pack` archive installed outside the checkout, without NODE_PATH.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const { gitignoreText, REPO_ROOT } = require('../test/helpers/factory-package');
const { tarballFiles, packedManifest, installPackage, runtimeClosure } = require('../test/fixtures/installed-ralph/package');
const { makeFactoryProject } = require('../test/helpers/factory-project');
const { npmCli } = require('../test/helpers/npm');
const { runSetup } = require('./setup');
const { HOOK_ENTRIES, entryId } = require('../hooks/entries');

const DOCTOR = path.join(REPO_ROOT, 'bin', 'doctor.js');
const PROFILES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'profiles');
const FACTORY_REPOSITORY = /github\.com\/([^/]+\/[^/.]+)/.exec(require('../package.json').repository.url)[1];
const PLACEHOLDER_SHA = '0123456789abcdef0123456789abcdef01234567';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'f1e2d3c4b5a60718293a4b5c6d7e8f9012345678';
const SECRET_VALUE = 'secret-value-that-must-not-be-asked-or-printed';
const CORE_LABELS = ['spec-approved', 'manual-verified', 'factory-cross-change', 'test-removal-approved'];
const READ_ONLY_GIT = new Set(['rev-parse', 'symbolic-ref', 'ls-files', 'check-ignore']);
const GH_READS = ['label list', 'secret list', 'variable list'];

const realTemp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const scratch = { dir: '' };
before(() => {
  scratch.dir = realTemp('doctor-test-');
});
after(() => fs.rmSync(scratch.dir, { recursive: true, force: true }));
let counter = 0;
const freshDir = (name) => {
  const dir = path.join(scratch.dir, `${name}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^git_/i.test(name)));
const git = (cwd, ...args) =>
  String(childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));

const writeFile = (root, relative, content) => {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
};

/** File path -> sha256 of every file under `root`, `.git` left out. */
const treeHashes = (root) => {
  const hashes = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hashes[path.relative(root, full).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return hashes;
};

const snapshot = (root) => ({
  files: treeHashes(root),
  status: git(root, 'status', '--porcelain', '--ignored'),
  refs: git(root, 'for-each-ref') + git(root, 'rev-parse', 'HEAD'),
});

// --- the child_process boundary (loaded into the doctor process with --require) ---

const boundaryMain = () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');
  const config = JSON.parse(fs.readFileSync(process.env.DOCTOR_BOUNDARY, 'utf8'));
  const real = cp.spawnSync;
  const normal = (target) => {
    try {
      return fs.realpathSync.native(target).toLowerCase();
    } catch {
      return String(target).toLowerCase();
    }
  };
  const result = (status, stdout, stderr, error) => ({ status, signal: null, stdout, stderr, pid: 1, output: [null, stdout, stderr], error });
  const EXPECTED = {
    label: ['label', 'list', '--limit', '1000', '--json', 'name'],
    secret: ['secret', 'list', '--json', 'name'],
    variable: ['variable', 'list', '--json', 'name,value'],
  };
  const KINDS = { label: 'labels', secret: 'secrets', variable: 'variables' };
  const reply = (args, cwd) => {
    const key = Object.keys(config.gh).find((candidate) => normal(candidate) === normal(cwd));
    if (key === undefined) return result(1, '', `no stub for ${cwd}`);
    const entry = config.gh[key];
    const kind = KINDS[args[0]];
    if (kind === undefined || JSON.stringify(args) !== JSON.stringify(EXPECTED[args[0]])) return result(1, '', 'unexpected gh call');
    const failure = entry.fail?.[kind];
    if (failure === 'spawn') return result(null, '', '', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    if (failure === 'exit') return result(4, '', 'HTTP 403: Resource not accessible\nsecond line');
    if (failure === 'garbage') return result(0, 'this is not json', '');
    if (kind === 'variables') return result(0, JSON.stringify(Object.entries(entry.variables).map(([name, value]) => ({ name, value }))), '');
    return result(0, JSON.stringify(entry[kind].map((name) => ({ name }))), '');
  };
  /** @type {any} */ (cp).spawnSync = function spawnSync(file, args, options) {
    const tool = path.basename(String(file)).replace(/\.exe$/i, '');
    if (tool === 'git' || tool === 'gh') {
      const cwd = options && options.cwd ? String(options.cwd) : process.cwd();
      fs.appendFileSync(config.trace, `${JSON.stringify({ tool, args, cwd })}\n`);
      if (tool === 'gh') return reply(args, cwd);
    }
    return real.apply(this, arguments);
  };
};

let boundaryFile = '';
before(() => {
  boundaryFile = path.join(scratch.dir, 'boundary.js');
  fs.writeFileSync(boundaryFile, `(${boundaryMain.toString()})();\n`);
});

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(node_path|node_options|init_cwd|gh_.*|github_.*)$/i.test(name)));

/**
 * Runs the doctor CLI in its own process. `gh` maps a project root to the stub's answers.
 * @type {(options: { cwd: string, args?: string[], gh?: Record<string, any>, entry?: string, env?: Record<string, string> }) => { status: number, stdout: string, stderr: string, calls: any[] }}
 */
const runDoctor = ({ cwd, args = ['doctor'], gh = {}, entry = DOCTOR, env = {} }) => {
  const dir = freshDir('run');
  const trace = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(trace, '');
  const config = path.join(dir, 'boundary.json');
  fs.writeFileSync(config, JSON.stringify({ trace, gh }));
  const result = childProcess.spawnSync(process.execPath, ['--require', boundaryFile, entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...cleanEnv(), ...env, DOCTOR_BOUNDARY: config },
  });
  const calls = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
};

// --- the delivery: a real npm pack of this checkout, prepared once ---

const delivery = { dir: '', tarball: '', manifest: null, runtimeDir: '' };
const prepareDelivery = () => {
  if (delivery.tarball) return delivery;
  delivery.dir = freshDir('delivery');
  const inherited = Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name));
  const env = { ...Object.fromEntries(inherited), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const packed = childProcess.spawnSync(process.execPath, [npmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', delivery.dir], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`npm pack failed (${packed.status}): ${packed.stderr}`);
  delivery.tarball = path.join(delivery.dir, JSON.parse(packed.stdout)[0].filename);
  delivery.manifest = packedManifest(delivery.tarball);
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, delivery.manifest.dependencies, 'package-lock.json does not match the packed dependencies');
  delivery.runtimeDir = path.join(delivery.dir, 'runtime');
  for (const key of runtimeClosure(lock, delivery.manifest.dependencies)) {
    const source = path.join(REPO_ROOT, key);
    if (!fs.existsSync(path.join(source, 'package.json'))) {
      if (lock.packages[key].optional) continue;
      throw new Error(`runtime dependency ${key} is not installed; run npm ci first`);
    }
    fs.cpSync(source, path.join(delivery.runtimeDir, key), { recursive: true });
  }
  return delivery;
};

// A light installed package for the many checks that do not run the delivery: what doctor reads of
// the package (manifest, hook scripts, base set sources) and the pinned metaskills next to it.
let lightModules = '';
const lightNodeModules = () => {
  if (lightModules) return lightModules;
  lightModules = path.join(freshDir('light'), 'node_modules');
  const target = path.join(lightModules, 'dark-factory');
  const keep = (source) => path.basename(source) !== 'node_modules' && !source.endsWith('.test.js');
  fs.mkdirSync(target, { recursive: true });
  for (const entry of ['package.json', 'skills', 'agents', 'hooks']) fs.cpSync(path.join(REPO_ROOT, entry), path.join(target, entry), { recursive: true, filter: keep });
  fs.cpSync(path.join(REPO_ROOT, 'node_modules', 'metaskills'), path.join(lightModules, 'metaskills'), { recursive: true, filter: keep });
  return lightModules;
};

// --- projects ---

const readmeSettings = () => JSON.parse(/```json\r?\n([\s\S]*?)\r?\n```/.exec(fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'README.md'), 'utf8'))[1]);
const example = (name) => fs.readFileSync(path.join(REPO_ROOT, 'examples', 'wrappers', name), 'utf8').split(PLACEHOLDER_SHA).join(SHA);
const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')), 'utf8');

/**
 * A committed project of one shape with everything doctor checks in place: profile (Ralph and
 * Judge enabled), trusted configs, wrappers, settings, installed package, copies and list.
 * `files` replaces or (null) removes project files; `profile` mutates the profile; `after` runs
 * last. `gh` is the stub's answers for the root; `install` is false, 'light' or { tarball }.
 * @type {(form: string, options?: any) => { root: string, gh: any, profile: any }}
 */
const makeProject = (form, { profile: mutate = () => {}, files = {}, judge = true, ralph = true, install = 'light', commit = true, seedSetup = true, after = () => {}, ghChange = () => {} } = {}) => {
  const root = path.join(freshDir('project'), 'app');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');

  const profile = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, form, '.factory', 'profile.json'), 'utf8'));
  profile.ralph = { techDebtTrackerIssue: 5, ...profile.ralph, enabled: ralph };
  profile.labels = { ...profile.labels, humanNeeded: 'needs-human' };
  if (judge) {
    profile.judge = { enabled: true };
    profile.labels.calibration = 'calibrate';
  }
  mutate(profile);

  const checks = profile.verifier?.checks ?? [];
  const defaults = {
    '.factory/profile.json': profile,
    'package.json': { name: 'consumer', private: true, devDependencies: { 'dark-factory': `github:${FACTORY_REPOSITORY}#v0.1.0` } },
    '.github/verifier/owners.json': ['owner-one'],
    '.github/verifier/required-checks.json': ['CI'],
    '.github/verifier/allowed-models.json': ['model-v'],
    '.github/verifier/tampering-scan.json': { test: ['**/*.test.ts'] },
    '.github/verifier/risk-zones.json': { zones: [{ name: 'billing', description: 'money movement' }] },
    '.github/workflows/acceptance-verifier.yml': example('acceptance-verifier.yml'),
    '.claude/settings.json': readmeSettings(),
    '.gitignore': gitignoreText(),
  };
  if (judge) {
    defaults['.github/calibration/taxonomy.json'] = fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'judge', 'taxonomy.json'), 'utf8');
    defaults['.github/calibration/allowed-models.json'] = ['model-j'];
    defaults['.github/workflows/calibration-judge.yml'] = example('calibration-judge.yml');
  }
  if (checks.includes('spec-approval')) defaults['.github/workflows/spec-approval.yml'] = example('spec-approval.yml');
  for (const [relative, content] of Object.entries({ ...defaults, ...files })) {
    if (content !== null) writeFile(root, relative, content);
  }

  if (install === 'light') fs.cpSync(lightNodeModules(), path.join(root, 'node_modules'), { recursive: true });
  else if (install) installPackage(path.join(root, 'node_modules'), { ...install });
  if (install && seedSetup) {
    runSetup({ consumerRoot: root, env: {}, packageRoot: path.join(root, 'node_modules', 'dark-factory'), log: () => {} });
  }
  if (commit) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'project');
  }
  after(root);

  let finalProfile = profile;
  try {
    finalProfile = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'profile.json'), 'utf8'));
  } catch {
    // a test removed or damaged the profile on purpose
  }
  const labels = [...CORE_LABELS];
  if (finalProfile.ralph?.enabled === true) labels.push('ralph-blocked', 'needs-human');
  if (finalProfile.judge?.enabled === true) labels.push('calibrate');
  const variables = { VERIFIER_MODEL: 'model-v' };
  if (finalProfile.judge?.enabled === true) variables.CALIBRATION_JUDGE_MODEL = 'model-j';
  const gh = { labels, secrets: ['OPENAI_API_KEY'], variables, secretValues: { OPENAI_API_KEY: SECRET_VALUE }, fail: {} };
  ghChange(gh);
  return { root, gh, profile: finalProfile };
};

/** @type {(project: any, options?: any) => any} */
const doctorOf = (project, options = {}) => runDoctor({ cwd: project.root, gh: { [project.root]: project.gh }, ...options });

/** The report lines "- subject: reason". */
const problemLines = (result) => result.stdout.split('\n').filter((line) => line.startsWith('- '));
const hasProblem = (result, pattern) => problemLines(result).some((line) => pattern.test(line));
const expectProblem = (result, ...patterns) => {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  for (const pattern of patterns) assert.ok(hasProblem(result, pattern), `no problem line matching ${pattern} in:\n${result.stdout}${result.stderr}`);
};
const expectClean = (result, label = '') => {
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /No problems found\./);
  assert.deepEqual(problemLines(result), []);
};

const eachForm = (callback) => {
  for (const form of FIXTURE_PROFILES) callback(form);
};

// --- tests ---

describe('factory doctor', () => {
  it('reports no problems for complete project', () => {
    eachForm((form) => {
      const project = makeProject(form);
      const result = doctorOf(project);
      expectClean(result, form);
      assert.ok(result.stdout.includes(project.root), result.stdout);
      assert.match(result.stdout, /branch: main/);
      assert.equal(result.calls.filter((call) => call.tool === 'gh').length, 3, 'one read of labels, secrets, variables');

      const detached = makeProject(form);
      git(detached.root, 'checkout', '-q', '--detach');
      const detachedResult = doctorOf(detached);
      expectClean(detachedResult, `${form} detached`);
      assert.match(detachedResult.stdout, /branch: detached HEAD/);
    });
  });

  it('reports missing profile', () => {
    eachForm((form) => {
      const project = makeProject(form, { seedSetup: false, files: { '.factory/profile.json': null } });
      const result = doctorOf(project);
      expectProblem(result, /\.factory\/profile\.json: Profile not found/);
      assert.ok(result.stdout.includes(path.join(project.root, '.factory', 'profile.json')));
    });
  });

  it('reports missing trusted configs', () => {
    eachForm((form) => {
      const missing = ['owners', 'required-checks', 'risk-zones'];
      const project = makeProject(form, { files: Object.fromEntries(missing.map((name) => [`.github/verifier/${name}.json`, null])) });
      const result = doctorOf(project);
      expectProblem(result, ...missing.map((name) => new RegExp(`\\.github/verifier/${name}\\.json: missing`)));
      assert.equal(problemLines(result).length, 3, result.stdout);
    });
  });

  it('reports missing labels', () => {
    eachForm((form) => {
      const project = makeProject(form, { ghChange: (gh) => { gh.labels = []; } });
      const result = doctorOf(project);
      expectProblem(result, ...CORE_LABELS.map((name) => new RegExp(`label "${name}": does not exist`)));
    });
  });

  it('reports missing secret and variable', () => {
    eachForm((form) => {
      const project = makeProject(form, { ghChange: (gh) => { gh.secrets = []; delete gh.variables.VERIFIER_MODEL; } });
      const result = doctorOf(project);
      expectProblem(result, /secret OPENAI_API_KEY: is not set/, /variable VERIFIER_MODEL: is not set/);
    });
  });

  it('reports missing verifier wrapper', () => {
    eachForm((form) => {
      const project = makeProject(form, { files: { '.github/workflows/acceptance-verifier.yml': null } });
      expectProblem(doctorOf(project), /\.github\/workflows\/: no valid verifier wrapper/);
    });
  });

  it('reports missing hook entry', () => {
    eachForm((form) => {
      const project = makeProject(form, { files: { '.claude/settings.json': {} } });
      const result = doctorOf(project);
      expectProblem(result, ...HOOK_ENTRIES.map((entry) => new RegExp(entryId(entry).replace(/[|\\]/g, '\\$&'))));
      assert.equal(problemLines(result).filter((line) => line.includes('.claude/settings.json ')).length, 6, result.stdout);
    });
  });

  it('reports package not installed', () => {
    eachForm((form) => {
      const project = makeProject(form, { install: false });
      const result = doctorOf(project);
      expectProblem(result, /node_modules\/dark-factory: not installed in the selected project/);
      assert.ok(!hasProblem(result, /node_modules\/dark-factory\/hooks/), 'the running copy is not substituted');
      assert.ok(result.stdout.includes(project.root));
    });
  });

  it('skips ralph checks when ralph disabled', () => {
    eachForm((form) => {
      const project = makeProject(form, { ralph: false, judge: false, ghChange: (gh) => { gh.labels = [...CORE_LABELS]; } });
      expectClean(doctorOf(project), form);
    });
  });

  it('accepts trusted configs through core validators', () => {
    eachForm((form) => {
      const overlay = { sections: [{ title: 'Rollout', required: false, idPrefix: null }] };
      const project = makeProject(form, { files: { '.github/verifier/issue-contract.overlay.json': overlay } });
      expectClean(doctorOf(project), form);
    });
  });

  it('accepts configured models from their own allowlists', () => {
    eachForm((form) => {
      const project = makeProject(form, { files: { '.github/verifier/allowed-models.json': ['model-v', 'model-x'], '.github/calibration/allowed-models.json': ['model-j'] } });
      assert.ok(project.profile.verifier.checks.includes('allowed-model'));
      expectClean(doctorOf(project), form);
    });
  });

  it('checks explicit project instead of caller repository', () => {
    const outer = makeProject('monorepo');
    const inner = makeProject('single-package', { judge: false, ghChange: (gh) => { gh.labels = gh.labels.filter((name) => name !== 'manual-verified' && name !== 'ralph-blocked'); } });
    const subdirectory = path.join(outer.root, 'packages');
    fs.mkdirSync(subdirectory);
    const result = runDoctor({ cwd: subdirectory, args: ['doctor', inner.root], gh: { [outer.root]: outer.gh, [inner.root]: inner.gh } });
    expectProblem(result, /label "manual-verified"/, /label "ralph-blocked"/);
    assert.ok(result.stdout.includes(inner.root));
    assert.ok(!result.stdout.includes(`doctor: ${outer.root}`));
    const calls = result.calls.filter((call) => call.tool === 'gh');
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(fs.realpathSync.native(call.cwd), inner.root);
  });

  it('accepts installed copies without applying setup', () => {
    eachForm((form) => {
      const project = makeProject(form);
      const before = snapshot(project.root);
      expectClean(doctorOf(project), form);
      assert.deepEqual(snapshot(project.root), before);
      assert.ok(fs.existsSync(path.join(project.root, '.claude', '.factory-installed.json')));
    });
  });

  it('accepts spec approval wrapper when check enabled', () => {
    eachForm((form) => {
      const project = makeProject(form, { profile: (profile) => { profile.verifier.checks = [...new Set([...profile.verifier.checks, 'spec-approval'])]; } });
      assert.ok(fs.existsSync(path.join(project.root, '.github', 'workflows', 'spec-approval.yml')));
      expectClean(doctorOf(project), form);
    });
  });

  it('runs doctor from installed package', () => {
    const { tarball, manifest, runtimeDir } = prepareDelivery();
    const files = tarballFiles(tarball);
    assert.ok(files.includes('doctor/registry.js') && files.includes(manifest.bin.factory), 'the archive carries the doctor payload');
    eachForm((form) => {
      const project = makeProject(form, { install: { tarball, runtimeDir } });
      const entry = path.join(project.root, 'node_modules', 'dark-factory', ...manifest.bin.factory.split('/'));
      assert.ok(fs.existsSync(entry));
      const result = runDoctor({ cwd: project.root, entry, gh: { [project.root]: project.gh } });
      expectClean(result, form);
      assert.ok(result.stdout.includes(project.root));
    });
  });
});

describe('factory doctor: conditional blocks and profile', () => {
  it('reports missing ralph block label when ralph enabled', () => {
    eachForm((form) => {
      const noBlock = doctorOf(makeProject(form, { ghChange: (gh) => { gh.labels = gh.labels.filter((name) => name !== 'ralph-blocked'); } }));
      expectProblem(noBlock, /label "ralph-blocked": does not exist/);
      assert.equal(problemLines(noBlock).length, 1);

      const noHuman = doctorOf(makeProject(form, { ghChange: (gh) => { gh.labels = gh.labels.filter((name) => name !== 'needs-human'); } }));
      expectProblem(noHuman, /label "needs-human": does not exist/);
      assert.equal(problemLines(noHuman).length, 1);

      const noField = makeProject(form, { after: (root) => {
        const file = path.join(root, '.factory', 'profile.json');
        const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete profile.labels.humanNeeded;
        fs.writeFileSync(file, JSON.stringify(profile));
      } });
      noField.gh.labels = noField.gh.labels.filter((name) => name !== 'needs-human');
      const fieldResult = doctorOf(noField);
      expectProblem(fieldResult, /labels\.humanNeeded: required field is missing/);
      assert.ok(!hasProblem(fieldResult, /not checked/), 'the profile is still usable');
    });
  });

  it('checks judge settings only when judge enabled', () => {
    eachForm((form) => {
      const broken = makeProject(form, {
        files: {
          '.github/calibration/taxonomy.json': null,
          '.github/calibration/allowed-models.json': null,
          '.github/workflows/calibration-judge.yml': null,
          '.github/workflows/acceptance-verifier.yml': null,
          '.github/workflows/verify.yml': example('acceptance-verifier.yml'),
        },
        ghChange: (gh) => { gh.labels = gh.labels.filter((name) => name !== 'calibrate'); delete gh.variables.CALIBRATION_JUDGE_MODEL; },
      });
      expectProblem(
        doctorOf(broken),
        /label "calibrate": does not exist/,
        /variable CALIBRATION_JUDGE_MODEL: is not set/,
        /calibration-judge\.yml|no valid Calibration Judge wrapper/,
        /\.github\/calibration\/taxonomy\.json: missing/,
        /\.github\/calibration\/allowed-models\.json: missing/,
        /verify\.yml: Judge is enabled: the verifier wrapper must be at \.github\/workflows\/acceptance-verifier\.yml/,
      );

      const off = makeProject(form, {
        judge: false,
        ghChange: (gh) => { gh.labels = gh.labels.filter((name) => name !== 'calibrate'); },
        files: { '.github/workflows/acceptance-verifier.yml': null, '.github/workflows/verify.yml': example('acceptance-verifier.yml') },
      });
      expectClean(doctorOf(off), `${form} judge off`);
    });
  });

  it('preserves explicitly disabled verifier checks', () => {
    eachForm((form) => {
      const project = makeProject(form, { profile: (profile) => { profile.verifier.checks = []; }, files: { '.github/workflows/spec-approval.yml': null } });
      assert.deepEqual(project.profile.verifier.checks, []);
      const result = doctorOf(project);
      expectClean(result, form);
    });
  });

  it('does not require optional contract overlay', () => {
    eachForm((form) => {
      const project = makeProject(form, { files: { '.github/verifier/issue-contract.overlay.json': null } });
      assert.ok(!fs.existsSync(path.join(project.root, '.github', 'verifier', 'issue-contract.overlay.json')));
      expectClean(doctorOf(project), form);
    });
  });

  it('reports invalid profile checks and settings', () => {
    const forms = [...FIXTURE_PROFILES];
    const invalid = makeProject(forms[0], { seedSetup: false, files: { '.factory/profile.json': '{"branchTemplate": 1}' } });
    const invalidResult = doctorOf(invalid);
    expectProblem(invalidResult, /\.factory\/profile\.json: Invalid profile/, /not checked: the profile is unusable/);
    assert.ok(!hasProblem(invalidResult, /label "ralph-blocked"/), 'an invalid profile is not an implicit Ralph skip');

    const unknown = makeProject(forms[1], { profile: (profile) => { profile.verifier.checks = ['allowed-model', 'no-such-check']; } });
    expectProblem(doctorOf(unknown), /verifier\.checks: unknown check "no-such-check"/);

    const settings = makeProject(forms[0], { files: { '.claude/settings.json': '{not json' } });
    expectProblem(doctorOf(settings), /\.claude\/settings\.json: is not valid JSON/);
  });
});

describe('factory doctor: trusted configs', () => {
  it('rejects missing or invalid trusted configs', () => {
    /** @type {any[][]} */
    const cases = [
      ['.github/verifier/owners.json', null, /missing/],
      ['.github/verifier/required-checks.json', null, /missing/],
      ['.github/verifier/allowed-models.json', null, /missing/],
      ['.github/verifier/tampering-scan.json', null, /missing/],
      ['.github/verifier/risk-zones.json', null, /missing/],
      ['.github/verifier/owners.json', '{oops', /is not valid JSON/],
      ['.github/verifier/owners.json', { owner: 'one' }, /must be a JSON array of strings/],
      ['.github/verifier/required-checks.json', [1, 2], /must be a JSON array of strings/],
      ['.github/verifier/allowed-models.json', '"model"', /must be a JSON array of strings/],
      ['.github/verifier/tampering-scan.json', ['x'], /must map class names to arrays of pattern strings/],
      ['.github/verifier/risk-zones.json', { zones: 'x' }, /"zones" must be a list/],
      ['.github/verifier/issue-contract.overlay.json', { removeSections: ['Context'] }, /cannot remove base section/],
      ['.github/calibration/taxonomy.json', { primary_cause: [] }, /taxonomy is missing required key/],
      ['.github/calibration/allowed-models.json', { model: 1 }, /must be a JSON array of strings/],
    ];
    for (const [index, [file, content, reason]] of cases.entries()) {
      const project = makeProject(FIXTURE_PROFILES[index % 2], { files: { [file]: content } });
      const result = doctorOf(project);
      expectProblem(result, new RegExp(`${file.replace(/\./g, '\\.')}: .*${reason.source}`));
      assert.equal(problemLines(result).length, 1, `${file}\n${result.stdout}`);
    }
  });
});

describe('factory doctor: GitHub reads', () => {
  it('reports github unavailable instead of passing', () => {
    const kinds = { labels: 'gh label list', secrets: 'gh secret list', variables: 'gh variable list' };
    const reasons = { spawn: /did not run/, exit: /exited with 4: HTTP 403/, garbage: /not JSON/ };
    let index = 0;
    for (const [kind, subject] of Object.entries(kinds)) {
      for (const [mode, reason] of Object.entries(reasons)) {
        const project = makeProject(FIXTURE_PROFILES[index++ % 2], { ghChange: (gh) => { gh.fail[kind] = mode; } });
        const result = doctorOf(project);
        expectProblem(result, new RegExp(`${subject}: check unavailable: .*`), reason);
        assert.ok(!hasProblem(result, /does not exist|is not set/), `no proven absence from a failed read\n${result.stdout}`);
        assert.equal(problemLines(result).length, 1, result.stdout);
      }
    }
  });

  it('makes read-only github calls', () => {
    /** @type {any[][]} */
    const scenarios = [
      ['monorepo', {}],
      ['single-package', { ghChange: (gh) => { gh.labels = []; gh.fail.secrets = 'exit'; } }],
      ['monorepo', { files: { '.claude/settings.json': {} }, install: false }],
    ];
    for (const [form, options] of scenarios) {
      const project = makeProject(form, options);
      const checkoutBefore = ['bin', 'doctor', 'hooks'].map((dir) => treeHashes(path.join(REPO_ROOT, dir)));
      const before = snapshot(project.root);
      const result = doctorOf(project);
      assert.ok([0, 1].includes(result.status), result.stderr);
      assert.deepEqual(snapshot(project.root), before, 'project files, status and refs are unchanged');
      assert.deepEqual(['bin', 'doctor', 'hooks'].map((dir) => treeHashes(path.join(REPO_ROOT, dir))), checkoutBefore, 'the executing package is unchanged');

      const ghCalls = result.calls.filter((call) => call.tool === 'gh');
      assert.equal(ghCalls.length, 3);
      for (const call of ghCalls) {
        assert.ok(GH_READS.includes(call.args.slice(0, 2).join(' ')), call.args.join(' '));
        assert.equal(fs.realpathSync.native(call.cwd), project.root);
        assert.ok(!call.args.join(' ').includes('value') || call.args[0] === 'variable', 'the secret value is not asked for');
      }
      for (const call of result.calls.filter((item) => item.tool === 'git')) {
        const args = call.args.filter((arg, position) => !arg.startsWith('-') && call.args[position - 1] !== '-c');
        assert.ok(READ_ONLY_GIT.has(args[0]), `git ${call.args.join(' ')}`);
      }
      assert.ok(!result.stdout.includes(SECRET_VALUE) && !result.stderr.includes(SECRET_VALUE));
    }
  });
});

describe('factory doctor: hooks', () => {
  const settingsFor = (mutate) => {
    const settings = readmeSettings();
    mutate(settings.hooks);
    return settings;
  };
  const groupOf = (hooks, event, matcher) => hooks[event].find((group) => group.matcher === matcher);
  const commandOf = (entry) => `node "$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/${entry}"`;

  it('reports gate entry without fail closed', () => {
    eachForm((form) => {
      const settings = settingsFor((hooks) => { groupOf(hooks, 'PreToolUse', 'Write|Edit').hooks[0].command = commandOf('skill-gate.js'); });
      const result = doctorOf(makeProject(form, { files: { '.claude/settings.json': settings } }));
      expectProblem(result, /PreToolUse\/Write\|Edit\/skill-gate\.js: wrong: .*expected node .* \|\| exit 2/);
      assert.equal(problemLines(result).length, 1);
    });
  });

  it('rejects incomplete or miswired hook entries', () => {
    /** @type {any[][]} */
    const cases = [
      ['wrong event', (hooks) => { hooks.PreToolUse.push(hooks.PostToolUse.shift()); }, /PostToolUse\/Skill\/skill-marker\.js: missing/],
      ['wrong matcher', (hooks) => { groupOf(hooks, 'PostToolUse', 'Write|Edit').matcher = 'Write'; }, /PostToolUse\/Write\|Edit\/lint\.js: missing/],
      ['wrong path', (hooks) => { groupOf(hooks, 'PostToolUse', 'Write|Edit').hooks[0].command = 'node "$CLAUDE_PROJECT_DIR/vendor/hooks/lint.js" || true'; }, /PostToolUse\/Write\|Edit\/lint\.js: wrong/],
      ['only the MCP closure gate missing', (hooks) => { hooks.PreToolUse = hooks.PreToolUse.filter((group) => group.matcher !== 'mcp__github__issue_write'); }, /PreToolUse\/mcp__github__issue_write\/closure-gate\.js: missing/],
      ['name inside echo', (hooks) => { groupOf(hooks, 'PostToolUse', 'Write|Edit').hooks[1].command = `echo ${commandOf('typecheck.js')} || true`; }, /PostToolUse\/Write\|Edit\/typecheck\.js: wrong/],
      ['unquoted path', (hooks) => { groupOf(hooks, 'PostToolUse', 'Skill').hooks[0].command = 'node $CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/skill-marker.js || true'; }, /PostToolUse\/Skill\/skill-marker\.js: wrong/],
      ['helper that can block', (hooks) => { groupOf(hooks, 'PostToolUse', 'Skill').hooks[0].command = commandOf('skill-marker.js'); }, /PostToolUse\/Skill\/skill-marker\.js: wrong/],
    ];
    for (const [index, [label, mutate, reason]] of cases.entries()) {
      const project = makeProject(FIXTURE_PROFILES[index % 2], { files: { '.claude/settings.json': settingsFor(mutate) } });
      const result = doctorOf(project);
      expectProblem(result, reason);
      const settingsProblems = problemLines(result).filter((line) => line.includes('.claude/settings.json '));
      assert.equal(settingsProblems.length, label === 'wrong matcher' ? 2 : 1, `${label}\n${result.stdout}`);
    }
  });
});

describe('factory doctor: wrappers', () => {
  const wrapper = (change) => change(example('acceptance-verifier.yml'));
  const wrapperProblem = (form, text, pattern) => {
    const project = makeProject(form, { files: { '.github/workflows/acceptance-verifier.yml': text } });
    expectProblem(doctorOf(project), pattern);
  };

  it('rejects invalid verifier wrapper pins and targets', () => {
    const verifierUses = `uses: ${FACTORY_REPOSITORY}/.github/workflows/acceptance-verifier.yml@${SHA}`;
    /** @type {any[][]} */
    const cases = [
      ['floating ref', wrapper((text) => text.replace(`${verifierUses}`, `${verifierUses.replace(`@${SHA}`, '@main')}`)), /"@main" is not a full 40-character/],
      ['with sha differs', wrapper((text) => text.replace(`factory-sha: ${SHA}`, `factory-sha: ${OTHER_SHA}`)), /with\.factory-sha is f1e2/],
      ['uses and with in different jobs', wrapper((text) => `${text.replace(/^ {4}with:[\s\S]*$/m, '')}  other:\n    runs-on: ubuntu-latest\n    with:\n      factory-sha: ${SHA}\n`), /has no with\.factory-sha/],
      ['foreign repository', wrapper((text) => text.replace(`uses: ${FACTORY_REPOSITORY}/`, 'uses: someone/else/')), /calls someone\/else, not /],
      ['commented uses', wrapper((text) => text.replace(/^ {4}uses:/m, '    # uses:')), /no job calls /],
      ['broken structure', 'name: broken\non: push\nsteps:\n  - run: echo\n', /not a workflow with a "jobs:" block/],
      ['judge workflow instead', wrapper((text) => text.replace('/acceptance-verifier.yml@', '/calibration-judge.yml@')), /no job calls .*acceptance-verifier\.yml/],
    ];
    for (const [index, [label, text, reason]] of cases.entries()) {
      const project = makeProject(FIXTURE_PROFILES[index % 2], { judge: false, files: { '.github/workflows/acceptance-verifier.yml': text } });
      const result = doctorOf(project);
      assert.equal(result.status, 1, label);
      assert.ok(hasProblem(result, /acceptance-verifier\.yml: not a valid verifier wrapper/) && hasProblem(result, reason), `${label}\n${result.stdout}`);
    }
    wrapperProblem('monorepo', example('acceptance-verifier.yml').replace(/ {4}uses:.*\n/, '    uses: ./.github/workflows/acceptance-verifier.yml\n'), /no job calls /);
  });

  it('requires valid spec approval wrapper only when enabled', () => {
    const withSpec = (profile) => { profile.verifier.checks = [...new Set([...profile.verifier.checks, 'spec-approval'])]; };
    /** @type {any[][]} */
    const cases = [
      ['missing', null, /no valid spec-approval wrapper/],
      ['floating', example('spec-approval.yml').replace(`@${SHA}`, '@v1'), /spec-approval\.yml: not a valid spec-approval wrapper.*not a full 40-character/],
      ['sha differs from verifier', example('spec-approval.yml').split(SHA).join(OTHER_SHA), /pin different commits/],
    ];
    for (const [index, [label, text, reason]] of cases.entries()) {
      const form = FIXTURE_PROFILES[index % 2];
      const project = makeProject(form, { profile: withSpec, files: { '.github/workflows/spec-approval.yml': text } });
      const result = doctorOf(project);
      assert.equal(result.status, 1, label);
      assert.ok(hasProblem(result, reason), `${label}\n${result.stdout}`);
    }
    eachForm((form) => {
      const without = makeProject(form, { profile: (profile) => { profile.verifier.checks = profile.verifier.checks.filter((name) => name !== 'spec-approval'); }, files: { '.github/workflows/spec-approval.yml': null } });
      expectClean(doctorOf(without), form);
    });
  });
});

describe('factory doctor: package and models', () => {
  it('rejects incomplete package and floating reference', () => {
    const pin = (spec) => ({ 'package.json': { name: 'consumer', devDependencies: { 'dark-factory': spec } } });
    /** @type {any[][]} */
    const cases = [
      ['empty package directory', { install: false, after: (root) => fs.mkdirSync(path.join(root, 'node_modules', 'dark-factory', 'hooks'), { recursive: true }) }, /node_modules\/dark-factory: node_modules\/dark-factory\/package\.json is not readable/],
      ['wrong package name', { after: (root) => writeFile(root, 'node_modules/dark-factory/package.json', { name: 'other' }) }, /names "other", not "dark-factory"/],
      ['missing hook script', { after: (root) => fs.rmSync(path.join(root, 'node_modules', 'dark-factory', 'hooks', 'lint.js')) }, /node_modules\/dark-factory\/hooks\/lint\.js: the hook script is missing/],
      ['floating reference', { files: pin(`github:${FACTORY_REPOSITORY}#main`) }, /package\.json: floating factory reference .*"main" is not a release tag/],
      ['other repository', { files: pin('github:someone/else#v0.1.0') }, /package\.json: factory dependency .* does not install from /],
    ];
    for (const [index, [label, options, reason]] of cases.entries()) {
      const result = doctorOf(makeProject(FIXTURE_PROFILES[index % 2], { seedSetup: false, ...options }));
      assert.equal(result.status, 1, label);
      assert.ok(hasProblem(result, reason), `${label}\n${result.stdout}`);
    }
  });

  it('rejects models outside applicable allowlist', () => {
    const verifierUnknown = makeProject('monorepo', { ghChange: (gh) => { gh.variables.VERIFIER_MODEL = 'model-unknown'; } });
    expectProblem(doctorOf(verifierUnknown), /variable VERIFIER_MODEL: "model-unknown" is not in \.github\/verifier\/allowed-models\.json/);

    const judgeUnknown = makeProject('single-package', { ghChange: (gh) => { gh.variables.CALIBRATION_JUDGE_MODEL = 'model-unknown'; } });
    expectProblem(doctorOf(judgeUnknown), /variable CALIBRATION_JUDGE_MODEL: "model-unknown" is not in \.github\/calibration\/allowed-models\.json/);

    eachForm((form) => {
      const crossed = makeProject(form, { ghChange: (gh) => { gh.variables.CALIBRATION_JUDGE_MODEL = 'model-v'; } });
      const result = doctorOf(crossed);
      expectProblem(result, /variable CALIBRATION_JUDGE_MODEL: "model-v" is not in \.github\/calibration/);
      assert.equal(problemLines(result).length, 1);

      const off = makeProject(form, {
        profile: (profile) => { profile.verifier.checks = profile.verifier.checks.filter((name) => name !== 'allowed-model'); },
        ghChange: (gh) => { gh.variables.VERIFIER_MODEL = 'model-unknown'; },
      });
      expectClean(doctorOf(off), `${form} allowed-model disabled`);
    });
  });
});

describe('factory doctor: copies', () => {
  const firstSkill = () => JSON.parse(read('skills/base-set.json')).processSkills[0].name;

  it('reports setup conflicts without changing copies', () => {
    const skill = firstSkill();
    const copy = `.claude/skills/${skill}`;
    const manifestFile = '.claude/.factory-installed.json';
    /** @type {any[][]} */
    const cases = [
      ['tracked path', { after: (root) => { git(root, 'add', '-f', copy); git(root, 'commit', '-q', '-m', 'track'); } }, new RegExp(`conflict: "${copy}" has tracked files`)],
      ['foreign path', { after: (root) => {
        const file = path.join(root, manifestFile);
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.copies = manifest.copies.filter((name) => name !== copy);
        fs.writeFileSync(file, JSON.stringify(manifest));
      } }, new RegExp(`conflict: "${copy}" exists and is not listed`)],
      ['broken list', { after: (root) => fs.writeFileSync(path.join(root, manifestFile), '{broken') }, /\.factory-installed\.json is not valid JSON/],
      ['missing copy', { after: (root) => fs.rmSync(path.join(root, copy), { recursive: true }) }, new RegExp(`${copy}: the expected skill copy is missing`)],
      ['missing list', { after: (root) => fs.rmSync(path.join(root, manifestFile)) }, /\.factory-installed\.json: the list of installed copies is missing/],
      ['missing exclusion', { after: (root) => fs.writeFileSync(path.join(root, '.gitignore'), gitignoreText().replace(`${copy}\n`, '')) }, new RegExp(`\\.gitignore has no entry for "${copy}"`)],
      ['negated exclusion', { after: (root) => fs.writeFileSync(path.join(root, '.gitignore'), `${gitignoreText()}!${copy}\n`) }, new RegExp(`git does not ignore "${copy}"`)],
      ['list not excluded', { after: (root) => fs.writeFileSync(path.join(root, '.gitignore'), gitignoreText().replace(`${manifestFile}\n`, '')) }, new RegExp(`\\.gitignore has no entry for "${manifestFile}"`)],
    ];
    for (const [index, [label, options, reason]] of cases.entries()) {
      const project = makeProject(FIXTURE_PROFILES[index % 2], options);
      const before = snapshot(project.root);
      const result = doctorOf(project);
      assert.equal(result.status, 1, label);
      assert.ok(hasProblem(result, reason), `${label}\n${result.stdout}`);
      assert.deepEqual(snapshot(project.root), before, `${label}: nothing is written`);
    }
  });
});

describe('factory doctor: location and delivery', () => {
  it('resolves repository root and rejects invalid location', () => {
    eachForm((form) => {
      const project = makeProject(form);
      const nested = path.join(project.root, 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });
      const result = runDoctor({ cwd: nested, gh: { [project.root]: project.gh } });
      expectClean(result, form);
      assert.ok(result.stdout.includes(`doctor: ${project.root}`));
    });

    const outside = freshDir('outside');
    const outsideResult = runDoctor({ cwd: outside });
    assert.equal(outsideResult.status, 2);
    assert.match(outsideResult.stderr, /is not inside a git repository/);
    assert.deepEqual(fs.readdirSync(outside), []);

    const missing = runDoctor({ cwd: outside, args: ['doctor', path.join(outside, 'nope')] });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /project path .* is not an existing directory/);
    assert.equal(runDoctor({ cwd: outside, args: ['check'] }).status, 2);
  });

  it('reports unavailable git without fallback', () => {
    const project = makeProject('monorepo');
    const emptyPath = freshDir('no-git');
    const before = snapshot(project.root);
    const env = Object.fromEntries(Object.keys(process.env).filter((name) => /^path$/i.test(name)).map((name) => [name, emptyPath]));
    const result = runDoctor({ cwd: project.root, gh: { [project.root]: project.gh }, env });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /cannot run git/);
    assert.ok(!result.stdout.includes(REPO_ROOT) && !result.stdout.includes('No problems found.'));
    assert.deepEqual(snapshot(project.root), before);
  });

  it('requires doctor payload and preserves setup command', () => {
    const { tarball, manifest, runtimeDir } = prepareDelivery();
    const binDefects = (candidate) => ['factory', 'dark-factory-setup'].filter((name) => typeof candidate.bin?.[name] !== 'string');
    assert.deepEqual(binDefects(manifest), []);
    assert.equal(manifest.bin['dark-factory-setup'], 'bin/setup.js');
    assert.deepEqual(binDefects({ ...manifest, bin: { 'dark-factory-setup': 'bin/setup.js' } }), ['factory']);

    const payload = tarballFiles(tarball).filter((file) => file.startsWith('doctor/'));
    assert.ok(payload.length > 0);
    eachForm((form) => {
      const project = makeProject(form, { install: { tarball, runtimeDir, exclude: payload } });
      assert.ok(!fs.existsSync(path.join(project.root, 'node_modules', 'dark-factory', 'doctor')));
      const result = runDoctor({ cwd: project.root, entry: path.join(project.root, 'node_modules', 'dark-factory', 'bin', 'doctor.js'), gh: { [project.root]: project.gh } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Cannot find module .*doctor/);
      assert.ok(!result.stdout.includes('No problems found.'));
    });

    const fresh = makeProject('single-package', { install: { tarball, runtimeDir }, seedSetup: false, commit: false });
    const setup = childProcess.spawnSync(process.execPath, [path.join(fresh.root, 'node_modules', 'dark-factory', manifest.bin['dark-factory-setup']), '--consumer-root', fresh.root], { cwd: fresh.root, encoding: 'utf8', env: cleanEnv() });
    assert.equal(setup.status, 0, setup.stderr);
    assert.ok(fs.existsSync(path.join(fresh.root, '.claude', '.factory-installed.json')));
  });
});

describe('factory doctor: the factory itself', () => {
  // The real connection files of this repository (INV-17) next to the installed release; only gh is replaced.
  const factoryGh = (root, { labels = CORE_LABELS } = {}) => {
    const [model] = JSON.parse(fs.readFileSync(path.join(root, '.github', 'verifier', 'allowed-models.json'), 'utf8'));
    return { labels, secrets: ['OPENAI_API_KEY'], variables: { VERIFIER_MODEL: model }, secretValues: { OPENAI_API_KEY: SECRET_VALUE }, fail: {} };
  };
  const doctorOfFactory = (project, gh) => runDoctor({ cwd: project.root, entry: path.join(project.installed, 'bin', 'doctor.js'), gh: { [project.root]: gh } });

  it('doctor passes on factory itself without ralph checks', (t) => {
    const project = makeFactoryProject(t);
    const profile = JSON.parse(fs.readFileSync(path.join(project.root, '.factory', 'profile.json'), 'utf8'));
    assert.equal(profile.ralph.enabled, false);
    assert.equal(profile.judge, undefined);
    assert.ok(project.files.includes('.github/workflows/verifier-wrapper.yml') && project.files.includes('.github/verifier/owners.json'), 'the real files are the input');

    const gh = factoryGh(project.root);
    assert.ok(!gh.labels.includes('ralph-blocked') && !gh.labels.includes('calibrate'), 'no label of Ralph or Judge is set');
    const result = doctorOfFactory(project, gh);
    expectClean(result);
    assert.equal(result.calls.filter((call) => call.tool === 'gh').length, 3, 'one read of labels, secrets, variables');
    assert.ok(fs.existsSync(path.join(project.root, '.claude', '.factory-installed.json')), 'the copies come from the installed release');
    assert.ok(fs.existsSync(path.join(project.root, '.claude', 'skills', 'release', 'SKILL.md')), 'the own tools stay');
  });

  it('doctor on factory reports missing label', (t) => {
    const project = makeFactoryProject(t);
    const result = doctorOfFactory(project, factoryGh(project.root, { labels: CORE_LABELS.filter((name) => name !== 'spec-approved') }));
    expectProblem(result, /label "spec-approved": does not exist/);
    assert.equal(problemLines(result).length, 1, result.stdout);
  });
});
