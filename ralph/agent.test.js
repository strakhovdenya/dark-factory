'use strict';

// Portable tests of the agent call: the sandbox runtime is replaced, so no Docker and no model.
// What only a real container can show (what the container sees, its removal, a read-only .git) is
// listed in test/fixtures/ralph-controller/integration-cases.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const sandbox = require('./sandbox');
const { runAgent, buildClaudeArgs, describeToolUse, resolveAgentModel, buildAgentContainerEnv, DEFAULT_AGENT_MODEL } = require('./agent');
const { mockSandbox, mockGh } = require('../test/helpers/ralph');

const BOX = { image: 'neutral:test', rootKey: 'k', runLabel: 'issue-1', network: 'run-net', proxyUrl: 'http://proxy:3128', sessionsDir: '/runs/issue-1-sessions/01-implement' };

/** Replaces spawnInSandbox with a child that prints `lines` (or runs `script`) and exits with `code`. */
/** @type {(...args: any[]) => any} */
const fakeChild = (t, { lines = [], code = 0, onPrompt, chunks } = {}) => {
  const specs = [];
  const stops = [];
  const { EventEmitter } = require('node:events');
  const { PassThrough, Writable } = require('node:stream');
  t.mock.method(sandbox, 'spawnInSandbox', (spec) => {
    specs.push(spec);
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let prompt = '';
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += chunk;
        callback();
      },
      final(callback) {
        callback();
        setImmediate(() => {
          const out = onPrompt ? onPrompt(prompt) : lines;
          for (const piece of chunks || out.map((line) => `${line}\n`)) stdout.write(piece);
          stdout.end();
          stderr.end();
          if (code !== 'hang') setImmediate(() => child.emit('close', code));
        });
      },
    });
    Object.assign(child, { stdin, stdout, stderr, kill: () => child.emit('close', null) });
    return { child, name: 'agent-1', stop: () => {
      stops.push('stop');
      setImmediate(() => child.emit('close', 137));
    } };
  });
  return { specs, stops };
};

const SILENT = { out: () => {}, err: () => {} };

const event = (value) => JSON.stringify(value);
const text = (value, extra = {}) => event({ type: 'assistant', message: { content: [{ type: 'text', text: value }] }, ...extra });

