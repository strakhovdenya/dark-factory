'use strict';

// Portable tests of the sandbox runtime: no Docker, no network, no AI. Processes are replaced at
// the child_process boundary, HOME is a controlled temporary directory. The real Docker scenarios
// of the reference implementation are recorded in test/fixtures/ralph-sandbox/cases.json and
// belong to the integration task, not to this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { isBuiltin } = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const sandbox = require('./sandbox');
const { loadProfile } = require('../profile/load');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');

const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'profiles');
const fixtureRoot = (fixture) => path.join(FIXTURES_DIR, fixture);

const NEUTRAL = Object.freeze({
  image: 'neutral-sandbox:test',
  nodeVersion: '22',
  claudeCodeVersion: '1.2.3',
  allowedHosts: ['registry.example.org', 'models.example.org'],
});
const configWith = (overrides) => ({ ...NEUTRAL, ...overrides });

const BOX = { image: NEUTRAL.image, rootKey: 'testkey', runLabel: 'issue-test', network: 'none', user: null };

// --- controlled environment ---

/** Replaces the operator HOME with an empty temporary directory for the length of the test. */
const useHome = (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-home-')));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, env: { HOME: home, USERPROFILE: home } };
};

/** A temporary directory outside the (controlled) home. */
const scratch = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-scratch-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

/** A directory link (a junction on Windows) that is removed, as a link, when the test ends. */
const makeLink = (t, target, linkPath) => {
  fs.symlinkSync(target, linkPath, linkType);
  t.after(() => fs.rmSync(linkPath, { force: true, recursive: true }));
};

const isOutside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

/**
 * Replaces the process boundary. spawnSync and spawn are recorded and answered by `respond`;
 * any other way of starting a host process fails the test.
 */
const mockProcesses = (t, respond = (_command, _args, _options) => undefined) => {
  const calls = [];
  const children = [];
  const cp = /** @type {any} */ (childProcess);
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    t.mock.method(cp, name, () => {
      throw new Error(`a host process was started through ${name}`);
    });
  }
  t.mock.method(cp, 'spawnSync', (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '', error: undefined, ...respond(command, args, options) };
  });
  t.mock.method(cp, 'spawn', (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    children.push(child);
    return child;
  });
  return { calls, children };
};

const mountsOf = (args) => args.flatMap((arg, index) => (args[index - 1] === '--mount' ? [arg] : []));
const labelsOf = (args) => args.flatMap((arg, index) => (args[index - 1] === '--label' ? [arg] : []));
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
const removalsOf = (calls) => calls.filter((call) => call.args[0] === 'rm').map((call) => call.args[2]);

const makeClone = (dir, name = 'clone') => {
  const clone = path.join(dir, name);
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  return clone;
};

// --- profile settings ---

test('takes sandbox settings from profile', (t) => {
  const { calls } = mockProcesses(t, (_command, args) => (args[0] === 'logs' ? { stdout: sandbox.PROXY_READY_LINE } : undefined));
  for (const fixture of FIXTURE_PROFILES) {
    const profile = loadProfile(fixtureRoot(fixture));
    const raw = profile.sandbox;
    const config = sandbox.validateSandboxConfig(raw);

    assert.deepEqual(
      { ...config, allowedHosts: [...config.allowedHosts], installEnv: { ...config.installEnv } },
      {
        image: raw.image,
        nodeVersion: raw.nodeVersion,
        claudeCodeVersion: raw.claudeCodeVersion,
        allowedHosts: raw.allowedHosts,
        installEnv: raw.installEnv || {},
      },
      fixture,
    );
    assert.deepEqual(Object.keys(config).sort(), ['allowedHosts', 'claudeCodeVersion', 'image', 'installEnv', 'nodeVersion'], fixture);
    assert.equal('runsRoot' in config, false, `${fixture}: the runs root is not a profile setting`);
    assert.ok(Object.isFrozen(config) && Object.isFrozen(config.allowedHosts) && Object.isFrozen(config.installEnv), fixture);
    // The profile keeps its own form: nothing is substituted into it.
    assert.deepEqual(Object.keys(profile.sandbox), Object.keys(raw), fixture);

    const buildArgs = sandbox.buildImageArgs(config);
    assert.deepEqual(buildArgs.slice(buildArgs.indexOf('-t'), buildArgs.indexOf('-t') + 2), ['-t', raw.image], fixture);
    assert.ok(buildArgs.includes(`NODE_VERSION=${raw.nodeVersion}`), fixture);
    assert.ok(buildArgs.includes(`CLAUDE_CODE_VERSION=${raw.claudeCodeVersion}`), fixture);

    calls.length = 0;
    const proxy = sandbox.startProxy({ image: config.image, rootKey: 'k', runLabel: 'issue-1', allowedHosts: config.allowedHosts });
    const runCall = calls.find((call) => call.args[0] === 'run');
    assert.ok(runCall.args.includes(config.image), fixture);
    assert.equal(runCall.options.env[sandbox.PROXY_ALLOWED_HOSTS_ENV], raw.allowedHosts.join(','), fixture);
    proxy.stop();
  }
});

