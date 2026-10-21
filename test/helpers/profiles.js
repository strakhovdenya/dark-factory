'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILES_DIR = path.join(__dirname, '..', 'fixtures', 'profiles');
const FIXTURE_PROFILES = ['monorepo', 'single-package'];

const readFixture = (fixture) =>
  JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, fixture, '.factory', 'profile.json'), 'utf8'));

/**
 * A temporary project root whose profile is a copy of a fixture profile changed by `mutate`.
 * The fixture itself is never touched; the root is removed when the test ends. Load it with the
 * real loadProfile.
 */
const profileCopy = (t, fixture, mutate = (_profile) => {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = readFixture(fixture);
  mutate(profile);
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory', 'profile.json'), JSON.stringify(profile));
  return root;
};

/** Makes the judge section of a profile enabled with the given calibration label. */
const enableJudge = (label) => (profile) => {
  profile.judge = { enabled: true };
  profile.labels = { ...profile.labels, calibration: label };
};

module.exports = { FIXTURE_PROFILES, profileCopy, enableJudge };
