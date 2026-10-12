'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REASON_CODE_SET } = require('./acceptance-verdict/result');

const VERDICTS = new Set(['PASS', 'FAIL']);
const VERDICT_NEEDS_HUMAN = 'NEEDS_HUMAN';
const RUN_NAMES = ['first', 'second'];

const BROKEN_PAIR = 'broken pair';

const OUTCOME = Object.freeze({
  MATCHED: 'matched',
  FALSE_PASS: 'false_pass',
  FALSE_FAIL: 'false_fail',
  RUN_FAILURE: 'run_failure',
  NEEDS_HUMAN: 'needs_human',
  REASON_MISMATCH: 'reason_mismatch',
});

const usage = () =>
  'usage: node scripts/verifier-eval.js <cases-dir> <results-dir> [--out <file>]';

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

// A PASS case checks no reason, so both fields must be null. A FAIL case
// names the reason code (from the closed list the verifier exports) and the
// issue item it is about, or null for a rule without an ID (INV-3, INV-4).
const isValidExpectation = (parsed) => {
  const {
    expected,
    expected_criterion_id: id,
    expected_reason_code: code,
  } = parsed;
  if (expected === 'PASS') return id === null && code === null;
  return REASON_CODE_SET.has(code) && (id === null || isNonEmptyString(id));
};

const readHasPatch = (casesDir, name) => {
  try {
    return (
      fs
        .readFileSync(path.join(casesDir, name, 'mutation.patch'), 'utf8')
        .trim() !== ''
    );
  } catch {
    return false;
  }
};

// A mutation case (pair_of set) is a FAIL case that names its corruption kind
// and ships a non-empty mutation.patch (AC-3).
const isValidMutation = ({ expected, pairOf, mutationKind, hasPatch }) =>
  pairOf === null ||
  (expected === 'FAIL' && isNonEmptyString(mutationKind) && hasPatch);

// A case is a subdirectory of casesDir holding a case.json with an
// `expected` verdict (PASS/FAIL). An unreadable or malformed case.json is
// skipped rather than crashing the whole eval run. A case whose reason
// expectation is missing or invalid is kept but marked, so it is counted as
// a run failure instead of being checked by verdict alone.
const readCases = (casesDir) => {
  let entries;
  try {
    entries = fs.readdirSync(casesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const cases = [];
  for (const name of names) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(casesDir, name, 'case.json'), 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || !VERDICTS.has(parsed.expected)) continue;
    const pairOf = isNonEmptyString(parsed.pair_of) ? parsed.pair_of : null;
    const mutationKind = isNonEmptyString(parsed.mutation_kind)
      ? parsed.mutation_kind
      : null;
    const hasPatch = readHasPatch(casesDir, name);
    const isExpectationValid = isValidExpectation(parsed);
    const isValid =
      isExpectationValid &&
      isValidMutation({
        expected: parsed.expected,
        pairOf,
        mutationKind,
        hasPatch,
      });
    cases.push({
      name,
      expected: parsed.expected,
      pairOf,
      mutationKind,
      criterionId: isValid ? parsed.expected_criterion_id : null,
      reasonCode: isValid ? parsed.expected_reason_code : null,
      isValid,
    });
  }
  return cases;
};

// One actual-result file per case, named `<case>.json`, holding
// `{ "actual": "PASS" | "FAIL" | "NEEDS_HUMAN", "reasons": [{ "code", "id" }],
// "items": [{ "id", "statuses" }] }` (the reconciled verdict, the coded
// reasons and the per-item statuses of the two runs, taken by the eval
// workflow from the verifier's result.json for that case's frozen inputs).
// `items` is required only for NEEDS_HUMAN; for PASS/FAIL it is kept when
// valid and read as an empty list otherwise.
const readActualsRaw = (resultsDir, cases) => {
  const actualsRaw = {};
  for (const { name } of cases) {
    try {
      actualsRaw[name] = fs.readFileSync(
        path.join(resultsDir, `${name}.json`),
        'utf8',
      );
    } catch {
      // Missing result — left unset; summarize() counts it as a run failure.
    }
  }
  return actualsRaw;
};

const isReason = (reason) =>
  reason !== null &&
  typeof reason === 'object' &&
  isNonEmptyString(reason.code) &&
  (reason.id === null || isNonEmptyString(reason.id));

const isItem = (item) =>
  item !== null &&
  typeof item === 'object' &&
  isNonEmptyString(item.id) &&
  Array.isArray(item.statuses) &&
  item.statuses.length > 0 &&
  item.statuses.every(isNonEmptyString);

const parseItems = (items) =>
  Array.isArray(items) && items.every(isItem)
    ? items.map(({ id, statuses }) => ({ id, statuses: [...statuses] }))
    : null;

