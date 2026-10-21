'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { loadTaxonomy } = require('./taxonomy');
const { buildSchema } = require('./schema');
const {
  validateAnalysis,
  validateIndependentResult,
  checkModel,
} = require('./validate');
const {
  loadInputsConfig,
  collect,
  classifyRun,
} = require('./collect');
const { loadFingerprintConfig, compareRounds } = require('./compare');
const { computeTransitions } = require('./transitions');
const { decideTrigger } = require('./trigger');
const { readJudgeConfig, pinChecker } = require('./config');
const { issueOfBranch, findPullRequest, checkPullRequest } = require('./check-pr');
const {
  readRoundPolicy,
  statusRecordOf,
  writePolicyFiles,
  loadStoredPolicy,
  policyDiff,
} = require('./policy');
const {
  VERIFIER_STATUS_CONTEXT,
  VERIFIER_WORKFLOW_PATH,
  ROUND_ARTIFACTS,
} = require('../verifier/round-protocol');
const {
  STAGE_INDEPENDENT,
  STAGE_ANALYSIS,
  STAGE_MANIFEST,
  STAGE_MODEL,
  buildAnalysisError,
  assemble,
} = require('./assemble');
const { render } = require('./render');
const {
  toRoundKey,
  findOwnComment,
  decodeRounds,
  publish,
  publishWithRetry,
} = require('./publish');
const { loadCommentConfig } = require('./render');

const USAGE =
  'usage:\n' +
  '  calibration-judge.js schema <template.json> --taxonomy <taxonomy.json> ' +
  '[--out <file>]\n' +
  '  calibration-judge.js validate <analysis.json> ' +
  '--stage <independent|analysis> --taxonomy <taxonomy.json>\n' +
  '  calibration-judge.js check-model <judge-model> ' +
  '--verifier-model <model> --allowlist <allowed-models.json>\n' +
  '  calibration-judge.js collect <raw-dir> --inputs <inputs.json> ' +
  '--out <dir>\n' +
  '  calibration-judge.js assemble --manifest <manifest.json> ' +
  '--stage1 <independent.json> --stage2 <analysis.json> ' +
  '--taxonomy <taxonomy.json> [--model-error <reason>] [--input-error <reason>] ' +
  '[--previous <previous-round.json>] [--compare <compare.json>] ' +
  '[--transitions <transitions.json>] [--out <file>]\n' +
  '  calibration-judge.js render <assembled.json> [--out <file>]\n' +
  '  calibration-judge.js resolve-round --attempts <attempts.json> ' +
  '--inputs <inputs.json> --pr <number> [--run-id <id>] ' +
  '[--run-attempt <n>]\n' +
  '  calibration-judge.js publish <assembled.json> --comments <comments.json> ' +
  '--author <login> --repository <owner/repo> --run-id <id> ' +
  '--run-attempt <n> --inputs <inputs.json> --out <file> [--id-out <file>]\n' +
  '  calibration-judge.js publish-round <assembled.json> ' +
  '--repository <owner/repo> --pr <number> --author <login> ' +
  '--run-id <id> --run-attempt <n> --inputs <inputs.json> ' +
  '[--max-attempts <n>]\n' +
  '  calibration-judge.js previous-round --comments <comments.json> ' +
  '--author <login> --repository <owner/repo> --run-id <id> ' +
  '--run-attempt <n> [--out <file>]\n' +
  '  calibration-judge.js config --project <dir> --factory-repository ' +
  '<owner/repo> --factory-dir <dir> --wrapper-sha <sha>\n' +
  '  calibration-judge.js check-pr --pull <pull.json> --round <round.json> ' +
  '--repository <owner/repo> --project <dir>\n' +
  '  calibration-judge.js issue-number --branch <name> --project <dir>\n' +
  '  calibration-judge.js find-pr --pulls <pulls.json> --issue <number> ' +
  '--repository <owner/repo> --project <dir>\n' +
  '  calibration-judge.js check-trigger --event <round|labeled|manual> ' +
  '--verdict <verdict> --config <config.json> --owners <owners.json> ' +
  '--pull-timeline <file> [--issue-timeline <file>] [--event-label <name>] ' +
  '[--round-head <sha>] [--current-head <sha>]\n' +
  '  calibration-judge.js compare --current <round-dir> ' +
  '[--previous <round-dir>|none] --inputs <inputs.json> [--out <file>]\n' +
  '  calibration-judge.js transitions --current <round-dir> ' +
  '[--previous <round-dir>|none] [--compare <compare.json>] [--out <file>]\n' +
  '  calibration-judge.js read-snapshot --inputs <inputs.json> ' +
  '--provenance <provenance.json> --run-id <id> --run-attempt <n> ' +
  '--head-sha <sha> --out-dir <dir> --status-out <file> [--snapshot <file>] ' +
  '[--missing-reason <text>] [--failure-reason <text>]\n' +
  '  calibration-judge.js policy-diff --current <round-dir> ' +
  '[--previous <round-dir>|none] --inputs <inputs.json> [--out <file>]\n' +
  '  calibration-judge.js round-protocol';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Statuses of the previous round's analysis, the same words collect.js and
