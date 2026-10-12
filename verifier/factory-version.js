'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// The factory release a project runs is pinned twice: the project wrapper
// calls the reusable workflow by a commit SHA, and the project's package.json
// on its default branch names the release tag the verifier scripts come from.
// This module reads that tag and checks that both pins name one commit.

const FACTORY_PACKAGE = 'dark-factory';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const BOM = 0xfeff;

// "owner/name" of a git dependency source (the spec before "#"), or null.
// Accepts the GitHub forms npm installs from: github:owner/name,
// owner/name, https://, git+https://, git+ssh:// and git@ URLs.
const GITHUB_SOURCE = new RegExp(
  '^(?:github:|(?:git\\+)?https://github\\.com/|git\\+ssh://git@github\\.com/|git@github\\.com:)?' +
    '([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\\.git)?$',
);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const repositoryOf = (source) => GITHUB_SOURCE.exec(source)?.[1].toLowerCase() ?? null;

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
// "latest", a semver range, no ref at all) is a floating reference. With
// repository ("owner/name"), the spec must also install from that
// repository, so the release the project runs is the one the tag names here.
const readFactoryTag = (packageJson, { repository = null } = {}) => {
  const spec = factorySpecOf(packageJson);
  const hash = spec.lastIndexOf('#');
  const ref = hash === -1 ? '' : spec.slice(hash + 1);
  if (!RELEASE_TAG.test(ref)) {
    const what = ref === '' ? 'it names no tag' : `"${ref}" is not a release tag vX.Y.Z`;
    throw new Error(
      `floating factory reference "${spec}": ${what}; pin the dependency to a release tag`,
    );
  }
  if (repository !== null && repositoryOf(spec.slice(0, hash)) !== repository.toLowerCase()) {
    throw new Error(`factory dependency "${spec}" does not install from ${repository}`);
  }
  return ref;
};

const readFactoryTagFile = (file, options = {}) => {
  let packageJson;
  try {
    const text = fs.readFileSync(file, 'utf8');
    packageJson = JSON.parse(text.charCodeAt(0) === BOM ? text.slice(1) : text);
  } catch (error) {
    throw new Error(`${file} is not readable JSON: ${error.message}`, { cause: error });
  }
  return readFactoryTag(packageJson, options);
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

const runGit = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// The whole pin check of a workflow run: the tag from the project's
// package.json, resolved to its commit in the factory checkout's origin, must
// be wrapperSha. Returns { tag, tagSha }; throws with the reason otherwise.
const verifyPin = ({ packageFile, repository, factoryDir, wrapperSha, git = runGit }) => {
  const tag = readFactoryTagFile(packageFile, { repository });
  let tagSha;
  try {
    git(factoryDir, ['fetch', '--no-tags', '--depth=1', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`]);
    tagSha = git(factoryDir, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    throw new Error(`factory tag ${tag} cannot be resolved in ${repository}: ${detail}`, {
      cause: error,
    });
  }
  checkTagMatchesSha({ tag, tagSha, wrapperSha });
  return { tag, tagSha };
};

const usage = () =>
  'usage: factory-version.js verify --package <package.json> --repository <owner/name> ' +
  '--factory-dir <dir> --wrapper-sha <sha>';

const OPTION_KEYS = {
  '--package': 'packageFile',
  '--repository': 'repository',
  '--factory-dir': 'factoryDir',
  '--wrapper-sha': 'wrapperSha',
};

/** @returns {Record<string, string> | null} */
const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  if (command !== 'verify') return null;
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!Object.hasOwn(OPTION_KEYS, flag)) return null;
    if (value === undefined || value.startsWith('--')) return null;
    options[OPTION_KEYS[flag]] = value;
  }
  const complete = Object.values(OPTION_KEYS).every((key) => options[key] !== undefined);
  return complete ? options : null;
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  try {
    const { packageFile, repository, factoryDir, wrapperSha } = args;
    const { tag, tagSha } = verifyPin({ packageFile, repository, factoryDir, wrapperSha });
    process.stdout.write(`factory pin: ${tag} (${tagSha})\n`);
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
  verifyPin,
  parseArgs,
  main,
};
