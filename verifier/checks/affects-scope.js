'use strict';

const { deterministicReason } = require('../verdict/reason');
const { REASON_CODES: CODE } = require('../verdict/result');

const SCOPE_NOT_CHECKED = 'scope was not checked';

// Applies only to v2 issues: a legacy issue keeps relying on the model's own
// out_of_scope_files, judged by the verdict core.
const checkScope = (scopeResult, specFormat) => {
  if (specFormat !== 'v2') return [];
  if (scopeResult === undefined || scopeResult === null) {
    return [deterministicReason(CODE.SCOPE_NOT_CHECKED, SCOPE_NOT_CHECKED)];
  }
  return scopeResult.out_of_scope.map((file) =>
    deterministicReason(
      CODE.OUT_OF_SCOPE_FILE,
      `out of scope file (computed): ${file}`,
    ),
  );
};

// Scope by Affects (affects-scope.js): every changed file matches a path or
// pattern of the issue's Affects section.
module.exports = {
  name: 'affects-scope',
  stage: 'spec',
  codes: [CODE.SCOPE_NOT_CHECKED, CODE.OUT_OF_SCOPE_FILE],
  run: ({ scope, specFormat }) => checkScope(scope, specFormat),
  checkScope,
  SCOPE_NOT_CHECKED,
};
