'use strict';

const fs = require('node:fs');
const { isV2Spec, specItemsOf, isSpecInvalid } = require('./acceptance-verdict/common');
const {
  readSpecResult,
  readApproval,
  readRequiredChecks,
  parseTamperingScan,
  parseProvenance,
  parseAllowedModels,
  readScopeResult,
  parseReport,
  readReport,
  readRefsProblems,
  readRefsNotes,
  readRawFile,
  readAbsenceItems,
} = require('./acceptance-verdict/inputs');
const {
  checkRefs,
  checkRefsWithNotes,
  checkBehaviorRefs,
} = require('./acceptance-verdict/refs');
const {
  countIssueItems,
  checkCoverage,
  checkIds,
  checkIssueCoverage,
} = require('./acceptance-verdict/coverage');
const { parseCiFailures } = require('./acceptance-verdict/ci');
const { computeAbsenceItems, computeCiItems } = require('./acceptance-verdict/computed');
const { evaluate, SPEC_NOT_CHECKED } = require('./acceptance-verdict/verdict');
const { COMMENT_MARKER, renderComment } = require('./acceptance-verdict/render');
const {
  VERDICT_NEEDS_HUMAN,
  needsSecondRun,
  divergingIds,
  singleRun,
  reconcile,
} = require('./acceptance-verdict/second-run');
const { buildResult } = require('./acceptance-verdict/result');

const parseArgs = (argv) => {
  const options = {
    file: null,
    out: null,
    manualVerified: false,
    checkRefs: false,
    root: null,
    refsProblems: null,
    refsNotes: null,
    notesOut: null,
    ci: null,
    issue: null,
    spec: null,
    absence: null,
    absenceOut: null,
    approval: null,
    scope: null,
    requiredChecks: null,
    tamperingScan: null,
    provenance: null,
    allowedModels: null,
    manualVerifiedIgnoredBy: undefined,
    testRemovalApproved: false,
    testRemovalIgnoredBy: undefined,
    needsSecondRun: false,
    second: null,
    secondRefsProblems: null,
    resultOut: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--manual-verified') options.manualVerified = true;
    else if (arg === '--check-refs') options.checkRefs = true;
    else if (arg === '--out') options.out = argv[++index] ?? null;
    else if (arg === '--root') options.root = argv[++index] ?? null;
    else if (arg === '--refs-problems') {
      options.refsProblems = argv[++index] ?? null;
    } else if (arg === '--ci') options.ci = argv[++index] ?? null;
    else if (arg === '--issue') options.issue = argv[++index] ?? null;
    else if (arg === '--spec') options.spec = argv[++index] ?? null;
    else if (arg === '--absence') options.absence = argv[++index] ?? null;
    else if (arg === '--approval') options.approval = argv[++index] ?? null;
    else if (arg === '--scope') options.scope = argv[++index] ?? null;
    else if (arg === '--required-checks') {
      options.requiredChecks = argv[++index] ?? null;
    } else if (arg === '--tampering-scan') {
      options.tamperingScan = argv[++index] ?? null;
    } else if (arg === '--provenance') {
      options.provenance = argv[++index] ?? null;
    } else if (arg === '--allowed-models') {
      options.allowedModels = argv[++index] ?? null;
    } else if (arg === '--absence-out') {
      options.absenceOut = argv[++index] ?? null;
    } else if (arg === '--refs-notes') {
      options.refsNotes = argv[++index] ?? null;
    } else if (arg === '--notes-out') {
      options.notesOut = argv[++index] ?? null;
    } else if (arg === '--manual-verified-ignored') {
      options.manualVerifiedIgnoredBy = argv[++index] ?? null;
    } else if (arg === '--manual-verified-ignored-unknown') {
      options.manualVerifiedIgnoredBy = null;
    } else if (arg === '--test-removal-approved') {
      options.testRemovalApproved = true;
    } else if (arg === '--test-removal-ignored') {
      options.testRemovalIgnoredBy = argv[++index] ?? null;
    } else if (arg === '--test-removal-ignored-unknown') {
      options.testRemovalIgnoredBy = null;
    } else if (arg === '--needs-second-run') options.needsSecondRun = true;
    else if (arg === '--second') options.second = argv[++index] ?? null;
    else if (arg === '--second-refs-problems') {
      options.secondRefsProblems = argv[++index] ?? null;
    } else if (arg === '--result-out') {
      options.resultOut = argv[++index] ?? null;
    } else if (options.file === null) options.file = arg;
  }
  return options;
};

