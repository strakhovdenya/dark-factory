'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Every file name, job name and marker this module reads comes from the
// config object (judge/inputs.json), never from a literal
// here. The only names hardcoded below are generic field
// names of an already-established cross-cutting data shape — the
// verifier's own run-provenance record and generic round-key/job-result
// fields — not project-specific paths, check names, logins or models.

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

const isInputEntry = (entry) =>
  isObject(entry) &&
  isNonEmptyString(entry.key) &&
  (entry.selfReport === true || isNonEmptyString(entry.path)) &&
  (entry.format === 'json' || entry.format === 'text') &&
  (entry.fallbackPath === undefined || isNonEmptyString(entry.fallbackPath)) &&
  (entry.statusField === undefined ||
    (isNonEmptyString(entry.statusField) && entry.format === 'json'));

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => isNonEmptyString(item));

// Fail closed: a missing/unparsable file, a malformed shape, a key
// duplicated across independentInputs/fullOnlyInputs, or the same file
// path listed in both lists all throw rather than silently loading a
// partial or ambiguous config.
const loadInputsConfig = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObject(data)) throw new Error('inputs config must be a JSON object');

  const { independentInputs, fullOnlyInputs, roundMeta } = data;
  const isEntryList = (list) => Array.isArray(list) && list.every(isInputEntry);
  if (!isEntryList(independentInputs)) {
    throw new Error('inputs config: independentInputs is invalid');
  }
  if (!isEntryList(fullOnlyInputs)) {
    throw new Error('inputs config: fullOnlyInputs is invalid');
  }
  if (!isStringArray(data.trustedConfigs)) {
    throw new Error('inputs config: trustedConfigs is invalid');
  }
  if (!isNonEmptyString(data.trustedConfigsRoot)) {
    throw new Error('inputs config: trustedConfigsRoot is invalid');
  }
  const { policy } = data;
  if (
    !isObject(policy) ||
    !isNonEmptyString(policy.statusFile) ||
    !isObject(policy.parts) ||
    !Object.values(policy.parts).every((file) => data.trustedConfigs.includes(file))
  ) {
    throw new Error('inputs config: policy is invalid');
  }
  if (
    !isObject(roundMeta) ||
    !isNonEmptyString(roundMeta.runFile) ||
    !isNonEmptyString(roundMeta.jobsFile) ||
    !isNonEmptyString(roundMeta.prFile) ||
    !isNonEmptyString(roundMeta.verifyJobName) ||
    !isNonEmptyString(roundMeta.reportJobName)
  ) {
    throw new Error('inputs config: roundMeta is invalid');
  }
  if (!isNonEmptyString(data.selfReportMarker)) {
    throw new Error('inputs config: selfReportMarker is invalid');
  }
  if (!isNonEmptyString(data.selfReportCommentsFile)) {
    throw new Error('inputs config: selfReportCommentsFile is invalid');
  }

  const keys = new Set();
  const paths = new Set();
  for (const entry of [...independentInputs, ...fullOnlyInputs]) {
    if (keys.has(entry.key)) {
      throw new Error(`inputs config: duplicate input key: ${entry.key}`);
    }
    keys.add(entry.key);
    if (entry.path !== undefined) {
      if (paths.has(entry.path)) {
        throw new Error(`inputs config: duplicate input path: ${entry.path}`);
      }
      paths.add(entry.path);
    }
  }

  return data;
};

const ENTRY_STATUSES = new Set(['present', 'absent', 'unreadable']);

// A file can describe its own status (entry.statusField): the step that
// wrote it knew the source was missing or broken, e.g. no earlier round or
// an unreadable comment. Such a file counts as that status and its content
// is not passed on; an unknown status value is unreadable (fail closed).
const declaredStatusOf = (entry, content) => {
  if (entry.statusField === undefined) return 'present';
  const declared = isObject(content) ? content[entry.statusField] : undefined;
  return ENTRY_STATUSES.has(declared) ? declared : 'unreadable';
};

const sha256Hex = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

// Reads one configured input relative to rawDir. historical is true only
// when the primary (historical, artifact-sourced) path was used; a value
// read from fallbackPath is explicitly non-historical. A
// primary that exists but fails to parse still falls through to
// fallbackPath (a corrupted historical copy is as unusable as a missing
// one) rather than reporting unreadable while live data sits unused;
// unreadable is returned only once no candidate could be read.
const readEntry = (rawDir, entry) => {
  const candidates = [
    { file: entry.path, historical: true },
    { file: entry.fallbackPath, historical: false },
  ].filter((candidate) => candidate.file !== undefined);
  const defaultExtension = entry.format === 'json' ? '.json' : '.txt';

  let firstFailure = null;
  for (const candidate of candidates) {
    const fullPath = path.join(rawDir, candidate.file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const content = entry.format === 'json' ? JSON.parse(raw) : raw;
      const status = declaredStatusOf(entry, content);
      const isPresent = status === 'present';
      return {
        status,
        historical: candidate.historical,
        content: isPresent ? content : null,
        sourcePath: fullPath,
        extension: isPresent
          ? path.extname(candidate.file) || defaultExtension
          : null,
      };
    } catch {
      firstFailure ??= {
        status: 'unreadable',
        historical: candidate.historical,
        content: null,
        sourcePath: fullPath,
        extension: null,
      };
    }
  }

  return (
    firstFailure ?? {
      status: 'absent',
      historical: null,
      content: null,
      sourcePath: null,
      extension: null,
    }
  );
};

