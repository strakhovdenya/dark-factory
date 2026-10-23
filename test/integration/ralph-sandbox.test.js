'use strict';

// Real Docker integration of the Ralph sandbox and controller (`npm run test:ralph:sandbox`, never
// part of `npm test`). Linux host with a Linux Docker engine; the images are prepared beforehand by
// `npm run prepare:ralph:sandbox` and are only checked here, never built or pulled.
//
// What is real: the Docker CLI and engine, the egress proxy, bind mounts, networks, time limits,
// cleanup, git (with a local bare origin), npm against the controlled HTTPS registry fixture, and
// the factory's own modules, loaded from an installed copy of the current working version. What is
// replaced: the agent (a stub `claude` first in PATH of the derived image, a separate process in
// the real agent container), the gh CLI (answered at the child_process boundary, addressed to `gh`
// only) and, for the startup scenarios, the image build step (a check of the prepared image).
//
// No test here is skipped: without Docker or the images the `before` hook fails every test. The
// scenarios of the two maps of preserved reference tests name tests of this file (see
// test/fixtures/ralph-sandbox/lib/coverage.js); the last test checks that each of them ran and passed.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helpers = require('../helpers/ralph');
const { installFactoryRuntime, gitignoreText } = require('../helpers/factory-package');
const harness = require('./run-ralph-sandbox');
const coverage = require('../fixtures/ralph-sandbox/lib/coverage');
const { treeHash } = require('../fixtures/ralph-sandbox/lib/tree-hash');
const { parseEvidence } = require('../fixtures/ralph-sandbox/lib/probes');
const { PROBE_BODY, READY_LINE } = require('../fixtures/ralph-sandbox/service/server');

// --- configuration, scratch space, the installed factory copy ---

const CONFIG = harness.loadConfig();
const STUB = CONFIG.stubImage;
const SOURCE = CONFIG.sandbox.image;
const ALLOWED = CONFIG.service.allowedHost;
const BLOCKED = CONFIG.service.blockedHost;
const PACKAGE = CONFIG.service.package;
const MISSING_PACKAGE = CONFIG.service.missingPackage;
const STEP = ['node', '/opt/ralph-fixture/bin/step.js'];
const QUIET = { out: () => {}, err: () => {} };
const RUN_ID = crypto.randomBytes(3).toString('hex');
const ROOT_KEY = `it${RUN_ID}`;
const CANARY = {
  apiKey: `sk-ant-canary-${RUN_ID}`,
  oauth: `oauth-canary-${RUN_ID}`,
  ghToken: `gh-canary-${RUN_ID}`,
  githubToken: `github-canary-${RUN_ID}`,
  password: `password-canary-${RUN_ID}`,
};
const OPERATOR_HOME = os.homedir();

// Nothing of the suite may land in the operator's home: checked before the first write.
if (require('../../ralph/sandbox').isInsideHome(os.tmpdir())) {
  throw new Error(`the temporary directory ${os.tmpdir()} is inside the operator's home; set TMPDIR outside it`);
}

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-it-')));
const NODE_MODULES = path.join(SCRATCH, 'installed', 'node_modules');
const { packageRoot: PACKAGE_ROOT } = installFactoryRuntime(NODE_MODULES);
const FACTORY_HASH = treeHash(PACKAGE_ROOT);
const factory = (relative) => require(path.join(PACKAGE_ROOT, relative));
const sandbox = factory('ralph/sandbox.js');
const agent = factory('ralph/agent.js');
const workspace = factory('ralph/workspace.js');
const core = factory('ralph/core.js');
const run = factory('ralph/run.js');
const boundary = factory('ralph/boundary.js');
const { loadProfile } = factory('profile/load.js');
const { freezeSnapshot } = factory('ralph/trusted-profile.js');