const parseActual = (raw) => {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const isNeedsHuman = parsed.actual === VERDICT_NEEDS_HUMAN;
  if (!VERDICTS.has(parsed.actual) && !isNeedsHuman) return null;
  if (!Array.isArray(parsed.reasons) || !parsed.reasons.every(isReason)) {
    return null;
  }
  const reasons = parsed.reasons.map(({ code, id }) => ({ code, id }));
  const items = parseItems(parsed.items);
  if (items === null && isNeedsHuman) return null;
  return { verdict: parsed.actual, reasons, items: items ?? [] };
};

const hasExpectedReason = ({ reasonCode, criterionId }, reasons) =>
  reasons.some(
    (reason) => reason.code === reasonCode && reason.id === criterionId,
  );

// The single place that puts a case into exactly one category (INV-2).
const classify = (testCase, actual) => {
  if (!testCase.isValid || actual === null) return OUTCOME.RUN_FAILURE;
  const { expected } = testCase;
  if (actual.verdict === VERDICT_NEEDS_HUMAN) return OUTCOME.NEEDS_HUMAN;
  if (expected === 'FAIL' && actual.verdict === 'PASS') {
    return OUTCOME.FALSE_PASS;
  }
  if (expected === 'PASS' && actual.verdict === 'FAIL') {
    return OUTCOME.FALSE_FAIL;
  }
  if (expected === 'PASS') return OUTCOME.MATCHED;
  return hasExpectedReason(testCase, actual.reasons)
    ? OUTCOME.MATCHED
    : OUTCOME.REASON_MISMATCH;
};

const buildPairs = (rows) => {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const pairs = [];
  for (const row of rows) {
    const passRow = row.pairOf === null ? undefined : byName.get(row.pairOf);
    if (passRow === undefined || passRow.expected !== 'PASS') continue;
    pairs.push({
      pass: passRow.name,
      mutation: row.name,
      passActual: passRow.actual,
      mutationActual: row.actual,
    });
  }
  return pairs;
};

// Structural check of the golden set (INV-6): the minimum number of pairs and
// the required corruption kinds come from the caller.
const checkGoldenSet = (cases, { minPairs, requiredKinds }) => {
  const validCases = cases.filter((item) => item.isValid);
  const mutations = validCases.filter(
    (item) => item.pairOf !== null && item.expected === 'FAIL',
  );
  const pairedNames = new Set(mutations.map((item) => item.pairOf));
  const passNames = validCases
    .filter((item) => item.expected === 'PASS')
    .map((item) => item.name);
  const unpairedPass = passNames.filter((name) => !pairedNames.has(name));
  const pairedCount = passNames.length - unpairedPass.length;
  const coveredKinds = new Set(
    mutations
      .filter((item) => passNames.includes(item.pairOf))
      .map((item) => item.mutationKind),
  );
  return {
    unpairedPass,
    missingPairs: Math.max(0, minPairs - pairedCount),
    missingKinds: requiredKinds.filter((kind) => !coveredKinds.has(kind)),
  };
};

// Describes a NEEDS_HUMAN case: the items the two runs disagreed on and, for a
// FAIL case whose expected reason has an item ID, what each run said about
// that item. A reason without an ID has no item to look at (INV-5).
const describeDivergence = (testCase, actual) => {
  const diverged = actual.items.filter(
    ({ statuses }) => new Set(statuses).size > 1,
  );
  const { expected, criterionId } = testCase;
  if (expected !== 'FAIL' || criterionId === null) {
    return { diverged, expectedItem: undefined };
  }
  const item = actual.items.find(({ id }) => id === criterionId);
  const expectedItem = item === undefined ? null : item.statuses;
  return { diverged, expectedItem };
};

// Pure summary over in-memory data (cases + raw actual-result text), so
// this can be tested without touching the filesystem. `false PASS`
// (expected FAIL, actual PASS) is the main metric; `false FAIL` is counted
// for visibility only. A FAIL that carries no reason with the expected code
// and ID is a reason mismatch: the verifier failed the case, but not for the
// defect the case exists to catch. A missing or malformed actual result, or a
// case with no valid reason expectation, is a run failure — counted
// separately from all of them.
const summarize = (cases, actualsRaw) => {
  const counts = new Map(Object.values(OUTCOME).map((key) => [key, 0]));
  const passNames = new Set(
    cases
      .filter((item) => item.expected === 'PASS' && item.isValid)
      .map((item) => item.name),
  );
  const rows = [];
  for (const testCase of cases) {
    const { name, expected, criterionId, reasonCode, pairOf } = testCase;
    const isBroken = pairOf !== null && !passNames.has(pairOf);
    const raw = Object.prototype.hasOwnProperty.call(actualsRaw, name)
      ? actualsRaw[name]
      : undefined;
    const actual = raw === undefined ? null : parseActual(raw);
    const outcome = isBroken ? OUTCOME.RUN_FAILURE : classify(testCase, actual);
    counts.set(outcome, counts.get(outcome) + 1);
    rows.push({
      name,
      expected,
      actual: actual === null ? null : actual.verdict,
      expectedReason:
        reasonCode === null ? null : { code: reasonCode, id: criterionId },
      actualReasons: actual === null ? [] : actual.reasons,
      divergence:
        outcome === OUTCOME.NEEDS_HUMAN
          ? describeDivergence(testCase, actual)
          : null,
      outcome,
      pairOf,
      note: isBroken ? BROKEN_PAIR : null,
    });
  }
  return {
    rows,
    pairs: buildPairs(rows),
    falsePass: counts.get(OUTCOME.FALSE_PASS),
    falseFail: counts.get(OUTCOME.FALSE_FAIL),
    runFailures: counts.get(OUTCOME.RUN_FAILURE),
    needsHuman: counts.get(OUTCOME.NEEDS_HUMAN),
    reasonMismatches: counts.get(OUTCOME.REASON_MISMATCH),
  };
};

