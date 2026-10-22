'use strict';

// Base step `implement`: the agent implements the issue with write access. Also the source of the
// fix that a read-only review may carry: a fix is an implementation pass framed by the findings.

const { buildPrompt, buildFixPrompt } = require('../prompts');
const { parseVerdict } = require('../parsing');

const DEFAULT_FIX_BUDGET = 2;

// The verdict of a call with write access as a step outcome; DONE carries TYPE/SUMMARY.
function parseWritesOutput(output, ctx) {
  const verdict = parseVerdict(output, ctx.profile.ralph.humanNeededVerdict);
  if (verdict.kind === 'done') return { kind: 'passed', type: verdict.type, summary: verdict.summary };
  if (verdict.kind === 'blocked' || verdict.kind === 'human-needed') return { kind: verdict.kind, reason: verdict.reason };
  return { kind: 'unparseable' };
}

/** The fix of a review step: its own pass name, the implementer profile and the default budget. */
const implementationFix = (pass) => ({
  pass,
  permissions: 'implementer',
  budget: DEFAULT_FIX_BUDGET,
  buildPrompt: (ctx, findings) => buildFixPrompt(ctx.chosen, findings, ctx.promptCtx),
  parseOutput: parseWritesOutput,
});

const implement = {
  name: 'implement',
  kind: 'agent',
  mode: 'writes',
  permissions: 'implementer',
  skipOnDocOnly: false,
  buildPrompt: (ctx) => buildPrompt(ctx.chosen, ctx.promptCtx),
  parseOutput: parseWritesOutput,
};

module.exports = { implement, implementationFix, parseWritesOutput, DEFAULT_FIX_BUDGET };