// Host git of the tests and of the controller: no operator config, a fixed identity.
fs.writeFileSync(path.join(SCRATCH, 'empty.gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: path.join(SCRATCH, 'empty.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

// --- the process boundary: every host process is recorded; gh is answered, nothing else replaced ---

const real = { spawnSync: childProcess.spawnSync, spawn: childProcess.spawn, execFileSync: childProcess.execFileSync };
const hostCalls = [];
let ghHandler = null;

const argsOf = (args) => (Array.isArray(args) ? [...args] : []);

/** @type {any} */ (childProcess).spawnSync = (file, args, options) => {
  const result = real.spawnSync(file, args, options);
  const list = argsOf(args);
  const isRun = file === 'docker' && list[0] === 'run';
  hostCalls.push({ via: 'spawnSync', file, args: list, stdout: isRun ? String(result.stdout || '') : null });
  return result;
};
/** @type {any} */ (childProcess).spawn = (file, args, options) => {
  hostCalls.push({ via: 'spawn', file, args: argsOf(args), stdout: null });
  return real.spawn(file, args, options);
};
/** @type {any} */ (childProcess).execFileSync = (file, args, options = {}) => {
  hostCalls.push({ via: 'execFileSync', file, args: argsOf(args), stdout: null });
  if (file !== 'gh') return real.execFileSync(file, args, options);
  if (!ghHandler) throw new Error(`unexpected gh call: ${argsOf(args).join(' ')}`);
  const out = String(ghHandler(argsOf(args), options) ?? '');
  return options.encoding ? out : Buffer.from(out);
};

// --- Docker helpers of the test (not recorded) ---

const docker = (args) => real.spawnSync('docker', args, { encoding: 'utf8' });

const mustDocker = (args) => {
  const result = docker(args);
  if (result.error || result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.error ? result.error.message : String(result.stderr).trim()}`);
  return String(result.stdout);
};

// Ids from a listing; a failing Docker query is an error, never an empty result.
const dockerIds = (args) =>
  mustDocker(args)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const resourcesWith = (label) => ({
  containers: dockerIds(['ps', '-aq', '--filter', `label=${label}`]),
  networks: dockerIds(['network', 'ls', '-q', '--filter', `label=${label}`]),
});

const assertNoResources = (label) => assert.deepEqual(resourcesWith(label), { containers: [], networks: [] }, label);

const isRunning = (id) => dockerIds(['ps', '-q', '--no-trunc', '--filter', `id=${id}`]).length > 0;
const networkExists = (name) => dockerIds(['network', 'ls', '-q', '--filter', `name=^${name}$`]).length > 0;
const containerExists = (name) => dockerIds(['ps', '-aq', '--filter', `name=^${name}$`]).length > 0;

const removeNetwork = (network) => {
  const attached = docker(['network', 'inspect', '-f', '{{range .Containers}}{{.Name}} {{end}}', network]);
  for (const name of String(attached.stdout || '').split(/\s+/).filter(Boolean)) docker(['network', 'disconnect', '-f', network, name]);
  docker(['network', 'rm', network]);
};

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check, what, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleepMs(200);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const sleeper = (t, labels) => {
  const id = mustDocker(['run', '-d', '--rm', ...labels.flatMap((label) => ['--label', label]), STUB, 'sleep', '300']).trim();
  t.after(() => docker(['rm', '-f', id]));
  return id;
};

const labelledNetwork = (t, labels) => {
  const name = `ralph-it-net-${crypto.randomBytes(3).toString('hex')}`;
  mustDocker(['network', 'create', ...labels.flatMap((label) => ['--label', label]), name]);
  t.after(() => removeNetwork(name));
  return name;
};

// --- scratch repositories, clones and stub calls ---

let dirSeq = 0;
const scratchDir = (prefix) => {
  dirSeq++;
  const dir = path.join(SCRATCH, `${prefix}-${dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const gitIn = (cwd, ...args) => String(real.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

/** A bare origin with one commit of `files` on `trunk` and a consumer root cloned from it. */
function makeRepository(files) {
  const root = scratchDir('repo');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  gitIn(seed, 'init', '-q', '-b', 'trunk');
  helpers.writeFiles(seed, { '.gitignore': gitignoreText(), ...files });
  gitIn(seed, 'add', '-A');
  gitIn(seed, 'commit', '-qm', 'init');
  const origin = path.join(root, 'origin.git');
  gitIn(root, 'clone', '-q', '--bare', seed, origin);
  const consumerRoot = path.join(root, 'consumer');
  gitIn(root, 'clone', '-q', origin, consumerRoot);
  return { origin, consumerRoot, root };
}

/**
 * A run clone made by the controller's own prepareClone, with its sessions root beside it.
 * @param {Record<string, string>} [files]
 */
function cloneFor(files = { 'a.txt': 'one\n' }) {
  const { origin } = makeRepository(files);
  const runsRoot = scratchDir('runs');
  const runDir = workspace.runDirFor(runsRoot, 1);
  workspace.prepareClone(runsRoot, runDir, origin);
  return { runDir, runsRoot, sessionsRoot: workspace.runSessionsDirFor(runsRoot, 1) };
}

const directivePrompt = (directive) => `Stub call of the integration test.\nRALPH-STUB-DIRECTIVE: ${JSON.stringify(directive)}\n`;
const box = (runLabel, extra = {}) => ({ image: STUB, rootKey: ROOT_KEY, runLabel, network: 'none', ...extra });
const readReport = (sessionsDir) => JSON.parse(fs.readFileSync(path.join(sessionsDir, 'ralph-stub-report.json'), 'utf8'));
const journalsIn = (sessionsDir) => {
  const projects = path.join(sessionsDir, 'projects');
  return fs.existsSync(projects) ? fs.readdirSync(projects, { recursive: true }).map(String).filter((file) => file.endsWith('.jsonl')) : [];
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** The log a failure message names (`...; full output: <log>`). */
const namedLog = (message) => {
  const match = /full output: (\S+)$/.exec(String(message));
  assert.ok(match, `the failure names its log: ${message}`);
  return match[1];
};

/**
 * runAgent of the installed copy with the stub; returns the result and the call's sessions dir.
 * @param {{ env?: Record<string, string>, runLabel?: string, timeoutMs?: number, network?: string, proxyUrl?: string }} [options]
 */
async function stubCall(runDir, sessionsRoot, label, directive, options = {}) {
  const { env = { ANTHROPIC_API_KEY: CANARY.apiKey }, runLabel = 'issue-agent', timeoutMs, network = 'none', proxyUrl } = options;
  const sessionsDir = workspace.prepareAgentSessionDir(sessionsRoot, label);
  const result = await agent.runAgent(directivePrompt(directive), runDir, null, {
    env,
    timeoutMs,
    echo: QUIET,
    sandbox: box(runLabel, { network, proxyUrl, sessionsDir }),
  });
  return { result, sessionsDir };
}

/** A fake operator home with canaries, set as HOME/USERPROFILE for the duration of `fn`. */
async function withOperatorHome(fn) {
  const home = scratchDir('operator-home');
  const marker = `.ralph-home-marker-${RUN_ID}`;
  helpers.writeFiles(home, {
    [marker]: 'operator secret\n',
    '.ssh/id_ed25519': `ssh canary ${RUN_ID}\n`,
    '.config/gh/hosts.yml': `github.com:\n  oauth_token: ${CANARY.ghToken}\n`,
    '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: CANARY.oauth } }),
    '.claude.json': JSON.stringify({ primaryApiKey: CANARY.apiKey }),
  });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DOCKER_CONFIG: process.env.DOCKER_CONFIG };
  process.env.DOCKER_CONFIG = saved.DOCKER_CONFIG || path.join(OPERATOR_HOME, '.docker');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn({ home, marker });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// --- controlled service, proxy and the positive control probe ---

function startService(t) {
  const id = crypto.randomBytes(3).toString('hex');
  const network = `ralph-it-svc-${id}`;
  const name = `ralph-it-service-${id}`;
  mustDocker(['network', 'create', network]);
  t.after(() => {
    docker(['rm', '-f', name]);
    removeNetwork(network);
  });
  const aliases = [ALLOWED, BLOCKED].flatMap((alias) => ['--network-alias', alias]);
  mustDocker(['run', '-d', '--name', name, '--network', network, ...aliases, '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', STUB, 'node', '/opt/ralph-fixture/service/server.js']);
  const logs = () => String(docker(['logs', name]).stdout || '');
  const deadline = Date.now() + 20000;
  while (!logs().includes(READY_LINE)) {
    if (Date.now() > deadline) throw new Error(`fixture error: the controlled service did not start: ${logs()}`);
    real.spawnSync('sleep', ['0.2']);
  }
  const ip = mustDocker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name]).trim();
  return { network, name, ip, logs };
}

// The service answers on both names and on its IP from a container on its own network; without
// this, a refused connection later would prove nothing.
function controlProbe(service) {
  const plan = { direct: [{ host: ALLOWED, servername: ALLOWED }, { host: BLOCKED, servername: BLOCKED }, { host: service.ip, servername: ALLOWED }] };
  const result = docker(['run', '--rm', '--network', service.network, STUB, ...STEP, 'control', '--net-probe', JSON.stringify(plan)]);
  const evidence = parseEvidence(result.stdout).find((entry) => entry.network);
  const failed = plan.direct.filter((entry) => evidence?.network.direct[entry.host]?.body !== PROBE_BODY).map((entry) => entry.host);
  if (result.status !== 0 || !evidence || failed.length > 0) {
    throw new Error(`fixture error: the controlled service is not reachable from the allowed side (${failed.join(', ') || String(result.stderr).trim()}); refused connections would prove nothing`);
  }
  return evidence.network;
}

/** The control probe, then the isolation checks; the checks never run against an unreachable service. */
async function withReachableService(service, checks) {
  controlProbe(service);
  return checks();
}

function startConnectedProxy(t, service, runLabel) {
  const proxy = sandbox.startProxy({ image: STUB, rootKey: ROOT_KEY, runLabel, allowedHosts: CONFIG.sandbox.allowedHosts });
  t.after(() => proxy.stop());
  mustDocker(['network', 'connect', service.network, proxy.name]);
  return proxy;
}

// Connects every proxy of `rootKey` to the service network as soon as it appears. A separate
// process: the controller blocks its own event loop while it prepares a clone.
function attachProxies(t, rootKey, network) {
  const script = `
const { spawnSync } = require('node:child_process');
const seen = new Set();
setInterval(() => {
  const out = spawnSync('docker', ['ps', '-q', '--filter', 'label=ralph.managed=${rootKey}', '--filter', 'name=ralph-proxy'], { encoding: 'utf8' }).stdout || '';
  for (const id of out.split(/\\s+/).filter(Boolean)) {
    if (seen.has(id)) continue;
    if (spawnSync('docker', ['network', 'connect', '${network}', id]).status === 0) seen.add(id);
  }
}, 100);`;
  const child = real.spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
}

// --- the controller scenario ---

const FORMS = {
  monorepo: { app: 'packages/billing', other: 'packages/storefront' },
  'single-package': { app: '.', other: null },
};

const inApp = (form, file) => (FORMS[form].app === '.' ? file : `${FORMS[form].app}/${file}`);
const manifest = (version, dependency = PACKAGE) => `${JSON.stringify({ name: 'app', version: '1.0.0', private: true, dependencies: { [dependency]: version } }, null, 2)}\n`;

const INSTALL_ENV = {
  RALPH_FIXTURE_INSTALL_ENV: 'from-profile',
  npm_config_registry: `https://${ALLOWED}/`,
  npm_config_cafile: '/opt/ralph-fixture/service/certs/ca.pem',
  npm_config_cache: '/tmp/ralph-npm-cache',
  npm_config_update_notifier: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};

const NPM_INSTALL = ['npm', 'install', '--ignore-scripts'];

/**
 * The fixture profile of `form` with the integration sandbox (stub image) and test commands, loaded
 * with the installed copy's loader. `options`: factoryArgs (extra install-factory args), appInstall
 * (argv list of the app install), sync (argv of the dependency sync).
 */
function integrationProfile(form, { factoryArgs = [], appInstall = [[...STEP, 'install-app']], sync = [...STEP, 'sync', '--lock'] } = {}) {
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'profiles', form, '.factory', 'profile.json'), 'utf8'));
  helpers.enableController(profile);
  profile.sandbox = { ...CONFIG.sandbox, image: STUB, installEnv: INSTALL_ENV };
  profile.install = [{ argv: [...STEP, 'install', '--install-factory', ...factoryArgs], cwd: '.' }];
  for (const app of profile.apps) {
    app.install = appInstall.map((argv) => ({ argv, cwd: app.path }));
    app.gate = [{ argv: [...STEP, 'gate', '--require-loopback', '--fail-if-exists', 'gate-fail.flag'], cwd: app.path }];
  }
  if (FORMS[form].app === '.') profile.dependencySync = [{ argv: sync, cwd: '.' }];
  else profile.apps[0].dependencySync = [{ argv: sync, cwd: FORMS[form].app }];
  const root = scratchDir('profile');
  helpers.writeFiles(root, { '.factory/profile.json': JSON.stringify(profile) });
  return loadProfile(root);
}

const consumerFiles = (form, profile, dependency = PACKAGE) => ({
  '.factory/profile.json': JSON.stringify(profile),
  [inApp(form, 'package.json')]: manifest('1.0.0', dependency),
  [inApp(form, 'src/a.ts')]: 'export const value = 0;\n',
  ...(FORMS[form].other ? { [`${FORMS[form].other}/package.json`]: manifest('1.0.0') } : {}),
});

const preparedImageApi = (calls) => ({
  ...sandbox,
  buildImage: (sandboxConfig) => {
    calls.push(sandboxConfig.image);
    harness.assertImage(sandboxConfig.image);
  },
});

/**
 * runIssue of the installed copy for one issue on a fresh consumer of `form`, after the real
 * startSandbox (only the image build replaced by a check of the prepared image).
 * @param {any} t
 * @param {string} form
 * @param {{ profileOptions?: any, implement?: any, dependency?: string, attach?: any }} [options]
 */
async function controllerRun(t, form, { profileOptions, implement = {}, dependency, attach = null } = {}) {
  const profile = integrationProfile(form, profileOptions);
  const { origin, consumerRoot } = makeRepository(consumerFiles(form, profile, dependency));
  const runsRoot = scratchDir('runs');
  const issueId = 46;
  const affects = [inApp(form, 'src/a.ts'), inApp(form, 'package.json'), inApp(form, 'fixture-deps.lock'), inApp(form, 'gate-fail.flag')];
  const base = helpers.issueWith(issueId, affects);
  const directive = {
    implementer: { verdict: helpers.done('feat', 'stub change', helpers.SELF_REPORT_FULL(2)), write: { [inApp(form, 'src/a.ts')]: 'export const value = 1;\n' }, ...implement },
  };
  const issue = { ...base, body: `${base.body}\n\nRALPH-STUB-DIRECTIVE: ${JSON.stringify(directive)}\n` };
  const gh = helpers.fakeGitHub({ body: issue.body });
  const sandboxConfig = sandbox.validateSandboxConfig(profile.sandbox);
  const builds = [];
  const rootKey = run.startSandbox(consumerRoot, sandboxConfig, { sandboxApi: preparedImageApi(builds) });
  consumerKeys.add(rootKey);
  if (attach) attachProxies(t, rootKey, attach.network);
  const ctx = {
    consumerRoot,
    profile: freezeSnapshot(profile),
    settings: { issues: [], maxTurns: 20, agentTimeoutMinutes: 5 },
    originUrl: origin,
    env: { ANTHROPIC_API_KEY: CANARY.apiKey, PATH: process.env.PATH },
    echo: QUIET,
    sandboxEnv: { sandboxConfig, runsRoot, rootKey, agentModel: agent.DEFAULT_AGENT_MODEL },
  };
  const callsFrom = hostCalls.length;
  ghHandler = gh.onGh;
  let result;
  try {
    result = await core.runIssue(ctx, new Map([[issueId, { ...issue, status: 'not-started' }]]), issue);
  } finally {
    ghHandler = null;
  }
  const calls = hostCalls.slice(callsFrom);
  const sessionsParent = workspace.sessionsRootFor(runsRoot, issueId);
  // A fresh runs root: at most the one sessions dir of this run.
  const runSessions = fs.existsSync(sessionsParent) ? fs.readdirSync(sessionsParent) : [];
  assert.ok(runSessions.length <= 1, `one sessions dir per run, got ${runSessions.join(', ')}`);
  const sessionsRoot = runSessions.length === 1 ? path.join(sessionsParent, runSessions[0]) : null;
  const sessionEntries = sessionsRoot ? fs.readdirSync(sessionsRoot) : [];
  const logs = sessionEntries.filter((name) => name.endsWith('.log')).map((name) => ({ name, text: fs.readFileSync(path.join(sessionsRoot, name), 'utf8') }));
  const agentCalls = sessionEntries.filter((name) => /^\d+-/.test(name) && fs.statSync(path.join(sessionsRoot, name)).isDirectory()).sort();
  const gateRuns = calls.filter((call) => call.file === 'docker' && call.args[0] === 'run' && call.args[call.args.indexOf('--network') + 1] === 'none');
  return {
    result,
    profile,
    origin,
    consumerRoot,
    rootKey,
    builds,
    runDir: workspace.runDirFor(runsRoot, issueId),
    runsRoot,
    sessionsRoot,
    logs,
    agentCalls,
    reports: Object.fromEntries(agentCalls.map((name) => [name, readReport(path.join(sessionsRoot, name))])),
    gateRuns,
    calls,
    mutations: gh.mutations,
    branches: helpers.originBranches(origin),
  };
}

const evidenceOf = (logs, prefix) => logs.filter((log) => log.name.startsWith(prefix)).flatMap((log) => parseEvidence(log.text));
const hostPrograms = (calls) => [...new Set(calls.map((call) => call.file))].sort();
const dockerSubcommands = () => hostCalls.filter((call) => call.file === 'docker').map((call) => call.args[0]);

// The successful controller run of each form, shared by the tests that inspect it.
const mainRuns = new Map();
const mainRun = (t, form) => {
  if (!mainRuns.has(form)) {
    mainRuns.set(form, controllerRun(t, form, { implement: { write: { [inApp(form, 'src/a.ts')]: 'export const value = 1;\n', [inApp(form, 'package.json')]: manifest('2.0.0') } } }));
  }
  return mainRuns.get(form);
};

// --- harness of this file ---

const completed = new Set();
const consumerKeys = new Set();
const TEST_TIMEOUT_MS = 15 * 60 * 1000;

/** A test that records its name once every assertion of it passed. */
const scenario = (name, fn) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    await fn(t);
    completed.add(name);
  });

