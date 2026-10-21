'use strict';

const path = require('node:path');
const { issueNumberOfBranch } = require('../profile/branch');
const { verifyPin } = require('../verifier/factory-version');

// Judge is an optional element: it runs only for a valid project profile with
// judge.enabled: true. The answer has three states, and the difference matters:
// - disabled: a valid profile without a judge section or with enabled false;
//   an ordinary skip, in any way of starting Judge;
// - invalid: no profile, an invalid profile, or a wrapper SHA that is not the
//   project's pinned release; a configuration error, never an ordinary skip;
// - enabled: the label and the branch template come from the profile.

const STATUS_ENABLED = 'enabled';
const STATUS_DISABLED = 'disabled';
const STATUS_INVALID = 'invalid';

const invalid = (reason) => ({ status: STATUS_INVALID, reason });

// The profile loader brings its own dependencies, which only the jobs that
// read the profile install.
const readProfile = (projectRoot) => require('../profile/load').loadProfile(projectRoot);

/**
 * @param {{
 *   projectRoot: string,
 *   checkPin?: () => void,
 *   read?: (projectRoot: string) => any,
 * }} options checkPin throws with the reason when the pin does not hold; it
 * runs only for an enabled Judge, so a disabled one needs no pin.
 */
const readJudgeConfig = ({ projectRoot, checkPin = () => {}, read = readProfile }) => {
  let profile;
  try {
    profile = read(projectRoot);
  } catch (error) {
    return invalid(`profile cannot be used: ${error.message}`);
  }
  if (profile.judge?.enabled !== true) {
    return { status: STATUS_DISABLED, reason: 'judge is not enabled in the profile' };
  }
  const label = profile.labels?.calibration;
  if (typeof label !== 'string' || label === '') {
    return invalid('profile enables judge without labels.calibration');
  }
  try {
    issueNumberOfBranch(profile.branchTemplate, '');
  } catch (error) {
    return invalid(`branchTemplate cannot be used: ${error.message}`);
  }
  try {
    checkPin();
  } catch (error) {
    return invalid(`factory pin is not confirmed: ${error.message}`);
  }
  return {
    status: STATUS_ENABLED,
    reason: 'judge is enabled in the profile',
    label,
    branchTemplate: profile.branchTemplate,
  };
};

/** The pin check of a workflow run: the project's pinned tag must be the wrapper SHA. */
const pinChecker = ({ projectRoot, repository, factoryDir, wrapperSha }) => () => {
  verifyPin({
    packageFile: path.join(projectRoot, 'package.json'),
    repository,
    factoryDir,
    wrapperSha,
  });
};

module.exports = {
  STATUS_ENABLED,
  STATUS_DISABLED,
  STATUS_INVALID,
  readJudgeConfig,
  pinChecker,
};
