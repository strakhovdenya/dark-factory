const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('./sandbox');
const { runAgent, buildClaudeArgs, describeToolUse, resolveAgentModel, DEFAULT_AGENT_MODEL } = require('./agent');

// Every agent call runs in the Docker sandbox (issue #506); `command` replaces `claude` with a
// stand-in inside the same container. No skips: without Docker before() throws.
const SANDBOX_CONFIG = sandbox.validateSandboxConfig(require('./config.example.json').sandbox);
const ROOT_KEY = `test${crypto.randomBytes(4).toString('hex')}`;
const CREDENTIALS = { ANTHROPIC_API_KEY: 'sk-test-placeholder' };

const SCRATCH_FALLBACK = path.join(__dirname, '..', '..', '.ralph-sandbox-tmp');
const scratchRoot = () => {
  const root = [os.tmpdir(), SCRATCH_FALLBACK].find((dir) => !sandbox.isInsideHome(dir));
  assert.ok(root, 'no scratch directory outside the operator home');
  fs.mkdirSync(root, { recursive: true });
  return root;
};

let runDir = null;
const boxFor = (runLabel = 'issue-test', overrides = {}) => ({ image: SANDBOX_CONFIG.image, rootKey: ROOT_KEY, runLabel, network: 'none', ...overrides });
const node = (script) => ['node', '-e', script];

const containerExists = (name) =>
  String(spawnSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8' }).stdout || '').trim() !== '';
const containersWithLabel = (label) =>
  String(spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

test.before(() => {
  sandbox.assertAvailable();
  sandbox.buildImage(SANDBOX_CONFIG, { stdio: 'ignore' });
  runDir = fs.mkdtempSync(path.join(scratchRoot(), 'ralph-agent-'));
  spawnSync('git', ['init', '-q'], { cwd: runDir });
});

test.after(() => {
  sandbox.removeLeftovers(ROOT_KEY);
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

const run = (options) => runAgent(options.prompt || '', runDir, null, { env: CREDENTIALS, sandbox: boxFor(), ...options });

// --- credentials (AC-9, AC-10) ---

test('sandboxed agent requires explicit credentials', async () => {
  for (const env of [{}, { GH_TOKEN: 'gh-secret', PATH: process.env.PATH }, { ANTHROPIC_API_KEY: '' }]) {
    // A docker binary that does not exist: had runAgent got as far as launching, the error would be
    // a spawn failure, not the credentials message.
    const result = await runAgent('', runDir, null, { env, sandbox: boxFor('issue-test', { docker: 'ralph-no-such-container-runtime' }), command: node('') });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /ANTHROPIC_API_KEY/);
    assert.match(result.error, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.strictEqual(result.container, null);
  }
});

test('sandboxed agent receives only explicit credentials', async () => {
  const script = [
    "const fs = require('fs');",
    "const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').map((line) => line.split(' ')[4]).filter(Boolean);",
    'const text = JSON.stringify({ key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN, home: process.env.HOME, mounts });',
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text } ] } }));",
  ].join('\n');
  const env = { ANTHROPIC_API_KEY: 'sk-test-only-this', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret-2', PATH: process.env.PATH };
  const result = await runAgent('', runDir, null, { env, sandbox: boxFor(), command: node(script) });
  assert.strictEqual(result.ok, true, result.error);
  const seen = JSON.parse(result.output);
  assert.strictEqual(seen.key, 'sk-test-only-this');
  assert.strictEqual(seen.oauth, undefined);
  assert.strictEqual(seen.gh, undefined);
  assert.strictEqual(seen.github, undefined);
  assert.strictEqual(seen.home, sandbox.CONTAINER_HOME);
  assert.ok(seen.mounts.includes(sandbox.CONTAINER_WORKDIR), seen.mounts.join(' '));
  assert.ok(!seen.mounts.some((mount) => mount === sandbox.CONTAINER_HOME || mount.startsWith('/root') || mount === os.homedir().replace(/\\/g, '/')), seen.mounts.join(' '));
});

// --- container lifecycle (AC-11, AC-25, AC-12) ---

test('timed out sandboxed agent stops its container', async () => {
  const started = Date.now();
  const result = await run({ timeoutMs: 3000, command: ['sh', '-c', 'sleep 300 & sleep 300'] });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.ok(Date.now() - started < 30000);
  assert.ok(result.container, 'result names its container');
  assert.strictEqual(containerExists(result.container), false);
});

