'use strict';

// Base step `code-review`: the `code-review` skill in report-only mode, after self-review. Findings
// outside the issue's Affects are an out-of-scope pass; the controller records them and goes on.

const { buildCodeReviewPrompt } = require('../prompts');
const { parseCodeReviewVerdict } = require('../parsing');
const { implementationFix } = require('./implement');
const { reviewOutcome } = require('./self-review');

const codeReview = {
  name: 'code-review',
  kind: 'agent',
  mode: 'read-only',
  permissions: 'code-reviewer',
  skipOnDocOnly: true,
  label: 'Code-review (Ralph loop, code-review skill)',
  blockedStatus: 'code_review_blocked',
  failedStatus: 'code_review_failed',
  buildPrompt: (ctx) => buildCodeReviewPrompt(ctx.chosen, ctx.promptCtx),
  parseOutput: (output) => reviewOutcome(parseCodeReviewVerdict(output)),
  fix: implementationFix('code-review-fix'),
};

module.exports = { codeReview };
