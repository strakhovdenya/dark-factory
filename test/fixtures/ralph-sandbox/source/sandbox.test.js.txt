const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('./sandbox');
const { CREDENTIAL_ISOLATION_ENV } = require('./boundary');

// Integration tests run against a real Docker engine and never skip (TR-1): without Docker the
// image build in before() throws and every test below fails.
const SANDBOX_CONFIG = sandbox.validateSandboxConfig(require('./config.example.json').sandbox);
const BOX = { image: SANDBOX_CONFIG.image, rootKey: `test${crypto.randomBytes(4).toString('hex')}`, runLabel: 'issue-test' };

// Mounted dirs must be outside the operator's home (INV-10); on Windows os.tmpdir() is inside it.
const SCRATCH_FALLBACK = path.join(__dirname, '..', '..', '.ralph-sandbox-tmp');
const scratchDir = () => {
  const root = [os.tmpdir(), SCRATCH_FALLBACK].find((dir) => !sandbox.isInsideHome(dir));
  assert.ok(root, 'no scratch directory outside the operator home');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'ralph-sbx-'));
};

const withScratch = async (fn) => {
  const dir = scratchDir();
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const runIn = (runDir, script, extra = {}) =>
  sandbox.runInSandboxSync({ ...BOX, runDir, network: 'none', command: ['node', '-e', script], ...extra });

const runJson = (runDir, script, extra) => {
  const result = runIn(runDir, script, extra);
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
};

const containersWithLabel = (label) =>
  String(spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8' }).stdout || '').trim();

test.before(() => {
  sandbox.assertAvailable();
  sandbox.buildImage(SANDBOX_CONFIG, { stdio: 'ignore' });
});

test.after(() => {
  sandbox.removeLeftovers(BOX.rootKey);
});

// --- isolation from the operator ---

test('sandbox does not see operator HOME marker', async () => {
  const markerName = `.ralph-home-marker-${crypto.randomBytes(4).toString('hex')}`;
  const markerPath = path.join(os.homedir(), markerName);
  fs.writeFileSync(markerPath, 'operator secret\n');
  try {
    await withScratch((dir) => {
      const script = [
        "const fs = require('fs');",
        `const name = ${JSON.stringify(markerName)};`,
        `const hostPath = ${JSON.stringify(markerPath.replace(/\\/g, '/'))};`,
        'console.log(JSON.stringify({ inHome: fs.existsSync(process.env.HOME + "/" + name), atHostPath: fs.existsSync(hostPath) }));',
      ].join('\n');
      assert.deepStrictEqual(runJson(dir, script), { inHome: false, atHostPath: false });
      const found = sandbox.runInSandboxSync({
        ...BOX,
        runDir: dir,
        network: 'none',
        command: ['sh', '-c', `find / \\( -path /proc -o -path /sys \\) -prune -o -name '${markerName}' -print 2>/dev/null; true`],
      });
      assert.strictEqual(found.stdout.trim(), '');
    });
  } finally {
    fs.rmSync(markerPath, { force: true });
  }
});

test('rejects sandbox config mounting operator home', () => {
  const home = os.homedir();
  const spec = (overrides) => ({ ...BOX, runDir: scratchDirPath(), network: 'none', command: ['true'], ...overrides });
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: home })), /home directory/);
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(home, 'projects', '.ralph-runs', 'issue-1') })), /home directory/);
  assert.throws(() => sandbox.buildRunArgs(spec({ sessionsDir: path.join(home, '.claude') })), /home directory/);
  const otherHome = path.join(scratchDirPath(), 'other-home');
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(otherHome, 'x') }), { HOME: otherHome }), /home directory/);
  assert.throws(() => sandbox.buildRunArgs(spec({ runDir: path.join(otherHome, 'x') }), { USERPROFILE: otherHome }), /home directory/);
  assert.strictEqual(sandbox.isInsideHome(home), true);
  assert.strictEqual(sandbox.isInsideHome(path.join(home, '.ssh')), true);
});

// A path outside home without creating it (only args are built).
function scratchDirPath() {
  const root = [os.tmpdir(), SCRATCH_FALLBACK].find((dir) => !sandbox.isInsideHome(dir));
  assert.ok(root, 'no scratch directory outside the operator home');
  return path.join(root, 'ralph-sbx-args');
}

