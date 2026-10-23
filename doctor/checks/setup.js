'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectPlan, SetupError, MANIFEST_PATH } = require('../../bin/setup');
const { profileUnusable } = require('../context');
const { installedPackage, INSTALLED } = require('./package');

// The copies of skills and agents: the plan setup would make, prepared without applying it, from
// the package installed in the selected project. Conflicts, list and exclusion errors come from
// that plan; a copy or the list missing after installation is added here.
module.exports = {
  name: 'setup',
  run(context) {
    const { root } = context;
    const loaded = context.profile();
    if (!loaded.ok) return [profileUnusable('.claude (skill and agent copies)')];
    const installed = installedPackage(root);
    if (installed.reason !== null) return [{ subject: '.claude (skill and agent copies)', reason: `not checked: the package is not usable (${INSTALLED}): ${installed.reason}` }];

    let plan;
    try {
      plan = inspectPlan({ root, packageRoot: installed.dir, profile: loaded.profile });
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      return [{ subject: '.claude (skill and agent copies)', reason: error.message }];
    }

    const problems = plan.problems.map((reason) => ({ subject: '.claude (setup plan)', reason }));
    if (!fs.existsSync(path.join(root, MANIFEST_PATH))) {
      problems.push({ subject: MANIFEST_PATH, reason: 'the list of installed copies is missing' });
    }
    for (const item of plan.wanted) {
      if (plan.problems.some((problem) => problem.includes(`"${item.destination}"`))) continue;
      if (fs.lstatSync(path.join(root, item.destination), { throwIfNoEntry: false }) === undefined) {
        problems.push({ subject: item.destination, reason: `the expected ${item.kind} copy is missing` });
      }
    }
    return problems;
  },
};