const USAGE =
  'usage:\n' +
  '  acceptance-verdict.js --check-refs <verdict.json> --root <dir> ' +
  '--out <refs-problems.json> [--issue <issue.md>] ' +
  '[--spec <spec-lint.json>] [--absence-out <absence.json>] ' +
  '[--notes-out <refs-notes.json>]\n' +
  '  acceptance-verdict.js <verdict.json> --out <comment.md> ' +
  '[--refs-problems <refs-problems.json>] [--refs-notes <refs-notes.json>] ' +
  '[--ci <ci.json>] ' +
  '[--spec <spec-lint.json>] [--absence <absence.json>] ' +
  '[--approval <spec-approval.json>] [--scope <scope.json>] ' +
  '[--required-checks <required-checks.json>] ' +
  '[--tampering-scan <tampering-scan-result.json>] ' +
  '[--provenance <provenance.json>] ' +
  '[--allowed-models <allowed-models.json>] ' +
  '[--manual-verified] ' +
  '[--manual-verified-ignored <actor> | --manual-verified-ignored-unknown] ' +
  '[--test-removal-approved] ' +
  '[--test-removal-ignored <actor> | --test-removal-ignored-unknown] ' +
  '[--second <verdict2.json> --second-refs-problems <refs-problems2.json>] ' +
  '[--result-out <result.json>]\n' +
  '  acceptance-verdict.js <verdict.json> --needs-second-run ' +
  '[the verdict inputs above, without --out]';

const readIssueCoverage = (report, issue) => {
  if (issue === null) return [];
  try {
    const issueMarkdown = fs.readFileSync(issue, 'utf8');
    return checkIssueCoverage(report, { issueMarkdown });
  } catch (error) {
    return [`issue not readable, coverage not checked: ${error.code}`];
  }
};

// Fail closed: a --spec that was passed but could not be read means the ID
// match did not run; the count check still runs as a floor.
const readSpecCoverage = (report, { issue, spec }) => {
  const specResult = readSpecResult(spec);
  if (isV2Spec(specResult)) {
    return checkIssueCoverage(report, { spec: specResult });
  }
  const coverage = readIssueCoverage(report, issue);
  if (specResult !== null) return coverage;
  return [`${SPEC_NOT_CHECKED}, issue ids were not matched`, ...coverage];
};

const runCheckRefs = ({
  file,
  root,
  out,
  issue,
  spec,
  absenceOut,
  notesOut,
}) => {
  const { raw } = readReport(file);
  const { report } = raw === null ? { report: null } : parseReport(raw);
  const specItems = specItemsOf(readSpecResult(spec));
  const refsResult =
    report === null ? null : checkRefsWithNotes(report, root, specItems);
  const problems =
    report === null
      ? null
      : [
          ...refsResult.problems,
          ...checkBehaviorRefs(report, specItems),
          ...readSpecCoverage(report, { issue, spec }),
        ];
  fs.writeFileSync(out, JSON.stringify(problems));
  if (absenceOut !== null) {
    fs.writeFileSync(
      absenceOut,
      JSON.stringify(computeAbsenceItems(specItems, root)),
    );
  }
  if (notesOut !== null) {
    fs.writeFileSync(
      notesOut,
      JSON.stringify(refsResult === null ? [] : refsResult.notes),
    );
  }
  console.log(problems === null ? 'SKIPPED' : `${problems.length} problem(s)`);
  return 0;
};

