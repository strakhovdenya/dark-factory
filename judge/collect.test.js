'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadInputsConfig,
  readEntry,
  pickLatestSelfReport,
  classifyRun,
  buildManifest,
  collect,
} = require('./collect');
const { hash: specHash } = require('../verifier/spec-hash');

const SELF_REPORT_MARKER =
  'Agent-reported DONE — self-reported by the autonomous agent, ' +
  'not independently re-verified by the controller.';

const makeConfig = (overrides = {}) => ({
  independentInputs: [
    { key: 'issue', path: 'issue.md', fallbackPath: 'issue-current.md', format: 'text' },
    { key: 'specLint', path: 'spec-lint.json', format: 'json' },
    { key: 'diff', path: 'diff.patch', format: 'text' },
    { key: 'ci', path: 'ci.json', format: 'json' },
    { key: 'scope', path: 'scope.json', format: 'json' },
    { key: 'provenance', path: 'provenance.json', format: 'json' },
  ],
  fullOnlyInputs: [
    { key: 'verdict', path: 'verdict.json', format: 'json' },
    { key: 'verdict2', path: 'verdict2.json', format: 'json' },
    { key: 'refsProblems', path: 'refs-problems.json', format: 'json' },
    { key: 'verifierComment', path: 'verifier-comment.md', format: 'text' },
    { key: 'selfReport', selfReport: true, format: 'text' },
  ],
  trustedConfigs: ['verifier/prompt.md'],
  policy: { statusFile: 'policy-status.json', parts: { prompt: 'verifier/prompt.md' } },
  trustedConfigsRoot: 'trusted',
  roundMeta: {
    runFile: 'run.json',
    jobsFile: 'jobs.json',
    prFile: 'pr.json',
    verifyJobName: 'Verify',
    reportJobName: 'Report',
  },
  selfReportMarker: SELF_REPORT_MARKER,
  selfReportCommentsFile: 'pr-comments.json',
  ...overrides,
});

const makeRawDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-collect-raw-'));
const makeOutDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-collect-out-'));

const writeRaw = (rawDir, relPath, data) => {
  const fullPath = path.join(rawDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, typeof data === 'string' ? data : JSON.stringify(data));
};

const writeConfigFile = (config) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-collect-config-'));
  const file = path.join(dir, 'inputs.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
};

const COMPLETE_ROUND = {
  'run.json': { repository: 'owner/repo', run_id: 123, run_attempt: 1, conclusion: 'success' },
  'jobs.json': {
    jobs: [
      { name: 'Verify', status: 'completed', conclusion: 'success' },
      { name: 'Report', status: 'completed', conclusion: 'success' },
    ],
  },
  'pr.json': { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) },
};

const writeCompleteRound = (rawDir, overrides = {}) => {
  const data = { ...COMPLETE_ROUND, ...overrides };
  for (const [relPath, content] of Object.entries(data)) writeRaw(rawDir, relPath, content);
};

test('builds independent and full packages', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'issue.md', '# Issue');
  writeRaw(rawDir, 'spec-lint.json', { format: 'v2' });
  writeRaw(rawDir, 'diff.patch', '--- a\n+++ b\n');
  writeRaw(rawDir, 'ci.json', { checks: [] });
  writeRaw(rawDir, 'scope.json', { out_of_scope: [] });
  writeRaw(rawDir, 'provenance.json', {
    head_sha: 'b'.repeat(40),
    issue_body_sha256: 'c'.repeat(64),
    verifier_commit: 'd'.repeat(40),
    model: 'verifier-model-x',
    codex_version: '0.156.1',
  });
  writeRaw(rawDir, 'verdict.json', { criteria: [] });
  writeRaw(rawDir, 'verdict2.json', { criteria: [] });
  writeRaw(rawDir, 'refs-problems.json', []);
  writeRaw(rawDir, 'verifier-comment.md', '## Acceptance verifier: PASS');
  writeRaw(rawDir, 'trusted/verifier/prompt.md', 'prompt text');

  const manifest = collect(rawDir, outDir, makeConfig());

  const independentFiles = fs.readdirSync(path.join(outDir, 'independent')).sort();
  assert.deepStrictEqual(independentFiles, [
    'ci.json',
    'diff.patch',
    'issue.md',
    'provenance.json',
    'scope.json',
    'specLint.json',
    'trusted',
  ]);
  const fullFiles = fs.readdirSync(path.join(outDir, 'full')).sort();
  assert.deepStrictEqual(fullFiles, [
    'ci.json',
    'diff.patch',
    'issue.md',
    'provenance.json',
    'refsProblems.json',
    'scope.json',
    'specLint.json',
    'trusted',
    'verdict.json',
    'verdict2.json',
    'verifierComment.md',
  ]);
  assert.ok(fs.existsSync(path.join(outDir, 'independent', 'trusted/verifier/prompt.md')));
  assert.strictEqual(manifest.round_key.repository, 'owner/repo');
});

