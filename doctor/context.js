'use strict';

// What the checks share for one run: the selected project root and the values read once from it.

const { loadProfile, PROFILE_RELATIVE_PATH } = require('../profile/load');
const { createGithub } = require('./github');

/**
 * @param {{ root: string, packageRoot: string }} options root is the selected project;
 * packageRoot is the executing package (only its metadata is used, never as the project's package)
 */
const createContext = ({ root, packageRoot }) => {
  let profileResult = null;
  const github = createGithub(root);
  return {
    root,
    packageRoot,
    github,
    /** The profile through the one loader: { ok: true, profile } or { ok: false, error }. */
    profile() {
      if (profileResult === null) {
        try {
          profileResult = { ok: true, profile: loadProfile(root) };
        } catch (error) {
          profileResult = { ok: false, error: String(error.message).replace(/\s*\r?\n\s*/g, ' ') };
        }
      }
      return profileResult;
    },
  };
};

/** The problem of a check that depends on the profile when the profile cannot be used. */
const profileUnusable = (subject) => ({ subject, reason: 'not checked: the profile is unusable (see the profile problem above)' });

module.exports = { createContext, profileUnusable, PROFILE_RELATIVE_PATH };