test('example of absent installEnv is normalized in the runtime only', () => {
  const config = sandbox.validateSandboxConfig(NEUTRAL);
  assert.deepEqual({ ...config.installEnv }, {});
  assert.equal('installEnv' in NEUTRAL, false);
  assert.throws(() => sandbox.validateSandboxConfig(undefined), /sandbox/);
  assert.throws(() => sandbox.validateSandboxConfig([]), /sandbox/);
});

test('rejects reserved env name in profile', () => {
  const reserved = [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'DOCKER_HOST', 'DOCKER_CONFIG',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR', 'GH_TOKEN', 'HOME', 'Home', 'CLAUDE_CONFIG_DIR',
  ];
  for (const name of reserved) {
    assert.throws(
      () => sandbox.validateSandboxConfig(configWith({ installEnv: { [name]: 'x' } })),
      (/** @type {Error} */ error) => error.message.includes(`sandbox.installEnv.${name}`) && error.message.includes(`installEnv may not set ${name}`),
      name,
    );
  }
  assert.deepEqual({ ...sandbox.validateSandboxConfig(configWith({ installEnv: { SOME_FLAG: 'true' } })).installEnv }, { SOME_FLAG: 'true' });
  for (const installEnv of [{ '1BAD': 'x' }, { 'BAD-NAME': 'x' }, { FLAG: 1 }, { FLAG: null }, 'FLAG=1', ['FLAG']]) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ installEnv })), /sandbox\.installEnv/, JSON.stringify(installEnv));
  }
});

test('rejects invalid image tag in profile', () => {
  for (const image of ['untagged-image', '', 'Upper:tag', 'name:', 'name:tag with space', 'name:tag!', '-name:1', 'name:tag,x', 42, null, undefined]) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ image })), /sandbox\.image/, JSON.stringify(image));
  }
  for (const image of ['name:1.0', 'registry.example.org/team/name:tag-1_x', 'a:b']) {
    assert.equal(sandbox.validateSandboxConfig(configWith({ image })).image, image);
  }
});

test('rejects malformed allowlist, node and claude versions', () => {
  const notHosts = [
    'https://registry.example.org', 'registry.example.org:443', 'registry.example.org/path', '10.0.0.1', '::1', '', 42, null,
    '*.example.org', 'localhost', '-bad.example.org', 'example.123',
  ];
  for (const entry of notHosts) {
    assert.throws(
      () => sandbox.validateSandboxConfig(configWith({ allowedHosts: [entry] })),
      /sandbox\.allowedHosts\[0\]: entry is not a host name/,
      JSON.stringify(entry),
    );
  }
  for (const allowedHosts of [[], 'registry.example.org', undefined]) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ allowedHosts })), /sandbox\.allowedHosts/);
  }
  for (const version of ['^2.1.0', '~2.1.0', '2.x', '2.1', '>=2.1.0', 'latest', 'next', '2.1.195-beta.1', '2.1.195+build', '', 2]) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ claudeCodeVersion: version })), /sandbox\.claudeCodeVersion/, JSON.stringify(version));
  }
  for (const version of ['', 'latest', '22.x', '22.1.2.3', '^22', 22]) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ nodeVersion: version })), /sandbox\.nodeVersion/, JSON.stringify(version));
  }
  for (const version of ['22', '22.1', '22.1.2']) {
    assert.equal(sandbox.validateSandboxConfig(configWith({ nodeVersion: version })).nodeVersion, version);
  }
  assert.throws(() => sandbox.validateSandboxConfig(configWith({ runsRoot: 'runs' })), /sandbox\.runsRoot: unknown field/);
  assert.throws(() => sandbox.validateSandboxConfig(configWith({ extra: 1 })), /sandbox\.extra: unknown field/);
});