// validate.js use: absent is the first observed round.
const PREVIOUS_PRESENT = 'present';
const PREVIOUS_ABSENT = 'absent';
const PREVIOUS_UNREADABLE = 'unreadable';

const readAllowlist = (file) => {
  try {
    const data = readJson(file);
    return Array.isArray(data) && data.every((item) => typeof item === 'string')
      ? data
      : null;
  } catch {
    return null;
  }
};

const parseOptionArgs = (argv) => {
  const options = {
    taxonomy: null,
    out: null,
    stage: null,
    verifierModel: null,
    allowlist: null,
    inputs: null,
    manifest: null,
    stage1: null,
    stage2: null,
    modelError: null,
    inputError: null,
    attempts: null,
    pr: null,
    runId: null,
    runAttempt: null,
    comments: null,
    author: null,
    repository: null,
    idOut: null,
    pull: null,
    round: null,
    project: null,
    snapshot: null,
    missingReason: null,
    failureReason: null,
    provenance: null,
    headSha: null,
    outDir: null,
    statusOut: null,
    factoryDir: null,
    wrapperSha: null,
    factoryRepository: null,
    pulls: null,
    issue: null,
    config: null,
    previous: null,
    current: null,
    compare: null,
    transitions: null,
    maxAttempts: null,
    branch: null,
    event: null,
    verdict: null,
    owners: null,
    pullTimeline: null,
    issueTimeline: null,
    eventLabel: null,
    roundHead: null,
    currentHead: null,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--taxonomy') options.taxonomy = argv[++index] ?? null;
    else if (arg === '--out') options.out = argv[++index] ?? null;
    else if (arg === '--stage') options.stage = argv[++index] ?? null;
    else if (arg === '--verifier-model') options.verifierModel = argv[++index] ?? null;
    else if (arg === '--allowlist') options.allowlist = argv[++index] ?? null;
    else if (arg === '--inputs') options.inputs = argv[++index] ?? null;
    else if (arg === '--manifest') options.manifest = argv[++index] ?? null;
    else if (arg === '--stage1') options.stage1 = argv[++index] ?? null;
    else if (arg === '--stage2') options.stage2 = argv[++index] ?? null;
    else if (arg === '--model-error') options.modelError = argv[++index] ?? null;
    else if (arg === '--input-error') options.inputError = argv[++index] ?? null;
    else if (arg === '--attempts') options.attempts = argv[++index] ?? null;
    else if (arg === '--pr') options.pr = argv[++index] ?? null;
    else if (arg === '--run-id') options.runId = argv[++index] ?? null;
    else if (arg === '--run-attempt') options.runAttempt = argv[++index] ?? null;
    else if (arg === '--comments') options.comments = argv[++index] ?? null;
    else if (arg === '--author') options.author = argv[++index] ?? null;
    else if (arg === '--repository') options.repository = argv[++index] ?? null;
    else if (arg === '--id-out') options.idOut = argv[++index] ?? null;
    else if (arg === '--pull') options.pull = argv[++index] ?? null;
    else if (arg === '--round') options.round = argv[++index] ?? null;
    else if (arg === '--project') options.project = argv[++index] ?? null;
    else if (arg === '--snapshot') options.snapshot = argv[++index] ?? null;
    else if (arg === '--missing-reason') options.missingReason = argv[++index] ?? null;
    else if (arg === '--failure-reason') options.failureReason = argv[++index] ?? null;
    else if (arg === '--provenance') options.provenance = argv[++index] ?? null;
    else if (arg === '--head-sha') options.headSha = argv[++index] ?? null;
    else if (arg === '--out-dir') options.outDir = argv[++index] ?? null;
    else if (arg === '--status-out') options.statusOut = argv[++index] ?? null;
    else if (arg === '--factory-dir') options.factoryDir = argv[++index] ?? null;
    else if (arg === '--wrapper-sha') options.wrapperSha = argv[++index] ?? null;
    else if (arg === '--factory-repository') options.factoryRepository = argv[++index] ?? null;
    else if (arg === '--pulls') options.pulls = argv[++index] ?? null;
    else if (arg === '--issue') options.issue = argv[++index] ?? null;
    else if (arg === '--config') options.config = argv[++index] ?? null;
    else if (arg === '--previous') options.previous = argv[++index] ?? null;
    else if (arg === '--current') options.current = argv[++index] ?? null;
    else if (arg === '--compare') options.compare = argv[++index] ?? null;
    else if (arg === '--transitions') options.transitions = argv[++index] ?? null;
    else if (arg === '--max-attempts') options.maxAttempts = argv[++index] ?? null;
    else if (arg === '--branch') options.branch = argv[++index] ?? null;
    else if (arg === '--event') options.event = argv[++index] ?? null;
    else if (arg === '--verdict') options.verdict = argv[++index] ?? null;
    else if (arg === '--owners') options.owners = argv[++index] ?? null;
    else if (arg === '--pull-timeline') options.pullTimeline = argv[++index] ?? null;
    else if (arg === '--issue-timeline') options.issueTimeline = argv[++index] ?? null;
    else if (arg === '--event-label') options.eventLabel = argv[++index] ?? null;
    else if (arg === '--round-head') options.roundHead = argv[++index] ?? null;
    else if (arg === '--current-head') options.currentHead = argv[++index] ?? null;
    else positional.push(arg);
  }
  return { options, positional };
};

