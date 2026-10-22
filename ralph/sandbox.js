'use strict';

// Docker sandbox for everything that runs agent-written or agent-influenced code: the `claude`
// agent itself, dependency installs and the final project gate. The only module that calls the
// Docker CLI. Project-independent on purpose: the image tag, versions, allowed hosts and install
// env come from the `sandbox` section of the project profile, the runs root from the consumer's
// local run config.
//
// Requiring this module has no side effects and it uses Node built-ins only: sandbox/proxy.js
// loads it inside the image for the same proxy decision the host tests cover. It does not read
// the profile and does not import the profile loader, the agent, the workspace or the boundary.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DOCKER = 'docker';

// Paths inside the container. The run dir clone is the working tree, the per-call session dir is
// CLAUDE_CONFIG_DIR (claude's config and its .jsonl session journals), HOME is a 1777 directory
// baked into the image, so no other mount is needed for it.
const CONTAINER_WORKDIR = '/workspace';
const CONTAINER_SESSIONS_DIR = '/ralph-claude';
const CONTAINER_HOME = '/home/sandbox';

const PROXY_PORT = 3128;
const HTTPS_PORT = 443;
const PROXY_ALLOWED_HOSTS_ENV = 'RALPH_PROXY_ALLOWED_HOSTS';
const PROXY_SCRIPT = '/opt/ralph/sandbox/proxy.js';
const PROXY_READY_LINE = 'ralph-proxy listening';
const PROXY_READY_TIMEOUT_MS = 20000;

// Every container and network Ralph creates carries both labels: `managed` scopes cleanup to the
// consumer that started it (another consumer's Ralph keeps its containers), `run` names the issue.
const LABEL_MANAGED = 'ralph.managed';
const LABEL_RUN = 'ralph.run';

// The build context and the sandbox.js named context are files of the installed package, never
// of the consumer's checkout or of a run clone.
const IMAGE_CONTEXT_DIR = path.join(__dirname, 'sandbox');
const DEFAULT_RUNS_ROOT = '.ralph-runs';

const SPAWN_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

// --- operator home ---

// Symlinks and junctions resolved for the part of the path that exists: a runs root such as
// `/data/runs` that links into the home directory is the home directory for Docker.
function realpathOfExisting(target) {
  const resolved = path.resolve(target);
  const missing = [];
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    missing.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...missing);
  } catch {
    return resolved;
  }
}

const homeDirsOf = (env) => {
  const candidates = [env.HOME, env.USERPROFILE, os.homedir()].filter((dir) => typeof dir === 'string' && dir !== '');
  return [...new Set(candidates.flatMap((dir) => [path.resolve(dir), realpathOfExisting(dir)]))];
};

const normalizeForCompare = (p, platform) => (platform === 'win32' ? p.toLowerCase() : p);

const isSameOrInside = (parent, child) => {
  const relative = path.relative(parent, child);
  const isOutside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return !isOutside;
};

// True when `target` is an operator home directory or lies inside one, before or after resolving
// links. The single rule for both mounts (nothing under HOME ever reaches a container) and the runs
// root: a narrower "only HOME itself" rule would let `~/.ssh` or `~/.config` be mounted.
function isInsideHome(target, env = process.env, platform = process.platform) {
  const targets = [path.resolve(target), realpathOfExisting(target)].map((p) => normalizeForCompare(p, platform));
  return homeDirsOf(env).some((home) => {
    const normalizedHome = normalizeForCompare(home, platform);
    return targets.some((candidate) => isSameOrInside(normalizedHome, candidate));
  });
}

// --- allowed hosts and the proxy decision ---

const HOST_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

// A plain DNS name with at least two labels: no scheme, port, path, IP literal or wildcard.
function isAllowedHostName(entry) {
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > 253) return false;
  if (net.isIP(entry) !== 0) return false;
  const labels = entry.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => HOST_LABEL_RE.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

// `host:port` or `[v6]:port` from a CONNECT request line; null when it is not that shape.
function parseAuthority(authority) {
  if (typeof authority !== 'string') return null;
  const match = /^(?:\[([^\]]+)\]|([^:[\]/]+)):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  return { host: match[1] || match[2], port: Number(match[3]) };
}