let prerequisites = null;

test.before(() => {
  assert.equal(sandbox.isInsideHome(SCRATCH), false, `scratch ${SCRATCH} must be outside the operator home`);
  prerequisites = harness.checkPrerequisites({ config: CONFIG });
});

test.after(() => {
  for (const key of [ROOT_KEY, `${ROOT_KEY}a`, `${ROOT_KEY}b`, ...consumerKeys]) sandbox.removeLeftovers(key);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// --- prepared images and the harness ---

scenario('uses prepared images and verifies pinned cli', () => {
  assert.ok(prerequisites.sourceId && prerequisites.stubId, 'both prepared images exist');
  assert.equal(prerequisites.cliVersion, CONFIG.sandbox.claudeCodeVersion);
  assert.equal(harness.verifyPinnedCli(SOURCE, CONFIG.sandbox.claudeCodeVersion), CONFIG.sandbox.claudeCodeVersion);
  // The stub image is derived from the source image and keeps its real CLI behind the stub.
  const layers = (image) => JSON.parse(mustDocker(['image', 'inspect', '--format', '{{json .RootFS.Layers}}', image]));
  const sourceLayers = layers(SOURCE);
  assert.deepEqual(layers(STUB).slice(0, sourceLayers.length), sourceLayers);
  const stubPath = mustDocker(['run', '--rm', '--network', 'none', STUB, 'sh', '-c', 'command -v claude; /usr/local/bin/claude --version']).trim().split('\n');
  assert.equal(stubPath[0], '/opt/ralph-stub/bin/claude');
  assert.match(stubPath[1], new RegExp(`^${CONFIG.sandbox.claudeCodeVersion.replace(/\./g, '\\.')}\\b`));
  assert.deepEqual(dockerSubcommands().filter((name) => name === 'build' || name === 'pull'), []);
});

scenario('rejects missing or mismatched pinned cli', () => {
  assert.throws(() => harness.verifyPinnedCli(SOURCE, '9.9.9'), new RegExp(`${SOURCE}: expected the pinned 9\\.9\\.9, got ${CONFIG.sandbox.claudeCodeVersion.replace(/\./g, '\\.')}`));
  assert.throws(() => harness.verifyPinnedCli(SOURCE, CONFIG.sandbox.claudeCodeVersion, { env: { PATH: '/nonexistent' } }), /claude --version in .* failed .*expected the pinned/);
  const config = path.join(scratchDir('config'), 'integration.json');
  fs.writeFileSync(config, JSON.stringify({ ...CONFIG, sandbox: { ...CONFIG.sandbox, claudeCodeVersion: '9.9.9' } }));
  const child = real.spawnSync(process.execPath, [path.join(__dirname, 'run-ralph-sandbox.js')], { encoding: 'utf8', env: { ...process.env, [harness.CONFIG_ENV]: config } });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /expected the pinned 9\.9\.9, got/);
  assert.doesNotMatch(child.stdout, /passed/);
});

// A docker that logs its subcommands and then runs the real one (or answers `version` itself).
function dockerWrapper({ engineOs = null } = {}) {
  const dir = scratchDir('docker-wrapper');
  const realDocker = String(real.spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout).trim();
  const log = path.join(dir, 'calls.log');
  const fake = engineOs ? `if [ "$1" = version ]; then echo ${engineOs}; exit 0; fi\n` : '';
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "$*" >> '${log}'\n${fake}exec '${realDocker}' "$@"\n`, { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

const runHarness = (env) =>
  real.spawnSync(process.execPath, [path.join(__dirname, 'run-ralph-sandbox.js')], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });

scenario('fails explicitly when integration prerequisites are missing', () => {
  const emptyBin = scratchDir('empty-bin');
  const noCli = runHarness({ PATH: emptyBin });
  assert.equal(noCli.status, 1);
  assert.match(noCli.stderr, /cannot run: the Docker CLI is not available/);

  const noEngine = runHarness({ DOCKER_HOST: `unix://${path.join(SCRATCH, 'no-engine.sock')}` });
  assert.equal(noEngine.status, 1);
  assert.match(noEngine.stderr, /cannot run: the Docker engine is not reachable/);

  for (const field of ['source', 'stub']) {
    const missing = `ralph-sandbox-it:missing-${field}-${RUN_ID}`;
    const config = path.join(scratchDir('config'), 'integration.json');
    const changed = field === 'source' ? { ...CONFIG, sandbox: { ...CONFIG.sandbox, image: missing } } : { ...CONFIG, stubImage: missing };
    fs.writeFileSync(config, JSON.stringify(changed));
    const wrapper = dockerWrapper();
    const result = runHarness({ [harness.CONFIG_ENV]: config, PATH: `${wrapper.dir}:${process.env.PATH}` });
    assert.equal(result.status, 1, field);
    assert.match(result.stderr, new RegExp(`the prepared image ${missing} is missing`));
    assert.doesNotMatch(result.stdout, /passed/);
    const subcommands = wrapper.calls().split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
    assert.ok(subcommands.length > 0, 'the docker wrapper was used');
    assert.deepEqual(subcommands.filter((name) => ['build', 'pull', 'run', 'buildx'].includes(name)), [], field);
    assert.notEqual(docker(['image', 'inspect', missing]).status, 0, `${missing} was not built or pulled`);
  }
  // The file itself has no skip or todo marker and fails in before() without a runtime.
  const source = fs.readFileSync(__filename, 'utf8');
  for (const marker of ['.' + 'skip(', 'skip' + ': true', 't.' + 'skip', '.' + 'todo(', 'todo' + ': true', '.' + 'only(']) assert.ok(!source.includes(marker), marker);
  assert.ok(source.includes('prerequisites = harness.checkPrerequisites('), 'before() fails without a runtime instead of skipping');
});

