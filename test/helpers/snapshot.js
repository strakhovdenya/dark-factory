'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { profileCopy } = require('./profiles');
const { COMMON, readText } = require('./verdict');
const { buildSnapshot } = require('../../verifier/policy-snapshot');

const FACTORY_SHA = 'f'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);

const OVERLAY = {
  sections: [{ title: 'Rollout notes', required: false }],
  forbiddenPhrases: ['to be decided'],
};

const sandbox = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const writeFile = (root, relative, content) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

/**
 * The trusted checkout of a project: a copy of its fixture profile and the trusted verifier
 * configs. `without` lists files the project does not have; `mutate` changes the profile.
 * @param {any} t
 * @param {string} fixture
 * @param {{ overlay?: any, without?: string[], mutate?: (profile: any) => void, files?: Record<string, any> }} [options]
 */
const trustedCheckout = (t, fixture, { overlay = OVERLAY, without = [], mutate, files = {} } = {}) => {
  const root = profileCopy(t, fixture, mutate);
  const configs = {
    '.github/verifier/risk-zones.json': { zones: [{ name: 'billing_data', description: 'billing' }] },
    '.github/verifier/owners.json': ['maintainer'],
    '.github/verifier/required-checks.json': ['Lint', 'Test'],
    '.github/verifier/allowed-models.json': JSON.parse(readText(COMMON, 'allowed-models.json')),
    '.github/verifier/tampering-scan.json': JSON.parse(readText(COMMON, 'tampering-scan.json')),
    '.github/verifier/issue-contract.overlay.json': overlay,
    ...files,
  };
  for (const [relative, content] of Object.entries(configs)) {
    if (!without.includes(relative) && content !== null) writeFile(root, relative, content);
  }
  return root;
};

const renderedModelFiles = (t) => {
  const dir = sandbox(t);
  writeFile(dir, 'prompt.md', 'Verify the pull request.\nRisk zones: auth, billing_data\n');
  writeFile(dir, 'schema.json', { type: 'object', properties: { criteria: { type: 'array' } } });
  return { promptFile: path.join(dir, 'prompt.md'), schemaFile: path.join(dir, 'schema.json') };
};

const originOf = (overrides = {}) => ({
  factory_sha: FACTORY_SHA,
  project_sha: 'c'.repeat(40),
  head_sha: HEAD_SHA,
  run_id: 4242,
  run_attempt: 2,
  ...overrides,
});

/**
 * A snapshot object of a round formed for `fixture`, with the model having run.
 * @param {any} t
 * @param {string} fixture
 * @param {{ origin?: any, modelRan?: boolean, overlay?: any, without?: string[], mutate?: (profile: any) => void, files?: Record<string, any> }} [options]
 */
const snapshotOf = (t, fixture, { origin = originOf(), modelRan = true, ...options } = {}) =>
  buildSnapshot({
    projectDir: trustedCheckout(t, fixture, options),
    origin,
    modelRan,
    ...(modelRan ? renderedModelFiles(t) : {}),
  });

module.exports = {
  FACTORY_SHA,
  HEAD_SHA,
  OVERLAY,
  sandbox,
  writeFile,
  trustedCheckout,
  renderedModelFiles,
  originOf,
  snapshotOf,
};
