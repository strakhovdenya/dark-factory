'use strict';

const { deterministicReason } = require('../verdict/reason');
const { REASON_CODES: CODE } = require('../verdict/result');

const ALLOWED_MODELS_NOT_CHECKED = 'allowed models were not checked';
const modelNotAllowed = (model) =>
  `VERIFIER_MODEL is not in allowed-models.json: ${model}`;

// VERIFIER_MODEL is only checked against provenanceModel when provenance
// itself was read successfully; a missing provenance already fails via
// PROVENANCE_MISSING and this would only duplicate that reason.
const modelAllowedReasons = ({ allowedModels, provenanceModel }) => {
  if (allowedModels === null) {
    return [
      deterministicReason(
        CODE.ALLOWED_MODELS_NOT_CHECKED,
        ALLOWED_MODELS_NOT_CHECKED,
      ),
    ];
  }
  const isNotAllowed =
    provenanceModel !== null && !allowedModels.includes(provenanceModel);
  if (!isNotAllowed) return [];
  const text = modelNotAllowed(provenanceModel);
  return [deterministicReason(CODE.MODEL_NOT_ALLOWED, text)];
};

// Allowed model (trusted allowed-models.json): the model that wrote the
// report is one the project allows.
module.exports = {
  name: 'allowed-model',
  stage: 'report',
  codes: [CODE.ALLOWED_MODELS_NOT_CHECKED, CODE.MODEL_NOT_ALLOWED],
  run: modelAllowedReasons,
  ALLOWED_MODELS_NOT_CHECKED,
};
