'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;
const schema = require('./schema.json');

const PROFILE_RELATIVE_PATH = path.join('.factory', 'profile.json');

let validateProfile = null;

function getValidator() {
  if (!validateProfile) {
    validateProfile = new Ajv2020({ allErrors: true }).compile(schema);
  }
  return validateProfile;
}

/** Builds a dotted field path (`apps[0].name`) from an ajv error; '' is the profile root. */
function fieldPath(error) {
  const segments = error.instancePath.split('/').slice(1);
  if (error.keyword === 'required') segments.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties') segments.push(error.params.additionalProperty);
  let result = '';
  for (const raw of segments) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    result += /^\d+$/.test(segment) ? `[${segment}]` : (result ? '.' : '') + segment;
  }
  return result;
}

function describeError(error) {
  const field = fieldPath(error) || '(profile)';
  if (error.keyword === 'required') return `${field}: required field is missing`;
  if (error.keyword === 'additionalProperties') return `${field}: unknown field`;
  return `${field}: ${error.message}`;
}

/**
 * Reads and validates `<projectRoot>/.factory/profile.json`. The only reader of the profile for
 * factory cores. Throws an Error naming the profile file and every offending field.
 */
function loadProfile(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new TypeError('loadProfile: projectRoot must be a non-empty string');
  }
  const profilePath = path.join(path.resolve(projectRoot), PROFILE_RELATIVE_PATH);

  let text;
  try {
    text = fs.readFileSync(profilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Profile not found: expected ${profilePath}`, { cause: error });
    }
    throw new Error(`Cannot read profile ${profilePath}: ${error.message}`, { cause: error });
  }

  let profile;
  try {
    profile = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`Profile ${profilePath} is not valid JSON: ${error.message}`, { cause: error });
  }

  const validate = getValidator();
  if (!validate(profile)) {
    // The "if" error only restates the failing "then" branch, which is reported by its own errors.
    const lines = validate.errors.filter((e) => e.keyword !== 'if').map(describeError);
    const list = [...new Set(lines)].map((line) => `  - ${line}`).join('\n');
    throw new Error(`Invalid profile ${profilePath}:\n${list}`);
  }
  return profile;
}

module.exports = { loadProfile, PROFILE_RELATIVE_PATH };
