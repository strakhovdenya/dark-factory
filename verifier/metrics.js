'use strict';

const { execFileSync } = require('node:child_process');
const { COMMENT_MARKER } = require('./acceptance-verdict/render');
const { APPROVAL_AUTHOR: BOT_LOGIN } = require('./spec-hash');

const USAGE =
  'usage:\n' +
  '  verifier-metrics.js --pr <n> --context <name>\n' +
  '  verifier-metrics.js --prs <n1,n2,...> --context <name>';

const STATUS_UNVERIFIABLE = 'UNVERIFIABLE';
const CRITERION_HEADER = '| Criterion | Status | Summary | References |';
const VERDICT_HEADING = /^## Acceptance verifier: *(.*)$/m;
const VALID_VERDICTS = new Set(['PASS', 'FAIL', 'NEEDS_HUMAN']);
const POSITIVE_INT = /^[1-9]\d*$/;

const round2 = (value) => Math.round(value * 100) / 100;

const shareOf = (numerator, denominator) =>
  denominator === 0 ? 0 : round2(numerator / denominator);

// Reads only the Criterion table (INV-7): the loop stops at the blank line
// that always separates it from the Invariant table, so invariant rows are
// never counted here (there is no UNVERIFIABLE status for invariants).
const parseCommentMetrics = (commentBody) => {
  if (typeof commentBody !== 'string' || !commentBody.includes(COMMENT_MARKER)) {
    return { items: 0, unverifiable: 0 };
  }
  const lines = commentBody.split(/\r?\n/);
  const headerIndex = lines.indexOf(CRITERION_HEADER);
  if (headerIndex === -1) return { items: 0, unverifiable: 0 };
  let items = 0;
  let unverifiable = 0;
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('|')) break;
    const status = line.split('|')[2]?.trim();
    items += 1;
    if (status === STATUS_UNVERIFIABLE) unverifiable += 1;
  }
  return { items, unverifiable };
};

const parseVerdict = (commentBody) => {
  const match = VERDICT_HEADING.exec(String(commentBody ?? ''));
  if (match === null) return null;
  const value = match[1].trim();
  return VALID_VERDICTS.has(value) ? value : null;
};

// One commit status with the given context is one verifier round (INV-3).
const countRounds = (statuses, context) =>
  statuses.filter((status) => status?.context === context).length;

const emptyVerdictCounts = () => ({
  PASS: 0,
  FAIL: 0,
  NEEDS_HUMAN: 0,
  unknown: 0,
});

// Takes only already-collected per-PR metrics (INV-9); no gh/network call
// happens here.
const aggregateMetrics = (prMetricsList) => {
  const verdictCounts = emptyVerdictCounts();
  let items = 0;
  let unverifiable = 0;
  let runs = 0;
  for (const metrics of prMetricsList) {
    const key = VALID_VERDICTS.has(metrics.verdict) ? metrics.verdict : 'unknown';
    verdictCounts[key] += 1;
    items += metrics.items;
    unverifiable += metrics.unverifiable;
    runs += metrics.runs;
  }
  return {
    verdict_counts: verdictCounts,
    needs_human_share: shareOf(verdictCounts.NEEDS_HUMAN, prMetricsList.length),
    items,
    unverifiable,
    runs,
    unverifiable_share: shareOf(unverifiable, items),
  };
};

// gh substitutes {owner}/{repo} from the repository detected in the current
// directory, so no repository name is hardcoded here (INV-4).
// `gh api --paginate` merges a JSON-array response across pages into one
// array before printing it (confirmed against the live API on multiple
// endpoints here: per_page=1 across 2+ real pages still parses as a single
// JSON.parse-able array), so a plain JSON.parse of the combined output below
// is correct and needs no manual page-splitting.
const runGh = (exec, args) =>
  exec('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const fetchVerifierComment = (exec, pr) => {
  const output = runGh(exec, [
    'api',
    '--paginate',
    `repos/{owner}/{repo}/issues/${pr}/comments`,
  ]);
  const comments = JSON.parse(output);
  const found = comments.find(
    (comment) =>
      comment?.user?.login === BOT_LOGIN &&
      typeof comment.body === 'string' &&
      comment.body.includes(COMMENT_MARKER),
  );
  return found ? found.body : null;
};