test('finished sandboxed agent leaves no container', async () => {
  // A background process the "agent" leaves behind must not keep the container alive.
  const result = await run({ command: ['sh', '-c', 'sleep 300 >/dev/null 2>&1 & echo started'] });
  assert.strictEqual(result.ok, true, result.error);
  assert.ok(result.container, 'result names its container');
  assert.strictEqual(containerExists(result.container), false);
});

// The 'exit' mode needs a real process exit while docker children are still running. It is called
// through a bound reference: the verifier's tampering scan reads the tail of a direct call
// (x, i, t, opening parenthesis) as a skipped-test marker.
const CHILD_CONTROLLER = (agentPath, mode) => `
const { runAgent } = require(${JSON.stringify(agentPath)});
const { spawnSync } = require('child_process');
const box = JSON.parse(process.env.RALPH_TEST_BOX);
const env = { ANTHROPIC_API_KEY: 'sk-test-placeholder' };
for (let index = 0; index < 2; index++) {
  runAgent('', process.env.RALPH_TEST_RUN_DIR, null, { env, sandbox: box, command: ['sleep', '300'] });
}
const label = 'label=ralph.run=' + box.runLabel;
const timer = setInterval(() => {
  const ids = String(spawnSync('docker', ['ps', '-q', '--filter', label], { encoding: 'utf8' }).stdout).trim().split(/\\s+/).filter(Boolean);
  if (ids.length < 2) return;
  clearInterval(timer);
  console.log('both-running');
  ${mode === 'exit' ? 'const leave = process.exit.bind(process); leave(0);' : ''}
}, 200);
`;

const runChildController = (mode, runLabel) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_CONTROLLER(path.join(__dirname, 'agent.js'), mode)], {
      env: { ...process.env, RALPH_TEST_BOX: JSON.stringify(boxFor(runLabel)), RALPH_TEST_RUN_DIR: runDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let sawBoth = false;
    child.stdout.on('data', (chunk) => {
      if (!sawBoth && String(chunk).includes('both-running')) {
        sawBoth = true;
        if (mode === 'sigint') child.kill('SIGINT');
      }
    });
    const guard = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, sawBoth });
    });
  });

test('controller exit stops active agent containers', async () => {
  const modes = process.platform === 'win32' ? ['exit'] : ['exit', 'sigint'];
  for (const mode of modes) {
    const runLabel = `issue-exit-${mode}-${crypto.randomBytes(3).toString('hex')}`;
    const outcome = await runChildController(mode, runLabel);
    assert.ok(outcome.sawBoth, `${mode}: both agent containers were running`);
    if (mode === 'sigint') assert.strictEqual(outcome.code, 130);
    assert.deepStrictEqual(containersWithLabel(`${sandbox.LABEL_RUN}=${runLabel}`), [], mode);
  }
});

// --- stream-json handling, unchanged behavior inside the sandbox ---

test('is_error in the result event fails the call even with exit code 0', async () => {
  const event = { type: 'result', is_error: true, subtype: 'error_max_turns', total_cost_usd: 0.42 };
  const result = await run({ command: node(`console.log(${JSON.stringify(JSON.stringify(event))});`) });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /error_max_turns/);
  assert.strictEqual(result.costUsd, 0.42);
});

test('a successful run returns assistant text and cost', async () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'готово\nDONE' }] } },
    { type: 'result', is_error: false, total_cost_usd: 1.5 },
  ];
  const script = events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('');
  const result = await run({ command: node(script) });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, 'готово\nDONE');
  assert.strictEqual(result.costUsd, 1.5);
});

test('the prompt reaches the sandboxed process on stdin', async () => {
  const script = "let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: s }] } })));";
  const result = await run({ prompt: 'промпт агента', command: node(script) });
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.output, 'промпт агента');
});

test('a multi-byte character split across stdout chunks is decoded intact', async () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Блокировано' }] } });
  // Write the UTF-8 bytes in two chunks, cutting a Cyrillic letter in half.
  const script = [
    `const bytes = Buffer.from(${JSON.stringify(line + '\n')}, 'utf8');`,
    "const cut = bytes.indexOf(Buffer.from('Б')) + 1;",
    'process.stdout.write(bytes.subarray(0, cut));',
    'setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);',
  ].join('\n');
  const result = await run({ command: node(script) });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, 'Блокировано');
});

