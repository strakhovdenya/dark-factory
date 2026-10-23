'use strict';

// Entry of the Ralph Docker integration (`npm run test:ralph:sandbox`): checks the prerequisites,
// then runs test/integration/ralph-sandbox.test.js with the real node test runner and accepts the
// result only when every test ran and passed. It never builds or pulls an image and never falls
// back to the host: a missing Docker CLI, an unreachable or non-Linux engine, a non-Linux host, a
// missing prepared image or a claude CLI that is not the pinned one is an error with its reason.
// The images come from `npm run prepare:ralph:sandbox` (prepare-ralph-sandbox.js).
//
// Requiring this file has no side effects; the helpers are shared with the prepare entry and the
// integration test.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'ralph-sandbox');
const INTEGRATION_TEST = path.join(__dirname, 'ralph-sandbox.test.js');
// Another integration config (same shape as fixtures/ralph-sandbox/integration.json); used by the
// negative scenarios of the integration test itself.
const CONFIG_ENV = 'RALPH_SANDBOX_IT_CONFIG';
const DOCKER = 'docker';
const PREPARE_HINT = 'run `npm run prepare:ralph:sandbox` first';
const TAP_COUNTERS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

class IntegrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/** @returns {any} */
const loadConfig = (env = process.env) => {
  const file = env[CONFIG_ENV] || path.join(FIXTURE_DIR, 'integration.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

/**
 * Reasons the controller host or the engine is not the supported Linux + Linux engine pair.
 * @param {{ platform: string, engineOs?: string }} input
 */
function platformProblems({ platform, engineOs }) {
  const problems = [];
  if (platform !== 'linux') problems.push(`the integration runs on a Linux host (WSL included), this host is ${platform}`);
  if (engineOs !== undefined && engineOs !== 'linux') problems.push(`the integration needs a Linux Docker engine, this engine is ${engineOs || 'unknown'}`);
  return problems;
}

// The engine's OS; throws with the reason when the CLI is missing or the engine does not answer.
function engineOsOf(docker = DOCKER, env = process.env) {
  const result = childProcess.spawnSync(docker, ['version', '--format', '{{.Server.Os}}'], { encoding: 'utf8', env });
  const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  if (error) throw new IntegrationError(`the Docker CLI is not available (${error.code || error.message})`);
  if (result.status !== 0) throw new IntegrationError(`the Docker engine is not reachable: ${String(result.stderr).trim() || `exit ${result.status}`}`);
  return String(result.stdout).trim();
}

function assertImage(image, docker = DOCKER, env = process.env) {
  const result = childProcess.spawnSync(docker, ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', env });
  if (result.status !== 0) throw new IntegrationError(`the prepared image ${image} is missing (${String(result.stderr).trim() || `exit ${result.status}`}); ${PREPARE_HINT}`);
  return String(result.stdout).trim();
}

/**
 * `claude --version` in `image` must report `expected`. Only the source image is checked: in the
 * stub image the stub comes first in PATH. `env` adds container variables (a test removes claude
 * from PATH with it); `dockerEnv` is the Docker CLI's own environment.
 */
function verifyPinnedCli(image, expected, { docker = DOCKER, env = {}, dockerEnv = process.env } = {}) {
  const envArgs = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
  const result = childProcess.spawnSync(docker, ['run', '--rm', '--network', 'none', ...envArgs, image, 'claude', '--version'], { encoding: 'utf8', env: dockerEnv });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error || result.status !== 0) {
    throw new IntegrationError(`claude --version in ${image} failed (${result.error ? result.error.message : `exit ${result.status}`}): expected the pinned ${expected}, got: ${output.slice(0, 300)}`);
  }
  const actual = (/(\d+\.\d+\.\d+)/.exec(output) || [])[1] || output;
  if (actual !== expected) throw new IntegrationError(`claude --version in ${image}: expected the pinned ${expected}, got ${actual}`);
  return actual;
}

/**
 * Host, engine and images; throws an IntegrationError naming the first unmet prerequisite.
 * @param {{ config?: any, docker?: string, env?: NodeJS.ProcessEnv, platform?: string, images?: boolean }} [options]
 */
function checkPrerequisites({ config = loadConfig(), docker = DOCKER, env = process.env, platform = process.platform, images = true } = {}) {
  const hostProblems = platformProblems({ platform });
  if (hostProblems.length > 0) throw new IntegrationError(hostProblems.join('; '));
  const engineOs = engineOsOf(docker, env);
  const engineProblems = platformProblems({ platform, engineOs });
  if (engineProblems.length > 0) throw new IntegrationError(engineProblems.join('; '));
  if (!images) return { engineOs };
  const sourceId = assertImage(config.sandbox.image, docker, env);
  const stubId = assertImage(config.stubImage, docker, env);
  const cliVersion = verifyPinnedCli(config.sandbox.image, config.sandbox.claudeCodeVersion, { docker, dockerEnv: env });
  return { engineOs, sourceId, stubId, cliVersion };
}

/**
 * The counters of a TAP report of the node test runner and why it is not a full pass: a failure,
 * a cancelled test, any skip or todo, no test at all, a test file that defined no test (the runner
 * reports such a file as one passing test named by its path) or a missing counter.
 * @param {string} text
 * @param {string[]} [files] the test files of the run
 */
function evaluateTap(text, files = []) {
  const counts = {};
  for (const name of TAP_COUNTERS) {
    const matches = [...String(text).matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    counts[name] = matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
  }
  const problems = [];
  for (const name of TAP_COUNTERS) if (counts[name] === null) problems.push(`the report has no "${name}" counter`);
  if (counts.tests === 0) problems.push('no test ran');
  // The runner reports a file that defined no test as one passing test named by the file's path.
  const testPoint = /^(?:not )?ok \d+ - (.*)$/gm;
  const topLevel = new Set([...String(text).matchAll(testPoint)].map((match) => match[1]));
  // The TAP reporter escapes backslashes and `#` in names.
  const tapName = (file) => file.replace(/\\/g, '\\\\').replace(/#/g, '\\#');
  for (const file of files) if (topLevel.has(file) || topLevel.has(tapName(file))) problems.push(`${file} defined no test`);
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) if (counts[name] > 0) problems.push(`${counts[name]} test(s) ${name}`);
  if (counts.tests !== null && counts.pass !== counts.tests) problems.push(`${counts.pass} of ${counts.tests} test(s) passed`);
  return { counts, problems };
}

/**
 * Runs test files with the real node test runner (spec to the console, TAP to a file) and judges
 * the result. `code` is 0 only for a full pass with a zero runner exit.
 * @param {string[]} files
 * @param {{ env?: NodeJS.ProcessEnv, stdio?: 'inherit' | 'pipe' }} [options]
 */
function runTestFiles(files, { env = process.env, stdio = 'inherit' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-it-report-'));
  const tapFile = path.join(dir, 'report.tap');
  try {
    const args = ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tapFile}`, ...files];
    // A runner started from inside another test run would report to its parent, not to the reporters.
    const ownEnv = { ...env, NODE_TEST_CONTEXT: undefined };
    const result = childProcess.spawnSync(process.execPath, args, { env: ownEnv, stdio: stdio === 'inherit' ? 'inherit' : 'pipe', encoding: 'utf8', cwd: REPO_ROOT });
    const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, 'utf8') : '';
    const { counts, problems } = evaluateTap(tap, files);
    if (result.status !== 0) problems.unshift(`the test runner exited ${result.status ?? result.signal}`);
    return { code: problems.length === 0 ? 0 : 1, counts, problems, output: `${result.stdout || ''}${result.stderr || ''}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  try {
    const ready = checkPrerequisites();
    process.stdout.write(`Ralph sandbox integration: engine ${ready.engineOs}, claude ${ready.cliVersion}, images ready\n`);
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    process.stderr.write(`Ralph sandbox integration cannot run: ${error.message}\n`);
    return 1;
  }
  const result = runTestFiles([INTEGRATION_TEST]);
  if (result.code !== 0) {
    process.stderr.write(`Ralph sandbox integration failed: ${result.problems.join('; ')}\n`);
    return 1;
  }
  process.stdout.write(`Ralph sandbox integration passed: ${result.counts.pass} of ${result.counts.tests} tests\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  REPO_ROOT,
  FIXTURE_DIR,
  INTEGRATION_TEST,
  CONFIG_ENV,
  IntegrationError,
  loadConfig,
  platformProblems,
  engineOsOf,
  assertImage,
  verifyPinnedCli,
  checkPrerequisites,
  evaluateTap,
  runTestFiles,
};