scenario('rejects unsupported integration platform', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.match(harness.platformProblems({ platform }).join(), /Linux host/);
    // The host check comes first: a docker binary that does not exist is never reached.
    assert.throws(() => harness.checkPrerequisites({ platform, docker: path.join(SCRATCH, 'no-docker') }), /runs on a Linux host .* this host is/);
  }
  assert.match(harness.platformProblems({ platform: 'linux', engineOs: 'windows' }).join(), /Linux Docker engine, this engine is windows/);
  assert.deepEqual(harness.platformProblems({ platform: 'linux', engineOs: 'linux' }), []);
  const wrapper = dockerWrapper({ engineOs: 'windows' });
  const result = runHarness({ PATH: `${wrapper.dir}:${process.env.PATH}` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot run: the integration needs a Linux Docker engine, this engine is windows/);
  assert.doesNotMatch(result.stdout, /passed/);
  assert.deepEqual(wrapper.calls().split('\n').filter(Boolean).map((line) => line.split(' ')[0]), ['version']);
});

scenario('rejects failed empty or skipped integration results', () => {
  const dir = scratchDir('probe-suites');
  const head = "const test = require('node:test');\n";
  const suites = {
    passing: `${head}test('ok', () => {});\n`,
    failing: `${head}test('ok', () => {});\ntest('broken', () => { throw new Error('probe failure'); });\n`,
    empty: '// no tests\n',
    skipped: `${head}test('ok', () => {});\ntest('later', { ${'skip'}: true }, () => {});\n`,
    todo: `${head}test('ok', () => {});\ntest('later', { ${'todo'}: true }, () => {});\n`,
    cancelled: `${head}test('ok', () => {});\ntest('slow', { timeout: 50 }, () => new Promise((resolve) => setTimeout(resolve, 2000)));\n`,
  };
  const outcomes = {};
  for (const [name, text] of Object.entries(suites)) {
    const file = path.join(dir, `${name}.probe.js`);
    fs.writeFileSync(file, text);
    outcomes[name] = harness.runTestFiles([file], { stdio: 'pipe' });
  }
  assert.equal(outcomes.passing.code, 0, outcomes.passing.problems.join('; '));
  assert.deepEqual(outcomes.passing.counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  for (const name of ['failing', 'empty', 'skipped', 'todo', 'cancelled']) assert.equal(outcomes[name].code, 1, name);
  assert.match(outcomes.failing.problems.join(), /1 test\(s\) fail/);
  assert.match(outcomes.empty.problems.join(), /empty\.probe\.js defined no test/);
  const zero = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((name) => `# ${name} 0`).join('\n');
  assert.match(harness.evaluateTap(zero).problems.join(), /no test ran/);
  assert.match(outcomes.skipped.problems.join(), /1 test\(s\) skipped/);
  assert.match(outcomes.todo.problems.join(), /1 test\(s\) todo/);
  assert.notEqual(outcomes.cancelled.code, 0);
  assert.match(harness.evaluateTap('TAP version 13\n').problems.join(), /no "tests" counter/);
});

// --- the maps of preserved reference scenarios ---

const SANDBOX_FIXTURES = path.join(__dirname, '..', 'fixtures', 'ralph-sandbox');
const CONTROLLER_FIXTURES = path.join(__dirname, '..', 'fixtures', 'ralph-controller');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sandboxMap = () => readJson(path.join(SANDBOX_FIXTURES, 'cases.json'));
const controllerMap = () => readJson(path.join(CONTROLLER_FIXTURES, 'integration-cases.json'));
const sandboxSourceNames = () => coverage.sourceTestNames(fs.readFileSync(path.join(SANDBOX_FIXTURES, 'source', 'sandbox.test.js.txt'), 'utf8'));
const controllerSources = () => Object.fromEntries(['agent', 'workspace', 'run'].map((name) => [`${name}.test.js.txt`, fs.readFileSync(path.join(CONTROLLER_FIXTURES, 'source', `${name}.test.js.txt`), 'utf8')]));
const ownTestNames = () => coverage.integrationTestNames(fs.readFileSync(__filename, 'utf8'));

scenario('rejects missing mapped scenario coverage', () => {
  const testNames = ownTestNames();
  const sandboxInput = { sourceNames: sandboxSourceNames(), testNames };
  const controllerInput = { sources: controllerSources(), testNames };
  assert.deepEqual(coverage.checkSandboxMap(sandboxMap(), sandboxInput), []);
  assert.deepEqual(coverage.checkControllerMap(controllerMap(), controllerInput), []);

  const rowOf = (map, predicate) => map.cases.find(predicate);
  const reasons = (problems) => problems.map((problem) => `${problem.scenario}: ${problem.reason}`).join('\n');

  const removedSandbox = sandboxMap();
  const removedName = 'gate sandbox has no network';
  removedSandbox.cases = removedSandbox.cases.filter((entry) => entry.source !== removedName);
  assert.match(reasons(coverage.checkSandboxMap(removedSandbox, sandboxInput)), new RegExp(`${removedName}: row missing from the map`));

  const unknownSandbox = sandboxMap();
  rowOf(unknownSandbox, (entry) => entry.source === 'sandbox has no operator gh config').integration = `${coverage.INTEGRATION_FILE} "no such integration test"`;
  assert.match(reasons(coverage.checkSandboxMap(unknownSandbox, sandboxInput)), /sandbox has no operator gh config: integration test "no such integration test" does not exist/);

  const emptySandbox = sandboxMap();
  rowOf(emptySandbox, (entry) => entry.source === 'files written in sandbox are owned by controller user').assertions = [];
  assert.match(reasons(coverage.checkSandboxMap(emptySandbox, sandboxInput)), /files written in sandbox are owned by controller user: empty list of assertions/);

  const claimedSandbox = sandboxMap();
  rowOf(claimedSandbox, (entry) => entry.source === 'git works inside sandbox on run dir').status = 'passed';
  assert.match(reasons(coverage.checkSandboxMap(claimedSandbox, sandboxInput)), /git works inside sandbox on run dir: status claims a run result/);

  const removedController = controllerMap();
  removedController.cases = removedController.cases.filter((entry) => entry.test !== 'startup leaves unlabelled containers running');
  assert.match(reasons(coverage.checkControllerMap(removedController, controllerInput)), /startup leaves unlabelled containers running: row missing from the map/);

  const unknownController = controllerMap();
  rowOf(unknownController, (entry) => entry.test === 'dependency install runs inside sandbox').integration = `${coverage.INTEGRATION_FILE} "renamed away"`;
  assert.match(reasons(coverage.checkControllerMap(unknownController, controllerInput)), /dependency install runs inside sandbox: integration test "renamed away" does not exist/);

  const emptyController = controllerMap();
  rowOf(emptyController, (entry) => entry.test === 'a gate check cannot plant anything in .git').assertions = [];
  assert.match(reasons(coverage.checkControllerMap(emptyController, controllerInput)), /a gate check cannot plant anything in \.git: empty list of assertions/);
});

// --- agent: permissions, .git, credentials ---

scenario('enforces agent and git filesystem boundaries', async () => {
  for (const form of Object.keys(FORMS)) {
    const profile = integrationProfile(form);
    const { runDir, sessionsRoot } = cloneFor();
    const configBefore = fs.readFileSync(path.join(runDir, '.git', 'config'), 'utf8');
    const gateRules = workspace.gateCommandRules(profile);
    for (const name of ['implementer', 'reviewer', 'code-reviewer']) {
      workspace.writePermissionProfile(name, runDir, profile, ['issues', 'plan']);
      const { result, sessionsDir } = await stubCall(runDir, sessionsRoot, `${form}-${name}`, {});
      assert.equal(result.ok, true, result.error);
      const report = readReport(sessionsDir);
      const { allow, deny } = report.permissions;
      assert.equal(report.role, name);
      for (const rule of workspace.READ_ONLY_GIT) assert.ok(allow.includes(rule), `${name} ${rule}`);
      assert.equal(allow.includes('Bash(git show:*)'), name !== 'implementer', `${name} git show`);
      for (const rule of workspace.COMMON_DENY) assert.ok(deny.includes(rule), `${name} denies ${rule}`);
      assert.deepEqual(allow.filter((rule) => /git (commit|push)|\bgh\b|^Bash$|Bash\(\*\)/.test(rule)), [], name);
      assert.deepEqual(allow.filter((rule) => rule.startsWith('Bash(') && !rule.startsWith('Bash(git ')).sort(), [...gateRules].sort(), name);
      if (name === 'implementer') assert.ok(allow.includes('Edit') && allow.includes('Write'));
      else assert.ok(deny.includes('Edit(**)') && deny.includes('Write(**)') && !allow.includes('Edit'), name);
      // Inside the real container: git can be read, .git cannot be written, the working tree can.
      assert.equal(report.git.status.code, 0, report.git.status.stderr);
      assert.equal(report.git.diff.code, 0);
      assert.equal(report.git.log.code, 0);
      if (name !== 'implementer') assert.equal(report.git.show.code, 0);
      assert.equal(report.git.dubious, false);
      assert.notEqual(report.git.configWrite, 0, `${name}: git config wrote .git/config`);
      assert.notEqual(report.git.hookWrite, 'written', `${name}: a hook was written`);
      assert.equal(report.git.tree, 'written', `${name}: the working tree is writable`);
      assert.equal(report.operator.ghBinary, false, 'the image has no gh');
    }
    assert.equal(fs.readFileSync(path.join(runDir, '.git', 'config'), 'utf8'), configBefore);
    assert.equal(fs.existsSync(path.join(runDir, '.git', 'hooks', 'post-checkout')), false);
  }
});

scenario('does not expose operator credentials', async () => {
  await withOperatorHome(async ({ home, marker }) => {
    const { runDir, sessionsRoot } = cloneFor();
    // A credential helper that works on the controller side, in the clone's own config.
    gitIn(runDir, 'config', '--add', 'credential.helper', '');
    gitIn(runDir, 'config', '--add', 'credential.helper', `!f() { echo username=u; echo password=${CANARY.password}; }; f`);
    const hostFill = real.spawnSync('git', ['credential', 'fill'], { cwd: runDir, encoding: 'utf8', input: 'protocol=https\nhost=example.invalid\n\n' });
    assert.ok(hostFill.stdout.includes(`password=${CANARY.password}`), 'the controller side has a working helper');
    const operatorEnv = { ...process.env, GH_TOKEN: CANARY.ghToken, GITHUB_TOKEN: CANARY.githubToken, HOME: home, USERPROFILE: home };
    const cases = [
      { name: 'ANTHROPIC_API_KEY', value: CANARY.apiKey, env: boundary.buildAgentEnv({ ...operatorEnv, ANTHROPIC_API_KEY: CANARY.apiKey }) },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: CANARY.oauth, env: { ...operatorEnv, CLAUDE_CODE_OAUTH_TOKEN: CANARY.oauth } },
    ];
    for (const { name, value, env } of cases) {
      const callsFrom = hostCalls.length;
      const { result, sessionsDir } = await stubCall(runDir, sessionsRoot, `credentials-${name}`, { all: { findMarker: marker } }, { env });
      assert.equal(result.ok, true, result.error);
      const report = readReport(sessionsDir);
      const other = name === 'ANTHROPIC_API_KEY' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
      assert.equal(report.env.credentials[name], sha256(value), `${name} reached the container`);
      assert.equal(report.env.credentials[other], null, `${other} did not`);
      assert.equal(report.env.ghToken, false);
      assert.equal(report.env.githubToken, false);
      assert.equal(report.env.home, sandbox.CONTAINER_HOME);
      assert.equal(report.env.userProfile, null);
      assert.deepEqual(report.operator.marker, { inHome: false, found: '' });
      assert.equal(report.operator.sshEntries, 0);
      assert.equal(report.operator.ghConfig, false);
      assert.equal(report.operator.ghHosts, false);
      assert.equal(report.operator.credentialFill.hasPassword, false);
      assert.notEqual(report.operator.credentialFill.code, 0);
      assert.ok(report.mounts.includes(sandbox.CONTAINER_WORKDIR));
      assert.ok(!report.mounts.some((mount) => mount === sandbox.CONTAINER_HOME || mount.startsWith('/root') || mount.startsWith(home)), report.mounts.join(' '));
      const reportText = fs.readFileSync(path.join(sessionsDir, 'ralph-stub-report.json'), 'utf8');
      const argvText = hostCalls.slice(callsFrom).map((call) => call.args.join(' ')).join('\n');
      for (const canary of Object.values(CANARY)) {
        assert.ok(!reportText.includes(canary), 'no credential value in the report');
        assert.ok(!argvText.includes(canary), 'no credential value in argv');
      }
    }
  });
});