test('keeps verifier conclusions and self-report out of independent package', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'verdict.json', { criteria: [] });
  writeRaw(rawDir, 'verdict2.json', { criteria: [] });
  writeRaw(rawDir, 'refs-problems.json', []);
  writeRaw(rawDir, 'verifier-comment.md', '## Acceptance verifier: FAIL');
  writeRaw(rawDir, 'pr-comments.json', [
    { id: 1, created_at: '2026-09-29T10:00:00Z', user: { login: 'agent' }, body: SELF_REPORT_MARKER },
  ]);

  collect(rawDir, outDir, makeConfig());

  const independentFiles = fs.readdirSync(path.join(outDir, 'independent'));
  for (const forbidden of ['verdict.json', 'verdict2.json', 'refsProblems.json', 'verifierComment.md', 'selfReport.md']) {
    assert.ok(!independentFiles.includes(forbidden), `${forbidden} must not be in independent/`);
  }
  const fullFiles = fs.readdirSync(path.join(outDir, 'full'));
  for (const expected of ['verdict.json', 'verdict2.json', 'refsProblems.json', 'verifierComment.md', 'selfReport.md']) {
    assert.ok(fullFiles.includes(expected), `${expected} must be in full/`);
  }
});

test('excludes unlisted files from independent package', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'random-extra.txt', 'not part of any configured input');

  collect(rawDir, outDir, makeConfig());

  const independentFiles = fs.readdirSync(path.join(outDir, 'independent'));
  assert.ok(!independentFiles.includes('random-extra.txt'));
  const fullFiles = fs.readdirSync(path.join(outDir, 'full'));
  assert.ok(!fullFiles.includes('random-extra.txt'));
});

test('marks absent and unreadable inputs in manifest', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'ci.json', '{ not valid json');

  const manifest = collect(rawDir, outDir, makeConfig());

  assert.strictEqual(manifest.inputs.scope.status, 'absent');
  assert.strictEqual(manifest.inputs.ci.status, 'unreadable');
});

// The real config: the previous-round inputs must be full-only there, not in
// a fixture copy that could drift from it.
const REAL_CONFIG = loadInputsConfig(
  path.join(__dirname, 'inputs.json'),
);

const PREVIOUS_ROUND_FILES = {
  'previous-round.json': {
    status: 'present',
    round_key: { repository: 'owner/repo', verifier_run_id: 100, verifier_run_attempt: 1 },
    head_sha: 'c'.repeat(40),
    analysis: { implementation_defects: [] },
  },
  'previous-manifest.json': { head_sha: 'c'.repeat(40) },
  'head-diff.patch': '--- a/x.js\n+++ b/x.js\n',
  'issue-diff.patch': '--- previous/issue.md\n+++ current/issue.md\n',
  'policy-diff.patch': '--- previous/prompt.md\n+++ current/prompt.md\n',
  'round-compare.json': { taskChange: { type: 'both' } },
  'round-transitions.json': { transitions: [] },
};

const PREVIOUS_ROUND_KEYS = [
  'previousAnalysis',
  'previousManifest',
  'headDiff',
  'issueDiff',
  'policyDiff',
  'roundCompare',
  'roundTransitions',
];

test('passes previous round only to full package', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  for (const [relPath, content] of Object.entries(PREVIOUS_ROUND_FILES)) {
    writeRaw(rawDir, relPath, content);
  }

  const manifest = collect(rawDir, outDir, REAL_CONFIG);

  const independentKeys = REAL_CONFIG.independentInputs.map(({ key }) => key);
  const independentFiles = fs.readdirSync(path.join(outDir, 'independent'));
  const fullFiles = fs.readdirSync(path.join(outDir, 'full'));
  for (const key of PREVIOUS_ROUND_KEYS) {
    assert.strictEqual(manifest.inputs[key].status, 'present', key);
    assert.ok(!independentKeys.includes(key), `${key} must not be independent`);
    assert.ok(
      !independentFiles.some((file) => file.startsWith(`${key}.`)),
      `${key} must not be in independent/`,
    );
    assert.ok(
      fullFiles.some((file) => file.startsWith(`${key}.`)),
      `${key} must be in full/`,
    );
  }
  const previous = JSON.parse(
    fs.readFileSync(path.join(outDir, 'full', 'previousAnalysis.json'), 'utf8'),
  );
  assert.deepStrictEqual(previous, PREVIOUS_ROUND_FILES['previous-round.json']);
});

test('marks missing previous round', () => {
  const absentRaw = makeRawDir();
  const absentOut = makeOutDir();
  writeCompleteRound(absentRaw);
  const absent = collect(absentRaw, absentOut, REAL_CONFIG);
  for (const key of PREVIOUS_ROUND_KEYS) {
    assert.strictEqual(absent.inputs[key].status, 'absent', key);
  }

  const cases = [
    { content: { status: 'absent', analysis: null }, status: 'absent' },
    { content: { status: 'unreadable', analysis: null }, status: 'unreadable' },
    { content: { status: 'forged', analysis: {} }, status: 'unreadable' },
    { content: { analysis: {} }, status: 'unreadable' },
    { content: '{ not valid json', status: 'unreadable' },
  ];
  for (const item of cases) {
    const rawDir = makeRawDir();
    const outDir = makeOutDir();
    writeCompleteRound(rawDir);
    writeRaw(rawDir, 'previous-round.json', item.content);
    const manifest = collect(rawDir, outDir, REAL_CONFIG);
    assert.strictEqual(
      manifest.inputs.previousAnalysis.status,
      item.status,
      JSON.stringify(item.content),
    );
    const fullFiles = fs.readdirSync(path.join(outDir, 'full'));
    assert.ok(!fullFiles.includes('previousAnalysis.json'));
  }
});

test('rejects a status field on a text input', () => {
  const config = makeConfig({
    fullOnlyInputs: [
      { key: 'notes', path: 'notes.md', format: 'text', statusField: 'status' },
    ],
  });
  assert.throws(
    () => loadInputsConfig(writeConfigFile(config)),
    /fullOnlyInputs is invalid/,
  );
});