test('accepts sandbox config mounting only run dir', async () => {
  const runDir = path.join(scratchDirPath(), 'issue-1');
  const sessionsDir = path.join(scratchDirPath(), 'issue-1-sessions', '01-implement');
  const mountsOf = (args) => args.flatMap((arg, index) => (args[index - 1] === '--mount' ? [arg] : []));
  // The only extra mount allowed: the clone's own .git laid over itself read-only.
  await withScratch((clone) => {
    execFileSync('git', ['init', '-q'], { cwd: clone });
    const args = sandbox.buildRunArgs({ ...BOX, runDir: clone, sessionsDir, readOnlyGit: true, network: 'none', command: ['true'] });
    assert.deepStrictEqual(mountsOf(args), [
      `type=bind,source=${path.resolve(clone)},target=${sandbox.CONTAINER_WORKDIR}`,
      `type=bind,source=${path.resolve(clone, '.git')},target=${sandbox.CONTAINER_WORKDIR}/.git,readonly`,
      `type=bind,source=${path.resolve(sessionsDir)},target=${sandbox.CONTAINER_SESSIONS_DIR}`,
    ]);
  });
  const onlyRun = sandbox.buildRunArgs({ ...BOX, runDir, network: 'none', command: ['true'] });
  assert.deepStrictEqual(mountsOf(onlyRun), [`type=bind,source=${path.resolve(runDir)},target=${sandbox.CONTAINER_WORKDIR}`]);
  const withJournals = sandbox.buildRunArgs({ ...BOX, runDir, sessionsDir, network: 'none', command: ['true'] });
  assert.deepStrictEqual(mountsOf(withJournals), [
    `type=bind,source=${path.resolve(runDir)},target=${sandbox.CONTAINER_WORKDIR}`,
    `type=bind,source=${path.resolve(sessionsDir)},target=${sandbox.CONTAINER_SESSIONS_DIR}`,
  ]);
  for (const args of [onlyRun, withJournals]) {
    assert.ok(!args.some((arg) => ['-v', '--volume', '--tmpfs', '--volumes-from'].includes(arg)), args.join(' '));
  }
});