scenario('refuses ambient operator credentials', async () => {
  await withOperatorHome(async ({ home }) => {
    const { runDir, sessionsRoot } = cloneFor();
    const before = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8');
    const env = boundary.buildAgentEnv({ ...process.env, HOME: home, USERPROFILE: home, GH_TOKEN: CANARY.ghToken });
    const runLabel = `issue-ambient-${RUN_ID}`;
    const callsFrom = hostCalls.length;
    const { result, sessionsDir } = await stubCall(runDir, sessionsRoot, 'ambient', {}, { env, runLabel });
    assert.equal(result.ok, false);
    assert.match(result.error, /ANTHROPIC_API_KEY/);
    assert.match(result.error, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.equal(result.container, null);
    assert.deepEqual(hostCalls.slice(callsFrom).filter((call) => call.file === 'docker'), [], 'no Docker call');
    assert.deepEqual(dockerIds(['ps', '-aq', '--filter', `label=${sandbox.LABEL_RUN}=${runLabel}`]), []);
    assert.equal(fs.existsSync(path.join(sessionsDir, 'ralph-stub-report.json')), false);
    assert.equal(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'), before);
  });
});

// --- network ---

scenario('enforces proxy allowlist without direct egress', async (t) => {
  const service = startService(t);
  const runLabel = `issue-proxy-${RUN_ID}`;
  const proxy = startConnectedProxy(t, service, runLabel);
  await withReachableService(service, async () => {
    const plan = {
      viaProxy: [{ host: ALLOWED }, { host: BLOCKED }, { host: service.ip }],
      direct: [{ host: ALLOWED, servername: ALLOWED }, { host: service.ip, servername: ALLOWED }],
    };
    const { runDir, sessionsRoot } = cloneFor();
    const agentCall = await stubCall(runDir, sessionsRoot, 'network', { all: { network: plan } }, { runLabel, network: proxy.network, proxyUrl: proxy.proxyUrl });
    assert.equal(agentCall.result.ok, true, agentCall.result.error);
    const install = workspace.runInstallStep(
      runDir,
      box(runLabel, { network: proxy.network, proxyUrl: proxy.proxyUrl, installEnv: {}, logsDir: sessionsRoot, timeoutMs: 120000 }),
      { label: 'network-probe', command: { argv: [...STEP, 'install', '--net-probe', JSON.stringify(plan)], cwd: '.' } },
    );
    assert.equal(install.ok, true, install.error);
    const installNetwork = parseEvidence(fs.readFileSync(install.logPath, 'utf8')).find((entry) => entry.network).network;
    for (const [who, network] of [['agent', readReport(agentCall.sessionsDir).network], ['install', installNetwork]]) {
      assert.deepEqual(network.viaProxy[ALLOWED], { status: 200, body: PROBE_BODY }, `${who}: data through the allowed CONNECT:443`);
      assert.equal(network.viaProxy[BLOCKED].status, 403, `${who}: reachable but not allowlisted name`);
      assert.equal(network.viaProxy[service.ip].status, 403, `${who}: IP address`);
      assert.equal(network.direct[ALLOWED].connected, false, `${who}: direct by name`);
      assert.equal(network.direct[service.ip].connected, false, `${who}: direct by IP`);
    }
  });
  const proxyLog = String(docker(['logs', proxy.name]).stdout);
  assert.match(proxyLog, new RegExp(`allow ${ALLOWED.replace(/\./g, '\\.')}:443`));
  assert.match(proxyLog, new RegExp(`deny ${BLOCKED.replace(/\./g, '\\.')}:443`));
  assert.ok(service.logs().split('\n').filter((line) => line.includes('/ralph-fixture-probe')).length >= 3, 'the tunnelled requests reached the service');
});

scenario('fails when controlled service is not reachable', async (t) => {
  const service = startService(t);
  mustDocker(['stop', '-t', '0', service.name]);
  let checksRan = false;
  await assert.rejects(
    withReachableService(service, async () => {
      checksRan = true;
    }),
    /fixture error: the controlled service is not reachable from the allowed side/,
  );
  assert.equal(checksRan, false, 'no isolation check ran against an unreachable service');
});

scenario('isolates real gate network and git directory', async (t) => {
  const service = startService(t);
  await withReachableService(service, async () => {
    const { runDir } = cloneFor();
    const runLabel = `issue-gate-${RUN_ID}`;
    const runner = workspace.createSandboxGateRunner(runDir, box(runLabel, { timeoutMs: 120000 }));
    const plan = { direct: [{ host: ALLOWED, servername: ALLOWED }, { host: service.ip, servername: ALLOWED }] };
    const out = runner({ argv: [...STEP, 'gate', '--net-probe', JSON.stringify(plan), '--git-probe'], cwd: '.' });
    const evidence = parseEvidence(out);
    const where = evidence.find((entry) => entry.interfaces && entry.step === 'gate' && entry.cwd);
    assert.deepEqual(where.interfaces, ['lo']);
    assert.equal(where.container, true);
    assert.equal(where.installEnv, null);
    const network = evidence.find((entry) => entry.network).network;
    assert.deepEqual(network.interfaces, ['lo']);
    assert.equal(network.direct[ALLOWED].connected, false);
    assert.equal(network.direct[service.ip].connected, false);
    const git = evidence.find((entry) => entry.git).git;
    assert.notEqual(git.hook, 'written');
    assert.equal(git.tree, 'written');
    assert.equal(fs.readFileSync(path.join(runDir, 'gate-tree-probe.txt'), 'utf8'), 'written by the gate\n');
    assert.equal(fs.existsSync(path.join(runDir, '.git', 'hooks', 'pre-commit')), false);
    // Through the project gate: a check that plants a hook fails and leaves .git untouched.
    fs.rmSync(path.join(runDir, 'gate-tree-probe.txt'));
    const app = { name: 'app', path: '.', gate: [{ argv: [...STEP, 'gate', '--plant-hook'], cwd: '.' }] };
    const gate = workspace.runProjectGate(runDir, [app], runner, () => {});
    assert.equal(gate.ok, false, gate.output);
    assert.equal(fs.existsSync(path.join(runDir, '.git', 'hooks', 'pre-commit')), false);
    assertNoResources(`${sandbox.LABEL_RUN}=${runLabel}`);
  });
});

// --- real npm through the proxy ---

function npmFixture(t, form) {
  const service = startService(t);
  const runLabel = `issue-npm-${form}-${RUN_ID}`;
  const proxy = startConnectedProxy(t, service, runLabel);
  const profile = integrationProfile(form, { appInstall: [[...STEP, 'install-app'], NPM_INSTALL], sync: NPM_INSTALL });
  return { service, runLabel, proxy, profile };
}

const installBox = (fixture, logsDir) =>
  box(fixture.runLabel, { network: fixture.proxy.network, proxyUrl: fixture.proxy.proxyUrl, installEnv: fixture.profile.sandbox.installEnv, logsDir, timeoutMs: 180000 });

const npmProfile = (profile) => ({ ...profile, install: [], apps: [profile.apps[0]] });

scenario('installs and syncs real npm through fixture registry', async (t) => {
  for (const form of Object.keys(FORMS)) {
    const fixture = npmFixture(t, form);
    await withReachableService(fixture.service, async () => {
      const { runDir, sessionsRoot } = cloneFor({ [inApp(form, 'package.json')]: manifest('1.0.0') });
      const profile = npmProfile(fixture.profile);
      const boxOfInstall = installBox(fixture, sessionsRoot);
      workspace.installDependencies(runDir, profile, boxOfInstall);
      const installed = (file) => JSON.parse(fs.readFileSync(path.join(runDir, inApp(form, file)), 'utf8'));
      assert.equal(installed(`node_modules/${PACKAGE}/package.json`).version, '1.0.0');
      const lockEntry = () => installed('package-lock.json').packages[`node_modules/${PACKAGE}`];
      assert.equal(lockEntry().version, '1.0.0');
      assert.equal(lockEntry().resolved, `https://${ALLOWED}/${PACKAGE}/-/${PACKAGE}-1.0.0.tgz`);
      const logs = fs.readdirSync(sessionsRoot).filter((name) => name.startsWith('install-')).map((name) => fs.readFileSync(path.join(sessionsRoot, name), 'utf8'));
      const installWhere = logs.flatMap(parseEvidence).find((entry) => entry.step === 'install-app');
      assert.equal(installWhere.installEnv, 'from-profile', 'installEnv reaches the install');
      assert.equal(installWhere.container, true);
      assert.equal(installWhere.proxy, fixture.proxy.proxyUrl);
      assert.equal(installWhere.cwd, path.posix.join(sandbox.CONTAINER_WORKDIR, FORMS[form].app === '.' ? '' : FORMS[form].app));

      // The agent and the gate never see installEnv.
      const agentCall = await stubCall(runDir, sessionsRoot, 'npm-agent', {}, { runLabel: fixture.runLabel, network: fixture.proxy.network, proxyUrl: fixture.proxy.proxyUrl });
      assert.equal(agentCall.result.ok, true, agentCall.result.error);
      assert.equal(readReport(agentCall.sessionsDir).env.installEnv, null);
      const gateOut = workspace.createSandboxGateRunner(runDir, box(fixture.runLabel, { timeoutMs: 60000 }))({ argv: [...STEP, 'gate'], cwd: '.' });
      assert.equal(parseEvidence(gateOut)[0].installEnv, null);

      gitIn(runDir, 'add', '-A');
      gitIn(runDir, 'commit', '-qm', 'installed');
      fs.writeFileSync(path.join(runDir, inApp(form, 'package.json')), manifest('2.0.0'));
      const sync = workspace.syncDependencies(runDir, profile, workspace.gitStatusZ(runDir), boxOfInstall);
      assert.deepEqual(sync, { ok: true, ran: true, blockedReason: null });
      assert.equal(lockEntry().version, '2.0.0');
      assert.equal(installed(`node_modules/${PACKAGE}/package.json`).version, '2.0.0');
      assert.match(gitIn(runDir, 'status', '--porcelain'), new RegExp(`package-lock\\.json`));
      const requests = fixture.service.logs();
      for (const version of CONFIG.service.versions) assert.match(requests, new RegExp(`GET /${PACKAGE}/-/${PACKAGE}-${version.replace(/\./g, '\\.')}\\.tgz`), `${version} downloaded`);
    });
    const proxyLog = String(docker(['logs', fixture.proxy.name]).stdout);
    assert.match(proxyLog, /allow registry\.ralph-fixture\.test:443/);
    assert.doesNotMatch(proxyLog, /registry\.npmjs\.org/);
  }
});

scenario('keeps real registry failure output in named install log', async (t) => {
  for (const form of Object.keys(FORMS)) {
    const fixture = npmFixture(t, form);
    await withReachableService(fixture.service, async () => {
      const { runDir, sessionsRoot } = cloneFor({ [inApp(form, 'package.json')]: manifest('1.0.0', MISSING_PACKAGE) });
      const profile = npmProfile(fixture.profile);
      const boxOfInstall = installBox(fixture, sessionsRoot);
      let failure = null;
      try {
        workspace.installDependencies(runDir, profile, boxOfInstall);
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof workspace.InstallError, String(failure));
      assert.ok(failure.logPath.startsWith(sessionsRoot));
      assert.ok(failure.message.includes(failure.logPath));
      const installLog = fs.readFileSync(failure.logPath, 'utf8');
      assert.match(installLog, /E404/);
      assert.ok(installLog.includes(MISSING_PACKAGE), 'the package is named in the log');

      fs.writeFileSync(path.join(runDir, inApp(form, 'package.json')), manifest('2.0.0', MISSING_PACKAGE));
      const sync = workspace.syncDependencies(runDir, profile, workspace.gitStatusZ(runDir), boxOfInstall);
      assert.equal(sync.ok, false);
      const logPath = namedLog(sync.blockedReason);
      assert.ok(logPath.startsWith(sessionsRoot));
      assert.match(fs.readFileSync(logPath, 'utf8'), new RegExp(`E404[\\s\\S]*${MISSING_PACKAGE}|${MISSING_PACKAGE}[\\s\\S]*E404`));
    });
  }
  // In the controller: the install fails before the agent; no agent, gate or publication.
  const service = startService(t);
  controlProbe(service);
  const outcome = await controllerRun(t, 'monorepo', {
    dependency: MISSING_PACKAGE,
    profileOptions: { appInstall: [[...STEP, 'install-app', '--wait-registry', ALLOWED], NPM_INSTALL] },
    attach: service,
  });
  assert.equal(outcome.result.status, 'blocked', JSON.stringify(outcome.result));
  const logPath = namedLog(outcome.result.reason);
  assert.match(fs.readFileSync(logPath, 'utf8'), /E404/);
  assert.ok(fs.readFileSync(logPath, 'utf8').includes(MISSING_PACKAGE));
  assert.deepEqual(outcome.agentCalls, []);
  assert.deepEqual(outcome.gateRuns, []);
  assert.deepEqual(outcome.mutations.filter((m) => m.kind === 'pr'), []);
  assert.deepEqual(outcome.branches, ['trunk']);
  assertNoResources(`${sandbox.LABEL_MANAGED}=${outcome.rootKey}`);
});

// --- ownership, journals, time limits, process exit ---

scenario('preserves ownership and external session journals', async () => {
  const { runDir, sessionsRoot } = cloneFor({ 'a.txt': 'one\n' });
  const profile = integrationProfile('single-package');
  workspace.writePermissionProfile('implementer', runDir, profile, []);
  const { result, sessionsDir } = await stubCall(runDir, sessionsRoot, '01-implement', { implementer: { write: { 'sub/out.txt': 'x', 'a.txt': 'two\n' } } });
  assert.equal(result.ok, true, result.error);
  for (const file of ['sub/out.txt', 'a.txt', 'sub']) {
    const stat = fs.statSync(path.join(runDir, file));
    assert.equal(stat.uid, process.getuid(), file);
    assert.equal(stat.gid, process.getgid(), file);
  }
  const report = readReport(sessionsDir);
  assert.equal(report.uid, process.getuid());
  assert.equal(report.git.status.code, 0, report.git.status.stderr);
  assert.equal(report.git.dubious, false);
  assert.match(report.git.status.stdout, /^ M a\.txt$/m);
  assert.match(report.git.diff.stdout, /a\.txt \| 2/);
  assert.equal(journalsIn(sessionsDir).length, 1);
  assert.ok(path.relative(runDir, sessionsDir).startsWith('..'), 'the journal is outside the clone');
  const status = String(real.execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: runDir, encoding: 'utf8' }));
  assert.match(status, /a\.txt/);
  assert.doesNotMatch(status, /jsonl|ralph-stub-report|ralph-claude/);
  assert.deepEqual(status.split('\n').filter(Boolean).map((line) => line.slice(3)).sort(), ['a.txt', 'sub/out.txt']);
});