test('records round key provenance and config hashes', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'provenance.json', {
    head_sha: 'b'.repeat(40),
    issue_body_sha256: 'c'.repeat(64),
    verifier_commit: 'd'.repeat(40),
    model: 'verifier-model-x',
    codex_version: '0.156.1',
  });
  writeRaw(rawDir, 'trusted/verifier/prompt.md', 'prompt text');

  const manifest = collect(rawDir, outDir, makeConfig());

  assert.deepStrictEqual(manifest.round_key, {
    repository: 'owner/repo',
    verifier_run_id: 123,
    verifier_run_attempt: 1,
  });
  assert.strictEqual(manifest.base_sha, 'a'.repeat(40));
  assert.strictEqual(manifest.head_sha, 'b'.repeat(40));
  assert.strictEqual(manifest.issue_body_sha256, 'c'.repeat(64));
  assert.strictEqual(manifest.verifier_commit, 'd'.repeat(40));
  assert.strictEqual(manifest.model, 'verifier-model-x');
  assert.strictEqual(manifest.codex_version, '0.156.1');

  const crypto = require('node:crypto');
  const expectedHash = crypto.createHash('sha256').update('prompt text').digest('hex');
  assert.deepStrictEqual(manifest.trusted_config_hashes['verifier/prompt.md'], {
    present: true,
    sha256: expectedHash,
  });
});

test("independent package's issue-body hash matches provenance issue_body_sha256", () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  const body = 'The requirement text.\n';
  writeRaw(rawDir, 'issue.md', `# Some Issue Title\n\n${body}`);
  writeRaw(rawDir, 'issue-body.md', body);
  writeRaw(rawDir, 'provenance.json', {
    head_sha: 'b'.repeat(40),
    issue_body_sha256: specHash(body),
    verifier_commit: 'd'.repeat(40),
    model: 'verifier-model-x',
    codex_version: '0.156.1',
  });

  collect(rawDir, outDir, REAL_CONFIG);

  const packaged = fs.readFileSync(path.join(outDir, 'independent', 'issueBody.md'), 'utf8');
  const provenance = JSON.parse(
    fs.readFileSync(path.join(outDir, 'independent', 'provenance.json'), 'utf8'),
  );
  assert.strictEqual(specHash(packaged), provenance.issue_body_sha256);
  // issue.md (title + body) must not accidentally hash to the same value.
  const issueMd = fs.readFileSync(path.join(outDir, 'independent', 'issue.md'), 'utf8');
  assert.notStrictEqual(specHash(issueMd), provenance.issue_body_sha256);
});

test('a genuinely changed issue still mismatches via the title-free body file', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  const approvedBody = 'Approved requirement text.\n';
  const currentBody = 'Changed requirement text after approval.\n';
  writeRaw(rawDir, 'issue.md', `# Some Issue Title\n\n${currentBody}`);
  writeRaw(rawDir, 'issue-body.md', currentBody);
  writeRaw(rawDir, 'provenance.json', {
    head_sha: 'b'.repeat(40),
    issue_body_sha256: specHash(approvedBody),
    verifier_commit: 'd'.repeat(40),
    model: 'verifier-model-x',
    codex_version: '0.156.1',
  });

  collect(rawDir, outDir, REAL_CONFIG);

  const packaged = fs.readFileSync(path.join(outDir, 'independent', 'issueBody.md'), 'utf8');
  const provenance = JSON.parse(
    fs.readFileSync(path.join(outDir, 'independent', 'provenance.json'), 'utf8'),
  );
  assert.notStrictEqual(specHash(packaged), provenance.issue_body_sha256);
});

test('issueBody entry has no fallback and is absent when issue-body.md is missing', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'issue.md', '# Some Issue Title\n\nBody.\n');
  writeRaw(rawDir, 'issue-current.md', '# Some Issue Title\n\nLive body.\n');

  const manifest = collect(rawDir, outDir, REAL_CONFIG);

  const issueBodyEntry = REAL_CONFIG.independentInputs.find(
    (entry) => entry.key === 'issueBody',
  );
  assert.strictEqual(issueBodyEntry.fallbackPath, undefined);
  assert.strictEqual(manifest.inputs.issueBody.status, 'absent');
  const independentFiles = fs.readdirSync(path.join(outDir, 'independent'));
  assert.ok(!independentFiles.includes('issueBody.md'));
});

test('passes spec approval only to full package', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'spec-approval.json', {
    approved_hash: 'a'.repeat(64),
    current_hash: 'a'.repeat(64),
  });

  const manifest = collect(rawDir, outDir, REAL_CONFIG);

  const independentKeys = REAL_CONFIG.independentInputs.map(({ key }) => key);
  assert.ok(!independentKeys.includes('specApproval'));
  assert.strictEqual(manifest.inputs.specApproval.status, 'present');
  const independentFiles = fs.readdirSync(path.join(outDir, 'independent'));
  assert.ok(!independentFiles.some((file) => file.startsWith('specApproval.')));
  const fullFiles = fs.readdirSync(path.join(outDir, 'full'));
  assert.ok(fullFiles.some((file) => file.startsWith('specApproval.')));
});

test('marks missing spec approval without adding it to independent package', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);

  const manifest = collect(rawDir, outDir, REAL_CONFIG);

  assert.strictEqual(manifest.inputs.specApproval.status, 'absent');
  const independentFiles = fs.readdirSync(path.join(outDir, 'independent'));
  assert.ok(!independentFiles.some((file) => file.startsWith('specApproval.')));
});

