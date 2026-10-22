'use strict';

// The profile the controller trusts for one run: a frozen copy of the host's validated profile
// taken at start, and the check that the clone's selected base carries the same profile. Profiles
// are read only by profile/load.js.

const { isDeepStrictEqual } = require('node:util');
const { loadProfile } = require('../profile/load');

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** A separate deep copy of a validated profile, frozen recursively; the caller's object is untouched. */
const freezeSnapshot = (profile) => deepFreeze(structuredClone(profile));

/**
 * Loads the profile of the clone's checked-out base and compares it with the trusted snapshot by
 * JSON value: object key order is irrelevant, array order is not. Throws a configuration error
 * naming the host, the clone and the base; a loader failure keeps its own reason. Nothing is
 * repaired or published.
 */
function assertBaseProfileMatches({ snapshot, consumerRoot, runDir, baseRef }) {
  const where = `host ${consumerRoot}, clone ${runDir}, base ${baseRef}`;
  let baseProfile;
  try {
    baseProfile = loadProfile(runDir);
  } catch (error) {
    throw new Error(`Configuration error: the profile of the selected base cannot be used (${where}): ${error.message}`, { cause: error });
  }
  if (!isDeepStrictEqual(baseProfile, snapshot)) {
    throw new Error(`Configuration error: the profile of the selected base differs from the host profile loaded at start (${where}); the controller does not repair or publish profiles — commit the same profile to the base`);
  }
}

module.exports = { freezeSnapshot, assertBaseProfileMatches };