scenario('stops timed out steps and preserves journals', async () => {
  const runLabel = `issue-timeout-${RUN_ID}`;
  const { runDir, sessionsRoot } = cloneFor();
  const limitMs = 5000;
  const runner = workspace.createSandboxGateRunner(runDir, box(runLabel, { timeoutMs: limitMs }));
  const stepStarted = Date.now();
  assert.throws(() => runner({ argv: ['sleep', '300'], cwd: '.' }), /failed in the sandbox \(.*ETIMEDOUT/);
  assert.ok(Date.now() - stepStarted <= limitMs + 30000, `the step stopped in ${Date.now() - stepStarted} ms`);
  assertNoResources(`${sandbox.LABEL_RUN}=${runLabel}`);

  const agentStarted = Date.now();
  const { result, sessionsDir } = await stubCall(runDir, sessionsRoot, '01-implement', { all: { sleepSeconds: 300 } }, { runLabel, timeoutMs: limitMs });
  assert.ok(Date.now() - agentStarted <= limitMs + 30000, `the agent stopped in ${Date.now() - agentStarted} ms`);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(containerExists(result.container), false);
  assert.equal(journalsIn(sessionsDir).length, 1, 'the journal written before the timeout is kept');
  assertNoResources(`${sandbox.LABEL_RUN}=${runLabel}`);
  assert.equal(gitIn(runDir, 'status', '--porcelain', '-uall'), '', 'the clone is not polluted');

  const { result: finished, sessionsDir: finishedDir } = await stubCall(runDir, sessionsRoot, '02-implement', {}, { runLabel });
  assert.equal(finished.ok, true, finished.error);
  assert.equal(journalsIn(finishedDir).length, 1, 'the journal of a normal run is kept');
});

const CHILD_CONTROLLER = (mode) => `
const sandbox = require(${JSON.stringify(path.join(PACKAGE_ROOT, 'ralph', 'sandbox.js'))});
const { runAgent } = require(${JSON.stringify(path.join(PACKAGE_ROOT, 'ralph', 'agent.js'))});
const { spawnSync } = require('node:child_process');
sandbox.installExitHandlers();
const input = JSON.parse(process.env.RALPH_IT_CHILD);
const quiet = { out: () => {}, err: () => {} };
for (const sessionsDir of input.sessionsDirs) {
  runAgent(input.prompt, input.runDir, null, { env: { ANTHROPIC_API_KEY: 'sk-test-placeholder' }, echo: quiet, sandbox: { ...input.box, sessionsDir } });
}
const timer = setInterval(() => {
  const ids = String(spawnSync('docker', ['ps', '-q', '--filter', 'label=ralph.run=' + input.box.runLabel], { encoding: 'utf8' }).stdout).trim().split(/\\s+/).filter(Boolean);
  if (ids.length < 2) return;
  clearInterval(timer);
  console.log('both-running');
  ${mode === 'exit' ? 'const leave = process.exit.bind(process); leave(0);' : ''}
}, 200);
`;

const runChildController = (mode, input) =>
  new Promise((resolve, reject) => {
    const child = real.spawn(process.execPath, ['-e', CHILD_CONTROLLER(mode)], { env: { ...process.env, RALPH_IT_CHILD: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'inherit'] });
    let sawBoth = false;
    child.stdout.on('data', (chunk) => {
      if (!sawBoth && String(chunk).includes('both-running')) {
        sawBoth = true;
        if (mode === 'sigint') child.kill('SIGINT');
      }
    });
    const guard = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, sawBoth });
    });
  });