// --- proxy policy ---

test('proxy follows profile allowlist', (t) => {
  const cp = /** @type {any} */ (net);
  t.mock.method(cp, 'connect', () => {
    throw new Error('a socket was opened');
  });
  t.mock.method(cp, 'createServer', () => {
    throw new Error('a server was created');
  });
  for (const fixture of FIXTURE_PROFILES) {
    const hosts = [...sandbox.validateSandboxConfig(loadProfile(fixtureRoot(fixture)).sandbox).allowedHosts];
    const decide = (request) => sandbox.decideProxyRequest(request, hosts).allow;
    for (const host of hosts) {
      const mixed = host.replace(/^./, (letter) => letter.toUpperCase());
      for (const name of [host, host.toUpperCase(), mixed]) {
        assert.equal(decide({ method: 'CONNECT', host: name, port: 443 }), true, `${fixture}: ${name}`);
      }
      assert.deepEqual(sandbox.parseAuthority(`${host}:443`), { host, port: 443 });
      for (const denied of [`sub.${host}`, `a.b.${host}`, `${host}.evil.test`, `evil${host}`]) {
        assert.equal(decide({ method: 'CONNECT', host: denied, port: 443 }), false, `${fixture}: ${denied}`);
      }
      for (const method of ['GET', 'POST', 'PUT', 'connect', '']) {
        assert.equal(decide({ method, host, port: 443 }), false, `${fixture}: ${method}`);
      }
      for (const port of [80, 22, 8443, 4430, 0, undefined]) {
        assert.equal(decide({ method: 'CONNECT', host, port }), false, `${fixture}: ${port}`);
      }
    }
    for (const host of ['other.example.net', '1.1.1.1', '::1', '[::1]', 'localhost', '']) {
      assert.equal(decide({ method: 'CONNECT', host, port: 443 }), false, `${fixture}: ${host}`);
    }
  }
  assert.equal(sandbox.parseAuthority('registry.example.org'), null);
  assert.equal(sandbox.parseAuthority('http://registry.example.org:443'), null);
  assert.deepEqual(sandbox.parseAllowedHostsEnv('a.example.org,,b.example.org'), ['a.example.org', 'b.example.org']);
  assert.deepEqual(sandbox.parseAllowedHostsEnv(undefined), []);
});

// --- independence of the module ---

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const requiresOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(REQUIRE_RE)].map((match) => match[1]);

