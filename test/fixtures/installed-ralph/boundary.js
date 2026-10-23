'use strict';

// Preload (`node --require`) of the installed controller process: the external world replaced at
// the child_process boundary, before the controller loads. git runs for real; gh answers from the
// scenario; docker is emulated: an install step lays out the packed delivery in the clone, the
// factory-setup step runs the clone's real setup as a host Node process, a gate step succeeds,
// and the agent container is the stub agent (agent.js). Every call goes to the event log. Node
// built-ins and the fixture's own files only: the controller and setup come from the installed
// package, never from the checkout.

const childProcess = /** @type {any} */ (require('node:child_process'));
const fs = require('node:fs');
const path = require('node:path');
const { installPackage } = require('./package');
require('./record-modules');

const CONTAINER_WORKDIR = '/workspace';
const CONTAINER_SESSIONS_DIR = '/ralph-claude';
const SETUP_SUFFIX = 'node_modules/dark-factory/bin/setup.js';
const AGENT_SCRIPT = path.join(__dirname, 'agent.js');
const RECORD_SCRIPT = path.join(__dirname, 'record-modules.js');
const RUN_VALUE_OPTIONS = new Set(['--name', '--label', '--network', '--cap-drop', '--security-opt', '--user', '--mount', '-w', '-e']);

const real = { execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync, spawn: childProcess.spawn };
const scenario = JSON.parse(fs.readFileSync(process.env.INSTALLED_RALPH_SCENARIO, 'utf8'));
const log = (event) => fs.appendFileSync(process.env.INSTALLED_RALPH_LOG, `${JSON.stringify(event)}\n`);

// --- GitHub ---

const answerGh = (args) => {
  const [group, action] = args;
  const { issue } = scenario;
  if (group === 'label' && action === 'list') return JSON.stringify(scenario.labels.map((name) => ({ name })));
  if (group === 'issue' && action === 'view') {
    if (args.includes('-q')) return issue.body;
    const labels = [{ name: 'spec-approved' }];
    return JSON.stringify({ number: issue.id, title: issue.title, body: issue.body, url: `https://example.invalid/issues/${issue.id}`, state: 'OPEN', labels });
  }
  if (group === 'api' && args.some((arg) => arg.includes(`/issues/${issue.id}/comments`))) {
    return JSON.stringify({ user: { login: 'github-actions[bot]' }, body: issue.approval });
  }
  if (group === 'api' && args.some((arg) => arg.includes('/pulls'))) return '';
  if (group === 'pr' && action === 'create') return scenario.prUrl;
  if (group === 'issue' && (action === 'comment' || action === 'edit')) return '';
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
};

// --- Docker ---

const spawnResult = (status, stdout = '', stderr = '') => ({ pid: 0, output: [null, stdout, stderr], stdout, stderr, status, signal: null, error: undefined });

const parseRun = (args) => {
  const run = { mounts: {}, network: null, workdir: null, image: null, command: [] };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (RUN_VALUE_OPTIONS.has(arg)) {
      const value = args[++index];
      if (arg === '--network') run.network = value;
      if (arg === '-w') run.workdir = value;
      if (arg === '--mount') {
        const fields = Object.fromEntries(value.split(',').map((part) => part.split('=')));
        run.mounts[fields.target] = fields.source;
      }
    } else if (!arg.startsWith('-')) {
      run.image = arg;
      run.command = args.slice(index + 1);
      break;
    }
  }
  return run;
};

const toHost = (runDir, value) => {
  if (value !== CONTAINER_WORKDIR && !value.startsWith(`${CONTAINER_WORKDIR}/`)) return value;
  return path.join(runDir, ...value.slice(CONTAINER_WORKDIR.length).split('/').filter(Boolean));
};

const childEnv = (role, extra = {}) => ({ ...process.env, INSTALLED_RALPH_ROLE: role, ...extra });

const runSetup = (runDir, run) => {
  const [, script, ...args] = run.command.map((arg) => toHost(runDir, arg));
  return real.spawnSync(process.execPath, ['--require', RECORD_SCRIPT, script, ...args], {
    cwd: toHost(runDir, run.workdir),
    env: childEnv('setup'),
    encoding: 'utf8',
  });
};

const installInClone = (runDir) => {
  const nodeModules = path.join(runDir, 'node_modules');
  if (fs.existsSync(path.join(nodeModules, 'dark-factory'))) return;
  installPackage(nodeModules, { tarball: scenario.tarball, runtimeDir: scenario.runtimeDir, omit: scenario.cloneOmit });
};

const sandboxRun = (run) => {
  const runDir = run.mounts[CONTAINER_WORKDIR];
  const entry = { event: 'sandbox', kind: 'gate', runDir, workdir: run.workdir, network: run.network, image: run.image, command: run.command, status: 0 };
  if (String(run.command[1] || '').endsWith(SETUP_SUFFIX)) {
    const result = runSetup(runDir, run);
    log({ ...entry, kind: 'setup', status: result.status });
    return result;
  }
  if (run.network !== 'none') {
    installInClone(runDir);
    log({ ...entry, kind: 'install' });
    return spawnResult(0, 'installed\n');
  }
  log(entry);
  return spawnResult(0, 'gate ok\n');
};

const dockerSync = (args) => {
  const [command] = args;
  if (command === 'run' && !args.includes('-d')) return sandboxRun(parseRun(args));
  log({ event: 'docker', args });
  if (command === 'version') return spawnResult(0, '27.0.0\n');
  if (command === 'logs') return spawnResult(0, 'ralph-proxy listening\n');
  return spawnResult(0);
};

const spawnAgent = (args) => {
  const run = parseRun(args);
  if (run.command[0] !== 'claude') throw new Error(`unexpected streamed container: ${run.command.join(' ')}`);
  const pass = path.basename(run.mounts[CONTAINER_SESSIONS_DIR]).replace(/^\d+-/, '');
  const env = childEnv('agent', { INSTALLED_RALPH_RUN_DIR: run.mounts[CONTAINER_WORKDIR], INSTALLED_RALPH_PASS: pass });
  return real.spawn(process.execPath, [AGENT_SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
};

// --- the boundary ---

childProcess.execFileSync = (file, args = [], options = {}) => {
  if (file === 'git') return real.execFileSync(file, args, options);
  if (file !== 'gh') throw new Error(`unexpected host process ${file}`);
  log({ event: 'gh', args, cwd: options.cwd });
  const out = answerGh(args);
  return options.encoding ? out : Buffer.from(out);
};

childProcess.spawnSync = (file, args = [], options = {}) => {
  if (file === 'docker') return dockerSync(args);
  if (file === 'git') return real.spawnSync(file, args, options);
  throw new Error(`unexpected host process ${file}`);
};

childProcess.spawn = (file, args = []) => {
  if (file === 'docker') return spawnAgent(args);
  throw new Error(`unexpected host process ${file}`);
};

for (const name of ['exec', 'execSync', 'execFile', 'fork']) {
  childProcess[name] = (file) => {
    throw new Error(`a host process was started through ${name}: ${file}`);
  };
}
