'use strict';

const fs = require('node:fs');

// The factory release a project runs is pinned twice: the project wrapper
// calls the reusable workflow by a commit SHA, and the project's package.json
// on its default branch names the release tag the verifier scripts come from.
// This module reads that tag and checks that both pins name one commit; the
// workflow resolves the tag to its commit with git and passes it in.

const FACTORY_PACKAGE = 'dark-factory';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// The dependency spec of the factory, from dependencies or devDependencies.
// Throws when it is missing or the two fields disagree.
const factorySpecOf = (packageJson) => {
  if (!isObject(packageJson)) throw new Error('package.json is not a JSON object');
  const specs = DEPENDENCY_FIELDS
    .map((field) => packageJson[field]?.[FACTORY_PACKAGE])
    .filter((spec) => spec !== undefined);
  if (specs.length === 0) {
    throw new Error(
      `package.json has no "${FACTORY_PACKAGE}" dependency: the factory release is not pinned`,
    );
  }
  if (new Set(specs).size > 1) {
    throw new Error(
      `package.json pins "${FACTORY_PACKAGE}" twice with different specs: ${specs.join(', ')}`,
    );
  }
  const [spec] = specs;
  if (typeof spec !== 'string') {
    throw new Error(`"${FACTORY_PACKAGE}" dependency spec must be a string`);
  }
  return spec;
};

// The release tag of a git dependency spec such as
// "github:<owner>/dark-factory#v1.2.3". Anything that can move (a branch,
// "latest", a semver range, no ref at all) is a floating reference.
const readFactoryTag = (packageJson) => {
  const spec = factorySpecOf(packageJson);
  const hash = spec.lastIndexOf('#');
  const ref = hash === -1 ? '' : spec.slice(hash + 1);
  if (!RELEASE_TAG.test(ref)) {
    const what = ref === '' ? 'it names no tag' : `"${ref}" is not a release tag vX.Y.Z`;
    throw new Error(
      `floating factory reference "${spec}": ${what}; pin the dependency to a release tag`,
    );
  }
  return ref;
};

const readFactoryTagFile = (file) => {
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`${file} is not readable JSON: ${error.message}`, { cause: error });
  }
  return readFactoryTag(packageJson);
};

// Throws unless tagSha (the commit the tag resolves to) and wrapperSha (the
// SHA the wrapper called the reusable workflow with) are one full commit SHA.
const checkTagMatchesSha = ({ tag, tagSha, wrapperSha }) => {
  if (!FULL_SHA.test(wrapperSha ?? '')) {
    throw new Error(`wrapper SHA "${wrapperSha}" is not a full 40-character commit SHA`);
  }
  if (!FULL_SHA.test(tagSha ?? '')) {
    throw new Error(`tag ${tag} resolves to "${tagSha}", which is not a full commit SHA`);
  }
  if (tagSha !== wrapperSha) {
    throw new Error(
      `factory pin mismatch: tag ${tag} is commit ${tagSha}, the wrapper calls ${wrapperSha}`,
    );
  }
};

const usage = () =>
  'usage:\n' +
  '  factory-version.js tag --package <package.json>\n' +
  '  factory-version.js check --tag <vX.Y.Z> --tag-sha <sha> --wrapper-sha <sha>';

const OPTIONS = {
  tag: { '--package': 'packageFile' },
  check: { '--tag': 'tag', '--tag-sha': 'tagSha', '--wrapper-sha': 'wrapperSha' },
};

/** @returns {Record<string, string> | null} */
const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command)) return null;
  const keys = OPTIONS[command];
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = keys[rest[index]];
    const value = rest[index + 1];
    if (key === undefined || value === undefined || value.startsWith('--')) return null;
    options[key] = value;
  }
  const complete = Object.values(keys).every((key) => options[key] !== undefined);
  return complete ? { command, ...options } : null;
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  try {
    if (args.command === 'tag') {
      process.stdout.write(`${readFactoryTagFile(args.packageFile)}\n`);
    } else {
      const { tag, tagSha, wrapperSha } = args;
      checkTagMatchesSha({ tag, tagSha, wrapperSha });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  FACTORY_PACKAGE,
  readFactoryTag,
  readFactoryTagFile,
  checkTagMatchesSha,
  parseArgs,
  main,
};
