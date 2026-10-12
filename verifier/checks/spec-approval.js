'use strict';

const { deterministicReason } = require('../verdict/reason');
const { REASON_CODES: CODE } = require('../verdict/result');

const APPROVAL_NOT_CHECKED = 'spec approval was not checked';
const SPEC_NOT_APPROVED = 'spec not approved';
const SPEC_CHANGED = 'spec changed after approval';
const LEGACY_NOT_APPROVED = 'Spec approval: not approved (legacy)';

// A changed spec fails for every format; a missing approval fails unless the
// issue is known to be legacy, where it is only noted in the comment.
const checkApproval = (approval, specFormat) => {
  const result = (failures, note = null) => ({ failures, note });
  const failWith = (code, text) => result([deterministicReason(code, text)]);
  if (approval === undefined) return result([]);
  if (approval === null) {
    return failWith(CODE.APPROVAL_NOT_CHECKED, APPROVAL_NOT_CHECKED);
  }
  if (approval.approved_hash === null) {
    if (specFormat === 'legacy') return result([], LEGACY_NOT_APPROVED);
    return failWith(CODE.SPEC_NOT_APPROVED, SPEC_NOT_APPROVED);
  }
  if (approval.approved_hash !== approval.current_hash) {
    return failWith(CODE.SPEC_CHANGED, SPEC_CHANGED);
  }
  return result([]);
};

// Spec approval (spec-hash.js): the issue body still matches the hash the
// owner approved.
module.exports = {
  name: 'spec-approval',
  stage: 'spec',
  codes: [CODE.APPROVAL_NOT_CHECKED, CODE.SPEC_NOT_APPROVED, CODE.SPEC_CHANGED],
  run: ({ approval, specFormat }) => checkApproval(approval, specFormat).failures,
  note: ({ approval, specFormat }) => checkApproval(approval, specFormat).note,
  checkApproval,
  APPROVAL_NOT_CHECKED,
  SPEC_NOT_APPROVED,
  SPEC_CHANGED,
  LEGACY_NOT_APPROVED,
};
