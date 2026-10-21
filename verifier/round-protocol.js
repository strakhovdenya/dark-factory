'use strict';

// What a verifier round publishes and where it is found. The verifier workflow
// and Calibration Judge read these names from here, so both sides name the same
// status context, workflow path and artifacts. A project does not set them:
// the wrapper path and the workflow name follow the layout convention of
// examples/wrappers/acceptance-verifier.yml.

/** Context of the commit status the verifier sets on the PR head commit. */
const VERIFIER_STATUS_CONTEXT = 'Acceptance Verifier';

/** Path of the project wrapper of the verifier workflow; only runs of it are rounds. */
const VERIFIER_WORKFLOW_PATH = '.github/workflows/acceptance-verifier.yml';

/** Artifacts of a round, as the verifier workflow names them. */
const ROUND_ARTIFACTS = Object.freeze({
  verdict: 'verdict',
  verdictSecond: 'verdict-second',
  verdictReport: 'verdict-report',
  policySnapshot: 'policy-snapshot',
});

module.exports = {
  VERIFIER_STATUS_CONTEXT,
  VERIFIER_WORKFLOW_PATH,
  ROUND_ARTIFACTS,
};