test('keeps issue body in independent package', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'issue-body.md', 'The requirement text.\n');
  writeRaw(rawDir, 'spec-approval.json', {
    approved_hash: 'a'.repeat(64),
    current_hash: 'a'.repeat(64),
  });

  const manifest = collect(rawDir, outDir, REAL_CONFIG);

  assert.strictEqual(manifest.inputs.issueBody.status, 'present');
  const independentFiles = fs.readdirSync(path.join(outDir, 'independent'));
  assert.ok(independentFiles.includes('issueBody.md'));
});

test('treats both model runs as one round', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'verdict.json', { criteria: [] });
  writeRaw(rawDir, 'verdict2.json', { criteria: [] });

  const manifest = collect(rawDir, outDir, makeConfig());

  assert.strictEqual(manifest.inputs.verdict.status, 'present');
  assert.strictEqual(manifest.inputs.verdict2.status, 'present');
  const fullFiles = fs.readdirSync(path.join(outDir, 'full'));
  assert.ok(fullFiles.includes('verdict.json'));
  assert.ok(fullFiles.includes('verdict2.json'));
  assert.ok(!Object.prototype.hasOwnProperty.call(manifest, 'round_key_2'));
});

test('marks current api data as not historical', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);
  writeRaw(rawDir, 'issue-current.md', '# Issue (live from API)');

  const manifest = collect(rawDir, outDir, makeConfig());

  assert.strictEqual(manifest.inputs.issue.status, 'present');
  assert.strictEqual(manifest.inputs.issue.historical, false);
  const written = fs.readFileSync(path.join(outDir, 'independent', 'issue.md'), 'utf8');
  assert.strictEqual(written, '# Issue (live from API)');
});

test('fails without round key', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeRaw(rawDir, 'run.json', { repository: 'owner/repo', conclusion: 'success' });
  writeRaw(rawDir, 'jobs.json', { jobs: [] });
  writeRaw(rawDir, 'pr.json', { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) });

  assert.throws(() => collect(rawDir, outDir, makeConfig()), /round key/);
  assert.ok(!fs.existsSync(path.join(outDir, 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(outDir, 'independent')));
  assert.ok(!fs.existsSync(path.join(outDir, 'full')));
});

test('records verifier job conclusions', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir, {
    'jobs.json': {
      jobs: [
        { name: 'Verify', status: 'completed', conclusion: 'success' },
        { name: 'Verify second', status: 'completed', conclusion: 'failure' },
        { name: 'Report', status: 'completed', conclusion: 'success' },
      ],
    },
  });

  const manifest = collect(rawDir, outDir, makeConfig());

  assert.strictEqual(manifest.jobs.status, 'present');
  assert.deepStrictEqual(manifest.jobs.conclusions, {
    Verify: 'success',
    'Verify second': 'failure',
    Report: 'success',
  });
});

test('classifies success and failure runs as rounds', () => {
  const jobs = [
    { name: 'Verify', status: 'completed', conclusion: 'success' },
    { name: 'Report', status: 'completed', conclusion: 'success' },
  ];
  const roundMeta = { verifyJobName: 'Verify', reportJobName: 'Report' };

  assert.strictEqual(classifyRun({ conclusion: 'success' }, jobs, roundMeta).isRound, true);
  assert.strictEqual(classifyRun({ conclusion: 'failure' }, jobs, roundMeta).isRound, true);
});

test('does not count cancelled in-progress or stale runs', () => {
  const roundMeta = { verifyJobName: 'Verify', reportJobName: 'Report' };
  const successJobs = [
    { name: 'Verify', status: 'completed', conclusion: 'success' },
    { name: 'Report', status: 'completed', conclusion: 'success' },
  ];

  const cancelled = classifyRun({ conclusion: 'cancelled' }, successJobs, roundMeta);
  assert.strictEqual(cancelled.isRound, false);

  const inProgress = classifyRun({ conclusion: null }, successJobs, roundMeta);
  assert.strictEqual(inProgress.isRound, false);

  const staleJobs = [
    { name: 'Verify', status: 'completed', conclusion: 'success' },
    { name: 'Report', status: 'skipped', conclusion: null },
  ];
  const stale = classifyRun({ conclusion: 'success' }, staleJobs, roundMeta);
  assert.strictEqual(stale.isRound, false);
  assert.match(stale.reason, /stale/);
});

test('counts a run as a round when Report is absent from the jobs response rather than explicitly skipped', () => {
  const roundMeta = { verifyJobName: 'Verify', reportJobName: 'Report' };
  const jobsWithoutReport = [{ name: 'Verify', status: 'completed', conclusion: 'success' }];

  const result = classifyRun({ conclusion: 'success' }, jobsWithoutReport, roundMeta);

  assert.strictEqual(result.isRound, true);
});

test('picks latest executor self-report', () => {
  const comments = [
    { id: 1, created_at: '2026-09-29T10:00:00Z', body: `older ${SELF_REPORT_MARKER}` },
    { id: 2, created_at: '2026-09-29T12:00:00Z', body: `latest ${SELF_REPORT_MARKER}` },
    { id: 3, created_at: '2026-09-29T09:00:00Z', body: 'unrelated comment' },
  ];

  const picked = pickLatestSelfReport(comments, SELF_REPORT_MARKER);
  assert.strictEqual(picked.id, 2);

  const tied = [
    { id: 5, created_at: '2026-09-29T10:00:00Z', body: SELF_REPORT_MARKER },
    { id: 7, created_at: '2026-09-29T10:00:00Z', body: SELF_REPORT_MARKER },
  ];
  assert.strictEqual(pickLatestSelfReport(tied, SELF_REPORT_MARKER).id, 7);

  assert.strictEqual(pickLatestSelfReport([], SELF_REPORT_MARKER), null);
  assert.strictEqual(pickLatestSelfReport(null, SELF_REPORT_MARKER), null);
});

