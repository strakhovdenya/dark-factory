'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadCore, mergeOverlay, DEFAULT_OVERLAY } = require('./issue-contract');

// A snapshot of the rules one verifier round actually used: the project's
// trusted settings as the round's checkout held them, and the prompt, schema
// and issue contract the round ran with. It is a diagnostic record for
// Calibration Judge and never an input of the verdict: a failure to form or
// store it changes nothing in the round. Its content is data; nothing in it is
// executed. Each part states what happened to it:
//   saved       the content and its hash are kept;
//   absent      the file does not exist in the trusted checkout (a historical
//               fact of the round, with the reason);
//   unused      the round did not use the part (for example the model did not
//               run), with the reason;
//   unavailable the part exists but could not be turned into a rule (for
//               example an overlay that is not valid), with the reason.
// An unreadable source that exists, a missing prompt or schema of a round
// that ran the model, and any write error are formation failures: no snapshot
// file is left behind.

const FORMAT_VERSION = 1;
const SUPPORTED_FORMAT_VERSIONS = Object.freeze([1]);

const STATE_SAVED = 'saved';
const STATE_ABSENT = 'absent';
const STATE_UNUSED = 'unused';
const STATE_UNAVAILABLE = 'unavailable';

const FULL_SHA = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

const PROFILE_FILE = path.join('.factory', 'profile.json');

// Trusted settings of the project, read from its default-branch checkout.
const PROJECT_PARTS = Object.freeze([
  { name: 'profile', file: PROFILE_FILE },
  { name: 'risk_zones', file: path.join('.github', 'verifier', 'risk-zones.json') },
  { name: 'owners', file: path.join('.github', 'verifier', 'owners.json') },
  { name: 'required_checks', file: path.join('.github', 'verifier', 'required-checks.json') },
  { name: 'verifier_allowed_models', file: path.join('.github', 'verifier', 'allowed-models.json') },
  { name: 'tampering_config', file: path.join('.github', 'verifier', 'tampering-scan.json') },
  { name: 'issue_contract_overlay', file: DEFAULT_OVERLAY },
]);

const PART_NAMES = Object.freeze([
  ...PROJECT_PARTS.map(({ name }) => name),
  'enabled_checks',
  'prompt',
  'schema',
  'issue_contract',
]);

class SnapshotError extends Error {}

const sha256Of = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const forward = (file) => file.split(path.sep).join('/');

const saved = (file, content) => ({
  state: STATE_SAVED,
  path: forward(file),
  sha256: sha256Of(content),
  content,
});

const withoutContent = (state, file, reason) => ({ state, path: forward(file), reason });