test('loads independently for container proxy', (t) => {
  const sandboxFile = path.join(__dirname, 'sandbox.js');
  const proxyFile = path.join(__dirname, 'sandbox', 'proxy.js');
  const contextDir = path.join(__dirname, 'sandbox');

  // Only Node built-ins, so the file works inside the image, away from the rest of the package.
  const sandboxRequires = requiresOf(sandboxFile);
  assert.ok(sandboxRequires.length > 0);
  for (const specifier of sandboxRequires) assert.ok(isBuiltin(specifier), `sandbox.js requires a non-builtin: ${specifier}`);
  for (const specifier of requiresOf(proxyFile)) {
    assert.ok(isBuiltin(specifier) || specifier === '../sandbox', `proxy.js requires ${specifier}`);
  }

  // What the Dockerfile copies is what proxy.js resolves, and all of it is inside the package.
  const dockerfile = fs.readFileSync(path.join(contextDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --from=ralph sandbox\.js \/opt\/ralph\/sandbox\.js/);
  assert.match(dockerfile, /COPY proxy\.js \/opt\/ralph\/sandbox\/proxy\.js/);
  assert.ok(fs.existsSync(path.join(path.dirname(contextDir), 'sandbox.js')));
  assert.ok(fs.existsSync(path.join(contextDir, 'proxy.js')));

  // Loading starts no process, server or socket and registers no process handlers.
  const { calls } = mockProcesses(t);
  const cp = /** @type {any} */ (http.Server.prototype);
  t.mock.method(cp, 'listen', () => {
    throw new Error('a server started listening');
  });
  t.mock.method(/** @type {any} */ (net), 'connect', () => {
    throw new Error('a socket was opened');
  });
  const listeners = ['exit', 'SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event));
  const cached = [sandboxFile, proxyFile].map((file) => ({ file, entry: require.cache[file] }));
  for (const { file } of cached) delete require.cache[file];
  t.after(() => {
    for (const { file, entry } of cached) {
      if (entry) require.cache[file] = entry;
      else delete require.cache[file];
    }
  });

  const fresh = require(sandboxFile);
  assert.equal(fresh.validateSandboxConfig(NEUTRAL).image, NEUTRAL.image);
  assert.equal(fresh.decideProxyRequest({ method: 'CONNECT', host: 'registry.example.org', port: 443 }, NEUTRAL.allowedHosts).allow, true);
  const proxyModule = require(proxyFile);
  const server = proxyModule.createProxyServer(NEUTRAL.allowedHosts, () => {});
  assert.equal(server.listening, false);

  assert.deepEqual(calls, []);
  assert.deepEqual(['exit', 'SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event)), listeners);
});

// --- runs root ---

test('resolves local runs root from consumer root', (t) => {
  const { env } = useHome(t);
  const dir = scratch(t);
  const consumer = path.join(dir, 'consumer');
  const external = path.join(dir, 'external-runs');
  const packageRoot = path.resolve(__dirname, '..');

  const byDefault = path.join(consumer, '.ralph-runs');
  assert.equal(sandbox.resolveRunsRoot(undefined, consumer, env), byDefault);
  assert.equal(sandbox.resolveRunsRoot(null, consumer, env), byDefault);
  assert.equal(sandbox.resolveRunsRoot({}, consumer, env), byDefault);
  assert.equal(sandbox.resolveRunsRoot({ runsRoot: 'state/runs' }, consumer, env), path.join(consumer, 'state', 'runs'));
  assert.equal(sandbox.resolveRunsRoot({ runsRoot: external }, consumer, env), external);
  assert.equal(sandbox.resolveRunsRoot({ runsRoot: path.join('..', 'sibling-runs') }, consumer, env), path.join(dir, 'sibling-runs'));

  for (const root of [byDefault, external]) {
    assert.equal(fs.existsSync(root), false, 'resolving creates nothing');
    assert.ok(isOutside(packageRoot, root), 'state is never placed in the installed package');
  }
  assert.throws(() => sandbox.resolveRunsRoot({}, ''), /consumerRoot/);
  assert.throws(() => sandbox.resolveRunsRoot({}, undefined), /consumerRoot/);
  assert.throws(() => sandbox.resolveRunsRoot('runs', consumer, env), /options/);
});

test('rejects invalid or home located runs root', (t) => {
  const { home, env } = useHome(t);
  const dir = scratch(t);
  const consumer = path.join(dir, 'consumer');

  for (const runsRoot of ['', '   ', 42, null, true, {}, ['runs']]) {
    assert.throws(() => sandbox.resolveRunsRoot({ runsRoot }, consumer, env), /runsRoot/, JSON.stringify(runsRoot));
  }

  const insideHome = [
    { options: { runsRoot: path.join(home, 'runs') }, consumerRoot: consumer },
    { options: { runsRoot: home }, consumerRoot: consumer },
    { options: { runsRoot: path.join(home, '..cache', 'runs') }, consumerRoot: consumer },
    { options: { runsRoot: '.ralph-runs' }, consumerRoot: path.join(home, 'project') },
    { options: undefined, consumerRoot: path.join(home, 'project') },
  ];
  for (const { options, consumerRoot } of insideHome) {
    assert.throws(
      () => sandbox.resolveRunsRoot(options, consumerRoot, env),
      (/** @type {Error} */ error) => /runsRoot/.test(error.message) && /outside the home directory/.test(error.message) && !/disable|bypass|ignore|skip/i.test(error.message),
      JSON.stringify(options),
    );
  }
  assert.equal(sandbox.isInsideHome(path.join(home, '..'), env), false);
  assert.equal(sandbox.isInsideHome(path.join(home, '.ssh'), env), true);

  // A link outside the home whose target is inside it is the home for Docker.
  const target = path.join(home, 'linked-target');
  fs.mkdirSync(target);
  const link = path.join(dir, 'runs-link');
  makeLink(t, target, link);
  assert.throws(() => sandbox.resolveRunsRoot({ runsRoot: link }, consumer, env), /runsRoot/);
  assert.throws(() => sandbox.resolveRunsRoot({ runsRoot: path.join(link, 'issue-1') }, consumer, env), /runsRoot/);
  assert.equal(sandbox.isInsideHome(dir, env), false);
});

// --- run arguments ---

test('preserves mount and workdir boundaries', (t) => {
  const { env } = useHome(t);
  const dir = scratch(t);
  const clone = makeClone(dir);
  const sessionsDir = path.join(dir, 'sessions', '01-implement');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const args = sandbox.buildRunArgs({ ...BOX, runDir: clone, sessionsDir, readOnlyGit: true, command: ['true'] }, env);
  assert.deepEqual(mountsOf(args), [
    `type=bind,source=${path.resolve(clone)},target=${sandbox.CONTAINER_WORKDIR}`,
    `type=bind,source=${path.resolve(clone, '.git')},target=${sandbox.CONTAINER_WORKDIR}/.git,readonly`,
    `type=bind,source=${path.resolve(sessionsDir)},target=${sandbox.CONTAINER_SESSIONS_DIR}`,
  ]);
  assert.equal(valueAfter(args, '-w'), sandbox.CONTAINER_WORKDIR);

  const onlyRun = sandbox.buildRunArgs({ ...BOX, runDir: clone, command: ['true'] }, env);
  assert.deepEqual(mountsOf(onlyRun), [`type=bind,source=${path.resolve(clone)},target=${sandbox.CONTAINER_WORKDIR}`]);
  const withJournals = sandbox.buildRunArgs({ ...BOX, runDir: clone, sessionsDir, command: ['true'] }, env);
  assert.equal(mountsOf(withJournals).length, 2);

  for (const built of [args, onlyRun, withJournals]) {
    assert.ok(!built.some((arg) => ['-v', '--volume', '--tmpfs', '--volumes-from', '--privileged', '--pid', '--ipc'].includes(arg)), built.join(' '));
    assert.deepEqual(built.slice(built.indexOf('--cap-drop'), built.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
    assert.deepEqual(built.slice(built.indexOf('--security-opt'), built.indexOf('--security-opt') + 2), ['--security-opt', 'no-new-privileges']);
    assert.equal(valueAfter(built, '--network'), 'none');
  }

  const nested = sandbox.buildRunArgs({ ...BOX, runDir: clone, workdir: 'apps\\web', command: ['true'] }, env);
  assert.equal(valueAfter(nested, '-w'), '/workspace/apps/web');
  for (const workdir of ['', '.', 'apps/api']) {
    assert.doesNotThrow(() => sandbox.buildRunArgs({ ...BOX, runDir: clone, workdir, command: ['true'] }, env), workdir);
  }
});

test('rejects unsafe mount specifications', (t) => {
  const { home, env } = useHome(t);
  const dir = scratch(t);
  const clone = makeClone(dir);
  const { calls } = mockProcesses(t);
  const spec = (overrides) => ({ ...BOX, runDir: clone, command: ['true'], ...overrides });

  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: home }), env), /home directory/);
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(home, 'projects', 'issue-1') }), env), /home directory/);
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(home, '..cache', 'runs') }), env), /home directory/);
  assert.throws(() => sandbox.buildRunArgs(spec({ sessionsDir: path.join(home, '.claude') }), env), /home directory/);
  const otherHome = path.join(dir, 'other-home');
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(otherHome, 'x') }), { HOME: otherHome }), /home directory/);
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(otherHome, 'x') }), { USERPROFILE: otherHome }), /home directory/);

  // A link that resolves into the home is the home.
  const target = path.join(home, 'linked-target');
  fs.mkdirSync(target);
  const link = path.join(dir, 'clone-link');
  makeLink(t, target, link);
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(link, 'issue-1') }), env), /home directory/);

  for (const workdir of ['../workspace-other', '../workspaces', '..', '../../etc']) {
    assert.throws(() => sandbox.buildRunArgs(spec({ workdir }), env), /escapes the run dir/, workdir);
  }

  for (const runDir of ['', undefined, path.join(dir, 'with,comma'), path.join(dir, 'with"quote')]) {
    assert.throws(() => sandbox.buildRunArgs(spec({ runDir }), env), /mount path/, String(runDir));
  }

  // `.git` must be the clone's own directory: absent, a file or a link planted by the run is refused.
  const bare = path.join(dir, 'bare');
  fs.mkdirSync(bare);
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: bare, readOnlyGit: true }), env), /not a real directory/);
  const worktree = path.join(dir, 'worktree');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /elsewhere\n');
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: worktree, readOnlyGit: true }), env), /not a real directory/);
  const swapped = path.join(dir, 'swapped');
  fs.mkdirSync(swapped);
  const elsewhere = path.join(dir, 'elsewhere-git');
  fs.mkdirSync(elsewhere);
  makeLink(t, elsewhere, path.join(swapped, '.git'));
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: swapped, readOnlyGit: true }), env), /not a real directory/);
  const args = sandbox.buildRunArgs(spec({ readOnlyGit: true }), env);
  assert.ok(args.some((arg) => arg.endsWith(`target=${sandbox.CONTAINER_WORKDIR}/.git,readonly`)), args.join(' '));

  assert.throws(() => sandbox.buildRunArgs(spec({ command: [] }), env), /command is empty/);

  // The runners refuse before any process is started.
  for (const runDir of [home, swapped]) {
    assert.throws(() => sandbox.runInSandboxSync(spec({ runDir, readOnlyGit: true })));
    assert.throws(() => sandbox.spawnInSandbox(spec({ runDir, readOnlyGit: true })));
  }
  assert.deepEqual(calls, []);
});