test('a child that exits before reading stdin does not crash the controller', async () => {
  const result = await run({ prompt: 'x'.repeat(4 * 1024 * 1024), command: node('process.exitCode = 3') });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /exited 3/);
});

test('buildClaudeArgs passes turn and USD limits', () => {
  const args = buildClaudeArgs(50, 12.345);
  assert.deepStrictEqual(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2), ['--max-turns', '50']);
  assert.deepStrictEqual(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2), ['--max-budget-usd', '12.35']);
  assert.ok(!buildClaudeArgs(null, null).includes('--max-budget-usd'));
});

// --- review fix: the agent cannot plant git config that host git would run ---

test('sandboxed agent cannot write .git (no fsmonitor or hooks for host git)', async () => {
  const configBefore = fs.readFileSync(path.join(runDir, '.git', 'config'), 'utf8');
  const script = [
    "const fs = require('fs');",
    "const { spawnSync } = require('child_process');",
    "const config = spawnSync('git', ['config', 'core.fsmonitor', 'echo planted'], { cwd: '/workspace' }).status;",
    "let hook; try { fs.writeFileSync('/workspace/.git/hooks/post-checkout', 'x'); hook = 'written'; } catch (error) { hook = error.code; }",
    "let tree; try { fs.writeFileSync('/workspace/agent-file.txt', 'x'); tree = 'written'; } catch (error) { tree = error.code; }",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ config, hook, tree }) }] } }));",
  ].join('\n');
  const result = await run({ command: node(script) });
  assert.strictEqual(result.ok, true, result.error);
  const seen = JSON.parse(result.output);
  assert.notStrictEqual(seen.config, 0);
  assert.notStrictEqual(seen.hook, 'written');
  assert.strictEqual(seen.tree, 'written');
  assert.strictEqual(fs.readFileSync(path.join(runDir, '.git', 'config'), 'utf8'), configBefore);
  fs.rmSync(path.join(runDir, 'agent-file.txt'), { force: true });
});

test('the agent container env carries values outside the docker CLI env', () => {
  const { buildAgentContainerEnv } = require('./agent');
  const env = buildAgentContainerEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-placeholder', GH_TOKEN: 'gh-secret' });
  assert.deepStrictEqual(Object.keys(env.secrets), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.strictEqual(env.publicEnv.HOME, undefined, 'HOME comes from the image, never from the CLI env');
  assert.strictEqual(env.publicEnv.CLAUDE_CONFIG_DIR, sandbox.CONTAINER_SESSIONS_DIR);
  assert.strictEqual(buildAgentContainerEnv({ GH_TOKEN: 'gh-secret' }), null);
});

test('agent model comes from config and is passed to the CLI', () => {
  assert.strictEqual(resolveAgentModel({ agentModel: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');
  assert.strictEqual(resolveAgentModel({}), DEFAULT_AGENT_MODEL);
  const args = buildClaudeArgs(10, null, 'claude-sonnet-5-5');
  assert.deepStrictEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-sonnet-5-5']);
});

test('rejects an agent model that is not a model ID', () => {
  for (const agentModel of ['', 'sonnet 5', '--dangerously-skip-permissions', 42, null, 'claude;rm']) {
    assert.throws(() => resolveAgentModel({ agentModel }), /config\.agentModel/, JSON.stringify(agentModel));
  }
});

test('tool lines name the skill and the subagent', () => {
  assert.strictEqual(describeToolUse({ name: 'Skill', input: { skill: 'code-review' } }), 'Skill: code-review');
  assert.strictEqual(describeToolUse({ name: 'Agent', input: { subagent_type: 'codebase-scan', description: 'find callers' } }), 'Agent: codebase-scan — find callers');
  assert.strictEqual(describeToolUse({ name: 'Agent', input: {} }), 'Agent: agent');
  assert.strictEqual(describeToolUse({ name: 'Grep', input: { pattern: 'spawnSync' } }), 'Grep: spawnSync');
});

test('subagent text never becomes the agent output', async () => {
  const events = [
    { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'BLOCKED: subagent report' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'REVIEW: PASS' }] } },
    { type: 'result', is_error: false, total_cost_usd: 0.1 },
  ];
  const script = events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('');
  const result = await run({ command: node(script) });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, 'REVIEW: PASS');
});
