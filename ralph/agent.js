'use strict';

const sandbox = require('./sandbox');
const { CREDENTIAL_ISOLATION_ENV } = require('./boundary');

function describeToolUse(block) {
  const name = block.name || 'tool';
  const input = block.input || {};
  if (input.command) return `Bash: ${String(input.command).slice(0, 200)}`;
  if (input.file_path) return `${name}: ${input.file_path}`;
  if (name === 'Skill' && input.skill) return `Skill: ${input.skill}`;
  if (name === 'Agent' || name === 'Task') {
    const kind = input.subagent_type || 'agent';
    return input.description ? `${name}: ${kind} — ${String(input.description).slice(0, 120)}` : `${name}: ${kind}`;
  }
  if (input.pattern) return `${name}: ${String(input.pattern).slice(0, 120)}`;
  return name;
}

// Events of a subagent (stream-json sets parent_tool_use_id on them) are printed indented and
// never become the agent's own output: the verdict (DONE, BLOCKED, REVIEW: ...) is parsed from the
// main agent's text only, and a subagent's report must not be mistaken for it.
const SUBAGENT_PREFIX = '  ↳ ';

// The CLI inside the sandbox has no operator HOME, so it authenticates only with a key passed
// explicitly. Which one wins when both are set is the CLI's own rule.
const CREDENTIAL_ENV_NAMES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// Keeps the CLI to the API host: no telemetry, error reporting or self-update traffic, which the
// proxy would refuse anyway.
const CLAUDE_QUIET_ENV = {
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

const MISSING_CREDENTIALS_ERROR =
  'Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set: claude in the sandbox has no other way to authenticate ' +
  '(export ANTHROPIC_API_KEY, or create a token with `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN)';

const STOP_GRACE_MS = 10000;

const PROCESS_ECHO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

// Everything the container gets: `secrets` — explicit credentials from `sourceEnv` (the controller's
// scrubbed env), passed by name only; `publicEnv` — the git/gh isolation values and where claude
// keeps its config and session journals (HOME comes from the image). Null when no credential is set.
function buildAgentContainerEnv(sourceEnv) {
  const secrets = {};
  for (const name of CREDENTIAL_ENV_NAMES) {
    if (sourceEnv[name]) secrets[name] = sourceEnv[name];
  }
  if (Object.keys(secrets).length === 0) return null;
  const publicEnv = { ...CREDENTIAL_ISOLATION_ENV, ...CLAUDE_QUIET_ENV, CLAUDE_CONFIG_DIR: sandbox.CONTAINER_SESSIONS_DIR };
  return { secrets, publicEnv };
}

// The model is an exact ID from the local run config (`agentModel`), not the CLI alias `sonnet`: an alias
// resolves to whatever model the pinned claude-code version (sandbox.claudeCodeVersion) knows, so
// a run would silently stay on an older model until that pin moved.
const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5';
const AGENT_MODEL_RE = /^[a-z0-9][a-z0-9.-]*(\[[a-z0-9]+\])?$/i;

function resolveAgentModel(config) {
  const model = config.agentModel === undefined ? DEFAULT_AGENT_MODEL : config.agentModel;
  if (typeof model !== 'string' || !AGENT_MODEL_RE.test(model)) {
    throw new Error(`agentModel in the local run config must be a model ID such as "${DEFAULT_AGENT_MODEL}", got ${JSON.stringify(model)}`);
  }
  return model;
}

function buildClaudeArgs(maxTurns, maxBudgetUsd, model = DEFAULT_AGENT_MODEL) {
  // Model and effort are pinned explicitly rather than left to whatever the CLI default is: an
  // unattended run with no human to catch a shortcut answer should not depend on an unpinned
  // model or effort tier.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--effort',
    'high',
  ];
  if ((maxTurns ?? null) !== null) args.push('--max-turns', String(maxTurns));
  if ((maxBudgetUsd ?? null) !== null) args.push('--max-budget-usd', maxBudgetUsd.toFixed(2));
  return args;
}

