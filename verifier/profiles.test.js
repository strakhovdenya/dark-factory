'use strict';

// Integration coverage: the real verifier code on both fixture profiles. A
// profile is loaded through loadProfile, the verdict is computed from fixture
// inputs (no network, no model: the model report is a fixture file), and the
// golden eval compares those computed results with the expected ones. Unit
// checks of the registry and of the single check modules live next to them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../profile/load');
const { lint } = require('./issue-lint');
const { loadCore } = require('./issue-contract');
const { computeScope } = require('./affects-scope');
const { evaluate } = require('./verdict/verdict');
const {
  readApproval,
  readRefsProblems,
  parseAllowedModels,
  parseProvenance,
  parseTamperingScan,
} = require('./verdict/inputs');
const { parseCiFailures } = require('./verdict/ci');
const { buildResult } = require('./verdict/result');
const { singleRun } = require('./verdict/second-run');
const { deterministicReason } = require('./verdict/reason');
const { createCoreRegistry, coreRegistry } = require('./checks');
const { goldenDirOf, readCases, summarize } = require('./eval/verifier-eval');

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');
const PROFILES_DIR = path.join(FIXTURES, 'profiles');
const VERIFIER_FIXTURES = path.join(FIXTURES, 'verifier');
const COMMON = path.join(VERIFIER_FIXTURES, 'common');
const FIXTURE_PROFILES = ['monorepo', 'single-package'];

const PASS_CASE = 'pass-case';
const FAIL_CASE = 'out-of-scope-case';
const OUT_OF_SCOPE = 'out_of_scope_file';

const DUMMY_CHECK = 'dummy-check';
const DUMMY_CODE = 'dummy_check_failed';

const readText = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const profileRoot = (fixture) => path.join(PROFILES_DIR, fixture);
const readJson = (...parts) => JSON.parse(readText(...parts));
const goldenCaseDir = (fixture, name) =>
  path.join(goldenDirOf(profileRoot(fixture)), name);

// A temporary copy of a fixture profile, changed by `mutate`; the original
// file is never touched. The golden directory is made absolute because the
// copy lives elsewhere. Removed when the test ends.
const profileCopy = (t, fixture, mutate = (_profile) => {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = profileRoot(fixture);
  const profile = readJson(original, '.factory', 'profile.json');
  if (profile.verifier?.goldenDir !== undefined) {
    profile.verifier.goldenDir = path.resolve(original, profile.verifier.goldenDir);
  }
  mutate(profile);
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(
    path.join(root, '.factory', 'profile.json'),
    JSON.stringify(profile, null, 2),
  );
  return root;
};

const withChecks = (...names) => (profile) => {
  const enabled = profile.verifier.checks;
  profile.verifier.checks = [...enabled, ...names.filter((n) => !enabled.includes(n))];
};

// The dummy check exists only here. It reports the findings of a fixture file.
const dummyCheck = (calls = []) => ({
  name: DUMMY_CHECK,
  stage: 'report',
  codes: [DUMMY_CODE],
  run: () => {
    calls.push(DUMMY_CHECK);
    return readJson(COMMON, 'dummy-check-findings.json').map((finding) =>
      deterministicReason(DUMMY_CODE, `dummy check finding: ${finding}`),
    );
  },
});

const dummyRegistry = (calls) => {
  const registry = createCoreRegistry();
  registry.register(dummyCheck(calls));
  return registry;
};

// The verdict from the files of one case directory, through the same input
// readers and check modules the verifier CLI uses. `report` replaces the
// model report file.
const verdictOf = (
  root,
  caseDir,
  { registry = coreRegistry, report = readText(caseDir, 'model-report.json') } = {},
) => {
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
    checks: loadProfile(root).verifier?.checks ?? [],
  });
  return { result, summary: buildResult(singleRun(result)) };
};

const codesOf = ({ summary }) => summary.reasons.map(({ code }) => code);
const describe = ({ result }) => result.failures.join('\n');

test('verdict passes on monorepo fixture profile', () => {
  const root = profileRoot('monorepo');
  const enabled = loadProfile(root).verifier.checks;
  assert.ok(enabled.includes('affects-scope'), 'the monorepo profile checks scope');
  const verdict = verdictOf(root, goldenCaseDir('monorepo', PASS_CASE));
  assert.strictEqual(verdict.summary.verdict, 'PASS', describe(verdict));
});

test('verdict passes on single-package fixture profile', () => {
  const root = profileRoot('single-package');
  assert.ok(!loadProfile(root).verifier.checks.includes('affects-scope'));
  const verdict = verdictOf(root, goldenCaseDir('single-package', PASS_CASE));
  assert.strictEqual(verdict.summary.verdict, 'PASS', describe(verdict));
});