test('marks missing provenance without failing', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeCompleteRound(rawDir);

  const manifest = collect(rawDir, outDir, makeConfig());

  assert.strictEqual(manifest.inputs.provenance.status, 'absent');
  assert.strictEqual(manifest.issue_body_sha256, null);
  assert.strictEqual(manifest.verifier_commit, null);
  assert.strictEqual(manifest.model, null);
  assert.strictEqual(manifest.codex_version, null);
});

test('handles missing jobs response', () => {
  const rawDir = makeRawDir();
  const outDir = makeOutDir();
  writeRaw(rawDir, 'run.json', { repository: 'owner/repo', run_id: 1, run_attempt: 1, conclusion: 'success' });
  writeRaw(rawDir, 'pr.json', { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) });

  const manifest = collect(rawDir, outDir, makeConfig());

  assert.strictEqual(manifest.jobs.status, 'absent');
  assert.strictEqual(manifest.jobs.conclusions, null);
  assert.strictEqual(manifest.round_classification.isRound, false);
  assert.match(manifest.round_classification.reason, /no job data/);
});

test('rejects invalid inputs config', () => {
  assert.throws(() => loadInputsConfig(path.join(os.tmpdir(), 'does-not-exist-inputs.json')));

  const duplicateKeyConfig = makeConfig({
    fullOnlyInputs: [
      { key: 'issue', path: 'verdict.json', format: 'json' },
      { key: 'selfReport', selfReport: true, format: 'text' },
    ],
  });
  const file = writeConfigFile(duplicateKeyConfig);
  assert.throws(() => loadInputsConfig(file), /duplicate input key/);

  const duplicatePathConfig = makeConfig({
    fullOnlyInputs: [
      { key: 'ci2', path: 'ci.json', format: 'json' },
      { key: 'selfReport', selfReport: true, format: 'text' },
    ],
  });
  const duplicatePathFile = writeConfigFile(duplicatePathConfig);
  assert.throws(() => loadInputsConfig(duplicatePathFile), /duplicate input path/);
});

test('readEntry falls back to a non-historical path when the primary is absent', () => {
  const rawDir = makeRawDir();
  writeRaw(rawDir, 'issue-current.md', 'current body');
  const entry = { key: 'issue', path: 'issue.md', fallbackPath: 'issue-current.md', format: 'text' };

  const result = readEntry(rawDir, entry);

  assert.strictEqual(result.status, 'present');
  assert.strictEqual(result.historical, false);
  assert.strictEqual(result.content, 'current body');
});

test('readEntry falls back when the primary file exists but fails to parse', () => {
  const rawDir = makeRawDir();
  writeRaw(rawDir, 'spec-lint.json', '{ not valid json');
  writeRaw(rawDir, 'spec-lint-current.json', { format: 'v2' });
  const entry = {
    key: 'specLint',
    path: 'spec-lint.json',
    fallbackPath: 'spec-lint-current.json',
    format: 'json',
  };

  const result = readEntry(rawDir, entry);

  assert.strictEqual(result.status, 'present');
  assert.strictEqual(result.historical, false);
  assert.deepStrictEqual(result.content, { format: 'v2' });
});

test('readEntry reports unreadable when both the primary and fallback fail to parse', () => {
  const rawDir = makeRawDir();
  writeRaw(rawDir, 'spec-lint.json', '{ not valid json');
  writeRaw(rawDir, 'spec-lint-current.json', '{ also not valid');
  const entry = {
    key: 'specLint',
    path: 'spec-lint.json',
    fallbackPath: 'spec-lint-current.json',
    format: 'json',
  };

  const result = readEntry(rawDir, entry);

  assert.strictEqual(result.status, 'unreadable');
  assert.strictEqual(result.historical, true);
});

test('buildManifest throws when run.json is entirely absent', () => {
  const rawDir = makeRawDir();
  writeRaw(rawDir, 'jobs.json', { jobs: [] });
  writeRaw(rawDir, 'pr.json', { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) });

  assert.throws(() => buildManifest(rawDir, makeConfig(), new Map(), new Map()), /round key/);
});

// --- Historical policy: the rules of a round come from its policy snapshot ---

const { loadFingerprintConfig, compareRounds } = require('./compare');
const {
  readRoundPolicy,
  statusRecordOf,
  writePolicyFiles,
  loadStoredPolicy,
  policyDiff,
} = require('./policy');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const { snapshotOf, originOf, FACTORY_SHA, HEAD_SHA } = require('../test/helpers/snapshot');

const POLICY_CONFIG = loadInputsConfig(path.join(__dirname, 'inputs.json'));
const FINGERPRINT = loadFingerprintConfig(POLICY_CONFIG);
const POLICY_RUN_ID = 777;
const POLICY_ATTEMPT = 2;

const policyRound = (overrides = {}) => ({
  runId: POLICY_RUN_ID,
  runAttempt: POLICY_ATTEMPT,
  headSha: HEAD_SHA,
  verifierCommit: FACTORY_SHA,
  ...overrides,
});

