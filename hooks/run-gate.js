'use strict';

// Runner of the gate hooks (closure gate, skill gate). A gate handler takes the raw stdin event and
// the environment and returns a decision; any exception it throws (unparsable event, missing
// context, missing or invalid profile, damaged marker) becomes exit code 2 with the reason on
// stderr. stdout carries only the decision's own output (the JSON of permissionDecision "ask").

/**
 * @typedef {{ status: 0 | 2, stdout: string, stderr: string }} Decision
 * @typedef {(raw: string, env: NodeJS.ProcessEnv) => Decision} GateHandler
 */

/** @returns {Decision} */
const allow = () => ({ status: 0, stdout: '', stderr: '' });

/** @returns {Decision} */
const block = (message) => ({ status: 2, stdout: '', stderr: `${message}\n` });

/** Lets the tool call proceed only after the person confirms it. @returns {Decision} */
const ask = (reason) => {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: reason,
  };
  return { status: 0, stdout: `${JSON.stringify({ hookSpecificOutput })}\n`, stderr: '' };
};

const isDecision = (value) =>
  (value?.status === 0 || value?.status === 2) &&
  typeof value.stdout === 'string' &&
  typeof value.stderr === 'string';

/**
 * Runs a gate handler on one event and never throws.
 * @param {string} name hook name for the messages
 * @param {GateHandler} handler
 * @param {string} raw
 * @param {NodeJS.ProcessEnv} env
 * @returns {Decision}
 */
const evaluateGate = (name, handler, raw, env) => {
  try {
    const decision = handler(raw, env);
    if (isDecision(decision)) return decision;
    return block(`Blocked: ${name} returned no decision.`);
  } catch (error) {
    return block(`Blocked: ${name} could not decide (${error.message}).`);
  }
};

/** Entrypoint of a gate: reads stdin to the end, writes the decision and sets the exit code. */
const runGate = (name, handler) => {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    const decision = evaluateGate(name, handler, raw, process.env);
    if (decision.stdout !== '') process.stdout.write(decision.stdout);
    if (decision.stderr !== '') process.stderr.write(decision.stderr);
    process.exitCode = decision.status;
  });
};

module.exports = { allow, block, ask, evaluateGate, runGate };