// Reads every deterministic input once; the returned function judges one
// model report (and its own refs-problems) against them, so a first and a
// second run are evaluated on identical deterministic inputs.
const createReportEvaluator = ({
  manualVerified,
  refsNotes,
  ci,
  spec,
  absence,
  approval,
  scope,
  requiredChecks,
  tamperingScan,
  provenance,
  allowedModels,
  testRemovalApproved,
}) => {
  const specResult = readSpecResult(spec);
  const skipReport = specResult !== undefined && isSpecInvalid(specResult);
  const ciRaw = readRawFile(ci);
  const ciItems = computeCiItems(specItemsOf(specResult), ciRaw);
  const computedItems = [...ciItems, ...readAbsenceItems(absence)];
  const requiredChecksResult = readRequiredChecks(requiredChecks);
  const scanResult = parseTamperingScan(readRawFile(tamperingScan));
  const options = {
    manualVerified,
    ciFailures:
      ciRaw === null ? null : parseCiFailures(ciRaw, requiredChecksResult),
    tamperingFindings: scanResult === null ? null : scanResult.findings,
    assertionLosses: scanResult === null ? [] : scanResult.assertionLosses,
    assertionMoved: scanResult === null ? 0 : scanResult.assertionMoved,
    testRemovalApproved,
    provenance: parseProvenance(readRawFile(provenance)),
    allowedModels: parseAllowedModels(readRawFile(allowedModels)),
    spec: specResult,
    approval: readApproval(approval),
    scope: readScopeResult(scope),
    computedItems,
  };
  const evaluateReport = (file, { refsProblems, refsNotesFile = null }) => {
    const { raw, problem } = skipReport
      ? { raw: null, problem: null }
      : readReport(file);
    const result = evaluate(raw, {
      ...options,
      refsProblems: readRefsProblems(refsProblems),
      refsNotes: readRefsNotes(refsNotesFile),
    });
    return { result, problem };
  };
  return { evaluateReport, computedItems };
};

const runNeedsSecondRun = (options) => {
  const { evaluateReport } = createReportEvaluator(options);
  const { result } = evaluateReport(options.file, {
    refsProblems: options.refsProblems,
  });
  console.log(String(needsSecondRun(result)));
  return 0;
};

const runVerdict = (options) => {
  const { file, out, second, manualVerifiedIgnoredBy, testRemovalIgnoredBy } =
    options;
  const { evaluateReport, computedItems } = createReportEvaluator(options);
  const first = evaluateReport(file, {
    refsProblems: options.refsProblems,
    refsNotesFile: options.refsNotes,
  });
  const secondRun =
    second === null
      ? null
      : evaluateReport(second, { refsProblems: options.secondRefsProblems });
  const outcome =
    secondRun === null
      ? singleRun(first.result)
      : reconcile(first.result, secondRun.result);
  const { problem } = secondRun === null ? first : secondRun;
  fs.writeFileSync(
    out,
    renderComment(outcome.result, {
      problem,
      manualVerifiedIgnoredBy,
      testRemovalIgnoredBy,
      verdict: outcome.verdict,
      diverged: outcome.diverged,
      secondRun: outcome.secondRun,
    }),
  );
  // Only an extra output: the comment and stdout are the same without it.
  if (options.resultOut !== null) {
    const result = buildResult(outcome, computedItems);
    fs.writeFileSync(options.resultOut, JSON.stringify(result, null, 2));
  }
  console.log(outcome.verdict);
  return 0;
};

const main = (argv) => {
  const options = parseArgs(argv);
  const { file, out, root, checkRefs: isCheckRefs } = options;
  const isNeedsSecondRun = options.needsSecondRun && !isCheckRefs;
  const hasOut = out !== null || isNeedsSecondRun;
  if (file === null || !hasOut || (isCheckRefs && root === null)) {
    console.error(USAGE);
    return 2;
  }
  if (isCheckRefs) return runCheckRefs(options);
  if (isNeedsSecondRun) return runNeedsSecondRun(options);
  return runVerdict(options);
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  COMMENT_MARKER,
  evaluate,
  renderComment,
  parseArgs,
  checkRefs,
  checkBehaviorRefs,
  countIssueItems,
  checkCoverage,
  checkIds,
  checkIssueCoverage,
  parseCiFailures,
  readSpecResult,
  readApproval,
  readScopeResult,
  readRequiredChecks,
  parseTamperingScan,
  parseProvenance,
  parseAllowedModels,
  computeAbsenceItems,
  computeCiItems,
  VERDICT_NEEDS_HUMAN,
  needsSecondRun,
  divergingIds,
  singleRun,
  reconcile,
};
