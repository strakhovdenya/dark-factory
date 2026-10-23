'use strict';

// Stub `claude` of the derived integration image (/opt/ralph-stub/bin/claude, before the real CLI
// in PATH). It is a separate process inside the real agent container: it reads the prompt from
// stdin and the permission settings the controller wrote for this pass, records what it can see
// into a report and a session journal in CLAUDE_CONFIG_DIR, does what the prompt's directive asks
// and answers in the stream-json format of the real CLI. It never calls a model.
//
// Directive: a line `RALPH-STUB-DIRECTIVE: {json}` anywhere in the prompt (the issue body carries
// it in controller runs). Keys: `all` and the role names `implementer`, `reviewer`,
// `code-reviewer`; the role's entry overrides `all`. Fields: write ({ path: content } under the
// working tree), verdict (the text answer), exitCode, sleepSeconds, background (leave a sleeping
// process), findMarker (a file name searched on the whole filesystem), network (a probes.js plan).

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { treeHash } = require('../lib/tree-hash');
const { interfaces, probeNetwork, INSTALL_ENV_MARKER } = require('../lib/probes');

const WORKDIR = '/workspace';
const DIRECTIVE_RE = /^RALPH-STUB-DIRECTIVE: (\{.*\})\s*$/m;
const REPORT_FILE = 'ralph-stub-report.json';
const CREDENTIAL_NAMES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const DEFAULT_VERDICT = {
  implementer: 'DONE\nTYPE: feat\nSUMMARY: stub change',
  reviewer: 'REVIEW: PASS',
  'code-reviewer': 'CODEREVIEW: PASS',
};

const readStdin = () =>
  new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
  });

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// The pass is read from the settings the controller wrote for it, as the real CLI would read them.
function roleOf(settings) {
  const allow = settings?.permissions?.allow || [];
  if (allow.includes('Edit')) return 'implementer';
  if (allow.includes('Skill(code-review)')) return 'code-reviewer';
  return 'reviewer';
}

const sha256 = (value) => (value ? crypto.createHash('sha256').update(value).digest('hex') : null);

const run = (command, args, input) => {
  const result = childProcess.spawnSync(command, args, { cwd: WORKDIR, encoding: 'utf8', input, timeout: 20000 });
  return { code: result.status, stdout: String(result.stdout || '').slice(0, 2000), stderr: String(result.stderr || '').slice(0, 2000) };
};

const attempt = (fn) => {
  try {
    fn();
    return 'written';
  } catch (error) {
    return error.code || error.message;
  }
};

function gitProbes(role) {
  const show = role === 'implementer' ? null : run('git', ['show', '--stat', 'HEAD']);
  const status = run('git', ['status', '--porcelain']);
  const diff = run('git', ['diff', '--stat']);
  const log = run('git', ['log', '--oneline', '-1']);
  const probe = `${WORKDIR}/.ralph-stub-tree-probe-${process.pid}`;
  const tree = attempt(() => fs.writeFileSync(probe, 'x'));
  fs.rmSync(probe, { force: true });
  return {
    status,
    diff,
    log,
    show,
    dubious: [status, diff, log].some((result) => /dubious ownership/.test(result.stderr)),
    configWrite: run('git', ['config', 'core.fsmonitor', 'echo planted']).code,
    hookWrite: attempt(() => fs.writeFileSync(`${WORKDIR}/.git/hooks/post-checkout`, '#!/bin/sh\necho planted\n')),
    tree,
  };
}

function operatorProbes(directive) {
  const home = process.env.HOME || '';
  const ssh = path.join(home, '.ssh');
  const fill = run('git', ['credential', 'fill'], 'protocol=https\nhost=example.invalid\n\n');
  const report = {
    sshEntries: fs.existsSync(ssh) ? fs.readdirSync(ssh).length : 0,
    ghConfig: fs.existsSync(path.join(home, '.config', 'gh')),
    ghHosts: fs.existsSync(path.join(home, '.config', 'gh', 'hosts.yml')),
    credentialFill: { code: fill.code, hasPassword: /password=/.test(fill.stdout + fill.stderr) },
    ghBinary: run('sh', ['-c', 'command -v gh']).code === 0,
    marker: null,
  };
  if (directive.findMarker) {
    const found = run('sh', ['-c', `find / \\( -path /proc -o -path /sys \\) -prune -o -name '${directive.findMarker}' -print 2>/dev/null; true`]);
    report.marker = { inHome: fs.existsSync(path.join(home, directive.findMarker)), found: found.stdout.trim() };
  }
  return report;
}

function environment() {
  const credentials = Object.fromEntries(CREDENTIAL_NAMES.map((name) => [name, sha256(process.env[name])]));
  return {
    home: process.env.HOME ?? null,
    userProfile: process.env.USERPROFILE ?? null,
    ghToken: process.env.GH_TOKEN !== undefined,
    githubToken: process.env.GITHUB_TOKEN !== undefined,
    credentials,
    installEnv: process.env[INSTALL_ENV_MARKER] ?? null,
    httpsProxy: process.env.HTTPS_PROXY ?? null,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    names: Object.keys(process.env).sort(),
  };
}

const mountPoints = () =>
  fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .map((line) => line.split(' ')[4])
    .filter(Boolean);

function writeJournal(configDir, role) {
  const dir = path.join(configDir, 'projects', '-workspace');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', role, at: new Date().toISOString() })}\n`);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

async function main() {
  const prompt = await readStdin();
  const settings = readJson(`${WORKDIR}/.claude/settings.local.json`);
  const role = roleOf(settings);
  const match = DIRECTIVE_RE.exec(prompt);
  const directives = match ? JSON.parse(match[1]) : {};
  const directive = { ...(directives.all || {}), ...(directives[role] || {}) };
  const configDir = process.env.CLAUDE_CONFIG_DIR;

  if (role === 'implementer') {
    for (const [file, content] of Object.entries(directive.write || {})) {
      const target = path.join(WORKDIR, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  const report = {
    role,
    argv: process.argv.slice(2),
    promptBytes: Buffer.byteLength(prompt),
    uid: process.getuid(),
    gid: process.getgid(),
    permissions: settings?.permissions ?? null,
    env: environment(),
    git: gitProbes(role),
    operator: operatorProbes(directive),
    skills: fs.existsSync(`${WORKDIR}/.claude/skills`) ? fs.readdirSync(`${WORKDIR}/.claude/skills`).sort() : [],
    factoryHash: treeHash(`${WORKDIR}/node_modules/dark-factory`),
    interfaces: interfaces(),
    mounts: mountPoints(),
    network: directive.network ? await probeNetwork(directive.network) : null,
  };
  fs.writeFileSync(path.join(configDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  writeJournal(configDir, role);

  if (directive.background) childProcess.spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }).unref();
  if (directive.sleepSeconds) await new Promise((resolve) => setTimeout(resolve, directive.sleepSeconds * 1000));
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: directive.verdict ?? DEFAULT_VERDICT[role] }] } });
  emit({ type: 'result', is_error: false, total_cost_usd: 0, num_turns: 1 });
  process.exitCode = directive.exitCode ?? 0;
}

main().catch((error) => {
  process.stderr.write(`ralph stub failed: ${error.stack}\n`);
  process.exitCode = 70;
});