test('supports both explicit sandbox credential types', async (t) => {
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const containerEnv = buildAgentContainerEnv({ [name]: 'secret-value', GH_TOKEN: 'gh-secret', PATH: '/bin' });
    assert.deepEqual(Object.keys(containerEnv.secrets), [name]);
    assert.equal(containerEnv.publicEnv.CLAUDE_CONFIG_DIR, sandbox.CONTAINER_SESSIONS_DIR);
    assert.equal(/** @type {any} */ (containerEnv.publicEnv).HOME, undefined, 'HOME comes from the image');

    const { specs } = fakeChild(t, { lines: [text('DONE')] });
    const result = await runAgent('prompt', '/runs/issue-1', 5, { env: { [name]: 'secret-value', GH_TOKEN: 'gh-secret' }, sandbox: BOX, echo: SILENT });
    assert.equal(result.ok, true, result.error);
    const spec = specs[0];
    assert.deepEqual(spec.env, { [name]: 'secret-value' }, 'only the explicit credential, as a secret');
    assert.ok(!spec.command.some((arg) => arg.includes('secret-value')), 'never in argv');
    assert.ok(!JSON.stringify(spec.publicEnv).includes('secret-value'));
    assert.equal(spec.readOnlyGit, true);
    t.mock.restoreAll();
  }
  const { specs } = fakeChild(t, { lines: [text('DONE')] });
  await runAgent('', '/runs/issue-1', null, { env: { ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b' }, sandbox: BOX, echo: SILENT });
  assert.deepEqual(Object.keys(specs[0].env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], 'both passed; the CLI decides which wins');
});

test('does not launch sandbox agent without explicit credentials', async (t) => {
  const calls = mockGh(t);
  const box = mockSandbox(t);
  for (const env of [{}, { GH_TOKEN: 'gh-secret', PATH: '/bin' }, { ANTHROPIC_API_KEY: '' }]) {
    const result = await runAgent('', '/runs/issue-1', null, { env, sandbox: BOX, echo: SILENT });
    assert.equal(result.ok, false);
    assert.match(result.error, /ANTHROPIC_API_KEY/);
    assert.match(result.error, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.equal(result.container, null);
  }
  assert.equal(box.agents.length, 0, 'the agent process was not started');
  assert.deepEqual(calls, []);
});

test('is_error in the result event fails the call even with exit code 0', async (t) => {
  fakeChild(t, { lines: [event({ type: 'result', is_error: true, subtype: 'error_max_turns', total_cost_usd: 0.42 })] });
  const result = await runAgent('', '/r', null, { env: { ANTHROPIC_API_KEY: 'x' }, sandbox: BOX, echo: SILENT });
  assert.equal(result.ok, false);
  assert.match(result.error, /error_max_turns/);
  assert.equal(result.costUsd, 0.42);
});

test('a successful run returns assistant text and cost, never subagent text', async (t) => {
  fakeChild(t, {
    lines: [text('BLOCKED: subagent report', { parent_tool_use_id: 'toolu_1' }), text('готово\nDONE'), event({ type: 'result', is_error: false, total_cost_usd: 1.5 })],
  });
  const result = await runAgent('', '/r', null, { env: { ANTHROPIC_API_KEY: 'x' }, sandbox: BOX, echo: SILENT });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'готово\nDONE');
  assert.equal(result.costUsd, 1.5);
});

test('the prompt reaches the sandboxed process on stdin, not in argv', async (t) => {
  const { specs } = fakeChild(t, { onPrompt: (prompt) => [text(prompt)] });
  const result = await runAgent('промпт агента', '/r', null, { env: { ANTHROPIC_API_KEY: 'x' }, sandbox: BOX, echo: SILENT });
  assert.equal(result.output, 'промпт агента');
  assert.ok(!specs[0].command.includes('промпт агента'));
});

test('a multi-byte character split across stdout chunks is decoded intact', async (t) => {
  const bytes = Buffer.from(`${text('Блокировано')}\n`, 'utf8');
  const cut = bytes.indexOf(Buffer.from('Б')) + 1;
  fakeChild(t, { chunks: [bytes.subarray(0, cut), bytes.subarray(cut)] });
  const result = await runAgent('', '/r', null, { env: { ANTHROPIC_API_KEY: 'x' }, sandbox: BOX, echo: SILENT });
  assert.equal(result.output, 'Блокировано');
});

test('a non-zero exit fails the call', async (t) => {
  fakeChild(t, { code: 3 });
  const result = await runAgent('x'.repeat(1024), '/r', null, { env: { ANTHROPIC_API_KEY: 'x' }, sandbox: BOX, echo: SILENT });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited 3/);
});

test('a timed out agent stops its container', async (t) => {
  const { stops } = fakeChild(t, { code: 'hang' });
  const result = await runAgent('', '/r', null, { env: { ANTHROPIC_API_KEY: 'x' }, sandbox: BOX, timeoutMs: 20, echo: SILENT });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.deepEqual(stops, ['stop']);
});

test('buildClaudeArgs passes model, turn and USD limits', () => {
  const args = buildClaudeArgs(50, 12.345, 'neutral-model-1');
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--max-turns'), '50');
  assert.equal(after('--max-budget-usd'), '12.35');
  assert.equal(after('--model'), 'neutral-model-1');
  assert.ok(!buildClaudeArgs(null, null).includes('--max-budget-usd'));
});

test('agent model comes from the local config and must be a model ID', () => {
  assert.equal(resolveAgentModel({ agentModel: 'neutral-model-1' }), 'neutral-model-1');
  assert.equal(resolveAgentModel({}), DEFAULT_AGENT_MODEL);
  for (const agentModel of ['', 'sonnet 5', '--dangerously-skip-permissions', 42, null, 'claude;rm']) {
    assert.throws(() => resolveAgentModel({ agentModel }), /agentModel/, JSON.stringify(agentModel));
  }
});

test('tool lines name the skill and the subagent', () => {
  assert.equal(describeToolUse({ name: 'Skill', input: { skill: 'code-review' } }), 'Skill: code-review');
  assert.equal(describeToolUse({ name: 'Agent', input: { subagent_type: 'codebase-scan', description: 'find callers' } }), 'Agent: codebase-scan — find callers');
  assert.equal(describeToolUse({ name: 'Agent', input: {} }), 'Agent: agent');
  assert.equal(describeToolUse({ name: 'Grep', input: { pattern: 'spawnSync' } }), 'Grep: spawnSync');
});
