'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate } = require('./verdict');

const ref = (overrides = {}) => ({
  path: 'apps/api/x.ts',
  line: 1,
  quote: 'export const x',
  kind: 'impl',
  ...overrides,
});

const criterion = (status, text = 'AC one', overrides = {}) => ({
  id: '',
  text,
  status,
  summary: 'checked',
  refs: [ref()],
  ...overrides,
});

const report = (overrides = {}) =>
  JSON.stringify({
    criteria: [criterion('PASS')],
    invariants: [],
    test_tampering: [],
    risk_zones: ['none'],
    out_of_scope_files: [],
    ...overrides,
  });

const scanResult = (overrides = {}) => ({
  findings: [],
  assertion_losses: [],
  assertion_moved: 0,
  ...overrides,
});

// Fixture values only — deliberately not the real vars.VERIFIER_MODEL or the
// real Codex CLI pin, so this test fixture never duplicates a
// project-specific literal from the workflow.
const PROVENANCE = {
  head_sha: 'a'.repeat(40),
  issue_body_sha256: 'b'.repeat(64),
  verifier_commit: 'c'.repeat(40),
  model: 'test-model',
  codex_version: 'test-codex-version',
};

const ALLOWED_MODELS = [PROVENANCE.model];

const evaluateChecked = (raw, options = {}) =>
  evaluate(raw, {
    refsProblems: [],
    ciFailures: [],
    scope: { out_of_scope: [] },
    tamperingFindings: [],
    provenance: PROVENANCE,
    allowedModels: ALLOWED_MODELS,
    ...options,
  });

const codeqlSuccess = {
  name: 'Analyze (javascript-typescript)',
  status: 'completed',
  conclusion: 'success',
};

const ciJson = ({
  checks = [codeqlSuccess],
  statuses = [],
  conclusion = 'success',
  headSha = '0123456789abcdef',
} = {}) =>
  JSON.stringify({
    head_sha: headSha,
    ci_workflow_conclusion: conclusion,
    checks,
    statuses,
  });

const makeCheckout = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
};

const specItem = (id, type, text) => ({
  id,
  section: 'section',
  type,
  text,
  verify: type === null ? null : 'verify',
});

const absenceItem = (id, literal, filePath, text = 'absence check') => ({
  ...specItem(id, 'absence', text),
  verify: `absent "${literal}" in ${filePath}`,
});

const ciItem = (id, checkName, text = 'ci check') => ({
  ...specItem(id, 'ci', text),
  verify: `ci "${checkName}"`,
});

const V2_SPEC = {
  format: 'v2',
  problems: [],
  items: [
    specItem('INV-1', null, 'first invariant'),
    specItem('INV-2', null, 'second invariant'),
    specItem('AC-1', 'behavior', 'first behavior'),
    specItem('TR-1', 'behavior', 'test behavior'),
    specItem('DOD-1', 'doc', 'checks are green'),
  ],
};

const invariant = (id, status, overrides = {}) => ({
  id,
  status,
  summary: 'checked',
  refs: status === 'N/A' ? [] : [ref()],
  ...overrides,
});

const v2Report = ({
  ids = ['AC-1', 'TR-1', 'DOD-1'],
  invariants = [invariant('INV-1', 'PASS'), invariant('INV-2', 'N/A')],
} = {}) =>
  report({
    criteria: ids.map((id) => criterion('PASS', `model text ${id}`, { id })),
    invariants,
  });

// A v2 report over V2_SPEC's ids for the second-run fixtures: every entry
// passes unless its id is named in statuses.
const V2_CRITERION_IDS = ['AC-1', 'TR-1', 'DOD-1'];
const V2_INVARIANT_DEFAULTS = { 'INV-1': 'PASS', 'INV-2': 'N/A' };

const runReport = ({ statuses = {}, testTampering = [] } = {}) => {
  const statusOf = (id, fallback) => statuses[id] ?? fallback;
  const criteria = V2_CRITERION_IDS.map((id) =>
    criterion(statusOf(id, 'PASS'), `model text ${id}`, { id }),
  );
  const invariants = Object.entries(V2_INVARIANT_DEFAULTS).map(
    ([id, fallback]) => invariant(id, statusOf(id, fallback)),
  );
  return report({ criteria, invariants, test_tampering: testTampering });
};

const evaluateRun = (raw, options = {}) =>
  evaluateChecked(raw, { spec: V2_SPEC, ...options });

const LEGACY_SPEC = { format: 'legacy', problems: [] };
const BAD_REF_PROBLEM = 'AC-1: quote not found on apps/api/x.ts:1';
const CI_FAILURE = 'required check failed: Test (scripts) (failure)';

const SHA_APPROVED = 'a'.repeat(64);
const SHA_CURRENT = 'b'.repeat(64);
const APPROVAL_V2_SPEC = { format: 'v2', problems: [] };
const APPROVAL_LEGACY_SPEC = { format: 'legacy', problems: [] };

const approvalOf = (approved, current = SHA_CURRENT) => ({
  approved_hash: approved,
  current_hash: current,
});

const LOSS = { path: 'apps/api/x.spec.ts', lost: 3 };

// Built by concatenation (never a contiguous literal): this spec file is
// itself of class "test", so a literal marker here would flag this file.
const SKIP_FINDING = `x.spec.ts:1: skip-style marker "${'.' + 'only('}" added in test file`;

const CI_ABSENCE_SPEC_ITEMS = [
  specItem('AC-1', 'behavior', 'first behavior'),
  ciItem('DOD-1', 'Test (scripts)', 'checks are green'),
  absenceItem('DOD-2', 'TODO', 'apps/api/x.ts', 'no TODO left'),
];

const hasFailureWith = (result, text) =>
  result.failures.some((failure) => failure.includes(text));

const ISSUE_MD = [
  '# Title',
  '',
  '## Context',
  '- not counted',
  '',
  '## Acceptance Criteria',
  '- [x] first',
  '- [ ] second',
  '  - nested, not counted',
  '1. third',
  '',
  '## Definition of Done',
  '- [ ] Acceptance Criteria above are met',
  '',
  '## Test Requirement',
  'Unit tests in x.spec.js, CI-check `Test (scripts)`.',
  '',
  '## Manual verification (owner, not gated)',
  '- not counted',
  '',
  '```',
  '## Acceptance Criteria',
  '- fenced, not counted',
  '```',
].join('\n');

module.exports = {
  ref,
  criterion,
  report,
  scanResult,
  PROVENANCE,
  ALLOWED_MODELS,
  evaluateChecked,
  codeqlSuccess,
  ciJson,
  makeCheckout,
  specItem,
  absenceItem,
  ciItem,
  V2_SPEC,
  invariant,
  v2Report,
  runReport,
  evaluateRun,
  LEGACY_SPEC,
  BAD_REF_PROBLEM,
  CI_FAILURE,
  hasFailureWith,
  ISSUE_MD,
  CI_ABSENCE_SPEC_ITEMS,
  SHA_APPROVED,
  SHA_CURRENT,
  APPROVAL_V2_SPEC,
  APPROVAL_LEGACY_SPEC,
  approvalOf,
  LOSS,
  SKIP_FINDING,
};
