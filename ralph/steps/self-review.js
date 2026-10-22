'use strict';

// Base step `self-review`: a fresh read-only agent checks the diff against the issue. A real
// finding is fixed by a separate write call within the step's fix budget.

const { buildReviewPrompt } = require('../prompts');
const { parseReviewVerdict } = require('../parsing');
const { reviewDiff } = require('../github');
const { implementationFix } = require('./implement');

const REVIEW_OUTCOMES = { pass: 'passed', 'pass-out-of-scope': 'passed-out-of-scope', fail: 'failed' };

/** A review verdict ({ kind: pass | pass-out-of-scope | fail | unknown, reason? }) as a step outcome. */
function reviewOutcome(verdict) {
  const kind = REVIEW_OUTCOMES[verdict.kind];
  if (!kind) return { kind: 'unparseable' };
  return verdict.reason === undefined ? { kind } : { kind, reason: verdict.reason };
}

const selfReview = {
  name: 'self-review',
  kind: 'agent',
  mode: 'read-only',
  permissions: 'reviewer',
  skipOnDocOnly: true,
  label: 'Self-review (Ralph loop review pass)',
  blockedStatus: 'review_blocked',
  failedStatus: 'review_failed',
  buildPrompt: (ctx) => buildReviewPrompt(ctx.chosen, reviewDiff(ctx.runDir), ctx.promptCtx),
  parseOutput: (output) => reviewOutcome(parseReviewVerdict(output)),
  fix: implementationFix('review-fix'),
};

module.exports = { selfReview, reviewOutcome };