scenario('removes background and active containers on controller exit', async () => {
  const { runDir, sessionsRoot } = cloneFor();
  const background = await stubCall(runDir, sessionsRoot, 'background', { all: { background: true } }, { runLabel: `issue-bg-${RUN_ID}` });
  assert.equal(background.result.ok, true, background.result.error);
  assert.ok(background.result.container);
  assert.equal(containerExists(background.result.container), false, 'a background process does not keep the container');
  assertNoResources(`${sandbox.LABEL_RUN}=issue-bg-${RUN_ID}`);

  for (const mode of ['exit', 'sigint']) {
    const runLabel = `issue-exit-${mode}-${RUN_ID}`;
    const sessionsDirs = [1, 2].map((index) => workspace.prepareAgentSessionDir(sessionsRoot, `${mode}-${index}`));
    const outcome = await runChildController(mode, { runDir, sessionsDirs, prompt: directivePrompt({ all: { sleepSeconds: 300 } }), box: box(runLabel) });
    assert.ok(outcome.sawBoth, `${mode}: both agent containers were running`);
    assert.equal(outcome.code, mode === 'sigint' ? 130 : 0, `${mode}: exit code`);
    assertNoResources(`${sandbox.LABEL_RUN}=${runLabel}`);
  }
});

// --- labels and startup cleanup ---

scenario('labels real containers with consumer and run', async () => {
  const { runDir } = cloneFor();
  const specs = [
    { rootKey: `${ROOT_KEY}a`, runLabel: `issue-label-a-${RUN_ID}` },
    { rootKey: `${ROOT_KEY}b`, runLabel: `issue-label-b-${RUN_ID}` },
  ];
  const launched = specs.map((spec) => sandbox.spawnInSandbox({ image: STUB, ...spec, runDir, network: 'none', command: ['sleep', '60'] }));
  try {
    for (const [index, spec] of specs.entries()) {
      await waitFor(() => dockerIds(['ps', '-q', '--filter', `label=${sandbox.LABEL_RUN}=${spec.runLabel}`]).length === 1, `container of ${spec.runLabel}`);
      const labels = JSON.parse(mustDocker(['inspect', '--format', '{{json .Config.Labels}}', launched[index].name]));
      assert.equal(labels[sandbox.LABEL_MANAGED], spec.rootKey);
      assert.equal(labels[sandbox.LABEL_RUN], spec.runLabel);
      assert.deepEqual(dockerIds(['ps', '-q', '--filter', `label=${sandbox.LABEL_MANAGED}=${spec.rootKey}`]).length, 1);
    }
  } finally {
    for (const item of launched) {
      item.stop();
      item.child.kill();
    }
  }
  for (const spec of specs) assertNoResources(`${sandbox.LABEL_MANAGED}=${spec.rootKey}`);
});

const startupConfig = () => sandbox.validateSandboxConfig({ ...CONFIG.sandbox, image: STUB });

scenario('cleans only current consumer leftovers at startup', (t) => {
  const consumerRoot = scratchDir('consumer-startup');
  const rootKey = sandbox.rootKeyFor(consumerRoot);
  const otherKey = sandbox.rootKeyFor(scratchDir('other-consumer'));
  const own = sleeper(t, [`${sandbox.LABEL_MANAGED}=${rootKey}`, `${sandbox.LABEL_RUN}=issue-1`]);
  const ownNetwork = labelledNetwork(t, [`${sandbox.LABEL_MANAGED}=${rootKey}`]);
  const other = sleeper(t, [`${sandbox.LABEL_MANAGED}=${otherKey}`, `${sandbox.LABEL_RUN}=issue-1`]);
  const otherNetwork = labelledNetwork(t, [`${sandbox.LABEL_MANAGED}=${otherKey}`]);
  const unlabelled = sleeper(t, []);
  const unlabelledNetwork = labelledNetwork(t, []);
  assert.ok(isRunning(own) && isRunning(other) && isRunning(unlabelled));
  const builds = [];
  assert.equal(run.startSandbox(consumerRoot, startupConfig(), { sandboxApi: preparedImageApi(builds) }), rootKey);
  assert.deepEqual(builds, [STUB], 'only the prepared image check replaced the build');
  assert.equal(isRunning(own), false);
  assert.equal(networkExists(ownNetwork), false);
  assertNoResources(`${sandbox.LABEL_MANAGED}=${rootKey}`);
  assert.equal(isRunning(other), true);
  assert.equal(networkExists(otherNetwork), true);
  assert.equal(isRunning(unlabelled), true);
  assert.equal(networkExists(unlabelledNetwork), true);
});

scenario('leaves unrelated resources running without owned leftovers', (t) => {
  const consumerRoot = scratchDir('consumer-clean');
  const rootKey = sandbox.rootKeyFor(consumerRoot);
  const similarKey = `${rootKey.slice(0, -1)}${rootKey.endsWith('0') ? '1' : '0'}`;
  const otherKey = sandbox.rootKeyFor(scratchDir('other-consumer'));
  const kept = [
    sleeper(t, [`${sandbox.LABEL_MANAGED}=${otherKey}`]),
    sleeper(t, [`${sandbox.LABEL_MANAGED}=${similarKey}`]),
    sleeper(t, [`${sandbox.LABEL_MANAGED}=${rootKey}x`]),
    sleeper(t, []),
  ];
  const keptNetworks = [labelledNetwork(t, [`${sandbox.LABEL_MANAGED}=${otherKey}`]), labelledNetwork(t, [`${sandbox.LABEL_MANAGED}=${similarKey}`]), labelledNetwork(t, [])];
  assertNoResources(`${sandbox.LABEL_MANAGED}=${rootKey}`);
  const removed = [];
  const removeLeftovers = (key, options) => {
    const counts = sandbox.removeLeftovers(key, options);
    removed.push(counts);
    return counts;
  };
  const api = { ...preparedImageApi([]), removeLeftovers };
  run.startSandbox(consumerRoot, startupConfig(), { sandboxApi: api });
  assert.deepEqual(removed, [{ containers: 0, networks: 0 }]);
  assert.deepEqual(dockerIds(['ps', '-aq', '--filter', `label=${sandbox.LABEL_RUN}=issue-none-${RUN_ID}`]), [], 'a successful query of a run that does not exist');
  for (const id of kept) assert.equal(isRunning(id), true, id);
  for (const network of keptNetworks) assert.equal(networkExists(network), true, network);
  // A failing Docker query is an error here, never "nothing left".
  assert.throws(() => dockerIds(['ps', '-aq', '--filter', 'no-such-filter=1']), /docker ps .* failed/);
});

// --- the controller end to end ---

