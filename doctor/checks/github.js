'use strict';

const { SPEC_APPROVED_LABEL } = require('../../ralph/github');
const { BLOCK_LABEL } = require('../../ralph/config');
const { profileUnusable } = require('../context');

const SECRET_NAME = 'OPENAI_API_KEY';
const VERIFIER_MODEL_VARIABLE = 'VERIFIER_MODEL';
const JUDGE_MODEL_VARIABLE = 'CALIBRATION_JUDGE_MODEL';
// Labels the verifier workflows read for every project.
const CORE_LABELS = [SPEC_APPROVED_LABEL, 'manual-verified', 'factory-cross-change', 'test-removal-approved'];

const unavailable = ({ subject, reason }) => ({ subject, reason: `check unavailable: ${reason}` });

const missingNames = (query, wanted, describe) => {
  const present = new Set(query.items.map((item) => item.name));
  return wanted.filter((name) => !present.has(name)).map(describe);
};

// What GitHub of the selected project has: labels, the secret by name only, the variables. A
// failed read is an unavailable check, never a proven missing setting.
module.exports = {
  name: 'github',
  SECRET_NAME,
  VERIFIER_MODEL_VARIABLE,
  JUDGE_MODEL_VARIABLE,
  CORE_LABELS,
  run(context) {
    const problems = [];
    const loaded = context.profile();
    const profile = loaded.ok ? loaded.profile : null;
    if (profile === null) problems.push(profileUnusable('GitHub labels and variables of Ralph and Judge'));

    const labels = [...CORE_LABELS];
    if (profile?.ralph?.enabled === true) {
      labels.push(BLOCK_LABEL);
      if (profile.labels?.humanNeeded !== undefined) labels.push(profile.labels.humanNeeded);
    }
    if (profile?.judge?.enabled === true && profile.labels?.calibration !== undefined) labels.push(profile.labels.calibration);

    const variables = [VERIFIER_MODEL_VARIABLE];
    if (profile?.judge?.enabled === true) variables.push(JUDGE_MODEL_VARIABLE);

    const labelRead = context.github.labels();
    if (labelRead.ok) problems.push(...missingNames(labelRead, [...new Set(labels)], (name) => ({ subject: `GitHub label "${name}"`, reason: 'does not exist in the repository' })));
    else problems.push(unavailable(labelRead));

    const secretRead = context.github.secrets();
    if (secretRead.ok) problems.push(...missingNames(secretRead, [SECRET_NAME], (name) => ({ subject: `GitHub secret ${name}`, reason: 'is not set in the repository' })));
    else problems.push(unavailable(secretRead));

    const variableRead = context.github.variables();
    if (variableRead.ok) problems.push(...missingNames(variableRead, variables, (name) => ({ subject: `GitHub variable ${name}`, reason: 'is not set in the repository' })));
    else problems.push(unavailable(variableRead));
    return problems;
  },
};