const formatReason = ({ code, id }) => (id === null ? code : `${code}#${id}`);

const formatReasons = (reasons) =>
  reasons.length === 0 ? '-' : reasons.map(formatReason).join(', ');

const formatDiverged = ({ id, statuses }) => `${id} ${statuses.join('/')}`;

// Only an item the two runs disagreed on carries one status per run. A single
// status means the runs did not diverge on it (they agree, or the first run
// did not report the item), so no per-run claim is made.
const formatExpectedItem = (statuses) => {
  if (statuses === undefined) return null;
  if (statuses === null) return 'expected item not reported';
  if (statuses.length === 1) {
    return `expected item ${statuses[0]}, runs did not diverge on it`;
  }
  const perRun = RUN_NAMES.map((run, index) => `${run} ${statuses[index]}`);
  return `expected item: ${perRun.join(', ')}`;
};

const formatDivergence = ({ diverged, expectedItem }) => {
  const parts = [`diverged: ${diverged.map(formatDiverged).join(', ') || '-'}`];
  const expectedText = formatExpectedItem(expectedItem);
  if (expectedText !== null) parts.push(expectedText);
  return parts.join(' | ');
};

const render = ({
  rows,
  pairs = [],
  falsePass,
  falseFail,
  runFailures,
  needsHuman = 0,
  reasonMismatches,
}) => {
  const lines = [];
  if (rows.length === 0) {
    lines.push('no cases found');
  } else {
    lines.push('case | expected | actual | expected reason | actual reasons');
    for (const row of rows) {
      const expectedReason =
        row.expectedReason === null ? '-' : formatReason(row.expectedReason);
      lines.push(
        `${row.name} | ${row.expected} | ${row.actual ?? 'ERROR'} | ` +
          `${expectedReason} | ${formatReasons(row.actualReasons)}` +
          (row.note === null ? '' : ` | ${row.note}`) +
          (row.divergence === null
            ? ''
            : ` | ${formatDivergence(row.divergence)}`),
      );
    }
  }
  lines.push(`pairs: ${pairs.length}`);
  for (const pair of pairs) {
    lines.push(
      `${pair.pass}: ${pair.passActual ?? 'ERROR'} | ` +
        `${pair.mutation}: ${pair.mutationActual ?? 'ERROR'}`,
    );
  }
  lines.push(`needs human: ${needsHuman}`);
  lines.push(`run failures: ${runFailures}`);
  lines.push(`reason mismatches: ${reasonMismatches}`);
  lines.push(`false PASS: ${falsePass}, false FAIL: ${falseFail}`);
  return lines.join('\n');
};

const parseArgs = (argv) => {
  let casesDir = null;
  let resultsDir = null;
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) return null;
      out = value;
      index += 1;
    } else if (!arg.startsWith('--') && casesDir === null) {
      casesDir = arg;
    } else if (!arg.startsWith('--') && resultsDir === null) {
      resultsDir = arg;
    } else {
      return null;
    }
  }
  return casesDir !== null && resultsDir !== null
    ? { casesDir, resultsDir, out }
    : null;
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const cases = readCases(args.casesDir);
  const actualsRaw = readActualsRaw(args.resultsDir, cases);
  const summary = summarize(cases, actualsRaw);
  const rendered = render(summary);
  console.log(rendered);
  if (args.out !== null) fs.writeFileSync(args.out, rendered);
  const isFailing =
    summary.falsePass > 0 ||
    summary.runFailures > 0 ||
    summary.needsHuman > 0 ||
    summary.reasonMismatches > 0;
  return isFailing ? 1 : 0;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  usage,
  parseArgs,
  main,
  readCases,
  readActualsRaw,
  parseActual,
  classify,
  summarize,
  checkGoldenSet,
  render,
};