test('out_of_scope_file reason in both profiles', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, withChecks('affects-scope'));
    const caseDir = goldenCaseDir(fixture, FAIL_CASE);
    const verdict = verdictOf(root, caseDir);
    assert.strictEqual(verdict.summary.verdict, 'FAIL', fixture);
    assert.deepStrictEqual(codesOf(verdict), [OUT_OF_SCOPE], fixture);
    // The same change inside Affects is fine in the same copy.
    const inScope = verdictOf(root, goldenCaseDir(fixture, PASS_CASE));
    assert.strictEqual(inScope.summary.verdict, 'PASS', fixture);
  }
});

test('invalid model report fails in both profiles', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const report = readText(COMMON, 'model-report-invalid.json');
    for (const root of [profileRoot(fixture), profileCopy(t, fixture)]) {
      const verdict = verdictOf(root, goldenCaseDir(fixture, PASS_CASE), { report });
      assert.strictEqual(verdict.summary.verdict, 'FAIL', fixture);
      assert.notStrictEqual(verdict.summary.verdict, 'PASS');
    }
  }
});

test('dummy check enabled by profile adds its reason', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, withChecks(DUMMY_CHECK));
    const calls = [];
    const verdict = verdictOf(root, goldenCaseDir(fixture, PASS_CASE), {
      registry: dummyRegistry(calls),
    });
    assert.deepStrictEqual(calls, [DUMMY_CHECK], fixture);
    assert.strictEqual(verdict.summary.verdict, 'FAIL', fixture);
    assert.deepStrictEqual(codesOf(verdict), [DUMMY_CODE], fixture);
    assert.match(verdict.result.failures[0], /fixture finding/);
  }
});

test('dummy check disabled by profile changes nothing', () => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileRoot(fixture);
    assert.ok(!loadProfile(root).verifier.checks.includes(DUMMY_CHECK));
    for (const name of [PASS_CASE, FAIL_CASE]) {
      const caseDir = goldenCaseDir(fixture, name);
      const calls = [];
      const registered = verdictOf(root, caseDir, { registry: dummyRegistry(calls) });
      const plain = verdictOf(root, caseDir);
      assert.deepStrictEqual(calls, [], `${fixture} ${name}: the check did not run`);
      assert.deepStrictEqual(registered.summary, plain.summary, `${fixture} ${name}`);
      assert.deepStrictEqual(registered.result.failures, plain.result.failures);
    }
  }
});

// The actual-result file the eval reads, built from a computed verdict.
const actualOf = ({ summary }) =>
  JSON.stringify({
    actual: summary.verdict,
    reasons: summary.reasons.map(({ code, id }) => ({ code, id })),
    items: [],
  });

// Computes the result of every case of a fixture's golden directory, read from
// the profile copy that enables the scope check.
const computeGolden = (t, fixture) => {
  const root = profileCopy(t, fixture, withChecks('affects-scope'));
  const casesDir = goldenDirOf(root);
  const cases = readCases(casesDir);
  const actualsRaw = {};
  for (const { name } of cases) {
    actualsRaw[name] = actualOf(verdictOf(root, path.join(casesDir, name)));
  }
  return { casesDir, cases, actualsRaw };
};

test('golden eval runs on fixture set in both profiles', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const { casesDir, cases, actualsRaw } = computeGolden(t, fixture);
    assert.deepStrictEqual(
      cases.map(({ name }) => name),
      [FAIL_CASE, PASS_CASE],
      fixture,
    );
    for (const { name } of cases) {
      const patch = path.join(casesDir, name, 'mutation.patch');
      assert.strictEqual(fs.existsSync(patch), name === FAIL_CASE, `${fixture} ${name}`);
    }
    const summary = summarize(cases, actualsRaw);
    assert.strictEqual(summary.falsePass, 0, fixture);
    assert.strictEqual(summary.falseFail, 0, fixture);
    assert.strictEqual(summary.runFailures, 0, fixture);
    assert.strictEqual(summary.reasonMismatches, 0, fixture);
    assert.strictEqual(summary.needsHuman, 0, fixture);
    assert.ok(summary.rows.every(({ outcome }) => outcome === 'matched'), fixture);
    const failRow = summary.rows.find(({ name }) => name === FAIL_CASE);
    assert.strictEqual(failRow.actual, 'FAIL');
    assert.deepStrictEqual(failRow.expectedReason, { code: OUT_OF_SCOPE, id: null });
    assert.ok(failRow.actualReasons.some(({ code }) => code === OUT_OF_SCOPE));
    assert.strictEqual(summary.pairs.length, 1, fixture);
  }
});

test('golden eval reports false pass on fixture set', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const { cases, actualsRaw } = computeGolden(t, fixture);
    // The one deliberate substitution: the FAIL case comes back as PASS.
    actualsRaw[FAIL_CASE] = JSON.stringify({ actual: 'PASS', reasons: [], items: [] });
    const summary = summarize(cases, actualsRaw);
    assert.strictEqual(summary.falsePass, 1, fixture);
    assert.strictEqual(summary.rows.find(({ name }) => name === FAIL_CASE).outcome, 'false_pass');
    assert.strictEqual(summary.rows.find(({ name }) => name === PASS_CASE).outcome, 'matched');
  }
});
