'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TAG_PATTERN = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns a list of error messages; an empty list means the tag may become a release. */
function checkRelease(tag, packageJsonText, changelogText) {
  const match = TAG_PATTERN.exec(String(tag));
  if (!match) {
    return [`tag "${tag}" must have the form vX.Y.Z`];
  }
  const tagVersion = match[1];

  let version;
  try {
    version = JSON.parse(packageJsonText).version;
  } catch (error) {
    return [`package.json is not valid JSON: ${error.message}`];
  }

  const errors = [];
  if (version !== tagVersion) {
    errors.push(`tag "${tag}" does not match package.json version "${version}"`);
  }
  const heading = new RegExp(`^## \\[${escapeRegExp(tagVersion)}\\](\\s|$)`, 'm');
  if (!heading.test(String(changelogText))) {
    errors.push(`CHANGELOG.md is missing section "## [${tagVersion}]"`);
  }
  return errors;
}

function checkRepository(rootDir, tag) {
  const read = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');
  return checkRelease(tag, read('package.json'), read('CHANGELOG.md'));
}

if (require.main === module) {
  const tag = process.argv[2];
  let errors;
  try {
    errors = checkRepository(path.resolve(__dirname, '..', '..'), tag);
  } catch (error) {
    errors = [error.message];
  }
  if (errors.length > 0) {
    for (const message of errors) console.error(`release-check: ${message}`);
    process.exit(1);
  }
  console.log(`release-check: ${tag} ok`);
}

module.exports = { checkRelease, checkRepository };
