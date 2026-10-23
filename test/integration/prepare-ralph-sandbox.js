'use strict';

// Prepares the images of the Ralph Docker integration (`npm run prepare:ralph:sandbox`); the only
// step that builds or downloads anything. The current working version of the factory is laid out
// as an installed package with its runtime dependencies (offline, from this checkout's
// node_modules); the package's own sandbox.buildImage builds the source image from that copy's
// assets; then the derived stub image is built from test/fixtures/ralph-sandbox/Dockerfile with the
// same copy as its `factory` context. Linux host with a Linux Docker engine and BuildKit only.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installFactoryRuntime } = require('../helpers/factory-package');
const { FIXTURE_DIR, IntegrationError, loadConfig, checkPrerequisites } = require('./run-ralph-sandbox');

function buildStubImage(config, nodeModules) {
  const args = [
    'build',
    '-t',
    config.stubImage,
    '--build-arg',
    `SOURCE_IMAGE=${config.sandbox.image}`,
    '--build-context',
    `factory=${nodeModules}`,
    '-f',
    path.join(FIXTURE_DIR, 'Dockerfile'),
    FIXTURE_DIR,
  ];
  const result = childProcess.spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new IntegrationError(`building the stub image ${config.stubImage} failed (${result.error ? result.error.message : `exit ${result.status}`})`);
  }
}

function prepare() {
  const config = loadConfig();
  checkPrerequisites({ config, images: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-it-prepare-'));
  try {
    const nodeModules = path.join(dir, 'node_modules');
    const { packageRoot } = installFactoryRuntime(nodeModules);
    const sandbox = require(path.join(packageRoot, 'ralph', 'sandbox.js'));
    const sandboxConfig = sandbox.validateSandboxConfig(config.sandbox);
    process.stdout.write(`Building the source image ${sandboxConfig.image} with sandbox.buildImage of ${packageRoot}\n`);
    sandbox.buildImage(sandboxConfig);
    process.stdout.write(`Building the stub image ${config.stubImage}\n`);
    buildStubImage(config, nodeModules);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ready = checkPrerequisites({ config });
  process.stdout.write(`Prepared ${config.sandbox.image} (claude ${ready.cliVersion}) and ${config.stubImage}\n`);
}

if (require.main === module) {
  try {
    prepare();
  } catch (error) {
    process.stderr.write(`Preparing the Ralph sandbox integration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepare, buildStubImage };
