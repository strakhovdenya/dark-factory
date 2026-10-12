'use strict';

const { deterministicReason } = require('../verdict/reason');
const { REASON_CODES: CODE } = require('../verdict/result');

const ciReasons = (ciFailures) => {
  if (ciFailures === null) {
    return [
      deterministicReason(CODE.CI_NOT_CHECKED, 'CI results were not checked'),
    ];
  }
  return ciFailures.map((text) =>
    deterministicReason(CODE.CI_CHECK_FAILED, text),
  );
};

// CI results (ci.js): the CI workflow succeeded, every required check (from
// the trusted required-checks.json) completed successfully and no other
// check failed.
module.exports = {
  name: 'ci-checks',
  stage: 'report',
  codes: [CODE.CI_NOT_CHECKED, CODE.CI_CHECK_FAILED],
  run: ({ ciFailures }) => ciReasons(ciFailures),
};