const snapshotText = (snapshot) => JSON.stringify(snapshot);

const makeTemp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// The raw directory of a round, as the workflow builds it: the round's own
// artifacts plus the policy the snapshot (or its absence) produced. Nothing
// from the project's current settings is placed here.
const policyRaw = (t, source, { round = policyRound(), attempt = POLICY_ATTEMPT } = {}) => {
  const raw = makeTemp(t);
  writeRaw(raw, 'run.json', {
    repository: 'owner/repo',
    run_id: round.runId,
    run_attempt: attempt,
    conclusion: 'failure',
  });
  writeRaw(raw, 'jobs.json', COMPLETE_ROUND['jobs.json']);
  writeRaw(raw, 'pr.json', { base_sha: 'a'.repeat(40), head_sha: round.headSha });
  writeRaw(raw, 'provenance.json', {
    head_sha: round.headSha,
    issue_body_sha256: 'c'.repeat(64),
    verifier_commit: round.verifierCommit,
    model: 'verifier-model-x',
    codex_version: '0.156.1',
  });
  writeRaw(raw, 'issue.md', '# Issue');
  writeRaw(raw, 'ci.json', { checks: [] });
  writeRaw(raw, 'spec-approval.json', { approved_hash: null });
  writeRaw(raw, 'verifier-comment.md', 'verdict comment');
  writeRaw(raw, 'verdict.json', { criteria: [], invariants: [] });
  const policy = readRoundPolicy(source, round, POLICY_CONFIG);
  writePolicyFiles(policy, path.join(raw, POLICY_CONFIG.trustedConfigsRoot));
  writeRaw(raw, POLICY_CONFIG.policy.statusFile, statusRecordOf(policy));
  return { raw, policy };
};

const collectPolicy = (t, raw) => {
  const out = makeTemp(t);
  const manifest = collect(raw, out, POLICY_CONFIG);
  return { out, manifest };
};

const compareContents = { ci: { checks: [] }, specApproval: { approved_hash: null }, verifierComment: '' };
const withContents = (manifest) => ({ ...manifest, contents: compareContents });

const readPackaged = (out, kind, relative) =>
  fs.readFileSync(path.join(out, kind, 'trusted', relative), 'utf8');

test('reconstructs round policies from snapshots instead of current configs', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const previousSnapshot = snapshotOf(t, fixture, {
      origin: originOf({ run_id: 700, run_attempt: 1 }),
    });
    const currentSnapshot = snapshotOf(t, fixture, {
      origin: originOf({ run_id: POLICY_RUN_ID }),
      mutate: (profile) => {
        profile.verifier.checks = [...profile.verifier.checks, 'dummy-check'];
      },
      files: {
        '.github/verifier/risk-zones.json': { zones: [{ name: 'payments_core', description: 'payments' }] },
      },
    });
    const previous = policyRaw(t, { snapshotText: snapshotText(previousSnapshot) }, {
      round: policyRound({ runId: 700 }),
      attempt: 1,
    });
    const current = policyRaw(t, { snapshotText: snapshotText(currentSnapshot) });
    assert.strictEqual(previous.policy.status, 'present', fixture);
    assert.strictEqual(current.policy.status, 'present', fixture);

    // The default branch of the project has moved on since: its settings differ
    // from both rounds and must not appear in either package.
    const decoy = makeTemp(t);
    writeRaw(decoy, 'trusted/.github/verifier/risk-zones.json', { zones: [{ name: 'current_only' }] });
    writeRaw(decoy, 'trusted/.factory/profile.json', { branchTemplate: 'current/{issue}' });

    const previousPackage = collectPolicy(t, previous.raw);
    const currentPackage = collectPolicy(t, current.raw);
    for (const kind of ['independent', 'full']) {
      assert.strictEqual(
        readPackaged(currentPackage.out, kind, 'project/risk-zones.json'),
        currentSnapshot.parts.risk_zones.content,
      );
      assert.strictEqual(
        readPackaged(previousPackage.out, kind, 'project/risk-zones.json'),
        previousSnapshot.parts.risk_zones.content,
      );
      assert.doesNotMatch(readPackaged(currentPackage.out, kind, 'project/risk-zones.json'), /current_only/);
      assert.strictEqual(
        readPackaged(currentPackage.out, kind, 'project/profile.json'),
        currentSnapshot.parts.profile.content,
      );
    }

    const diff = policyDiff(
      loadStoredPolicy(previous.raw, POLICY_CONFIG),
      loadStoredPolicy(current.raw, POLICY_CONFIG),
      POLICY_CONFIG,
    );
    assert.match(diff, /^--- previous\/project\/risk-zones\.json$/m);
    assert.match(diff, /^\+.*payments_core/m);
    assert.match(diff, /^-.*billing_data/m);
    assert.match(diff, /^--- previous\/project\/profile\.json$/m);
    assert.match(diff, /^\+.*dummy-check/m);
    assert.match(diff, /^--- previous\/project\/enabled-checks\.json$/m);
    assert.match(diff, /^# unchanged: project\/owners\.json$/m);
    assert.doesNotMatch(diff, /current_only/);

    const comparison = compareRounds(
      withContents(previousPackage.manifest),
      withContents(currentPackage.manifest),
      FINGERPRINT,
    );
    assert.strictEqual(comparison.comparability.result, 'INPUTS_CHANGED', fixture);
    assert.deepStrictEqual(comparison.comparability.changedInputs, ['trustedConfigHashes']);

    // The same snapshots in both rounds are comparable, confirmed absences included.
    const twin = policyRaw(t, { snapshotText: snapshotText(previousSnapshot) }, {
      round: policyRound({ runId: 700 }),
      attempt: 1,
    });
    const twinPackage = collectPolicy(t, twin.raw);
    const same = compareRounds(
      withContents(previousPackage.manifest),
      withContents(twinPackage.manifest),
      FINGERPRINT,
    );
    assert.strictEqual(same.comparability.result, 'COMPARABLE', fixture);
  }
});

