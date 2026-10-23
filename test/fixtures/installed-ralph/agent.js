'use strict';

// Stub of the agent container: a host Node process started by the boundary in place of
// `docker run ... claude`. It reads the prompt, records what the clone offers the agent at that
// moment (installed skills and agents, the list of setup copies, the permission settings), applies
// the scenario's file changes for its pass and answers in the CLI's stream-json format. No model.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OUTPUT = { 'self-review': 'REVIEW: PASS', 'code-review': 'CODEREVIEW: PASS' };

const scenario = JSON.parse(fs.readFileSync(process.env.INSTALLED_RALPH_SCENARIO, 'utf8'));
const runDir = process.env.INSTALLED_RALPH_RUN_DIR;
const pass = process.env.INSTALLED_RALPH_PASS;

const listDir = (relative) => {
  try {
    return fs.readdirSync(path.join(runDir, relative)).sort();
  } catch {
    return [];
  }
};

const readJson = (relative, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, relative), 'utf8'));
  } catch {
    return fallback;
  }
};

const answer = (prompt) => {
  const permissions = readJson('.claude/settings.local.json', {}).permissions || { allow: [], deny: [] };
  const event = {
    event: 'agent',
    pass,
    skills: listDir('.claude/skills'),
    agents: listDir('.claude/agents'),
    copies: readJson('.claude/.factory-installed.json', { copies: [] }).copies,
    allow: permissions.allow,
    deny: permissions.deny,
    prompt,
  };
  fs.appendFileSync(process.env.INSTALLED_RALPH_LOG, `${JSON.stringify(event)}\n`);
  const step = scenario.agent[pass] || {};
  for (const [file, content] of Object.entries(step.files || {})) {
    const full = path.join(runDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const text = step.output ?? DEFAULT_OUTPUT[pass] ?? '';
  process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01 })}\n`);
};

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => answer(prompt));