// Picks the self-report comment among the executor's own comments on the
// issue: the comment whose body carries config.selfReportMarker,
// latest by created_at, ties broken by the larger numeric id.
const pickLatestSelfReport = (comments, marker) => {
  if (!Array.isArray(comments)) return null;
  const hasMarker = (comment) =>
    isObject(comment) &&
    typeof comment.body === 'string' &&
    comment.body.includes(marker);
  const matching = comments.filter(hasMarker);
  if (matching.length === 0) return null;
  return matching.reduce((latest, comment) => {
    const latestTime = Date.parse(latest.created_at);
    const commentTime = Date.parse(comment.created_at);
    if (commentTime > latestTime) return comment;
    if (commentTime < latestTime) return latest;
    return Number(comment.id) > Number(latest.id) ? comment : latest;
  });
};

const readJsonIfPresent = (rawDir, relativeFile) => {
  const fullPath = path.join(rawDir, relativeFile);
  if (!fs.existsSync(fullPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
};

const jobConclusion = (jobs, name) => {
  if (!Array.isArray(jobs)) return null;
  return jobs.find((job) => isObject(job) && job.name === name) ?? null;
};

// A completed run is a round only when it actually concluded and its
// Report job was not skipped after a successful Verify: a stale
// run (superseded by a newer push) published nothing to the PR.
const classifyRun = (runMeta, jobs, roundMeta) => {
  if (jobs === null) return { isRound: false, reason: 'no job data' };

  const conclusion = isObject(runMeta) ? runMeta.conclusion : null;
  if (conclusion !== 'success' && conclusion !== 'failure') {
    return { isRound: false, reason: `run did not conclude: ${conclusion}` };
  }

  const verifyJob = jobConclusion(jobs, roundMeta.verifyJobName);
  const reportJob = jobConclusion(jobs, roundMeta.reportJobName);
  const reportSkipped =
    reportJob !== null &&
    (reportJob.status === 'skipped' || reportJob.conclusion === 'skipped');
  const isStale =
    verifyJob !== null && verifyJob.conclusion === 'success' && reportSkipped;
  if (isStale) {
    return {
      isRound: false,
      reason: 'stale run: Verify succeeded, Report was skipped',
    };
  }

  return { isRound: true, reason: null };
};

// States of a snapshot part that are a confirmed historical fact: the file was
// not in the project's checkout, or the round did not use it. They make the
// part comparable; any other missing file is an unknown, not a fact.
const CONFIRMED_ABSENCE = new Set(['absent', 'unused']);

// The hashes of the round's rules. Each entry is { present, sha256 } and, for a
// part the round's policy snapshot vouches for, the confirmed `state`. A file
// that is missing without such a confirmation is an unknown and leaves the
// fingerprint incomplete: nothing is read as "unchanged" without evidence.
const collectTrustedConfigHashes = (rawDir, config) => {
  const status = readJsonIfPresent(rawDir, config.policy.statusFile);
  const verified = isObject(status) && status.status === 'present' && isObject(status.parts);
  const hashes = {};
  for (const configPath of config.trustedConfigs) {
    const fullPath = path.join(rawDir, config.trustedConfigsRoot, configPath);
    const state = verified ? status.parts[configPath]?.state : undefined;
    if (!fs.existsSync(fullPath)) {
      hashes[configPath] = CONFIRMED_ABSENCE.has(state)
        ? { present: false, sha256: null, state }
        : { present: false, sha256: null };
      continue;
    }
    try {
      const sha256 = sha256Hex(fs.readFileSync(fullPath));
      hashes[configPath] = { present: true, sha256 };
    } catch {
      hashes[configPath] = { present: false, sha256: null };
    }
  }
  return hashes;
};

const entryResults = (rawDir, entries, comments, config) => {
  const results = new Map();
  for (const entry of entries) {
    if (entry.selfReport === true) {
      const found = pickLatestSelfReport(comments, config.selfReportMarker);
      results.set(entry.key, {
        status: found === null ? 'absent' : 'present',
        historical: true,
        content: found === null ? null : found.body,
        sourcePath: null,
        extension: '.md',
      });
      continue;
    }
    results.set(entry.key, readEntry(rawDir, entry));
  }
  return results;
};

// Builds the round-level manifest. Throws
// when the round key cannot be determined: the caller must not write
// any package in that case.
const buildManifest = (rawDir, config, independentResults, fullResults) => {
  const runMeta = readJsonIfPresent(rawDir, config.roundMeta.runFile);
  const runId = isObject(runMeta) ? runMeta.run_id : undefined;
  const runAttempt = isObject(runMeta) ? runMeta.run_attempt : undefined;
  const repository = isObject(runMeta) ? runMeta.repository : undefined;
  if (!isNonEmptyString(runId) && typeof runId !== 'number') {
    throw new Error('round key is missing: run.json has no run_id');
  }
  if (!isNonEmptyString(runAttempt) && typeof runAttempt !== 'number') {
    throw new Error('round key is missing: run.json has no run_attempt');
  }
  if (!isNonEmptyString(repository)) {
    throw new Error('round key is missing: run.json has no repository');
  }

  const jobs = readJsonIfPresent(rawDir, config.roundMeta.jobsFile);
  const jobsList = isObject(jobs) ? jobs.jobs : jobs;
  const classification = classifyRun(runMeta, jobsList, config.roundMeta);
  const jobsPresent = Array.isArray(jobsList);
  const jobConclusions = jobsPresent
    ? Object.fromEntries(jobsList.map((job) => [job.name, job.conclusion ?? null]))
    : null;

  const prMeta = readJsonIfPresent(rawDir, config.roundMeta.prFile);
  const provenanceResult = independentResults.get('provenance');
  const provenance =
    provenanceResult && provenanceResult.status === 'present'
      ? provenanceResult.content
      : null;
  const provenanceField = (field) =>
    isObject(provenance) ? (provenance[field] ?? null) : null;
  const headSha =
    isObject(prMeta) && isNonEmptyString(prMeta.head_sha)
      ? prMeta.head_sha
      : provenanceField('head_sha');

  const inputs = {};
  for (const [key, result] of [...independentResults, ...fullResults]) {
    inputs[key] = { status: result.status, historical: result.historical };
  }

  return {
    round_key: {
      repository,
      verifier_run_id: runId,
      verifier_run_attempt: runAttempt,
    },
    base_sha: isObject(prMeta) ? (prMeta.base_sha ?? null) : null,
    head_sha: headSha,
    issue_body_sha256: provenanceField('issue_body_sha256'),
    verifier_commit: provenanceField('verifier_commit'),
    model: provenanceField('model'),
    codex_version: provenanceField('codex_version'),
    trusted_config_hashes: collectTrustedConfigHashes(rawDir, config),
    inputs,
    jobs: {
      status: jobsPresent ? 'present' : 'absent',
      conclusions: jobConclusions,
    },
    round_classification: classification,
  };
};

const writeEntry = (packageDir, key, result) => {
  if (result.status !== 'present') return;
  fs.mkdirSync(packageDir, { recursive: true });
  const serialized =
    typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content, null, 2);
  const fileName = `${key}${result.extension ?? '.txt'}`;
  fs.writeFileSync(path.join(packageDir, fileName), serialized);
};

const writeTrustedConfigs = (packageDir, rawDir, config) => {
  for (const configPath of config.trustedConfigs) {
    const sourcePath = path.join(rawDir, config.trustedConfigsRoot, configPath);
    if (!fs.existsSync(sourcePath)) continue;
    const destinationPath = path.join(packageDir, 'trusted', configPath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
};

// Builds independent/ and full/ next to manifest.json in outDir.
// independent/ is an allowlist of independentInputs + trusted configs only
// — never the full set filtered down. Nothing is written when the
// round key cannot be determined.
const collect = (rawDir, outDir, config) => {
  const comments = readJsonIfPresent(rawDir, config.selfReportCommentsFile);
  const independentResults = entryResults(
    rawDir,
    config.independentInputs,
    comments,
    config,
  );
  const fullOnlyResults = entryResults(rawDir, config.fullOnlyInputs, comments, config);

  const manifest = buildManifest(
    rawDir,
    config,
    independentResults,
    fullOnlyResults,
  );

  const independentDir = path.join(outDir, 'independent');
  const fullDir = path.join(outDir, 'full');
  fs.mkdirSync(independentDir, { recursive: true });
  fs.mkdirSync(fullDir, { recursive: true });

  for (const [key, result] of independentResults) {
    writeEntry(independentDir, key, result);
    writeEntry(fullDir, key, result);
  }
  for (const [key, result] of fullOnlyResults) {
    writeEntry(fullDir, key, result);
  }
  writeTrustedConfigs(independentDir, rawDir, config);
  writeTrustedConfigs(fullDir, rawDir, config);

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
};

module.exports = {
  loadInputsConfig,
  readEntry,
  pickLatestSelfReport,
  classifyRun,
  buildManifest,
  collect,
};