test('packages effective core and project rules while isolating stage one', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const snapshot = snapshotOf(t, fixture, { origin: originOf({ run_id: POLICY_RUN_ID }) });
    const { raw, policy } = policyRaw(t, { snapshotText: snapshotText(snapshot) });
    writeRaw(raw, 'previous-round.json', { status: 'present', analysis: { note: 'earlier analysis' } });
    const { out, manifest } = collectPolicy(t, raw);

    const wanted = {
      'verifier/prompt.md': snapshot.parts.prompt.content,
      'verifier/schema.json': snapshot.parts.schema.content,
      'verifier/issue-contract.json': snapshot.parts.issue_contract.content,
      'verifier/issue-contract.overlay.json': snapshot.parts.issue_contract_overlay.content,
      'project/profile.json': snapshot.parts.profile.content,
      'project/enabled-checks.json': snapshot.parts.enabled_checks.content,
      'project/risk-zones.json': snapshot.parts.risk_zones.content,
      'project/owners.json': snapshot.parts.owners.content,
      'project/required-checks.json': snapshot.parts.required_checks.content,
      'project/allowed-models.json': snapshot.parts.verifier_allowed_models.content,
      'project/tampering-scan.json': snapshot.parts.tampering_config.content,
    };
    for (const kind of ['independent', 'full']) {
      for (const [relative, content] of Object.entries(wanted)) {
        assert.strictEqual(readPackaged(out, kind, relative), content, `${fixture} ${kind} ${relative}`);
      }
    }
    assert.deepStrictEqual(Object.keys(policy.parts).sort(), Object.keys(wanted).sort());
    assert.strictEqual(manifest.inputs.policySnapshot.status, 'present');
    for (const relative of Object.keys(wanted)) {
      assert.strictEqual(manifest.trusted_config_hashes[relative].present, true, relative);
    }

    const independent = fs.readdirSync(path.join(out, 'independent'));
    for (const forbidden of [
      'verdict.json',
      'verdict2.json',
      'verifierComment.md',
      'specApproval.json',
      'previousAnalysis.json',
      'policySnapshot.json',
      'selfReport.md',
    ]) {
      assert.ok(!independent.includes(forbidden), `${fixture}: ${forbidden} is not independent`);
    }
    const full = fs.readdirSync(path.join(out, 'full'));
    for (const stageTwoOnly of ['verdict.json', 'verifierComment.md', 'specApproval.json', 'policySnapshot.json']) {
      assert.ok(full.includes(stageTwoOnly), `${fixture}: ${stageTwoOnly} reaches stage two`);
    }
  }
});

