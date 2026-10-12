'use strict';

const { modelReason } = require('../verdict/reason');
const { REASON_CODES: CODE } = require('../verdict/result');

const refsReasons = (refsProblems) => {
  if (refsProblems === null) {
    return [modelReason(CODE.REFS_NOT_CHECKED, 'references were not checked')];
  }
  return refsProblems.map((item) =>
    modelReason(CODE.BAD_REFERENCE, `bad reference: ${item}`),
  );
};

// References and coverage (refs.js, coverage.js): every reference of the
// model report points at a real line, and the report covers the issue's
// items. The problems are the model's, so the reasons are model reasons.
// Without a report there is nothing to check.
module.exports = {
  name: 'references',
  stage: 'report',
  codes: [CODE.REFS_NOT_CHECKED, CODE.BAD_REFERENCE],
  run: ({ report, refsProblems }) =>
    report === null ? [] : refsReasons(refsProblems),
};