test('sandbox returns empty git credentials', async () => {
  await withScratch((dir) => {
    // The controller-side check must never reach the operator's real helpers (system/global config,
    // e.g. Git Credential Manager): no system or global config, and the repo's helper list starts
    // with an empty entry that resets anything inherited. Output is never echoed into a message.
    const isolatedHostEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(dir, 'no-global-gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    };
    const hostGit = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', input: 'protocol=https\nhost=example.invalid\n\n', env: isolatedHostEnv });
    hostGit(['init', '-q']);
    hostGit(['config', '--add', 'credential.helper', '']);
    hostGit(['config', '--add', 'credential.helper', '!f() { echo username=u; echo password=leaked-secret; }; f']);
    assert.ok(hostGit(['credential', 'fill']).stdout.includes('password=leaked-secret'), 'the controller side has a working helper');
    const result = sandbox.runInSandboxSync({
      ...BOX,
      runDir: dir,
      network: 'none',
      env: { ...CREDENTIAL_ISOLATION_ENV },
      command: ['sh', '-c', "printf 'protocol=https\\nhost=example.invalid\\n\\n' | git credential fill; echo exit=$?; ls -A \"$HOME/.ssh\" 2>/dev/null | wc -l"],
    });
    assert.ok(!/leaked-secret|password=/.test(result.stdout + result.stderr), 'no credentials inside the sandbox');
    assert.match(result.stdout, /exit=[1-9]/);
    assert.match(result.stdout.trim(), /\n0$/);
  });
});

test('sandbox has no operator gh config', async () => {
  await withScratch((dir) => {
    const script = [
      "const fs = require('fs');",
      'const home = process.env.HOME;',
      'console.log(JSON.stringify({ hosts: fs.existsSync(home + "/.config/gh/hosts.yml"), dir: fs.existsSync(home + "/.config/gh") }));',
    ].join('\n');
    assert.deepStrictEqual(runJson(dir, script), { hosts: false, dir: false });
  });
});

// --- network ---

const PROBE_SCRIPT = [
  "const http = require('http');",
  "const net = require('net');",
  'const viaProxy = (host) => new Promise((resolve) => {',
  '  const proxy = new URL(process.env.HTTPS_PROXY);',
  "  const req = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: host + ':443', timeout: 8000 });",
  "  req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });",
  "  req.on('error', (error) => resolve(error.code));",
  "  req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });",
  '  req.end();',
  '});',
  'const direct = (host) => new Promise((resolve) => {',
  '  const socket = net.connect({ host, port: 443, timeout: 5000 }, () => { socket.destroy(); resolve("CONNECTED"); });',
  "  socket.on('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });",
  "  socket.on('error', (error) => resolve(error.code));",
  '});',
].join('\n');

test('sandbox blocks request to foreign host', async () => {
  const proxy = sandbox.startProxy({ ...BOX, allowedHosts: SANDBOX_CONFIG.allowedHosts });
  try {
    await withScratch((dir) => {
      const script = `${PROBE_SCRIPT}
(async () => {
  console.log(JSON.stringify({
    foreignName: await viaProxy('example.com'),
    foreignIp: await viaProxy('1.1.1.1'),
    directIp: await direct('1.1.1.1'),
    directName: await direct('example.com'),
  }));
})();`;
      const result = runJson(dir, script, { network: proxy.network, proxyUrl: proxy.proxyUrl });
      assert.strictEqual(result.foreignName, 403);
      assert.strictEqual(result.foreignIp, 403);
      assert.notStrictEqual(result.directIp, 'CONNECTED');
      assert.notStrictEqual(result.directName, 'CONNECTED');
    });
  } finally {
    proxy.stop();
  }
});

test('gate sandbox has no network', async () => {
  await withScratch((dir) => {
    const script = `${PROBE_SCRIPT}
const fs = require('fs');
(async () => {
  console.log(JSON.stringify({ ip: await direct('1.1.1.1'), name: await direct('example.com'), interfaces: fs.readdirSync('/sys/class/net') }));
})();`;
    const result = runJson(dir, script);
    assert.notStrictEqual(result.ip, 'CONNECTED');
    assert.notStrictEqual(result.name, 'CONNECTED');
    assert.deepStrictEqual(result.interfaces, ['lo']);
  });
});

// --- proxy policy (decideProxyRequest, used by sandbox/proxy.js) ---

test('proxy policy allows allowlisted host', () => {
  for (const host of SANDBOX_CONFIG.allowedHosts) {
    assert.deepStrictEqual(sandbox.decideProxyRequest({ method: 'CONNECT', host, port: 443 }, SANDBOX_CONFIG.allowedHosts).allow, true, host);
    const upper = host.toUpperCase();
    assert.strictEqual(sandbox.decideProxyRequest({ method: 'CONNECT', host: upper, port: 443 }, SANDBOX_CONFIG.allowedHosts).allow, true, upper);
  }
  assert.deepStrictEqual(sandbox.parseAuthority(`${SANDBOX_CONFIG.allowedHosts[0]}:443`), { host: SANDBOX_CONFIG.allowedHosts[0], port: 443 });
});

test('proxy policy rejects non-CONNECT and non-443', () => {
  const hosts = ['allowed.example.org'];
  for (const method of ['GET', 'POST', 'PUT', 'connect', '']) {
    assert.strictEqual(sandbox.decideProxyRequest({ method, host: hosts[0], port: 443 }, hosts).allow, false, method);
  }
  for (const port of [80, 22, 8443, 4430, 0, undefined]) {
    assert.strictEqual(sandbox.decideProxyRequest({ method: 'CONNECT', host: hosts[0], port }, hosts).allow, false, String(port));
  }
  assert.strictEqual(sandbox.parseAuthority('allowed.example.org'), null);
  assert.strictEqual(sandbox.parseAuthority('http://allowed.example.org:443'), null);
});

test('proxy policy rejects subdomain of allowlisted host', () => {
  const hosts = ['allowed.example.org'];
  for (const host of ['sub.allowed.example.org', 'a.b.allowed.example.org', 'allowed.example.org.evil.test', 'evilallowed.example.org', '1.1.1.1']) {
    assert.strictEqual(sandbox.decideProxyRequest({ method: 'CONNECT', host, port: 443 }, hosts).allow, false, host);
  }
});

// --- config ---

const configWith = (overrides) => ({ ...require('./config.example.json').sandbox, ...overrides });

test('rejects allowlist entry that is not a host name', () => {
  const bad = ['https://registry.example.org', 'registry.example.org:443', 'registry.example.org/path', '10.0.0.1', '::1', '', 42, null, '*.example.org', 'localhost', '-bad.example.org'];
  for (const entry of bad) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ allowedHosts: [entry] })), /allowedHosts entry is not a host name/, JSON.stringify(entry));
  }
  assert.throws(() => sandbox.validateSandboxConfig(configWith({ allowedHosts: [] })), /allowedHosts/);
  assert.throws(() => sandbox.validateSandboxConfig(configWith({ allowedHosts: 'registry.example.org' })), /allowedHosts/);
  assert.deepStrictEqual(sandbox.validateSandboxConfig(configWith({ allowedHosts: ['registry.example.org'] })).allowedHosts, ['registry.example.org']);
});

