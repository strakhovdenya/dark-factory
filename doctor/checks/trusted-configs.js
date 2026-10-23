'use strict';

const path = require('node:path');
const { isStringArray } = require('../../verifier/verdict/common');
const { readRequiredChecks, parseAllowedModels } = require('../../verifier/verdict/inputs');
const { isConfigShape } = require('../../verifier/test-tampering-scan');
const { loadRiskZones } = require('../../verifier/risk-zones');
const { buildContract, DEFAULT_OVERLAY } = require('../../verifier/issue-contract');
const { loadTaxonomy } = require('../../judge/taxonomy');
const { readAllowlist } = require('../../judge/calibration-judge');
const { readJsonFile, fileStat } = require('../files');
const { profileUnusable } = require('../context');

const VERIFIER_DIR = '.github/verifier';
const CALIBRATION_DIR = '.github/calibration';
const STRING_ARRAY = 'must be a JSON array of strings';
const OVERLAY_PATH = DEFAULT_OVERLAY.split(path.sep).join('/');

const absolute = (root, relative) => path.join(root, ...relative.split('/'));

// Same predicates and parsers as the verifier workflow uses; doctor only adds the reason.
// `validate` returns the reason a present file is rejected, or null.
const jsonReason = (root, relative, accepts, expects) => {
  const read = readJsonFile(root, relative);
  if (read.state === 'invalid') return read.reason;
  if (read.state === 'ok' && !accepts(read)) return expects;
  return null;
};

const throwingReason = (action) => {
  try {
    action();
    return null;
  } catch (error) {
    return error.message;
  }
};

const MANDATORY = [
  { path: `${VERIFIER_DIR}/owners.json`, validate: (root, relative) => jsonReason(root, relative, ({ value }) => isStringArray(value), STRING_ARRAY) },
  { path: `${VERIFIER_DIR}/required-checks.json`, validate: (root, relative) => jsonReason(root, relative, () => readRequiredChecks(absolute(root, relative)) !== null, STRING_ARRAY) },
  { path: `${VERIFIER_DIR}/allowed-models.json`, validate: (root, relative) => jsonReason(root, relative, ({ raw }) => parseAllowedModels(raw) !== null, STRING_ARRAY) },
  { path: `${VERIFIER_DIR}/tampering-scan.json`, validate: (root, relative) => jsonReason(root, relative, ({ value }) => isConfigShape(value), 'must map class names to arrays of pattern strings') },
  { path: `${VERIFIER_DIR}/risk-zones.json`, validate: (root, relative) => throwingReason(() => loadRiskZones(absolute(root, relative))) },
];

const JUDGE_CONFIGS = [
  { path: `${CALIBRATION_DIR}/taxonomy.json`, validate: (root, relative) => throwingReason(() => loadTaxonomy(absolute(root, relative))) },
  { path: `${CALIBRATION_DIR}/allowed-models.json`, validate: (root, relative) => jsonReason(root, relative, () => readAllowlist(absolute(root, relative)) !== null, STRING_ARRAY) },
];

const problemsOf = (root, configs) => {
  const problems = [];
  for (const config of configs) {
    if (fileStat(absolute(root, config.path)) === null) {
      problems.push({ subject: config.path, reason: 'missing (required file)' });
      continue;
    }
    const reason = config.validate(root, config.path);
    if (reason !== null) problems.push({ subject: config.path, reason });
  }
  return problems;
};

// The five mandatory trusted configs, the optional contract overlay (checked by building the
// contract with the core) and, only while Judge is enabled, its two calibration configs.
module.exports = {
  name: 'trusted-configs',
  VERIFIER_DIR,
  CALIBRATION_DIR,
  run(context) {
    const { root } = context;
    const problems = problemsOf(root, MANDATORY);

    if (fileStat(absolute(root, OVERLAY_PATH)) !== null) {
      const reason = throwingReason(() => buildContract(absolute(root, OVERLAY_PATH)));
      if (reason !== null) problems.push({ subject: OVERLAY_PATH, reason });
    }

    const loaded = context.profile();
    if (!loaded.ok) {
      problems.push(profileUnusable(CALIBRATION_DIR));
    } else if (loaded.profile.judge?.enabled === true) {
      problems.push(...problemsOf(root, JUDGE_CONFIGS));
    }
    return problems;
  },
};