// The text of an existing file, or null when it does not exist. Any other
// failure is a formation failure, never a silent "absent".
const readText = (file, read) => {
  try {
    return read(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new SnapshotError(`cannot read ${file}: ${error.message}`);
  }
};

const readProjectPart = ({ file }, projectDir, read) => {
  const content = readText(path.join(projectDir, file), read);
  return content === null
    ? withoutContent(STATE_ABSENT, file, 'the file is not in the trusted checkout of the project')
    : saved(file, content);
};

// The checks the profile enables, as the profile text names them.
const enabledChecksPart = (profilePart) => {
  const file = `${forward(PROFILE_FILE)}#verifier.checks`;
  if (profilePart.state !== STATE_SAVED) {
    return withoutContent(STATE_UNAVAILABLE, file, 'the profile is not saved');
  }
  try {
    const checks = JSON.parse(profilePart.content.replace(/^﻿/, ''))?.verifier?.checks ?? [];
    return saved(file, JSON.stringify(checks));
  } catch (error) {
    return withoutContent(STATE_UNAVAILABLE, file, `the profile is not valid JSON: ${error.message}`);
  }
};

// What the model was given. A round that ran the model must have both files.
const modelFilePart = (name, file, modelRan, read) => {
  const logical = `rendered ${name}`;
  if (!modelRan) {
    return withoutContent(STATE_UNUSED, logical, 'the model did not run in this round');
  }
  const content = readText(file, read);
  if (content === null) {
    throw new SnapshotError(`the model ran, but its ${name} file is missing: ${file}`);
  }
  return saved(logical, content);
};

// The contract the round linted the issue against: the core contract of the
// factory release with the project overlay added on top.
const contractPart = (overlayPart) => {
  const file = 'issue contract (core with overlay)';
  try {
    const overlay = overlayPart.state === STATE_SAVED ? JSON.parse(overlayPart.content) : null;
    return saved(file, JSON.stringify(mergeOverlay(loadCore(), overlay)));
  } catch (error) {
    return withoutContent(STATE_UNAVAILABLE, file, `the overlay cannot be applied: ${error.message}`);
  }
};

const checkOrigin = (origin) => {
  const problems = [];
  for (const key of ['factory_sha', 'project_sha', 'head_sha']) {
    if (!FULL_SHA.test(origin[key] ?? '')) problems.push(`${key} is not a full commit SHA`);
  }
  for (const key of ['run_id', 'run_attempt']) {
    if (!POSITIVE_INTEGER.test(String(origin[key] ?? ''))) problems.push(`${key} is not a positive integer`);
  }
  if (problems.length > 0) throw new SnapshotError(`origin is incomplete: ${problems.join('; ')}`);
};

/**
 * Builds the snapshot object of a round.
 * @param {{
 *   projectDir: string,
 *   origin: { factory_sha: string, project_sha: string, head_sha: string, run_id: string|number, run_attempt: string|number },
 *   modelRan: boolean,
 *   promptFile?: string,
 *   schemaFile?: string,
 *   read?: (file: string, encoding: 'utf8') => string,
 * }} options
 */
const buildSnapshot = ({ projectDir, origin, modelRan, promptFile, schemaFile, read = fs.readFileSync }) => {
  checkOrigin(origin);
  const parts = {};
  for (const spec of PROJECT_PARTS) parts[spec.name] = readProjectPart(spec, projectDir, read);
  parts.enabled_checks = enabledChecksPart(parts.profile);
  parts.prompt = modelFilePart('prompt', promptFile, modelRan, read);
  parts.schema = modelFilePart('schema', schemaFile, modelRan, read);
  parts.issue_contract = contractPart(parts.issue_contract_overlay);
  return {
    format_version: FORMAT_VERSION,
    origin: {
      factory_sha: origin.factory_sha,
      project_sha: origin.project_sha,
      head_sha: origin.head_sha,
      run_id: Number(origin.run_id),
      run_attempt: Number(origin.run_attempt),
    },
    parts,
  };
};

/**
 * Writes the snapshot atomically: the finished file appears at `outFile` only
 * after the whole content was written; on any error nothing is left there.
 */
const writeSnapshotFile = (outFile, snapshot, { fsApi = fs } = {}) => {
  if (fsApi.existsSync(outFile)) throw new SnapshotError(`${outFile} already exists`);
  const temporary = `${outFile}.${process.pid}.tmp`;
  try {
    fsApi.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    fsApi.renameSync(temporary, outFile);
  } catch (error) {
    fsApi.rmSync(temporary, { force: true });
    fsApi.rmSync(outFile, { force: true });
    throw new SnapshotError(`cannot write ${outFile}: ${error.message}`);
  }
};

const partProblem = (name, part) => {
  if (!isObject(part)) return `part ${name} is missing`;
  if (part.state === STATE_SAVED) {
    if (typeof part.content !== 'string') return `part ${name} has no content`;
    if (part.sha256 !== sha256Of(part.content)) return `part ${name} does not match its hash`;
    return null;
  }
  const states = [STATE_ABSENT, STATE_UNUSED, STATE_UNAVAILABLE];
  if (!states.includes(part.state)) return `part ${name} has an unknown state`;
  if (typeof part.reason !== 'string' || part.reason === '') return `part ${name} has no reason`;
  return null;
};

/**
 * Reads a snapshot read from an artifact. The format version is checked before
 * anything else is read, so a newer or damaged format is rejected as a whole.
 * Hashes check integrity only; where the snapshot came from is checked by
 * checkSnapshotOrigin.
 * @returns {{ ok: boolean, snapshot?: any, reason?: string }}
 */
const parseSnapshot = (text) => {
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `snapshot is not valid JSON: ${error.message}` };
  }
  if (!isObject(snapshot)) return { ok: false, reason: 'snapshot is not a JSON object' };
  if (!SUPPORTED_FORMAT_VERSIONS.includes(snapshot.format_version)) {
    return { ok: false, reason: `snapshot format version ${snapshot.format_version} is not supported` };
  }
  if (!isObject(snapshot.origin)) return { ok: false, reason: 'snapshot has no origin' };
  if (!isObject(snapshot.parts)) return { ok: false, reason: 'snapshot has no parts' };
  for (const name of PART_NAMES) {
    const problem = partProblem(name, snapshot.parts[name]);
    if (problem !== null) return { ok: false, reason: problem };
  }
  return { ok: true, snapshot };
};