test('rejects unpinned claude-code version', () => {
  for (const version of ['^2.1.0', '~2.1.0', '2.x', '2.1', '>=2.1.0', 'latest', 'next', '2.1.195-beta.1', '2.1.195+build', '', 2]) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ claudeCodeVersion: version })), /claudeCodeVersion/, JSON.stringify(version));
  }
  assert.strictEqual(sandbox.validateSandboxConfig(configWith({ claudeCodeVersion: '2.1.195' })).claudeCodeVersion, '2.1.195');
});

test('builds image from controller repo with pinned versions', () => {
  const args = sandbox.buildImageArgs(SANDBOX_CONFIG);
  const controllerSandboxDir = path.join(__dirname, 'sandbox');
  assert.strictEqual(args[0], 'build');
  assert.strictEqual(args[args.length - 1], controllerSandboxDir);
  assert.ok(fs.existsSync(path.join(controllerSandboxDir, 'Dockerfile')));
  assert.deepStrictEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', SANDBOX_CONFIG.image]);
  assert.ok(args.includes(`NODE_VERSION=${SANDBOX_CONFIG.nodeVersion}`));
  assert.ok(args.includes(`CLAUDE_CODE_VERSION=${SANDBOX_CONFIG.claudeCodeVersion}`));
  assert.ok(args.includes(`ralph=${__dirname}`));
});

// --- ownership and git on the mounted clone ---

test('files written in sandbox are owned by controller user', async () => {
  const dir = scratchDir();
  const result = runIn(dir, "require('fs').mkdirSync('/workspace/sub'); require('fs').writeFileSync('/workspace/sub/out.txt', 'x');");
  assert.strictEqual(result.status, 0, result.stderr);
  const stat = fs.statSync(path.join(dir, 'sub', 'out.txt'));
  if (typeof process.getuid === 'function') assert.strictEqual(stat.uid, process.getuid());
  fs.rmSync(dir, { recursive: true });
  assert.strictEqual(fs.existsSync(dir), false);
});