test('marks missing historical policy without substituting current rules', (t) => {
  const sources = [
    { name: 'old round without a snapshot', source: { snapshotText: null }, status: 'absent' },
    {
      name: 'expired artifact',
      source: { snapshotText: null, missingReason: 'the snapshot artifact has expired' },
      status: 'absent',
    },
    {
      name: 'download failure',
      source: { snapshotText: null, failureReason: 'the artifact could not be downloaded' },
      status: 'unreadable',
    },
  ];
  const goodSnapshot = snapshotOf(t, 'monorepo', { origin: originOf({ run_id: 700, run_attempt: 1 }) });
  const good = policyRaw(t, { snapshotText: snapshotText(goodSnapshot) }, {
    round: policyRound({ runId: 700 }),
    attempt: 1,
  });
  const goodPackage = collectPolicy(t, good.raw);
  for (const { name, source, status } of sources) {
    const { raw, policy } = policyRaw(t, source);
    assert.strictEqual(policy.status, status, name);
    assert.ok(policy.reason.length > 0, name);
    const { out, manifest } = collectPolicy(t, raw);

    assert.strictEqual(manifest.inputs.policySnapshot.status, status, name);
    for (const kind of ['independent', 'full']) {
      assert.ok(!fs.existsSync(path.join(out, kind, 'trusted')), `${name}: no rules are made up`);
    }
    for (const [relative, entry] of Object.entries(manifest.trusted_config_hashes)) {
      assert.deepStrictEqual(entry, { present: false, sha256: null }, `${name} ${relative}`);
    }

    const comparison = compareRounds(
      withContents(goodPackage.manifest),
      withContents(manifest),
      FINGERPRINT,
    );
    assert.strictEqual(comparison.comparability.result, 'UNKNOWN', name);
    assert.ok(comparison.comparability.incompleteInputs.includes('trustedConfigHashes'), name);

    const diff = policyDiff(
      loadStoredPolicy(good.raw, POLICY_CONFIG),
      loadStoredPolicy(raw, POLICY_CONFIG),
      POLICY_CONFIG,
    );
    assert.match(diff, /policy comparison unavailable/);
    assert.match(diff, /no conclusion about changed or unchanged rules/);
    assert.doesNotMatch(diff, /# unchanged/);
  }
  const fromNothing = loadStoredPolicy(makeTemp(t), POLICY_CONFIG);
  assert.strictEqual(fromNothing.status, 'absent');
});

test('rejects corrupted, unattributed or unsupported policy snapshots', (t) => {
  const valid = () => snapshotOf(t, 'single-package', { origin: originOf({ run_id: POLICY_RUN_ID }) });
  const variants = [
    { name: 'unknown format version', mutate: (s) => { s.format_version = 99; }, reason: /version 99 is not supported/ },
    { name: 'no format version', mutate: (s) => { delete s.format_version; }, reason: /not supported/ },
    { name: 'damaged hash', mutate: (s) => { s.parts.risk_zones.sha256 = '0'.repeat(64); }, reason: /risk_zones does not match its hash/ },
    { name: 'edited content', mutate: (s) => { s.parts.profile.content += ' '; }, reason: /profile does not match its hash/ },
    { name: 'no origin', mutate: (s) => { delete s.origin; }, reason: /no origin/ },
    { name: 'no factory SHA', mutate: (s) => { delete s.origin.factory_sha; }, reason: /another factory release/ },
    { name: 'other factory SHA', mutate: (s) => { s.origin.factory_sha = '1'.repeat(40); }, reason: /another factory release/ },
    { name: 'other head commit', mutate: (s) => { s.origin.head_sha = '2'.repeat(40); }, reason: /another head commit/ },
    { name: 'no project settings commit', mutate: (s) => { delete s.origin.project_sha; }, reason: /no project settings commit/ },
    { name: 'missing part', mutate: (s) => { delete s.parts.owners; }, reason: /owners is missing/ },
  ];
  for (const { name, mutate, reason } of variants) {
    const snapshot = valid();
    mutate(snapshot);
    const { raw, policy } = policyRaw(t, { snapshotText: snapshotText(snapshot) });
    assert.strictEqual(policy.status, 'unreadable', name);
    assert.match(policy.reason, reason, name);
    const { out, manifest } = collectPolicy(t, raw);
    assert.strictEqual(manifest.inputs.policySnapshot.status, 'unreadable', name);
    assert.ok(!fs.existsSync(path.join(out, 'full', 'trusted')), `${name}: nothing is taken from a rejected snapshot`);
  }
  const notJson = policyRaw(t, { snapshotText: '{ not json' });
  assert.strictEqual(notJson.policy.status, 'unreadable');

  const noProvenance = policyRaw(t, { snapshotText: snapshotText(valid()) }, {
    round: policyRound({ verifierCommit: null }),
  });
  assert.strictEqual(noProvenance.policy.status, 'unreadable');
  assert.match(noProvenance.policy.reason, /no verifier commit/);
});

test('binds snapshot to round run and attempt', (t) => {
  const accepted = (snapshot) => readRoundPolicy({ snapshotText: snapshotText(snapshot) }, policyRound(), POLICY_CONFIG);
  const make = (origin) => snapshotOf(t, 'monorepo', { origin: originOf(origin) });

  const sameAttempt = accepted(make({ run_id: POLICY_RUN_ID, run_attempt: POLICY_ATTEMPT }));
  assert.strictEqual(sameAttempt.status, 'present');
  assert.strictEqual(sameAttempt.attempt, POLICY_ATTEMPT);

  const earlier = accepted(make({ run_id: POLICY_RUN_ID, run_attempt: 1 }));
  assert.strictEqual(earlier.status, 'present');
  assert.strictEqual(earlier.attempt, 1);
  assert.strictEqual(earlier.origin.run_attempt, 1);

  const later = accepted(make({ run_id: POLICY_RUN_ID, run_attempt: POLICY_ATTEMPT + 1 }));
  assert.strictEqual(later.status, 'unreadable');
  assert.match(later.reason, /later than attempt/);
  assert.deepStrictEqual(later.files, {});

  const otherRun = accepted(make({ run_id: POLICY_RUN_ID + 1, run_attempt: 1 }));
  assert.strictEqual(otherRun.status, 'unreadable');
  assert.match(otherRun.reason, /belongs to run/);

  // An accepted snapshot of an earlier attempt is carried into the package record.
  const { raw } = policyRaw(t, { snapshotText: snapshotText(make({ run_id: POLICY_RUN_ID, run_attempt: 1 })) });
  const stored = JSON.parse(fs.readFileSync(path.join(raw, POLICY_CONFIG.policy.statusFile), 'utf8'));
  assert.strictEqual(stored.attempt, 1);
  assert.strictEqual(stored.status, 'present');
});

test('a policy record naming a path outside the rules is not trusted', (t) => {
  const { raw } = policyRaw(t, { snapshotText: snapshotText(snapshotOf(t, 'monorepo', { origin: originOf({ run_id: POLICY_RUN_ID }) })) });
  const file = path.join(raw, POLICY_CONFIG.policy.statusFile);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const bad of [{ '../../outside.txt': { state: 'saved', sha256: 'x' } }, { 'project/profile.json': null }]) {
    fs.writeFileSync(file, JSON.stringify({ ...record, parts: bad }));
    const policy = loadStoredPolicy(raw, POLICY_CONFIG);
    assert.strictEqual(policy.status, 'unreadable');
    assert.deepStrictEqual(policy.files, {});
  }
});

test('a diff too large to compute is reported instead of crashing', () => {
  const { unifiedDiff } = require('./policy');
  const big = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join('\n');
  assert.match(unifiedDiff(big, `${big}\nmore`, 'a', 'b'), /^# not compared: b is too large to diff/);
  assert.match(unifiedDiff('a\nb', 'a\nc', 'a', 'b'), /^--- a/);
});