// Only CONNECT to port 443 of a host that equals an allowlist entry (case-insensitively);
// subdomains, IP addresses, other ports and other methods are refused. Pure: opens no socket.
function decideProxyRequest({ method, host, port }, allowedHosts) {
  if (method !== 'CONNECT') return { allow: false, reason: 'method not allowed' };
  if (port !== HTTPS_PORT) return { allow: false, reason: 'port not allowed' };
  if (typeof host !== 'string' || !isAllowedHostName(host)) return { allow: false, reason: 'not a host name' };
  const wanted = host.toLowerCase();
  const isListed = allowedHosts.some((allowed) => allowed.toLowerCase() === wanted);
  return isListed ? { allow: true, reason: 'allowlisted' } : { allow: false, reason: 'host not allowlisted' };
}

const parseAllowedHostsEnv = (value) => String(value || '').split(',').filter((host) => host !== '');

// --- config (`sandbox` section of the project profile) ---

// An explicit tag is required: an untagged image would silently mean `latest`.
const IMAGE_TAG_RE = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]{1,128}$/;
const NODE_VERSION_RE = /^\d+(\.\d+){0,2}$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Install env names the runtime owns: proxy settings, the Docker CLI, git/credential isolation
// and the container's home/config dirs.
const RESERVED_INSTALL_ENV_RE = /^(https?_proxy|no_proxy|all_proxy|docker_.*|git_.*|gcm_.*|gh_.*|home|claude_config_dir)$/i;
const SANDBOX_FIELDS = ['image', 'nodeVersion', 'claudeCodeVersion', 'allowedHosts', 'installEnv'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Every problem of a `sandbox` section as `{ path, message }`, where `path` is the full dotted
 * path of the offending field under `basePath`. The single rule set: the profile loader and the
 * runtime both use it, so the two cannot disagree.
 * @param {unknown} sandbox
 * @param {string} [basePath]
 * @returns {{ path: string, message: string }[]}
 */
function collectSandboxProblems(sandbox, basePath = 'sandbox') {
  if (!isPlainObject(sandbox)) {
    return [{ path: basePath, message: 'is missing or not an object: the agent sandbox needs image, nodeVersion, claudeCodeVersion and allowedHosts' }];
  }
  const section = /** @type {Record<string, any>} */ (sandbox);
  const problems = [];
  const add = (field, message) => problems.push({ path: `${basePath}.${field}`, message });
  for (const name of Object.keys(section)) {
    if (!SANDBOX_FIELDS.includes(name)) add(name, 'unknown field');
  }
  if (typeof section.image !== 'string' || !IMAGE_TAG_RE.test(section.image)) {
    add('image', 'must be a Docker image name with an explicit tag (name:tag)');
  }
  if (typeof section.nodeVersion !== 'string' || !NODE_VERSION_RE.test(section.nodeVersion)) {
    add('nodeVersion', 'must be a numeric version such as "22", "22.1" or "22.1.2"');
  }
  if (typeof section.claudeCodeVersion !== 'string' || !EXACT_VERSION_RE.test(section.claudeCodeVersion)) {
    add('claudeCodeVersion', 'must be an exact X.Y.Z version (no range, tag or pre-release)');
  }
  if (!Array.isArray(section.allowedHosts) || section.allowedHosts.length === 0) {
    add('allowedHosts', 'must be a non-empty array of host names');
  } else {
    section.allowedHosts.forEach((entry, index) => {
      if (!isAllowedHostName(entry)) add(`allowedHosts[${index}]`, `entry is not a host name: ${JSON.stringify(entry)}`);
    });
  }
  if (section.installEnv !== undefined) {
    if (!isPlainObject(section.installEnv)) {
      add('installEnv', 'must be an object of string values');
    } else {
      for (const [name, value] of Object.entries(section.installEnv)) {
        if (!ENV_NAME_RE.test(name)) add(`installEnv.${name}`, `entry is invalid: ${JSON.stringify(name)} is not an environment variable name`);
        else if (typeof value !== 'string') add(`installEnv.${name}`, 'entry is invalid: the value must be a string');
        else if (RESERVED_INSTALL_ENV_RE.test(name)) {
          add(`installEnv.${name}`, `installEnv may not set ${name} (proxy, Docker, git isolation and home settings belong to the runtime)`);
        }
      }
    }
  }
  return problems;
}

/**
 * Validates a profile `sandbox` section and returns the normalized, frozen runtime config.
 * A missing `installEnv` becomes `{}` here only; the profile itself is never rewritten.
 * @param {unknown} sandbox
 */
function validateSandboxConfig(sandbox) {
  const problems = collectSandboxProblems(sandbox);
  if (problems.length > 0) {
    throw new Error(`Invalid sandbox config:\n${problems.map((p) => `- ${p.path}: ${p.message}`).join('\n')}`);
  }
  const section = /** @type {Record<string, any>} */ (sandbox);
  return Object.freeze({
    image: section.image,
    nodeVersion: section.nodeVersion,
    claudeCodeVersion: section.claudeCodeVersion,
    allowedHosts: Object.freeze([...section.allowedHosts]),
    installEnv: Object.freeze({ ...(section.installEnv || {}) }),
  });
}

// --- runs root (local run config, outside Git) ---

/**
 * Clones and session journals live under this root, so it is mounted into containers and must
 * pass the same home rule as any mount. `localRunOptions.runsRoot` is optional: absent means
 * `<consumerRoot>/.ralph-runs`; a given path is absolute or relative to `consumerRoot`. State is
 * never placed in the installed package.
 * @param {any} localRunOptions
 * @param {string} consumerRoot
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveRunsRoot(localRunOptions, consumerRoot, env = process.env) {
  if (typeof consumerRoot !== 'string' || consumerRoot === '') throw new TypeError('resolveRunsRoot: consumerRoot must be a non-empty string');
  if (localRunOptions !== undefined && localRunOptions !== null && !isPlainObject(localRunOptions)) {
    throw new TypeError('resolveRunsRoot: the local run options must be an object');
  }
  const configured = localRunOptions ? localRunOptions.runsRoot : undefined;
  if (configured !== undefined && (typeof configured !== 'string' || configured.trim() === '')) {
    throw new Error('runsRoot must be a non-empty path string');
  }
  const root = path.resolve(consumerRoot, configured === undefined ? DEFAULT_RUNS_ROOT : String(configured));
  if (isInsideHome(root, env)) {
    throw new Error(
      `runsRoot ${root} is inside the operator's home directory, which is never mounted into the sandbox. ` +
        'Set runsRoot in the local run config to a directory outside the home directory.',
    );
  }
  return root;
}

const rootKeyFor = (consumerRoot) =>
  crypto.createHash('sha256').update(normalizeForCompare(path.resolve(consumerRoot), process.platform)).digest('hex').slice(0, 12);

// --- image ---

// The build context is the package's own sandbox/ directory, never a run clone or the consumer
// checkout; sandbox.js itself reaches the image through a second named context, so proxy.js can
// require it there too.
function buildImageArgs(sandboxConfig, contextDir = IMAGE_CONTEXT_DIR) {
  return [
    'build',
    '-t',
    sandboxConfig.image,
    '--build-arg',
    `NODE_VERSION=${sandboxConfig.nodeVersion}`,
    '--build-arg',
    `CLAUDE_CODE_VERSION=${sandboxConfig.claudeCodeVersion}`,
    '--build-context',
    `ralph=${path.dirname(contextDir)}`,
    contextDir,
  ];
}

// Runs on the host network: the image is the package's own artifact, built from its own files.
/**
 * @param {{ image: string, nodeVersion: string, claudeCodeVersion: string }} sandboxConfig
 * @param {{ docker?: string, stdio?: any }} [options]
 */
function buildImage(sandboxConfig, { docker = DOCKER, stdio = 'inherit' } = {}) {
  const result = childProcess.spawnSync(docker, buildImageArgs(sandboxConfig), { stdio, encoding: 'utf8', maxBuffer: SPAWN_MAX_BUFFER_BYTES });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `exit ${result.status}`;
    throw new Error(`Building the sandbox image ${sandboxConfig.image} failed (${detail}); the build needs BuildKit (docker buildx) for --build-context`);
  }
}