const runSchema = (argv) => {
  const { options, positional } = parseOptionArgs(argv);
  const [templateFile] = positional;
  if (templateFile === undefined || options.taxonomy === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let schema;
  try {
    const template = readJson(templateFile);
    const taxonomy = loadTaxonomy(options.taxonomy);
    schema = buildSchema(template, taxonomy);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const output = JSON.stringify(schema, null, 2);
  if (options.out !== null) fs.writeFileSync(options.out, output);
  else process.stdout.write(`${output}\n`);
  return 0;
};

const runValidate = (argv) => {
  const { options, positional } = parseOptionArgs(argv);
  const [analysisFile] = positional;
  if (
    analysisFile === undefined ||
    options.taxonomy === null ||
    (options.stage !== 'independent' && options.stage !== 'analysis')
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    const analysis = readJson(analysisFile);
    const taxonomy = loadTaxonomy(options.taxonomy);
    result =
      options.stage === 'independent'
        ? validateIndependentResult(analysis, taxonomy)
        : validateAnalysis(analysis, taxonomy);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (result.valid) {
    console.log('VALID');
    return 0;
  }
  process.stderr.write(`${result.problems.join('\n')}\n`);
  return 1;
};

const runCheckModel = (argv) => {
  const { options, positional } = parseOptionArgs(argv);
  const [judgeModel] = positional;
  if (
    judgeModel === undefined ||
    options.verifierModel === null ||
    options.allowlist === null
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const allowlist = readAllowlist(options.allowlist);
  const { allowed, reason } = checkModel(judgeModel, options.verifierModel, allowlist);
  if (allowed) {
    console.log('ALLOWED');
    return 0;
  }
  process.stderr.write(`${reason}\n`);
  return 1;
};

const runCollect = (argv) => {
  const { options, positional } = parseOptionArgs(argv);
  const [rawDir] = positional;
  if (rawDir === undefined || options.inputs === null || options.out === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let manifest;
  try {
    const config = loadInputsConfig(options.inputs);
    manifest = collect(rawDir, options.out, config);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
};

const writeOutput = (text, out) => {
  if (out !== null) fs.writeFileSync(out, text);
  else process.stdout.write(text);
};

// A missing or unparsable model output is not a CLI failure: it becomes an
// analysis error naming the stage, so the round still gets a comment.
const readStageFile = (file, stage) => {
  if (!fs.existsSync(file)) {
    return { value: null, problem: `${stage} stage output file is missing` };
  }
  try {
    return { value: readJson(file), problem: null };
  } catch {
    return { value: null, problem: `${stage} stage output is not valid JSON` };
  }
};

// A round-context file the workflow could not produce is no context at all,
// never a guess: missing or broken reads as null.
const readOptionalJson = (file) => {
  if (file === null) return null;
  try {
    const value = readJson(file);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
};

// The previous round as previous-round wrote it. Not passed: no earlier round
// is known, the round is the first observed one. Passed but missing or
// broken: the previous round exists but proves nothing (unreadable).
const readPreviousRound = (file) => {
  if (file === null) return { status: PREVIOUS_ABSENT, analysis: null };
  const data = readOptionalJson(file);
  if (data === null) return { status: PREVIOUS_UNREADABLE, analysis: null };
  return { status: data.status, analysis: data.analysis ?? null };
};

// The round context (comparison, transitions) is kept on every error path,
// as assemble itself does: a failed analysis still shows how the round
// relates to the previous one.
const assembleFromFiles = (options, taxonomy) => {
  const comparison = readOptionalJson(options.compare);
  const transitions = readOptionalJson(options.transitions);
  const fail = (manifest, stage, problem) =>
    buildAnalysisError(manifest, stage, [problem], comparison, transitions);

  const manifestFile = readStageFile(options.manifest, STAGE_MANIFEST);
  const manifest = manifestFile.value;
  if (manifestFile.problem !== null) {
    return fail(manifest, STAGE_MANIFEST, manifestFile.problem);
  }
  if (options.inputError !== null) {
    return fail(manifest, STAGE_MANIFEST, options.inputError);
  }
  if (options.modelError !== null) {
    return fail(manifest, STAGE_MODEL, options.modelError);
  }
  const stage1 = readStageFile(options.stage1, STAGE_INDEPENDENT);
  if (stage1.problem !== null) {
    return fail(manifest, STAGE_INDEPENDENT, stage1.problem);
  }
  const stage2 = readStageFile(options.stage2, STAGE_ANALYSIS);
  if (stage2.problem !== null) {
    return fail(manifest, STAGE_ANALYSIS, stage2.problem);
  }
  return assemble({
    manifest,
    stage1: stage1.value,
    stage2: stage2.value,
    taxonomy,
    previous: readPreviousRound(options.previous),
    comparison,
    transitions,
  });
};

const runAssemble = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [
    options.manifest,
    options.stage1,
    options.stage2,
    options.taxonomy,
  ];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let taxonomy;
  try {
    taxonomy = loadTaxonomy(options.taxonomy);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const assembled = assembleFromFiles(options, taxonomy);
  writeOutput(`${JSON.stringify(assembled, null, 2)}\n`, options.out);
  return 0;
};

const runRender = (argv) => {
  const { options, positional } = parseOptionArgs(argv);
  const [assembledFile] = positional;
  if (assembledFile === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let comment;
  try {
    comment = render(readJson(assembledFile));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  writeOutput(comment, options.out);
  return 0;
};

const startedAt = (attempt) => {
  const time = Date.parse(attempt.run_started_at);
  return Number.isNaN(time) ? 0 : time;
};

const compareAttempts = (left, right) =>
  startedAt(left) - startedAt(right) ||
  Number(left.run_id) - Number(right.run_id) ||
  Number(left.run_attempt) - Number(right.run_attempt);

const matchesFilter = (attempt, runId, runAttempt) =>
  (runId === null || String(attempt.run_id) === String(runId)) &&
  (runAttempt === null || String(attempt.run_attempt) === String(runAttempt));

// Picks the latest attempt classified as a round (collect.js classifyRun):
// a run that did not conclude or a stale run published nothing to the PR
// and is not a round. "No runs at all" and "runs, but none is a round" are
// reported differently, both naming the PR.
const resolveRound = (attempts, roundMeta, filter) => {
  const where = filter.runId === null ? '' : ` for run ${filter.runId}`;
  const candidates = (Array.isArray(attempts) ? attempts : []).filter(
    (attempt) => matchesFilter(attempt, filter.runId, filter.runAttempt),
  );
  if (candidates.length === 0) {
    return {
      round: null,
      error: `PR #${filter.pr}: no verifier runs found${where}`,
    };
  }
  const rounds = candidates.filter(
    (attempt) => classifyRun(attempt, attempt.jobs ?? null, roundMeta).isRound,
  );
  if (rounds.length === 0) {
    return {
      round: null,
      error:
        `PR #${filter.pr}: none of ${candidates.length} verifier run ` +
        `attempts${where} is a round`,
    };
  }
  const latest = rounds.toSorted(compareAttempts).at(-1);
  return {
    round: { run_id: latest.run_id, run_attempt: latest.run_attempt },
    error: null,
  };
};

// The workflow's "Resolve round" step skips quietly only on RESOLVE_NO_ROUND.
// It is not 1, the code Node itself exits with on any uncaught error (a
// missing module included), so a crash can never read as "not a round".
const RESOLVE_INTERNAL_ERROR = 3;
const RESOLVE_NO_ROUND = 4;

const runResolveRound = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [options.attempts, options.inputs, options.pr];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let attempts;
  let config;
  try {
    attempts = readJson(options.attempts);
    config = loadInputsConfig(options.inputs);
  } catch (error) {
    process.stderr.write(`resolve-round: internal error: ${error.message}\n`);
    return RESOLVE_INTERNAL_ERROR;
  }
  let round;
  let error;
  try {
    ({ round, error } = resolveRound(attempts, config.roundMeta, {
      pr: options.pr,
      runId: options.runId,
      runAttempt: options.runAttempt,
    }));
  } catch (internalError) {
    process.stderr.write(
      `resolve-round: internal error: ${internalError.message}\n`,
    );
    return RESOLVE_INTERNAL_ERROR;
  }
  if (round === null) {
    process.stderr.write(`${error}\n`);
    return RESOLVE_NO_ROUND;
  }
  console.log(JSON.stringify(round));
  return 0;
};

// An unreadable comments list fails the command instead of being read as
// "no own comment": that guess would post a second Judge comment.
const runPublish = (argv) => {
  const { options, positional } = parseOptionArgs(argv);
  const [assembledFile] = positional;
  const required = [
    options.comments,
    options.author,
    options.repository,
    options.runId,
    options.runAttempt,
    options.inputs,
    options.out,
  ];
  if (assembledFile === undefined || required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    const { maxBodyLength } = loadCommentConfig(readJson(options.inputs));
    result = publish({
      comments: readJson(options.comments),
      author: options.author,
      roundKey: toRoundKey({
        repository: options.repository,
        runId: options.runId,
        runAttempt: options.runAttempt,
      }),
      assembled: readJson(assembledFile),
      maxBodyLength,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  fs.writeFileSync(options.out, result.body);
  if (options.idOut !== null) {
    const commentId = result.commentId === null ? '' : String(result.commentId);
    fs.writeFileSync(options.idOut, commentId);
  }
  return 0;
};

const POSITIVE_INT = /^[1-9]\d*$/;
// A digit string this regex alone accepts can still exceed Number's safe
// integer range (or even overflow to Infinity), at which point incrementing
// an attempt counter up to it would never terminate in practice. No
// realistic retry count is anywhere near this, so a small ceiling rejects
// the unsafe input outright rather than letting it reach the retry loop.
const MAX_ATTEMPTS_CEILING = 20;

// Fetches every comment on a pull request via `gh api` (array arguments).
// `--paginate` alone prints each page as its own separate JSON
// array/object — it does not merge them (`gh api --help`: "Each page is a
// separate JSON array or object. Pass `--slurp` to wrap all pages ... into
// an outer JSON array."), so a plain JSON.parse of a multi-page response
// would throw. `--slurp` wraps every page's array into one outer array, so
// the parsed, flattened result is the full comment list regardless of page
// count; only the fields publish.js needs are kept.
const fetchComments = (exec, repository, pr) => {
  const output = exec(
    'gh',
    ['api', '--paginate', '--slurp', `repos/${repository}/issues/${pr}/comments`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const raw = JSON.parse(output).flat();
  return raw.map((comment) => ({
    id: comment.id,
    user: { login: comment.user?.login ?? null },
    body: comment.body,
  }));
};

// Writes `body` to a fixed file first (gh's `-F field=@path` reads the field
// value from that file, so the body itself never becomes a command-line
// argument) and posts or updates the Judge comment via `gh api` with array
// arguments: a new comment when `commentId` is null, else an update
// in place.
const writeCommentViaGh = (exec, repository, pr, commentId, bodyFile) => {
  if (commentId === null) {
    exec(
      'gh',
      ['api', '-X', 'POST', `repos/${repository}/issues/${pr}/comments`, '-F', `body=@${bodyFile}`],
      { encoding: 'utf8' },
    );
  } else {
    exec(
      'gh',
      ['api', '-X', 'PATCH', `repos/${repository}/issues/comments/${commentId}`, '-F', `body=@${bodyFile}`],
      { encoding: 'utf8' },
    );
  }
};

// Publishes one round's analysis to the PR with the full reread/merge/write/
// verify/retry loop (publish.js's publishWithRetry): each attempt rereads
// the comment via `gh api` right before merging and writing, then rereads
// again to confirm the written revision actually landed, so a concurrent
// write from another run is picked up instead of silently lost.
// `exec` defaults to execFileSync and is only overridden by tests.
const defaultExec = (file, args, options) =>
  execFileSync(file, args, { encoding: 'utf8', ...options });

/**
 * @param {string[]} argv
 * @param {{ exec?: (file: string, args: string[], options?: object) => string }} [deps]
 */
const runPublishRound = (argv, { exec = defaultExec } = {}) => {
  const { options, positional } = parseOptionArgs(argv);
  const [assembledFile] = positional;
  const required = [
    options.repository,
    options.pr,
    options.author,
    options.runId,
    options.runAttempt,
    options.inputs,
  ];
  if (assembledFile === undefined || required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (options.maxAttempts !== null) {
    const value = Number(options.maxAttempts);
    const isValid =
      POSITIVE_INT.test(options.maxAttempts) &&
      Number.isSafeInteger(value) &&
      value <= MAX_ATTEMPTS_CEILING;
    if (!isValid) {
      process.stderr.write(
        `--max-attempts must be a positive integer up to ${MAX_ATTEMPTS_CEILING}, got: ${options.maxAttempts}\n`,
      );
      return 2;
    }
  }
  const maxAttempts =
    options.maxAttempts === null ? undefined : Number(options.maxAttempts);
  const bodyFile = `${assembledFile}.comment.md`;
  let outcome;
  try {
    const { maxBodyLength } = loadCommentConfig(readJson(options.inputs));
    const assembled = readJson(assembledFile);
    const roundKey = toRoundKey({
      repository: options.repository,
      runId: options.runId,
      runAttempt: options.runAttempt,
    });
    outcome = publishWithRetry({
      author: options.author,
      roundKey,
      assembled,
      maxBodyLength,
      maxAttempts,
      readComments: () => fetchComments(exec, options.repository, options.pr),
      writeComment: (commentId, body) => {
        fs.writeFileSync(bodyFile, body);
        writeCommentViaGh(exec, options.repository, options.pr, commentId, bodyFile);
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (!outcome.ok) {
    process.stderr.write(
      `publish-round: gave up after ${outcome.attempts} attempt(s) without verifying the write\n`,
    );
    return 1;
  }
  return 0;
};

const isEarlierRound = (left, right) => {
  const leftRun = Number(left.verifier_run_id);
  const rightRun = Number(right.verifier_run_id);
  if (leftRun !== rightRun) return leftRun < rightRun;
  return Number(left.verifier_run_attempt) < Number(right.verifier_run_attempt);
};

const previousResult = (status, record = null) => {
  const assembled = isPlainObject(record?.analysis) ? record.analysis : null;
  return {
    status,
    round_key: record === null ? null : record.round_key,
    head_sha: assembled?.head_sha ?? null,
    analysis: status === PREVIOUS_PRESENT ? assembled.analysis : null,
  };
};

// Picks the analysis of the round before roundKey from Judge's own comment
// (its hidden rounds block). No own comment or no earlier record: absent, the
// current round is the first observed one. A broken block, or an earlier
// round whose analysis failed: unreadable, so no earlier finding is assumed.
const selectPreviousRound = ({ comments, author, roundKey }) => {
  if (!Array.isArray(comments)) return previousResult(PREVIOUS_UNREADABLE);
  const own = findOwnComment(comments, author);
  if (own === null) return previousResult(PREVIOUS_ABSENT);
  const decoded = decodeRounds(own.body);
  if (!decoded.ok) return previousResult(PREVIOUS_UNREADABLE);

  const earlier = decoded.records.filter(
    (record) =>
      String(record.round_key.repository) === String(roundKey.repository) &&
      isEarlierRound(record.round_key, roundKey),
  );
  if (earlier.length === 0) return previousResult(PREVIOUS_ABSENT);
  const latest = earlier.reduce((best, record) =>
    isEarlierRound(best.round_key, record.round_key) ? record : best,
  );
  const hasAnalysis = isPlainObject(latest.analysis?.analysis);
  const status = hasAnalysis ? PREVIOUS_PRESENT : PREVIOUS_UNREADABLE;
  return previousResult(status, latest);
};

// An unreadable comments list is not an error here: it only means the
// previous round cannot be read, which the result says.
const runPreviousRound = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [
    options.comments,
    options.author,
    options.repository,
    options.runId,
    options.runAttempt,
  ];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let comments = null;
  try {
    comments = readJson(options.comments);
  } catch {
    comments = null;
  }
  const result = selectPreviousRound({
    comments,
    author: options.author,
    roundKey: toRoundKey({
      repository: options.repository,
      runId: options.runId,
      runAttempt: options.runAttempt,
    }),
  });
  writeOutput(`${JSON.stringify(result, null, 2)}
`, options.out);
  return 0;
};

// The profile loader brings its own dependencies, which only the jobs that read the
// profile install.
const readProfile = (project) => require('../profile/load').loadProfile(project);

const runConfig = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [
    options.project,
    options.factoryRepository,
    options.factoryDir,
    options.wrapperSha,
  ];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const config = readJudgeConfig({
    projectRoot: options.project,
    checkPin: pinChecker({
      projectRoot: options.project,
      repository: options.factoryRepository,
      factoryDir: options.factoryDir,
      wrapperSha: options.wrapperSha,
    }),
  });
  console.log(JSON.stringify(config));
  return 0;
};

const runCheckPr = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [options.pull, options.round, options.repository, options.project];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let pull;
  let round;
  let branchTemplate;
  try {
    pull = readJson(options.pull);
    round = readJson(options.round);
    ({ branchTemplate } = readProfile(options.project));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const { ok, reason } = checkPullRequest(pull, round, {
    repository: options.repository,
    branchTemplate,
  });
  if (!ok) {
    process.stderr.write(`${reason}
`);
    return 1;
  }
  console.log('OK');
  return 0;
};

const runIssueNumber = (argv) => {
  const { options } = parseOptionArgs(argv);
  if (options.branch === null || options.project === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let number;
  try {
    number = issueOfBranch(readProfile(options.project).branchTemplate, options.branch);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  console.log(number === null ? '' : String(number));
  return 0;
};

// Prints the number of the open pull request of the labeled issue, or nothing.
const runFindPr = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [options.pulls, options.project, options.repository, options.issue];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let number;
  try {
    number = findPullRequest(readJson(options.pulls), {
      repository: options.repository,
      branchTemplate: readProfile(options.project).branchTemplate,
      issue: Number(options.issue),
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  console.log(number === null ? '' : String(number));
  return 0;
};

const readTimeline = (file) => {
  const data = readJson(file);
  if (!Array.isArray(data)) throw new Error(`${file} is not a JSON array`);
  return data;
};

// Prints "run: <reason>" or "skip: <reason>". Fails closed: a timeline or
// owners file that cannot be read means the label is not counted, so the
// answer is skip with exit code 0, never a crash .
const runCheckTrigger = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [
    options.event,
    options.verdict,
    options.config,
    options.owners,
    options.pullTimeline,
  ];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let decision;
  try {
    decision = decideTrigger({
      config: readJson(options.config),
      event: options.event,
      verdict: options.verdict,
      owners: readTimeline(options.owners),
      pullTimeline: readTimeline(options.pullTimeline),
      issueTimeline:
        options.issueTimeline === null ? [] : readTimeline(options.issueTimeline),
      eventLabel: options.eventLabel,
      roundHead: options.roundHead,
      currentHead: options.currentHead,
    });
  } catch (error) {
    decision = { run: false, configError: false, reason: `inputs unreadable: ${error.message}` };
  }
  const answer = decision.run ? 'run' : decision.configError ? 'error' : 'skip';
  console.log(`${answer}: ${decision.reason}`);
  return 0;
};

// Reads every file directly inside dir (not "trusted/", collect.js's own
// trusted-config copy), keyed by filename without extension — the same key
// collect.js wrote it under (writeEntry: `${key}${extension}`).
const loadPackageContents = (dir) => {
  const contents = {};
  if (!fs.existsSync(dir)) return contents;
  for (const fileName of fs.readdirSync(dir)) {
    const fullPath = `${dir}/${fileName}`;
    if (!fs.statSync(fullPath).isFile()) continue;
    const key = fileName.replace(/\.[^.]+$/, '');
    try {
      contents[key] = fileName.endsWith('.json')
        ? readJson(fullPath)
        : fs.readFileSync(fullPath, 'utf8');
    } catch {
      contents[key] = null;
    }
  }
  return contents;
};

// Loads one round's manifest plus the raw content of its collected inputs
// (full/ wins over independent/ for a key present in both, same content
// either way) for compareRounds (judge/compare.js),
// which itself does no filesystem I/O.
const loadRound = (dir) => {
  const manifest = readJson(`${dir}/manifest.json`);
  const contents = {
    ...loadPackageContents(`${dir}/independent`),
    ...loadPackageContents(`${dir}/full`),
  };
  return { ...manifest, contents };
};

const runCompare = (argv) => {
  const { options } = parseOptionArgs(argv);
  if (options.current === null || options.inputs === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    const config = loadFingerprintConfig(readJson(options.inputs));
    const current = loadRound(options.current);
    const previous =
      options.previous === null || options.previous === 'none'
        ? null
        : loadRound(options.previous);
    result = compareRounds(previous, current, config);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  writeOutput(`${JSON.stringify(result, null, 2)}\n`, options.out);
  return 0;
};

// One round's verifier outputs for computeTransitions: the files may sit
// directly in dir or in a collected package (independent/, full/, under
// collect.js's keys); a missing or unreadable file is null, not an error.
const loadTransitionRound = (dir) => {
  const contents = {
    ...loadPackageContents(dir),
    ...loadPackageContents(`${dir}/independent`),
    ...loadPackageContents(`${dir}/full`),
  };
  const valueOf = (...keys) => {
    const key = keys.find((name) => contents[name] !== undefined);
    return key === undefined ? null : contents[key];
  };
  return {
    result: valueOf('result'),
    verdict2: valueOf('verdict2'),
    verdict: valueOf('verdict'),
    spec: valueOf('specLint', 'spec-lint'),
  };
};

// The task-change type from the compare subcommand's output; without it the
// type is unknown and no transition is marked FLIP.
const readTaskChangeType = (file) => {
  if (file === null) return null;
  const type = readJson(file)?.taskChange?.type;
  return typeof type === 'string' ? type : null;
};

const runTransitions = (argv) => {
  const { options } = parseOptionArgs(argv);
  if (options.current === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    const current = loadTransitionRound(options.current);
    const previous =
      options.previous === null || options.previous === 'none'
        ? null
        : loadTransitionRound(options.previous);
    const taskChangeType = readTaskChangeType(options.compare);
    result = computeTransitions(previous, current, taskChangeType);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  writeOutput(`${JSON.stringify(result, null, 2)}\n`, options.out);
  return 0;
};

// Turns the round's policy snapshot (or the lack of one) into the status record
// and the saved rule files of the raw inputs. Anything that makes the snapshot
// untrustworthy is a status, not a crash: the analysis then says its historical
// inputs are incomplete. An unusable command line or inputs config still fails.
const runReadSnapshot = (argv) => {
  const { options } = parseOptionArgs(argv);
  const required = [
    options.inputs,
    options.provenance,
    options.runId,
    options.runAttempt,
    options.headSha,
    options.outDir,
    options.statusOut,
  ];
  if (required.includes(null)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let config;
  try {
    config = loadInputsConfig(options.inputs);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  let verifierCommit = null;
  try {
    verifierCommit = readJson(options.provenance).verifier_commit ?? null;
  } catch {
    verifierCommit = null;
  }
  const source = { snapshotText: null };
  if (options.snapshot !== null) {
    try {
      source.snapshotText = fs.readFileSync(options.snapshot, 'utf8');
    } catch (error) {
      source.failureReason = `snapshot file cannot be read: ${error.code ?? error.message}`;
    }
  }
  if (options.failureReason !== null) source.failureReason = options.failureReason;
  if (options.missingReason !== null) source.missingReason = options.missingReason;
  const policy = readRoundPolicy(
    source,
    {
      runId: Number(options.runId),
      runAttempt: Number(options.runAttempt),
      headSha: options.headSha,
      verifierCommit,
    },
    config,
  );
  writePolicyFiles(policy, options.outDir);
  fs.writeFileSync(options.statusOut, `${JSON.stringify(statusRecordOf(policy), null, 2)}
`);
  console.log(policy.status);
  return 0;
};

const runPolicyDiff = (argv) => {
  const { options } = parseOptionArgs(argv);
  if (options.current === null || options.inputs === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let text;
  try {
    const config = loadInputsConfig(options.inputs);
    const current = loadStoredPolicy(options.current, config);
    const previous =
      options.previous === null || options.previous === 'none'
        ? null
        : loadStoredPolicy(options.previous, config);
    text =
      previous === null
        ? '# first round: no earlier rules to compare\n'
        : policyDiff(previous, current, config);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  writeOutput(text, options.out);
  return 0;
};

const runRoundProtocol = () => {
  console.log(
    JSON.stringify({
      status_context: VERIFIER_STATUS_CONTEXT,
      workflow_path: VERIFIER_WORKFLOW_PATH,
      artifacts: ROUND_ARTIFACTS,
    }),
  );
  return 0;
};

const main = (argv) => {
  const [command, ...rest] = argv;
  if (command === 'schema') return runSchema(rest);
  if (command === 'validate') return runValidate(rest);
  if (command === 'check-model') return runCheckModel(rest);
  if (command === 'collect') return runCollect(rest);
  if (command === 'assemble') return runAssemble(rest);
  if (command === 'render') return runRender(rest);
  if (command === 'resolve-round') return runResolveRound(rest);
  if (command === 'publish') return runPublish(rest);
  if (command === 'publish-round') return runPublishRound(rest);
  if (command === 'previous-round') return runPreviousRound(rest);
  if (command === 'config') return runConfig(rest);
  if (command === 'check-pr') return runCheckPr(rest);
  if (command === 'find-pr') return runFindPr(rest);
  if (command === 'issue-number') return runIssueNumber(rest);
  if (command === 'check-trigger') return runCheckTrigger(rest);
  if (command === 'compare') return runCompare(rest);
  if (command === 'transitions') return runTransitions(rest);
  if (command === 'read-snapshot') return runReadSnapshot(rest);
  if (command === 'policy-diff') return runPolicyDiff(rest);
  if (command === 'round-protocol') return runRoundProtocol();
  process.stderr.write(`${USAGE}\n`);
  return 2;
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  USAGE,
  readAllowlist,
  parseOptionArgs,
  runSchema,
  runValidate,
  runCheckModel,
  runCollect,
  runAssemble,
  runRender,
  resolveRound,
  checkPullRequest,
  runCheckPr,
  runIssueNumber,
  runCheckTrigger,
  runResolveRound,
  runPublish,
  runPublishRound,
  fetchComments,
  writeCommentViaGh,
  selectPreviousRound,
  runPreviousRound,
  loadPackageContents,
  loadRound,
  runCompare,
  loadTransitionRound,
  runTransitions,
  main,
};