/**
 * Checks that a parsed snapshot belongs to the round: it was formed by a run
 * of the round's workflow run, no later than the round's attempt, by the
 * round's factory release, for the round's head commit.
 * @param {any} snapshot
 * @param {{ runId: number, runAttempt: number, headSha: string, verifierCommit: string }} round
 * @returns {{ ok: boolean, attempt?: number, reason?: string }}
 */
const checkSnapshotOrigin = (snapshot, round) => {
  const { origin } = snapshot;
  /** @param {string} reason */
  const reject = (reason) => /** @type {const} */ ({ ok: false, reason });
  if (!FULL_SHA.test(round.verifierCommit ?? '')) {
    return reject('the round records no verifier commit to compare with');
  }
  if (!FULL_SHA.test(round.headSha ?? '')) return reject('the round records no head commit');
  if (origin.run_id !== round.runId) {
    return reject(`snapshot belongs to run ${origin.run_id}, not run ${round.runId}`);
  }
  if (!Number.isInteger(origin.run_attempt) || origin.run_attempt < 1) {
    return reject('snapshot has no attempt');
  }
  if (origin.run_attempt > round.runAttempt) {
    return reject(`snapshot is from attempt ${origin.run_attempt}, later than attempt ${round.runAttempt}`);
  }
  if (origin.factory_sha !== round.verifierCommit) {
    return reject('snapshot was formed by another factory release than the round used');
  }
  if (origin.head_sha !== round.headSha) {
    return reject('snapshot was formed for another head commit than the round');
  }
  if (!FULL_SHA.test(origin.project_sha ?? '')) return reject('snapshot has no project settings commit');
  return { ok: true, attempt: origin.run_attempt };
};

const usage = () =>
  'usage: policy-snapshot.js write --project <trusted-checkout> --out <file> ' +
  '--factory-sha <sha> --requested-ref <sha> --head-sha <sha> --run-id <id> ' +
  '--run-attempt <n> --model-ran <true|false> [--prompt <file> --schema <file>]';

const OPTION_KEYS = Object.freeze({
  '--project': 'project',
  '--out': 'out',
  '--factory-sha': 'factorySha',
  '--requested-ref': 'requestedRef',
  '--head-sha': 'headSha',
  '--run-id': 'runId',
  '--run-attempt': 'runAttempt',
  '--model-ran': 'modelRan',
  '--prompt': 'prompt',
  '--schema': 'schema',
});

const REQUIRED_OPTIONS = Object.freeze([
  'project',
  'out',
  'factorySha',
  'requestedRef',
  'headSha',
  'runId',
  'runAttempt',
  'modelRan',
]);

/** @returns {Record<string, string> | null} */
const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  if (command !== 'write') return null;
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = OPTION_KEYS[rest[index]];
    const value = rest[index + 1];
    if (key === undefined || value === undefined) return null;
    options[key] = value;
  }
  return REQUIRED_OPTIONS.every((key) => options[key] !== undefined) ? options : null;
};

const gitHead = (dir) =>
  execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (args === null || !['true', 'false'].includes(args.modelRan)) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  try {
    const projectSha = gitHead(args.project);
    if (projectSha !== args.requestedRef) {
      throw new SnapshotError(
        `the trusted checkout is ${projectSha}, not the requested ${args.requestedRef}`,
      );
    }
    const snapshot = buildSnapshot({
      projectDir: args.project,
      origin: {
        factory_sha: args.factorySha,
        project_sha: projectSha,
        head_sha: args.headSha,
        run_id: args.runId,
        run_attempt: args.runAttempt,
      },
      modelRan: args.modelRan === 'true',
      promptFile: args.prompt,
      schemaFile: args.schema,
    });
    writeSnapshotFile(args.out, snapshot);
  } catch (error) {
    process.stderr.write(`policy snapshot was not formed: ${error.message}\n`);
    return 1;
  }
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  FORMAT_VERSION,
  SUPPORTED_FORMAT_VERSIONS,
  STATE_SAVED,
  STATE_ABSENT,
  STATE_UNUSED,
  STATE_UNAVAILABLE,
  PART_NAMES,
  SnapshotError,
  sha256Of,
  buildSnapshot,
  writeSnapshotFile,
  parseSnapshot,
  checkSnapshotOrigin,
  parseArgs,
  main,
};
