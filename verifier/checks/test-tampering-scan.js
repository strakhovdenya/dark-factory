'use strict';

const { deterministicReason } = require('../verdict/reason');
const { REASON_CODES: CODE } = require('../verdict/result');

const TAMPERING_SCAN_NOT_RUN = 'tampering scan was not run';

const describeLoss = ({ path: file, lost }) =>
  `${file}: ${lost} assertion line(s) removed without a matching added line`;

const scanReasons = ({
  tamperingFindings,
  assertionLosses,
  testRemovalApproved,
}) => {
  if (tamperingFindings === null) {
    return [
      deterministicReason(CODE.TAMPERING_SCAN_NOT_RUN, TAMPERING_SCAN_NOT_RUN),
    ];
  }
  const reasons = tamperingFindings.map((item) =>
    deterministicReason(
      CODE.TAMPERING_SCAN_FINDING,
      `test tampering (scan): ${item}`,
    ),
  );
  // The owner's approval excuses only assertion losses, never the other
  // scanner findings, the model's test_tampering or UNVERIFIABLE.
  if (!testRemovalApproved) {
    for (const loss of assertionLosses) {
      const text = `test tampering (scan): ${describeLoss(loss)}`;
      reasons.push(deterministicReason(CODE.ASSERTION_LOSS, text));
    }
  }
  return reasons;
};

// Test scanner (test-tampering-scan.js): skipped tests, removed assertions
// and disabled checks found in the diff.
module.exports = {
  name: 'test-tampering-scan',
  stage: 'report',
  codes: [
    CODE.TAMPERING_SCAN_NOT_RUN,
    CODE.TAMPERING_SCAN_FINDING,
    CODE.ASSERTION_LOSS,
  ],
  run: scanReasons,
  TAMPERING_SCAN_NOT_RUN,
};