// --- runtime availability and leftovers ---

// There is no host fallback: without a Docker engine the caller gets this error and nothing runs.
function assertAvailable({ docker = DOCKER } = {}) {
  const result = childProcess.spawnSync(docker, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : String(result.stderr || '').trim() || `exit ${result.status}`;
    throw new Error(`Docker is not available, the Ralph sandbox needs a running Docker engine: ${detail}`);
  }
  return String(result.stdout).trim();
}

const listIds = (docker, args) =>
  String(childProcess.spawnSync(docker, args, { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

// Containers and networks a killed controller of this consumer left behind. Nothing without this
// consumer's `managed` label is touched.
function removeLeftovers(rootKey, { docker = DOCKER } = {}) {
  const filter = `label=${LABEL_MANAGED}=${rootKey}`;
  const containers = listIds(docker, ['ps', '-aq', '--filter', filter]);
  if (containers.length > 0) childProcess.spawnSync(docker, ['rm', '-f', ...containers], { stdio: 'ignore' });
  const networks = listIds(docker, ['network', 'ls', '-q', '--filter', filter]);
  if (networks.length > 0) childProcess.spawnSync(docker, ['network', 'rm', ...networks], { stdio: 'ignore' });
  return { containers: containers.length, networks: networks.length };
}

// --- run spec -> `docker run` arguments ---

let nameSeq = 0;
const uniqueName = (prefix, runLabel) => {
  nameSeq++;
  return `${prefix}-${runLabel}-${process.pid}-${nameSeq}-${crypto.randomBytes(3).toString('hex')}`;
};

// POSIX: files the container writes into the bind mount belong to the controller's user. Docker
// Desktop on Windows maps bind-mount ownership itself, and there is no uid to pass.
const hostUser = () => (typeof process.getuid === 'function' ? { uid: process.getuid(), gid: process.getgid() } : null);

const proxyEnvFor = (proxyUrl) => ({
  HTTPS_PROXY: proxyUrl,
  https_proxy: proxyUrl,
  HTTP_PROXY: proxyUrl,
  http_proxy: proxyUrl,
  NO_PROXY: '',
  no_proxy: '',
});

function assertMountable(hostPath, env) {
  if (typeof hostPath !== 'string' || hostPath === '') throw new Error('sandbox mount path is empty');
  if (/[,"\n]/.test(hostPath)) throw new Error(`sandbox mount path contains an unsupported character: ${hostPath}`);
  if (isInsideHome(hostPath, env)) throw new Error(`sandbox refuses to mount the operator's home directory or a path inside it: ${hostPath}`);
}

const bindMount = (source, target, readonly = false) => [
  '--mount',
  `type=bind,source=${path.resolve(source)},target=${target}${readonly ? ',readonly' : ''}`,
];

// The clone's own `.git`, as a real directory (never a link the run could have planted) that passes
// the same mount rule as the clone.
function gitDirMount(runDir, homeEnv) {
  const gitDir = path.join(runDir, '.git');
  const stat = fs.lstatSync(gitDir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`sandbox refuses to mount ${gitDir}: not a real directory`);
  assertMountable(gitDir, homeEnv);
  return bindMount(gitDir, `${CONTAINER_WORKDIR}/.git`, true);
}

// spec: { image, rootKey, runLabel, runDir, sessionsDir?, workdir?, network ('none' | a network
// name), proxyUrl?, env? (secret name -> value), publicEnv? (name -> value), readOnlyGit?, user?,
// command: [cmd, ...args], interactive?, name? }. The spec is trusted input of the caller (the
// controller); it is never read from a working clone. Only runDir and sessionsDir are mounted;
// `readOnlyGit` lays the clone's own `.git` over itself read-only, so nothing in the container can
// plant hooks, fsmonitor or other config that the host-side git would later run. Whether a call
// must use it, and which network, is the caller's policy, not this module's.
// Secret values never appear in argv: `-e NAME` makes the Docker CLI read them from its own process
// env (see spawnEnvFor). Everything else (`publicEnv` and the proxy address) goes as
// `-e NAME=value`, so it never changes the CLI's own env (its HOME/config, a tcp:// DOCKER_HOST
// dialled through a proxy). The proxy values come last and win.
function buildRunArgs(spec, homeEnv = process.env) {
  assertMountable(spec.runDir, homeEnv);
  if (spec.sessionsDir) assertMountable(spec.sessionsDir, homeEnv);
  if (!Array.isArray(spec.command) || spec.command.length === 0) throw new Error('sandbox command is empty');
  const env = spec.env || {};
  const publicEnv = spec.publicEnv || {};
  const proxyEnv = spec.proxyUrl ? proxyEnvFor(spec.proxyUrl) : {};
  for (const name of [...Object.keys(env), ...Object.keys(publicEnv), ...Object.keys(proxyEnv)]) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid sandbox env name: ${name}`);
  }
  const user = spec.user === undefined ? hostUser() : spec.user;
  const workdir = path.posix.join(CONTAINER_WORKDIR, (spec.workdir || '').replace(/\\/g, '/'));
  const isInRunDir = workdir === CONTAINER_WORKDIR || workdir.startsWith(`${CONTAINER_WORKDIR}/`);
  if (!isInRunDir) throw new Error(`sandbox workdir escapes the run dir: ${spec.workdir}`);
  const gitMount = spec.readOnlyGit ? gitDirMount(spec.runDir, homeEnv) : [];
  return [
    'run',
    '--rm',
    ...(spec.interactive ? ['-i'] : []),
    '--init',
    '--name',
    spec.name || uniqueName('ralph', spec.runLabel),
    '--label',
    `${LABEL_MANAGED}=${spec.rootKey}`,
    '--label',
    `${LABEL_RUN}=${spec.runLabel}`,
    '--network',
    spec.network,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(user ? ['--user', `${user.uid}:${user.gid}`] : []),
    ...bindMount(spec.runDir, CONTAINER_WORKDIR),
    ...gitMount,
    ...(spec.sessionsDir ? bindMount(spec.sessionsDir, CONTAINER_SESSIONS_DIR) : []),
    '-w',
    workdir,
    ...Object.keys(env).flatMap((name) => ['-e', name]),
    ...Object.entries({ ...publicEnv, ...proxyEnv }).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    spec.image,
    ...spec.command,
  ];
}

// The Docker CLI is the controller's own tool and gets the controller's env (DOCKER_HOST, its
// config dir) plus only the secret values of `spec.env`, which it hands to the container by name.
const spawnEnvFor = (spec) => ({ ...process.env, ...(spec.env || {}) });

const nameFromArgs = (args) => args[args.indexOf('--name') + 1];

// --- running containers ---

// Containers and proxies of this process that are still up, so an exit or Ctrl-C can remove all of
// them (not only the most recent one).
const activeContainers = new Set();
const activeProxies = new Map();
let dockerForCleanup = DOCKER;

function stopContainer(name, { docker = DOCKER } = {}) {
  childProcess.spawnSync(docker, ['rm', '-f', name], { stdio: 'ignore' });
  activeContainers.delete(name);
}

// Async run for long, streamed work (the agent). Returns the docker CLI child and the container
// name; the container is force-removed when the CLI exits, whatever the reason.
function spawnInSandbox(spec, { docker = DOCKER } = {}) {
  const args = buildRunArgs(spec);
  const name = nameFromArgs(args);
  dockerForCleanup = docker;
  activeContainers.add(name);
  const child = childProcess.spawn(docker, args, { env: spawnEnvFor(spec), stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('close', () => stopContainer(name, { docker }));
  child.on('error', () => stopContainer(name, { docker }));
  return { child, name, stop: () => stopContainer(name, { docker }) };
}

// Sync run for the gate and installs: { status, stdout, stderr, error, name }.
/**
 * @param {any} spec
 * @param {{ docker?: string, timeoutMs?: number }} [options]
 */
function runInSandboxSync(spec, { docker = DOCKER, timeoutMs } = {}) {
  const args = buildRunArgs(spec);
  const name = nameFromArgs(args);
  dockerForCleanup = docker;
  activeContainers.add(name);
  try {
    const result = childProcess.spawnSync(docker, args, {
      env: spawnEnvFor(spec),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: SPAWN_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error || null, name };
  } finally {
    stopContainer(name, { docker });
  }
}

// --- egress proxy ---

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function stopProxy(proxy, { docker = DOCKER } = {}) {
  childProcess.spawnSync(docker, ['rm', '-f', proxy.name], { stdio: 'ignore' });
  childProcess.spawnSync(docker, ['network', 'rm', proxy.network], { stdio: 'ignore' });
  activeProxies.delete(proxy.name);
}

// An internal network (no route out) for the agent/install containers, plus a proxy container on
// that network and on the default bridge. The proxy is the only way out.
function startProxy({ image, rootKey, runLabel, allowedHosts }, { docker = DOCKER } = {}) {
  const network = uniqueName('ralph-net', runLabel);
  const name = uniqueName('ralph-proxy', runLabel);
  const labels = ['--label', `${LABEL_MANAGED}=${rootKey}`, '--label', `${LABEL_RUN}=${runLabel}`];
  const proxy = { name, network, proxyUrl: `http://${name}:${PROXY_PORT}` };
  dockerForCleanup = docker;
  activeProxies.set(name, proxy);
  const fail = (message) => {
    stopProxy(proxy, { docker });
    throw new Error(`Starting the sandbox proxy failed: ${message}`);
  };
  const create = childProcess.spawnSync(docker, ['network', 'create', '--internal', ...labels, network], { encoding: 'utf8' });
  if (create.error || create.status !== 0) fail(String(create.stderr || create.error || '').trim());
  const run = childProcess.spawnSync(
    docker,
    [
      'run', '-d', '--rm', '--init', '--name', name, ...labels,
      '--network', 'bridge', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-e', PROXY_ALLOWED_HOSTS_ENV, image, 'node', PROXY_SCRIPT,
    ],
    { encoding: 'utf8', env: { ...process.env, [PROXY_ALLOWED_HOSTS_ENV]: allowedHosts.join(',') } },
  );
  if (run.error || run.status !== 0) fail(String(run.stderr || run.error || '').trim());
  const connect = childProcess.spawnSync(docker, ['network', 'connect', network, name], { encoding: 'utf8' });
  if (connect.error || connect.status !== 0) fail(String(connect.stderr || connect.error || '').trim());
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = childProcess.spawnSync(docker, ['logs', name], { encoding: 'utf8' });
    if (String(logs.stdout || '').includes(PROXY_READY_LINE)) return { ...proxy, stop: () => stopProxy(proxy, { docker }) };
    sleepSync(200);
  }
  return fail('the proxy did not report readiness in time');
}

// --- controller exit ---

function stopAll() {
  for (const name of [...activeContainers]) stopContainer(name, { docker: dockerForCleanup });
  for (const proxy of [...activeProxies.values()]) stopProxy(proxy, { docker: dockerForCleanup });
}

// Node skips 'exit' listeners when a signal kills it, so Ctrl-C/SIGTERM are turned into a regular
// exit after the sandbox is cleaned up. process.exit() still runs the other 'exit' listeners.
// Idempotent; installed only by an explicit call, never on require.
const EXIT_CODE_BY_SIGNAL = { SIGINT: 130, SIGTERM: 143 };
let exitHandlersInstalled = false;

function installExitHandlers() {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  for (const signal of Object.keys(EXIT_CODE_BY_SIGNAL)) {
    process.once(signal, () => {
      stopAll();
      process.exit(EXIT_CODE_BY_SIGNAL[signal]);
    });
  }
  process.on('exit', stopAll);
}

module.exports = {
  CONTAINER_WORKDIR,
  CONTAINER_SESSIONS_DIR,
  CONTAINER_HOME,
  PROXY_PORT,
  PROXY_ALLOWED_HOSTS_ENV,
  PROXY_READY_LINE,
  LABEL_MANAGED,
  LABEL_RUN,
  IMAGE_CONTEXT_DIR,
  DEFAULT_RUNS_ROOT,
  isInsideHome,
  isAllowedHostName,
  parseAuthority,
  decideProxyRequest,
  parseAllowedHostsEnv,
  collectSandboxProblems,
  validateSandboxConfig,
  resolveRunsRoot,
  rootKeyFor,
  buildImageArgs,
  buildImage,
  assertAvailable,
  removeLeftovers,
  hostUser,
  buildRunArgs,
  spawnInSandbox,
  runInSandboxSync,
  stopContainer,
  startProxy,
  stopProxy,
  stopAll,
  installExitHandlers,
};