test('preserves secret and proxy environment boundaries', (t) => {
  const { env } = useHome(t);
  const dir = scratch(t);
  const clone = makeClone(dir);
  const proxyUrl = 'http://proxy-x.example.org:3128';
  const spec = {
    ...BOX,
    runDir: clone,
    network: 'internal-net-x',
    proxyUrl,
    env: { FAKE_SECRET_NAME: 'fake-secret-value' },
    publicEnv: { FAKE_PUBLIC_NAME: 'public-value', HTTPS_PROXY: 'http://untrusted.example.org:1' },
    command: ['true'],
  };
  const args = sandbox.buildRunArgs(spec, env);

  assert.ok(args.some((arg, index) => arg === 'FAKE_SECRET_NAME' && args[index - 1] === '-e'), 'the secret is passed by name');
  assert.ok(!args.some((arg) => arg.includes('fake-secret-value')), 'secret values never appear in argv');
  assert.ok(args.includes('FAKE_PUBLIC_NAME=public-value'));
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const entries = args.filter((arg) => arg.startsWith(`${name}=`));
    assert.deepEqual(entries, [`${name}=${proxyUrl}`], `${name} is the proxy and nothing overrides it`);
  }
  assert.ok(args.includes('NO_PROXY=') && args.includes('no_proxy='));
  assert.equal(valueAfter(args, '--network'), 'internal-net-x');

  for (const bad of [{ env: { 'BAD-NAME': 'x' } }, { publicEnv: { '1X': 'x' } }]) {
    assert.throws(() => sandbox.buildRunArgs({ ...spec, ...bad }, env), /invalid sandbox env name/);
  }

  const { calls } = mockProcesses(t);
  const result = sandbox.runInSandboxSync(spec);
  assert.equal(result.status, 0);
  const run = calls.find((call) => call.args[0] === 'run');
  assert.equal(run.command, 'docker');
  assert.equal(run.options.env.FAKE_SECRET_NAME, 'fake-secret-value', 'the CLI reads the secret from its own env');
  assert.equal(run.options.env.FAKE_PUBLIC_NAME, undefined, 'public settings do not change the CLI env');
  assert.equal(run.options.env.HTTPS_PROXY, process.env.HTTPS_PROXY, 'the proxy address does not change the CLI env');
  assert.ok(!run.args.some((arg) => arg.includes('fake-secret-value')));
  assert.equal(process.env.FAKE_SECRET_NAME, undefined);
});

