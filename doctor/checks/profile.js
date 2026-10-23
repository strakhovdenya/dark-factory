'use strict';

const path = require('node:path');
const { coreRegistry } = require('../../verifier/checks');
const { REQUIRED_PROFILE_SETTINGS } = require('../../ralph/run');
const { PROFILE_RELATIVE_PATH } = require('../context');

const PROFILE_FILE = PROFILE_RELATIVE_PATH.replaceAll(path.sep, '/');
const HUMAN_NEEDED = REQUIRED_PROFILE_SETTINGS.find(({ field }) => field === 'labels.humanNeeded');

// The profile through its loader, the enabled verifier checks against the core registry (an empty
// list stays empty), and the label Ralph cannot start without.
module.exports = {
  name: 'profile',
  run(context) {
    const loaded = context.profile();
    if (!loaded.ok) return [{ subject: PROFILE_FILE, reason: loaded.error }];
    const { profile } = loaded;
    const problems = [];
    const { unknown } = coreRegistry.select(profile.verifier?.checks ?? []);
    for (const name of unknown) {
      problems.push({ subject: 'verifier.checks', reason: `unknown check "${name}"; the core registry has: ${coreRegistry.names().join(', ')}` });
    }
    if (profile.ralph?.enabled === true && HUMAN_NEEDED.read(profile) === undefined) {
      problems.push({ subject: 'labels.humanNeeded', reason: 'required field is missing (ralph.enabled is true): Ralph blocks an issue with this label' });
    }
    return problems;
  },
};