const fetchCommitShas = (exec, pr) => {
  const output = runGh(exec, ['pr', 'view', String(pr), '--json', 'commits']);
  const parsed = JSON.parse(output);
  return (parsed.commits ?? []).map((commit) => commit.oid).filter(Boolean);
};

const fetchCommitStatuses = (exec, sha) => {
  const output = runGh(exec, [
    'api',
    '--paginate',
    `repos/{owner}/{repo}/commits/${sha}/statuses`,
  ]);
  return JSON.parse(output);
};

const collectPrMetrics = (exec, pr, context) => {
  const commentBody = fetchVerifierComment(exec, pr);
  const verdict = commentBody === null ? null : parseVerdict(commentBody);
  const { items, unverifiable } = parseCommentMetrics(commentBody);
  const shas = fetchCommitShas(exec, pr);
  let runs = 0;
  for (const sha of shas) {
    runs += countRounds(fetchCommitStatuses(exec, sha), context);
  }
  return {
    pr,
    verdict,
    runs,
    items,
    unverifiable,
    unverifiable_share: shareOf(unverifiable, items),
  };
};

const errorMessage = (error) => {
  const raw = error?.stderr;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed !== '' ? trimmed : error?.message ?? String(error);
};

const parseArgs = (argv) => {
  let pr = null;
  let prsRaw = null;
  let context = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pr') {
      pr = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--prs') {
      prsRaw = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--context') {
      context = argv[index + 1] ?? null;
      index += 1;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  if (context === null || context === '') {
    return { error: '--context is required' };
  }
  if (pr !== null && prsRaw !== null) {
    return { error: 'use either --pr or --prs, not both' };
  }
  if (pr !== null) {
    if (!POSITIVE_INT.test(pr)) {
      return { error: `--pr must be a positive integer, got: ${pr}` };
    }
    return { mode: 'pr', pr: Number(pr), context };
  }
  if (prsRaw !== null) {
    const prs = [];
    for (const part of prsRaw.split(',')) {
      const trimmed = part.trim();
      if (!POSITIVE_INT.test(trimmed)) {
        return { error: `--prs must list positive integers, got: ${trimmed}` };
      }
      prs.push(Number(trimmed));
    }
    return { mode: 'prs', prs, context };
  }
  return { error: '--pr or --prs is required' };
};

const buildPrOutput = (metrics) => ({
  pr: metrics.pr,
  verdict: metrics.verdict,
  runs: metrics.runs,
  items: metrics.items,
  unverifiable: metrics.unverifiable,
  unverifiable_share: metrics.unverifiable_share,
});

const buildPrsOutput = (prs, aggregate) => ({
  prs,
  verdict_counts: aggregate.verdict_counts,
  needs_human_share: aggregate.needs_human_share,
  items: aggregate.items,
  unverifiable: aggregate.unverifiable,
  unverifiable_share: aggregate.unverifiable_share,
  runs: aggregate.runs,
});

const main = (
  argv = process.argv.slice(2),
  { exec = execFileSync, stdout = process.stdout, stderr = process.stderr } = {},
) => {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 1;
  }
  if (parsed.mode === 'pr') {
    let metrics;
    try {
      metrics = collectPrMetrics(exec, parsed.pr, parsed.context);
    } catch (error) {
      stderr.write(`gh failed for PR ${parsed.pr}: ${errorMessage(error)}\n`);
      return 1;
    }
    stdout.write(`${JSON.stringify(buildPrOutput(metrics))}\n`);
    return 0;
  }
  const collected = [];
  for (const pr of parsed.prs) {
    try {
      collected.push(collectPrMetrics(exec, pr, parsed.context));
    } catch (error) {
      stderr.write(`gh failed for PR ${pr}: ${errorMessage(error)}\n`);
      return 1;
    }
  }
  const aggregate = aggregateMetrics(collected);
  stdout.write(`${JSON.stringify(buildPrsOutput(parsed.prs, aggregate))}\n`);
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  USAGE,
  parseCommentMetrics,
  parseVerdict,
  countRounds,
  aggregateMetrics,
  shareOf,
  round2,
  parseArgs,
  collectPrMetrics,
  buildPrOutput,
  buildPrsOutput,
  errorMessage,
  main,
};