// Streams the agent's output live via --output-format stream-json: plain
// `-p` text mode only prints the FINAL response, nothing while the agent is
// reading files/running tests/editing — found the hard way when a real run
// sat silent for 23 minutes with no visible progress at all. stream-json
// gives one JSON event per turn (assistant text, tool_use, tool result,
// final summary); we print a short readable line per event and separately
// accumulate just the assistant's text blocks into `output` for
// parseVerdict() below, which never has to know the format changed.
//
// The CLI runs in a sandbox container: only `runDir` and this call's session dir are
// mounted, network goes through the run's proxy, and only explicit credentials reach it.
//
// options:
//   env          — source of the credentials; the caller passes boundary.buildAgentEnv().
//   sandbox      — { image, rootKey, runLabel, network, proxyUrl, sessionsDir, docker? } of this run.
//   timeoutMs    — the container is removed after this long; result ok: false.
//   maxBudgetUsd — passed to the CLI as --max-budget-usd.
//   model        — exact model ID for --model (resolveAgentModel()).
//   command      — argv run in the container instead of `claude`, only for tests.
//   echo         — { out(text), err(text) } for the live progress lines; the process streams by default.
// Result: { ok, output, costUsd, container, error? }. A `result` event with is_error: true is a
// failure even when the process exits 0 (e.g. max turns or budget reached).
function runAgent(prompt, runDir, maxTurns, options = {}) {
  const { env, timeoutMs, maxBudgetUsd, model, command, sandbox: box } = options;
  const echo = options.echo || PROCESS_ECHO;
  const failed = (error) => Promise.resolve({ ok: false, output: '', costUsd: null, container: null, error });
  const containerEnv = buildAgentContainerEnv(env || process.env);
  if (!containerEnv) return failed(MISSING_CREDENTIALS_ERROR);
  if (!box) return failed('runAgent needs the sandbox context of the run');
  let launched;
  try {
    launched = sandbox.spawnInSandbox(
      {
        image: box.image,
        rootKey: box.rootKey,
        runLabel: box.runLabel,
        network: box.network,
        proxyUrl: box.proxyUrl,
        sessionsDir: box.sessionsDir,
        runDir,
        env: containerEnv.secrets,
        publicEnv: containerEnv.publicEnv,
        // The agent never needs to write .git (the controller owns every git mutation), and a
        // writable .git would let it plant config — fsmonitor, hooks — that host git runs.
        readOnlyGit: true,
        command: command || ['claude', ...buildClaudeArgs(maxTurns, maxBudgetUsd, model)],
        interactive: true,
      },
      { docker: box.docker },
    );
  } catch (error) {
    return failed(error.message);
  }
  const { child, name: container, stop } = launched;
  return new Promise((resolve) => {
    // Prompt is written to stdin rather than passed as an argv element — a
    // large review prompt (full issue body + `git diff HEAD`) can exceed
    // Windows' ~32K command-line length limit, which crashes spawn() with
    // ENAMETOOLONG before the process even starts (found live on a real
    // review-pass run once the diff grew past a few hundred lines). `claude
    // -p` reads the prompt from stdin when none is given positionally (the container runs with -i).

    let output = ''; // assistant text only — what parseVerdict() looks at
    let lineBuffer = '';
    let costUsd = null;
    let resultError = null;
    let timedOut = false;
    let settled = false;
    let stopTimer = null;
    let forceTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(stopTimer);
      clearTimeout(forceTimer);
      resolve({ costUsd, container, ...result, output });
    };

    if ((timeoutMs ?? null) !== null) {
      stopTimer = setTimeout(() => {
        timedOut = true;
        echo.out(`\n⏱️ claude -p превысил ${Math.round(timeoutMs / 1000)}s — останавливаю контейнер ${container}.\n`);
        stop();
        // `docker rm -f` ends the attached CLI; killing the CLI itself is only a fallback.
        forceTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      }, timeoutMs);
    }

    // EPIPE when the child dies before reading its prompt; the 'close' handler reports the exit.
    child.stdin.on('error', (error) => {
      echo.err(`⚠️ stdin claude -p: ${error.message}\n`);
    });
    child.stdin.write(prompt);
    child.stdin.end();

    function handleEvent(evt) {
      if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
        const isSubagent = Boolean(evt.parent_tool_use_id);
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) {
            if (isSubagent) {
              echo.out(`\n${SUBAGENT_PREFIX}${block.text.trim().split('\n')[0].slice(0, 200)}\n`);
            } else {
              output += block.text;
              echo.out(block.text);
            }
          } else if (block.type === 'tool_use') {
            echo.out(`\n${isSubagent ? SUBAGENT_PREFIX : ''}🔧 ${describeToolUse(block)}\n`);
          }
        }
      } else if (evt.type === 'result') {
        if (typeof evt.total_cost_usd === 'number') costUsd = evt.total_cost_usd;
        if (evt.is_error) resultError = `claude -p reported an error result (${evt.subtype || 'is_error'})`;
        const turns = evt.num_turns ?? evt.turns;
        const seconds = (evt.duration_ms ?? null) !== null ? Math.round(evt.duration_ms / 1000) : null;
        echo.out(`\n🏁 ${(turns ?? null) !== null ? `ходов: ${turns}` : 'завершено'}${seconds !== null ? `, ${seconds}s` : ''}\n`);
      }
    }

    // setEncoding: a multi-byte UTF-8 character (Cyrillic) split across two chunks is decoded
    // correctly instead of turning into two replacement characters.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          echo.out(`${line}\n`); // unexpected non-JSON line — don't swallow it
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      echo.err(chunk);
    });
    child.on('error', (error) => {
      finish({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      // sandbox.spawnInSandbox() has already removed the container (and with it whatever the agent
      // left running in it — a dev server, a stuck test) on this same 'close'.
      if (lineBuffer.trim()) {
        try {
          handleEvent(JSON.parse(lineBuffer));
        } catch {
          // trailing partial line, nothing usable — ignore
        }
      }
      if (timedOut) {
        finish({ ok: false, error: `claude -p timed out after ${Math.round(timeoutMs / 1000)}s and was killed` });
      } else if (code !== 0) {
        finish({ ok: false, error: `claude -p exited ${code}` });
      } else if (resultError) {
        finish({ ok: false, error: resultError });
      } else {
        finish({ ok: true });
      }
    });
  });
}

module.exports = {
  describeToolUse,
  buildClaudeArgs,
  resolveAgentModel,
  DEFAULT_AGENT_MODEL,
  buildAgentContainerEnv,
  runAgent,
};