test('preserves reference sandbox protections', (t) => {
  const { env } = useHome(t);
  const dir = scratch(t);
  const clone = makeClone(dir);
  const args = sandbox.buildRunArgs(
    { ...BOX, runLabel: 'issue-506', runDir: clone, user: { uid: 1000, gid: 1001 }, interactive: true, command: ['node', '-e', '1'] },
    env,
  );
  assert.deepEqual(args.slice(0, 3), ['run', '--rm', '-i']);
  assert.ok(args.includes('--init'));
  assert.equal(valueAfter(args, '--user'), '1000:1001');
  assert.deepEqual(labelsOf(args), [`${sandbox.LABEL_MANAGED}=testkey`, `${sandbox.LABEL_RUN}=issue-506`]);
  assert.deepEqual(args.slice(-4), [NEUTRAL.image, 'node', '-e', '1']);
  assert.ok(!args.includes('host') && !args.includes('--pid') && !args.includes('--privileged'));
  const named = sandbox.buildRunArgs({ ...BOX, runDir: clone, command: ['true'] }, env);
  const other = sandbox.buildRunArgs({ ...BOX, runDir: clone, command: ['true'] }, env);
  assert.notEqual(valueAfter(named, '--name'), valueAfter(other, '--name'), 'container names are unique');
  assert.ok(!sandbox.buildRunArgs({ ...BOX, runDir: clone, command: ['true'] }, env).includes('--user'));

  // No runtime, no fallback: the error says so and nothing but the Docker CLI is started.
  const { calls } = mockProcesses(t, () => ({ status: null, error: Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' }) }));
  assert.throws(() => sandbox.assertAvailable(), /Docker is not available.*ENOENT/);
  assert.throws(() => sandbox.buildImage(sandbox.validateSandboxConfig(NEUTRAL)), /Building the sandbox image neutral-sandbox:test failed.*BuildKit/);
  const result = sandbox.runInSandboxSync({ ...BOX, runDir: clone, command: ['echo', 'host-fallback'] });
  assert.equal(result.status, null);
  assert.equal(/** @type {any} */ (result.error).code, 'ENOENT');
  assert.ok(calls.length >= 3 && calls.every((call) => call.command === 'docker'), 'no command ran on the host');
  assert.ok(!calls.some((call) => call.command === 'echo'));

  assert.throws(() => sandbox.startProxy({ ...BOX, allowedHosts: NEUTRAL.allowedHosts }), /Starting the sandbox proxy failed/);
});

test('builds image from installed package assets', (t) => {
  const previous = process.cwd();
  t.after(() => process.chdir(previous));
  const config = sandbox.validateSandboxConfig(NEUTRAL);
  const consumerA = scratch(t);
  const consumerB = scratch(t);
  const contextDir = path.join(__dirname, 'sandbox');

  const args = sandbox.buildImageArgs(config);
  assert.equal(args[0], 'build');
  assert.equal(args[args.length - 1], contextDir);
  assert.equal(sandbox.IMAGE_CONTEXT_DIR, contextDir);
  assert.ok(args.includes(`ralph=${__dirname}`), 'the named context is the package directory with sandbox.js');
  assert.ok(args.includes(`NODE_VERSION=${NEUTRAL.nodeVersion}`) && args.includes(`CLAUDE_CODE_VERSION=${NEUTRAL.claudeCodeVersion}`));
  assert.equal(valueAfter(args, '-t'), NEUTRAL.image);
  for (const file of [path.join(contextDir, 'Dockerfile'), path.join(contextDir, 'proxy.js'), path.join(__dirname, 'sandbox.js')]) {
    assert.ok(fs.existsSync(file), file);
  }

  // The consumer's location changes nothing.
  for (const consumer of [consumerA, consumerB]) {
    process.chdir(consumer);
    const built = sandbox.buildImageArgs(config);
    assert.deepEqual(built, args);
    assert.ok(!built.some((arg) => arg.includes(consumer)));
  }

  const { calls } = mockProcesses(t);
  sandbox.buildImage(config, { stdio: 'ignore' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args, args);
});

// --- cleanup ---

test('cleans up owned resources after failure', (t) => {
  const keyA = sandbox.rootKeyFor(path.join(os.tmpdir(), 'consumer-a'));
  const keyB = sandbox.rootKeyFor(path.join(os.tmpdir(), 'consumer-b'));
  assert.notEqual(keyA, keyB);
  const idsByKey = { [keyA]: { ps: 'a-container-1\r\na-container-2\n', network: 'a-network\n' }, [keyB]: { ps: 'b-container\n', network: '\n' } };
  const timeout = Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
  let isTimingOut = false;
  const { calls, children } = mockProcesses(t, (_command, args) => {
    if (isTimingOut && args[0] === 'run') return { status: null, error: timeout };
    const filter = args.find((arg) => String(arg).startsWith(`label=${sandbox.LABEL_MANAGED}=`));
    const ids = filter ? idsByKey[filter.split('=')[2]] : undefined;
    if (args[0] === 'ps') return { stdout: ids.ps };
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: ids.network };
    return undefined;
  });

  // Leftovers: only what carries the consumer's own label, nothing else is named.
  assert.deepEqual(sandbox.removeLeftovers(keyA), { containers: 2, networks: 1 });
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2).join(' ')), ['ps -aq', 'rm -f', 'network ls', 'network rm']);
  assert.ok(calls.every((call) => call.command === 'docker'));
  assert.deepEqual(calls[1].args, ['rm', '-f', 'a-container-1', 'a-container-2']);
  assert.deepEqual(calls[3].args, ['network', 'rm', 'a-network']);
  assert.ok(!JSON.stringify(calls).includes(keyB) && !JSON.stringify(calls).includes('b-container'));
  calls.length = 0;
  assert.deepEqual(sandbox.removeLeftovers(keyB), { containers: 1, networks: 0 });
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2).join(' ')), ['ps -aq', 'rm -f', 'network ls']);
  assert.ok(!JSON.stringify(calls).includes(keyA) && !JSON.stringify(calls).includes('a-container'));
  calls.length = 0;

  // A sync step that fails or times out: the container is removed and the command never runs on the host.
  useHome(t);
  const dir = scratch(t);
  const spec = { ...BOX, rootKey: keyA, runDir: makeClone(dir), command: ['sleep', '300'] };
  isTimingOut = true;
  const result = sandbox.runInSandboxSync(spec, { timeoutMs: 3000 });
  assert.equal(result.error, timeout);
  assert.notEqual(result.status, 0);
  assert.equal(calls[0].options.timeout, 3000);
  assert.deepEqual(removalsOf(calls), [result.name]);
  assert.ok(calls.every((call) => call.command === 'docker'));
  assert.ok(!calls.some((call) => call.command === 'sleep'));
  calls.length = 0;

  // An async step: the container is removed whether the CLI closes or fails to start.
  const first = sandbox.spawnInSandbox({ ...spec, command: ['true'] });
  const second = sandbox.spawnInSandbox({ ...spec, command: ['true'] });
  const third = sandbox.spawnInSandbox({ ...spec, command: ['true'] });
  assert.equal(calls.length, 3);
  children[0].emit('close', 1);
  children[1].emit('error', new Error('spawn docker ENOENT'));
  assert.deepEqual(removalsOf(calls.slice(3)), [first.name, second.name]);

  // The controller exits: whatever is still up is removed, once.
  calls.length = 0;
  sandbox.stopAll();
  assert.deepEqual(removalsOf(calls), [third.name]);
  calls.length = 0;
  sandbox.stopAll();
  assert.deepEqual(calls, []);
  assert.ok(calls.every((call) => call.command === 'docker'));
});

test('cleans up the proxy when it fails to start', (t) => {
  for (const failing of ['network create', 'run', 'network connect']) {
    const { calls } = mockProcesses(t, (_command, args) =>
      args.slice(0, 2).join(' ').startsWith(failing) || (failing === 'run' && args[0] === 'run')
        ? { status: 1, stderr: `${failing} failed` }
        : undefined,
    );
    assert.throws(
      () => sandbox.startProxy({ image: NEUTRAL.image, rootKey: 'k', runLabel: 'issue-1', allowedHosts: NEUTRAL.allowedHosts }),
      new RegExp(`Starting the sandbox proxy failed: ${failing} failed`),
      failing,
    );
    const removed = calls.filter((call) => call.args[0] === 'rm' || (call.args[0] === 'network' && call.args[1] === 'rm'));
    assert.equal(removed.length, 2, `${failing}: the proxy container and its network are removed`);
    assert.ok(calls.every((call) => call.command === 'docker'));
    t.mock.restoreAll();
  }
});
