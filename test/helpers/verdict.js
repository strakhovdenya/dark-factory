'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadProfile } = require('../../profile/load');
const { lint } = require('../../verifier/issue-lint');
const { loadCore } = require('../../verifier/issue-contract');
const { computeScope } = require('../../verifier/affects-scope');
const { evaluate } = require('../../verifier/verdict/verdict');
const {
  readApproval,
  readRefsProblems,
  parseAllowedModels,
  parseProvenance,
  parseTamperingScan,
} = require('../../verifier/verdict/inputs');
const { parseCiFailures } = require('../../verifier/verdict/ci');
const { buildResult } = require('../../verifier/verdict/result');
const { singleRun } = require('../../verifier/verdict/second-run');
const { coreRegistry } = require('../../verifier/checks');

const COMMON = path.join(__dirname, '..', 'fixtures', 'verifier', 'common');

const readText = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

/**
 * The verdict from the files of one golden case directory, through the same input readers and
 * check modules the verifier CLI uses. `report` replaces the model report file.
 */
const verdictOf = (
  root,
  caseDir,
  { registry = coreRegistry, report = readText(caseDir, 'model-report.json') } = {},
) => {
  const enabled = loadProfile(root).verifier?.checks;
  assert.ok(enabled?.length > 0, 'the profile enables some checks');
  const issue = readText(caseDir, 'issue.md');
  const ciRaw = readText(COMMON, 'ci.json');
  const scan = parseTamperingScan(readText(COMMON, 'tampering-scan.json'));
  const result = evaluate(report, {
    spec: lint(issue, loadCore(), { requireV2: true }),
    scope: computeScope(issue, readText(caseDir, 'changed-files.txt')),
    approval: readApproval(path.join(COMMON, 'approval.json')),
    refsProblems: readRefsProblems(path.join(COMMON, 'refs-problems.json')),
    ciFailures: parseCiFailures(ciRaw, undefined),
    tamperingFindings: scan.findings,
    assertionLosses: scan.assertionLosses,
    assertionMoved: scan.assertionMoved,
    provenance: parseProvenance(readText(COMMON, 'provenance.json')),
    allowedModels: parseAllowedModels(readText(COMMON, 'allowed-models.json')),
    registry,
    checks: enabled,
  });
  return { result, summary: buildResult(singleRun(result)) };
};

module.exports = { COMMON, readText, verdictOf };
