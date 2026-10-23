'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseAllowedModels } = require('../../verifier/verdict/inputs');
const { readAllowlist } = require('../../judge/calibration-judge');
const { fileStat } = require('../files');
const { VERIFIER_MODEL_VARIABLE, JUDGE_MODEL_VARIABLE } = require('./github');

const VERIFIER_LIST = '.github/verifier/allowed-models.json';
const JUDGE_LIST = '.github/calibration/allowed-models.json';

const valueOf = (context, name) => {
  const read = context.github.variables();
  if (!read.ok) return null;
  return read.items.find((item) => item.name === name)?.value ?? null;
};

// An unusable list is null: the trusted-configs check reports it.
const verifierList = (root) => {
  const file = path.join(root, ...VERIFIER_LIST.split('/'));
  if (fileStat(file) === null) return null;
  try {
    return parseAllowedModels(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const judgeList = (root) => {
  const file = path.join(root, ...JUDGE_LIST.split('/'));
  return fileStat(file) === null ? null : readAllowlist(file);
};

// Each model variable against its own list. A missing variable, an unreadable list or a failed
// GitHub read is reported by the checks that own them, not here.
module.exports = {
  name: 'models',
  run(context) {
    const loaded = context.profile();
    if (!loaded.ok) return [];
    const { profile } = loaded;
    const problems = [];

    if ((profile.verifier?.checks ?? []).includes('allowed-model')) {
      const model = valueOf(context, VERIFIER_MODEL_VARIABLE);
      const list = verifierList(context.root);
      if (model !== null && list !== null && !list.includes(model)) {
        problems.push({ subject: `GitHub variable ${VERIFIER_MODEL_VARIABLE}`, reason: `"${model}" is not in ${VERIFIER_LIST} (the allowed-model check is enabled)` });
      }
    }
    if (profile.judge?.enabled === true) {
      const model = valueOf(context, JUDGE_MODEL_VARIABLE);
      const list = judgeList(context.root);
      if (model !== null && list !== null && !list.includes(model)) {
        problems.push({ subject: `GitHub variable ${JUDGE_MODEL_VARIABLE}`, reason: `"${model}" is not in ${JUDGE_LIST}` });
      }
    }
    return problems;
  },
};