scenario('runs agent install and gate inside sandbox', async (t) => {
  for (const form of Object.keys(FORMS)) {
    const appDir = path.posix.join(sandbox.CONTAINER_WORKDIR, FORMS[form].app === '.' ? '' : FORMS[form].app);
    const outcome = await mainRun(t, form);
    assert.equal(outcome.result.status, 'done', JSON.stringify(outcome.result));
    assert.deepEqual(outcome.result.steps.map((step) => `${step.name}:${step.outcome}`), ['implement:passed', 'self-review:passed', 'code-review:passed', 'final-gate:passed']);
    assert.deepEqual(outcome.builds, [STUB]);
    assert.deepEqual(hostPrograms(outcome.calls), ['docker', 'gh', 'git'], 'no project command on the host');

    // Installs, then setup, in containers through the proxy with the install env, in the profile's cwd.
    const install = evidenceOf(outcome.logs, 'install-install_0_');
    assert.equal(install.length, 1);
    assert.deepEqual([install[0].container, install[0].cwd, install[0].installEnv], [true, sandbox.CONTAINER_WORKDIR, 'from-profile']);
    assert.match(install[0].proxy, /^http:\/\/ralph-proxy-/);
    const appInstalls = evidenceOf(outcome.logs, 'install-apps_').filter((entry) => entry.step === 'install-app');
    assert.deepEqual(appInstalls.map((entry) => entry.cwd), outcome.profile.apps.map((app) => path.posix.join(sandbox.CONTAINER_WORKDIR, app.path === '.' ? '' : app.path)));
    assert.ok(appInstalls.every((entry) => entry.container && entry.installEnv === 'from-profile'));
    const setupLog = outcome.logs.find((log) => log.name.startsWith('install-factory-setup-'));
    assert.ok(setupLog, 'the setup log is kept');
    assert.match(setupLog.text, /--- exit 0/);
    assert.match(setupLog.text, /node \/workspace\/node_modules\/dark-factory\/bin\/setup\.js --consumer-root \/workspace/);

    // The agent passes, in order, each in a container; setup laid out the skills before the first one.
    assert.deepEqual(outcome.agentCalls, ['01-implement', '02-self-review', '03-code-review']);
    const reports = Object.values(outcome.reports);
    assert.deepEqual(reports.map((report) => report.role), ['implementer', 'reviewer', 'code-reviewer']);
    const implement = outcome.reports['01-implement'];
    assert.ok(implement.skills.includes('issues') && implement.skills.includes('task-lifecycle'), implement.skills.join());
    assert.ok(fs.statSync(path.join(outcome.sessionsRoot, setupLog.name)).mtimeMs <= fs.statSync(path.join(outcome.sessionsRoot, '01-implement', 'ralph-stub-report.json')).mtimeMs);
    for (const report of reports) {
      assert.equal(report.env.credentials.ANTHROPIC_API_KEY, sha256(CANARY.apiKey));
      assert.equal(report.env.installEnv, null, 'installEnv only for installs and sync');
      assert.match(report.env.httpsProxy, /^http:\/\/ralph-proxy-/);
      assert.equal(report.factoryHash, FACTORY_HASH, 'the clone runs the same installed factory');
      assert.deepEqual(report.argv.slice(0, 3), ['-p', '--output-format', 'stream-json']);
    }

    // Dependency sync of the changed manifest in its area, then the gate with loopback only.
    const sync = evidenceOf(outcome.logs, 'install-');
    const syncWhere = sync.find((entry) => entry.step === 'sync');
    assert.deepEqual([syncWhere.container, syncWhere.cwd, syncWhere.installEnv], [true, appDir, 'from-profile']);
    assert.equal(outcome.gateRuns.length, 1, 'one gate command of the touched app');
    const gateArgs = outcome.gateRuns[0].args;
    assert.equal(gateArgs[gateArgs.indexOf('-w') + 1], appDir);
    assert.equal(gateArgs[gateArgs.indexOf('--network') + 1], 'none');
    const gateWhere = parseEvidence(outcome.gateRuns[0].stdout)[0];
    assert.deepEqual([gateWhere.container, gateWhere.cwd, gateWhere.installEnv], [true, appDir, null]);
    assert.deepEqual(gateWhere.interfaces, ['lo']);

    // The controller published to the local origin and opened the PR through gh.
    const branch = outcome.branches.find((name) => name !== 'trunk');
    assert.ok(branch, outcome.branches.join());
    const committed = gitIn(outcome.origin, 'show', '--name-only', '--format=', branch).split('\n').sort();
    assert.deepEqual(committed, [inApp(form, 'fixture-deps.lock'), inApp(form, 'package.json'), inApp(form, 'src/a.ts')].sort());
    assert.equal(outcome.mutations.filter((m) => m.kind === 'pr').length, 1);
    assert.equal(treeHash(PACKAGE_ROOT), FACTORY_HASH, 'the installed copy is unchanged');
  }
});

scenario('cleans run resources after success', async (t) => {
  for (const form of Object.keys(FORMS)) {
    const outcome = await mainRun(t, form);
    assert.equal(outcome.result.status, 'done', JSON.stringify(outcome.result));
    assertNoResources(`${sandbox.LABEL_MANAGED}=${outcome.rootKey}`);
    assertNoResources(`${sandbox.LABEL_RUN}=issue-46`);
    assert.equal(fs.existsSync(outcome.runDir), false, 'the clone of a published run is removed');
    assert.ok(path.relative(outcome.runDir, outcome.sessionsRoot).startsWith('..'));
    for (const call of outcome.agentCalls) assert.equal(journalsIn(path.join(outcome.sessionsRoot, call)).length, 1, call);
    assert.ok(outcome.logs.some((log) => log.name.startsWith('install-install_0_')), 'the install log is kept');
  }
});

scenario('does not fall back after sandbox failure', async (t) => {
  for (const form of Object.keys(FORMS)) {
    const variants = {
      install: { profileOptions: { factoryArgs: ['--fail'] } },
      agent: { implement: { exitCode: 1 } },
      gate: { implement: { write: { [inApp(form, 'src/a.ts')]: 'export const value = 2;\n', [inApp(form, 'gate-fail.flag')]: 'fail\n' } } },
    };
    for (const [phase, options] of Object.entries(variants)) {
      const outcome = await controllerRun(t, form, options);
      const label = `${form} ${phase}`;
      assert.notEqual(outcome.result.status, 'done', label);
      assert.deepEqual(outcome.mutations.filter((m) => m.kind === 'pr'), [], `${label}: no PR`);
      assert.deepEqual(outcome.branches, ['trunk'], `${label}: no push`);
      assert.deepEqual(hostPrograms(outcome.calls).filter((name) => !['docker', 'gh', 'git'].includes(name)), [], `${label}: no host fallback`);
      assertNoResources(`${sandbox.LABEL_MANAGED}=${outcome.rootKey}`);
      if (phase === 'install') {
        assert.equal(outcome.result.status, 'blocked', label);
        assert.match(outcome.result.reason, /install\[0\] failed/);
        assert.deepEqual(outcome.agentCalls, [], `${label}: no agent`);
        assert.equal(outcome.logs.some((log) => log.name.startsWith('install-factory-setup-')), false, `${label}: no setup`);
        assert.ok(outcome.mutations.some((m) => m.kind === 'comment' && /BLOCKED/i.test(m.body)), `${label}: BLOCKED comment`);
      }
      if (phase === 'agent') {
        assert.equal(outcome.result.status, 'agent_failed', label);
        assert.deepEqual(outcome.agentCalls, ['01-implement'], `${label}: no later pass`);
      }
      if (phase === 'install' || phase === 'agent') assert.deepEqual(outcome.gateRuns, [], `${label}: no gate`);
      if (phase === 'gate') {
        assert.equal(outcome.result.status, 'final_gate_blocked', label);
        assert.equal(outcome.gateRuns.length, 1, `${label}: the gate ran in the sandbox`);
        assert.ok(outcome.mutations.some((m) => m.kind === 'label' && m.label === 'ralph-blocked'), `${label}: blocked label`);
      }
    }
  }
});

scenario('blocks when installed setup runtime is incomplete', async (t) => {
  for (const form of Object.keys(FORMS)) {
    for (const factoryArgs of [['--omit-setup'], ['--omit-dependency', 'ajv']]) {
      const label = `${form} ${factoryArgs.join(' ')}`;
      const outcome = await controllerRun(t, form, { profileOptions: { factoryArgs } });
      assert.equal(outcome.result.status, 'blocked', `${label}: ${JSON.stringify(outcome.result)}`);
      assert.match(outcome.result.reason, /factory-setup failed: node \/workspace\/node_modules\/dark-factory\/bin\/setup\.js/);
      const logPath = namedLog(outcome.result.reason);
      const log = fs.readFileSync(logPath, 'utf8');
      assert.match(log, factoryArgs[0] === '--omit-setup' ? /Cannot find module '\/workspace\/node_modules\/dark-factory\/bin\/setup\.js'/ : /Cannot find module 'ajv/, label);
      assert.doesNotMatch(log, /registry\.npmjs\.org/);
      assert.deepEqual(outcome.agentCalls, [], `${label}: no agent`);
      assert.deepEqual(outcome.gateRuns, [], `${label}: no gate`);
      assert.equal(fs.existsSync(path.join(outcome.runDir, '.claude', 'skills')), false, `${label}: no host setup`);
      assert.deepEqual(hostPrograms(outcome.calls), ['docker', 'gh', 'git']);
      assertNoResources(`${sandbox.LABEL_MANAGED}=${outcome.rootKey}`);
    }
  }
});

// --- coverage of the preserved scenarios (last) ---

scenario('covers preserved reference sandbox scenarios', () => {
  const testNames = ownTestNames();
  assert.deepEqual(coverage.checkSandboxMap(sandboxMap(), { sourceNames: sandboxSourceNames(), testNames }), []);
  assert.deepEqual(coverage.checkControllerMap(controllerMap(), { sources: controllerSources(), testNames }), []);
  const rows = [...sandboxMap().cases.filter((entry) => entry.destination !== 'portable'), ...controllerMap().cases];
  const referenced = new Set(rows.flatMap((entry) => coverage.referencedTests(entry.integration)));
  const notRun = [...referenced].filter((name) => !completed.has(name));
  assert.deepEqual(notRun, [], 'every mapped integration test ran and passed in this run');
  const others = testNames.filter((name) => name !== 'covers preserved reference sandbox scenarios');
  assert.deepEqual(others.filter((name) => !completed.has(name)), [], 'every test of this file passed before this one');
  assert.deepEqual(dockerSubcommands().filter((name) => name === 'build' || name === 'pull'), [], 'no image was built or pulled');
});