test('git works inside sandbox on run dir', async () => {
  await withScratch((dir) => {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    const result = sandbox.runInSandboxSync({
      ...BOX,
      runDir: dir,
      network: 'none',
      env: { ...CREDENTIAL_ISOLATION_ENV },
      command: ['sh', '-c', 'git status --porcelain && git diff --stat'],
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /dubious ownership/);
    assert.match(result.stdout, /^ M a\.txt$/m);
    assert.match(result.stdout, /a\.txt \| 2/);
  });
});

// --- session journals (agent.js runAgent with a stand-in command) ---

const { runAgent } = require('./agent');
const { prepareAgentSessionDir } = require('./workspace');

const JOURNAL_COMMAND = (tail) => [
  'sh',
  '-c',
  `mkdir -p "$CLAUDE_CONFIG_DIR/projects/-workspace" && echo '{"type":"user"}' > "$CLAUDE_CONFIG_DIR/projects/-workspace/session-1.jsonl"; ${tail}`,
];

const journalsIn = (sessionsDir) => {
  const projects = path.join(sessionsDir, 'projects');
  if (!fs.existsSync(projects)) return [];
  return fs.readdirSync(projects, { recursive: true }).filter((file) => String(file).endsWith('.jsonl'));
};

test('agent session journals persist after container exit', async () => {
  await withScratch(async (root) => {
    const runDir = path.join(root, 'issue-1');
    fs.mkdirSync(runDir);
    execFileSync('git', ['init', '-q'], { cwd: runDir });
    const env = { ANTHROPIC_API_KEY: 'sk-test' };
    const finished = prepareAgentSessionDir(path.join(root, 'issue-1-sessions'), '01-implement');
    const ok = await runAgent('', runDir, null, { env, sandbox: { ...BOX, network: 'none', sessionsDir: finished }, command: JOURNAL_COMMAND('true') });
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(journalsIn(finished).length, 1);
    const timedOut = prepareAgentSessionDir(path.join(root, 'issue-1-sessions'), '02-implement');
    const killed = await runAgent('', runDir, null, {
      env,
      timeoutMs: 6000,
      sandbox: { ...BOX, network: 'none', sessionsDir: timedOut },
      command: JOURNAL_COMMAND('sleep 300'),
    });
    assert.strictEqual(killed.ok, false);
    assert.match(killed.error, /timed out/);
    assert.strictEqual(journalsIn(timedOut).length, 1);
  });
});

test('session journals stay outside run dir clone', async () => {
  await withScratch(async (root) => {
    const runDir = path.join(root, 'issue-1');
    fs.mkdirSync(runDir);
    const git = (...args) => execFileSync('git', args, { cwd: runDir, encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(runDir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    const sessionsDir = prepareAgentSessionDir(path.join(root, 'issue-1-sessions'), '01-implement');
    const result = await runAgent('', runDir, null, {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      sandbox: { ...BOX, network: 'none', sessionsDir },
      command: JOURNAL_COMMAND('true'),
    });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(journalsIn(sessionsDir).length, 1);
    assert.ok(path.relative(runDir, sessionsDir).startsWith('..'));
    assert.strictEqual(git('status', '--porcelain', '-uall'), '');
  });
});

// --- labels ---

test('container is labelled with run id', async () => {
  const args = sandbox.buildRunArgs({ ...BOX, runLabel: 'issue-506', runDir: path.join(scratchDirPath(), 'issue-506'), network: 'none', command: ['true'] });
  const labels = args.flatMap((arg, index) => (args[index - 1] === '--label' ? [arg] : []));
  assert.ok(labels.includes(`${sandbox.LABEL_RUN}=issue-506`), labels.join(' '));
  assert.ok(labels.includes(`${sandbox.LABEL_MANAGED}=${BOX.rootKey}`), labels.join(' '));
  await withScratch((dir) => {
    const label = `issue-label-${crypto.randomBytes(3).toString('hex')}`;
    const { child, name } = sandbox.spawnInSandbox({ ...BOX, runLabel: label, runDir: dir, network: 'none', command: ['sleep', '30'] });
    try {
      let running = '';
      for (let attempt = 0; attempt < 50 && running === ''; attempt++) {
        running = containersWithLabel(`${sandbox.LABEL_RUN}=${label}`);
        if (running === '') spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
      }
      assert.notStrictEqual(running, '', `container ${name} is labelled ${label}`);
    } finally {
      sandbox.stopContainer(name);
      child.kill();
    }
  });
});

// --- TR-1 ---

test('sandbox tests do not skip when runtime is missing', () => {
  assert.throws(() => sandbox.assertAvailable({ docker: 'ralph-no-such-container-runtime' }), /Docker is not available/);
  const source = fs.readFileSync(__filename, 'utf8');
  const skipMarkers = ['.' + 'skip(', 'skip' + ': true', 't.' + 'skip', 'test.' + 'todo'];
  for (const marker of skipMarkers) assert.ok(!source.includes(marker), marker);
  assert.ok(source.includes('sandbox.assertAvailable();'), 'before() fails without a runtime instead of skipping');
});

// --- review fixes ---

test('home check treats dotted names inside home as inside and follows links into home', async () => {
  const home = os.homedir();
  assert.strictEqual(sandbox.isInsideHome(path.join(home, '..cache', 'runs')), true);
  assert.strictEqual(sandbox.isInsideHome(path.join(home, '..')), false);
  // The link points at an empty dir created for this test, never at home itself, and is removed
  // before cleanup, so no recursive delete can ever walk into the operator's files.
  const target = fs.mkdtempSync(path.join(home, '.ralph-link-target-'));
  try {
    await withScratch((dir) => {
      const link = path.join(dir, 'runs-link');
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        assert.strictEqual(sandbox.isInsideHome(link), true);
        assert.strictEqual(sandbox.isInsideHome(path.join(link, 'issue-1')), true);
        assert.throws(() => sandbox.buildRunArgs({ ...BOX, runDir: path.join(link, 'issue-1'), network: 'none', command: ['true'] }), /home directory/);
        assert.strictEqual(sandbox.isInsideHome(dir), false);
      } finally {
        fs.unlinkSync(link);
      }
    });
  } finally {
    fs.rmdirSync(target);
  }
});

test('workdir outside the run dir is rejected', () => {
  const spec = (workdir) => ({ ...BOX, runDir: path.join(scratchDirPath(), 'issue-1'), network: 'none', workdir, command: ['true'] });
  for (const workdir of ['../workspace-other', '../workspaces', '..', '../../etc']) {
    assert.throws(() => sandbox.buildRunArgs(spec(workdir)), /escapes the run dir/, workdir);
  }
  for (const workdir of ['', '.', 'apps/api', 'apps\\web']) {
    assert.doesNotThrow(() => sandbox.buildRunArgs(spec(workdir)), workdir);
  }
});

test('proxy address goes to the container only, not to the docker CLI env', () => {
  const args = sandbox.buildRunArgs({
    ...BOX,
    runDir: path.join(scratchDirPath(), 'issue-1'),
    network: 'ralph-net-x',
    proxyUrl: 'http://ralph-proxy-x:3128',
    env: { SECRET_NAME: 'secret-value' },
    command: ['true'],
  });
  assert.ok(args.includes('HTTPS_PROXY=http://ralph-proxy-x:3128'), args.join(' '));
  assert.ok(args.includes('SECRET_NAME'));
  assert.ok(!args.some((arg) => arg.includes('secret-value')), 'secret values never appear in argv');
});

test('read-only git mount keeps the clone writable but .git unwritable', async () => {
  await withScratch((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const script = [
      "const fs = require('fs');",
      'const tryWrite = (file) => { try { fs.writeFileSync(file, "x"); return "written"; } catch (error) { return error.code; } };',
      "console.log(JSON.stringify({ tree: tryWrite('/workspace/a.txt'), hook: tryWrite('/workspace/.git/hooks/pre-commit'), config: tryWrite('/workspace/.git/config') }));",
    ].join('\n');
    const result = runJson(dir, script, { readOnlyGit: true });
    assert.strictEqual(result.tree, 'written');
    assert.notStrictEqual(result.hook, 'written');
    assert.notStrictEqual(result.config, 'written');
    assert.strictEqual(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), false);
  });
});

test('a sandbox step that exceeds its time limit is stopped', async () => {
  await withScratch((dir) => {
    const label = `issue-timeout-${crypto.randomBytes(3).toString('hex')}`;
    const started = Date.now();
    const result = sandbox.runInSandboxSync({ ...BOX, runLabel: label, runDir: dir, network: 'none', command: ['sleep', '300'] }, { timeoutMs: 3000 });
    assert.ok(Date.now() - started < 60000);
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.error, 'the step reports its timeout');
    assert.strictEqual(containersWithLabel(`${sandbox.LABEL_RUN}=${label}`), '');
  });
});

test('install env may not override proxy or Docker settings', () => {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'ALL_PROXY', 'DOCKER_HOST', 'DOCKER_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR', 'HOME', 'CLAUDE_CONFIG_DIR']) {
    assert.throws(() => sandbox.validateSandboxConfig(configWith({ installEnv: { [name]: 'x' } })), /installEnv may not set/, name);
  }
  assert.deepStrictEqual(sandbox.validateSandboxConfig(configWith({ installEnv: { SOME_FLAG: 'true' } })).installEnv, { SOME_FLAG: 'true' });
});

test('read-only git mount needs the clone own .git directory', async () => {
  await withScratch((dir) => {
    const spec = { ...BOX, runDir: dir, network: 'none', readOnlyGit: true, command: ['true'] };
    assert.throws(() => sandbox.buildRunArgs(spec), /not a real directory/);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const args = sandbox.buildRunArgs(spec);
    assert.ok(args.some((arg) => arg.endsWith(`target=${sandbox.CONTAINER_WORKDIR}/.git,readonly`)), args.join(' '));
  });
});
