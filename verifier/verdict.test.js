'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('./acceptance-verdict');
const {
  report,
  scanResult,
  ciJson,
  makeCheckout,
  ref,
  criterion,
  ISSUE_MD,
  V2_SPEC,
  invariant,
  APPROVAL_LEGACY_SPEC,
  approvalOf,
  SHA_CURRENT,
  LOSS,
  PROVENANCE,
  codeqlSuccess,
  runReport,
  BAD_REF_PROBLEM,
} = require('./acceptance-verdict/test-helpers');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'acceptance-verdict.js');
const WORKFLOW = path.join(
  ROOT,
  '.github',
  'workflows',
  'acceptance-verifier.yml',
);

test('parseArgs reads file, --out, --refs-problems and flags', () => {
  assert.deepStrictEqual(
    parseArgs([
      'v.json',
      '--out',
      'c.md',
      '--refs-problems',
      'r.json',
      '--manual-verified',
    ]),
    {
      file: 'v.json',
      out: 'c.md',
      manualVerified: true,
      checkRefs: false,
      root: null,
      refsProblems: 'r.json',
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
    },
  );
  assert.strictEqual(parseArgs(['v.json', '--ci', 'ci.json']).ci, 'ci.json');
  const check = parseArgs([
    '--check-refs',
    'v.json',
    '--root',
    '.',
    '--out',
    'o',
  ]);
  assert.strictEqual(check.checkRefs, true);
  assert.strictEqual(check.root, '.');
});

test('parseArgs reads --manual-verified-ignored and --manual-verified-ignored-unknown', () => {
  const named = parseArgs([
    'v.json',
    '--out',
    'c.md',
    '--manual-verified-ignored',
    'someone-else',
  ]);
  assert.strictEqual(named.manualVerifiedIgnoredBy, 'someone-else');
  const unknown = parseArgs([
    'v.json',
    '--out',
    'c.md',
    '--manual-verified-ignored-unknown',
  ]);
  assert.strictEqual(unknown.manualVerifiedIgnoredBy, null);
});

test('parseArgs reads --approval', () => {
  const options = parseArgs(['v.json', '--approval', 'spec-approval.json']);
  assert.strictEqual(options.approval, 'spec-approval.json');
});

test('parseArgs reads --required-checks', () => {
  const options = parseArgs([
    'v.json',
    '--required-checks',
    'required-checks.json',
  ]);
  assert.strictEqual(options.requiredChecks, 'required-checks.json');
});

test('parseArgs reads --tampering-scan', () => {
  const options = parseArgs([
    'v.json',
    '--tampering-scan',
    'tampering-scan-result.json',
  ]);
  assert.strictEqual(options.tamperingScan, 'tampering-scan-result.json');
});

test('parseArgs reads --provenance', () => {
  const options = parseArgs(['v.json', '--provenance', 'provenance.json']);
  assert.strictEqual(options.provenance, 'provenance.json');
});

test('parseArgs reads --allowed-models', () => {
  const options = parseArgs([
    'v.json',
    '--allowed-models',
    'allowed-models.json',
  ]);
  assert.strictEqual(options.allowedModels, 'allowed-models.json');
});

test('parseArgs reads --needs-second-run, --second and --second-refs-problems', () => {
  const options = parseArgs([
    'v.json',
    '--needs-second-run',
    '--second',
    'verdict2.json',
    '--second-refs-problems',
    'refs-problems2.json',
  ]);
  assert.strictEqual(options.needsSecondRun, true);
  assert.strictEqual(options.second, 'verdict2.json');
  assert.strictEqual(options.secondRefsProblems, 'refs-problems2.json');
});

test('parses test-removal flags', () => {
  assert.strictEqual(
    parseArgs(['v.json', '--test-removal-approved']).testRemovalApproved,
    true,
  );
  assert.strictEqual(parseArgs(['v.json']).testRemovalApproved, false);
  assert.strictEqual(
    parseArgs(['v.json', '--test-removal-ignored', 'octocat']).testRemovalIgnoredBy,
    'octocat',
  );
  assert.strictEqual(
    parseArgs(['v.json', '--test-removal-ignored-unknown']).testRemovalIgnoredBy,
    null,
  );
  assert.strictEqual(parseArgs(['v.json']).testRemovalIgnoredBy, undefined);
});

test('CLI writes a FAIL comment when the report file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const out = path.join(dir, 'comment.md');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, path.join(dir, 'absent.json'), '--out', out],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), 'FAIL');
  assert.ok(fs.readFileSync(out, 'utf8').includes('report not readable'));
  fs.rmSync(dir, { recursive: true });
});

test('CLI end to end: --manual-verified-ignored-unknown renders the unknown actor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const file = path.join(dir, 'verdict.json');
  fs.writeFileSync(file, report());
  const out = path.join(dir, 'comment.md');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, file, '--out', out, '--manual-verified-ignored-unknown'],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.ok(
    fs.readFileSync(out, 'utf8').includes('manual-verified ignored: set by unknown'),
  );
  fs.rmSync(dir, { recursive: true });
});

test('CLI end to end: check refs, then compute a PASS verdict', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const file = path.join(root, 'verdict.json');
  fs.writeFileSync(file, report());
  const problems = path.join(root, 'refs-problems.json');
  const ci = path.join(root, 'ci.json');
  fs.writeFileSync(ci, ciJson());
  const tamperingScan = path.join(root, 'tampering-scan-result.json');
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  const provenance = path.join(root, 'provenance.json');
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  const allowedModels = path.join(root, 'allowed-models.json');
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  const check = spawnSync(
    process.execPath,
    [SCRIPT, '--check-refs', file, '--root', root, '--out', problems],
    { encoding: 'utf8' },
  );
  assert.strictEqual(check.status, 0);
  assert.strictEqual(fs.readFileSync(problems, 'utf8'), '[]');
  const verdict = spawnSync(
    process.execPath,
    [
      SCRIPT,
      file,
      '--out',
      path.join(root, 'c.md'),
      '--refs-problems',
      problems,
      '--ci',
      ci,
      '--tampering-scan',
      tamperingScan,
      '--provenance',
      provenance,
      '--allowed-models',
      allowedModels,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(verdict.stdout.trim(), 'PASS');
  fs.rmSync(root, { recursive: true });
});

test('CLI check-refs writes the shift to --notes-out', () => {
  const root = makeCheckout({
    'apps/api/x.ts': 'one\nexport const x = 1;\nthree\n',
  });
  const file = path.join(root, 'verdict.json');
  fs.writeFileSync(
    file,
    report({
      criteria: [
        criterion('PASS', 'AC', {
          refs: [ref({ line: 1, quote: 'export const x' })],
        }),
      ],
    }),
  );
  const problems = path.join(root, 'refs-problems.json');
  const notesOut = path.join(root, 'refs-notes.json');
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT, '--check-refs', file, '--root', root, '--out', problems,
      '--notes-out', notesOut,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.strictEqual(fs.readFileSync(problems, 'utf8'), '[]');
  const notes = JSON.parse(fs.readFileSync(notesOut, 'utf8'));
  assert.deepStrictEqual(notes, [
    { list: 'criteria', entry: 0, ref: 0, cited: 1, found: 2 },
  ]);
  fs.rmSync(root, { recursive: true });
});

test('CLI check-refs without --notes-out writes no notes file', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const file = path.join(root, 'verdict.json');
  fs.writeFileSync(file, report());
  const problems = path.join(root, 'refs-problems.json');
  const notesOut = path.join(root, 'refs-notes.json');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--check-refs', file, '--root', root, '--out', problems],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.strictEqual(fs.existsSync(notesOut), false);
  fs.rmSync(root, { recursive: true });
});

test('CLI is FAIL when the refs-problems file is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const file = path.join(dir, 'verdict.json');
  fs.writeFileSync(file, report());
  const run = spawnSync(
    process.execPath,
    [SCRIPT, file, '--out', path.join(dir, 'c.md')],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.stdout.trim(), 'FAIL');
  fs.rmSync(dir, { recursive: true });
});

test('CLI exits 2 on missing arguments', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(run.status, 2);
});

const writeInto = (dir) => (name, content) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};

// The deterministic inputs of a v2 run; all green unless ci says otherwise.
const secondRunArgs = (dir, { ci = ciJson() } = {}) => {
  const write = writeInto(dir);
  const scope = JSON.stringify({ out_of_scope: [] });
  const models = JSON.stringify([PROVENANCE.model]);
  return [
    '--spec', write('spec-lint.json', JSON.stringify(V2_SPEC)),
    '--scope', write('scope.json', scope),
    '--ci', write('ci.json', ci),
    '--tampering-scan',
    write('tampering-scan-result.json', JSON.stringify(scanResult())),
    '--provenance', write('provenance.json', JSON.stringify(PROVENANCE)),
    '--allowed-models', write('allowed-models.json', models),
  ];
};

const FAILED_BUILD_CI = ciJson({
  checks: [
    codeqlSuccess,
    { name: 'Build', status: 'completed', conclusion: 'failure' },
  ],
});

const runNeedsSecondRun = ({ ci } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const write = writeInto(dir);
  const file = write('verdict.json', runReport());
  const problems = write('refs-problems.json', JSON.stringify([BAD_REF_PROBLEM]));
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT, file, '--needs-second-run', '--refs-problems', problems,
      ...secondRunArgs(dir, { ci }),
    ],
    { encoding: 'utf8' },
  );
  fs.rmSync(dir, { recursive: true });
  return run;
};

test('CLI --needs-second-run prints true for a model-only FAIL', () => {
  const run = runNeedsSecondRun();
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), 'true');
});

test('CLI --needs-second-run prints false with a deterministic failure', () => {
  const run = runNeedsSecondRun({ ci: FAILED_BUILD_CI });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), 'false');
});

const runWithSecond = ({ firstReport, secondFile }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const write = writeInto(dir);
  const first = write('verdict.json', firstReport);
  const second =
    secondFile === null
      ? path.join(dir, 'absent.json')
      : write('verdict2.json', secondFile);
  const out = path.join(dir, 'comment.md');
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT, first, '--out', out,
      '--refs-problems', write('refs-problems.json', '[]'),
      '--second', second,
      '--second-refs-problems', write('refs-problems2.json', '[]'),
      ...secondRunArgs(dir),
    ],
    { encoding: 'utf8' },
  );
  const comment = fs.readFileSync(out, 'utf8');
  fs.rmSync(dir, { recursive: true });
  return { run, comment };
};

test('CLI --second prints NEEDS_HUMAN for diverging reports', () => {
  const { run, comment } = runWithSecond({
    firstReport: runReport({ statuses: { 'AC-1': 'FAIL' } }),
    secondFile: runReport(),
  });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), 'NEEDS_HUMAN');
  assert.ok(comment.includes('## Acceptance verifier: NEEDS_HUMAN'));
  assert.ok(comment.includes('**Runs disagree on**\n- AC-1'));
});

test('CLI --second prints PASS when an invalid first report meets a passing second', () => {
  const { run, comment } = runWithSecond({
    firstReport: '{not json',
    secondFile: runReport(),
  });
  assert.strictEqual(run.stdout.trim(), 'PASS');
  assert.ok(comment.includes('**Second run**'));
});

test('CLI --second with a missing file prints FAIL', () => {
  const { run, comment } = runWithSecond({
    firstReport: runReport(),
    secondFile: null,
  });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), 'FAIL');
  assert.ok(comment.includes('report not readable'));
});

test('parseArgs reads --result-out', () => {
  const options = parseArgs(['v.json', '--out', 'c.md', '--result-out', 'r.json']);
  assert.strictEqual(options.resultOut, 'r.json');
  assert.strictEqual(parseArgs(['v.json']).resultOut, null);
});

test('result-out does not change verdict or comment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const write = writeInto(dir);
  const first = write(
    'verdict.json',
    runReport({ statuses: { 'AC-1': 'FAIL' } }),
  );
  const second = write('verdict2.json', runReport());
  const resultFile = path.join(dir, 'result.json');
  const inputs = [
    '--refs-problems', write('refs-problems.json', '[]'),
    '--second', second,
    '--second-refs-problems', write('refs-problems2.json', '[]'),
    ...secondRunArgs(dir, { ci: FAILED_BUILD_CI }),
  ];
  const runOnce = (name, extra) => {
    const out = path.join(dir, name);
    const run = spawnSync(
      process.execPath,
      [SCRIPT, first, '--out', out, ...inputs, ...extra],
      { encoding: 'utf8' },
    );
    return { run, comment: fs.readFileSync(out, 'utf8') };
  };
  const without = runOnce('comment-plain.md', []);
  const withResult = runOnce('comment-result.md', ['--result-out', resultFile]);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  fs.rmSync(dir, { recursive: true });

  assert.strictEqual(without.run.status, 0);
  assert.strictEqual(withResult.run.status, 0);
  assert.strictEqual(withResult.run.stdout, without.run.stdout);
  assert.strictEqual(withResult.comment, without.comment);
  assert.strictEqual(result.verdict, without.run.stdout.trim());
});

test('CLI is FAIL on a failed CI check and PASS when CI is green', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const file = path.join(dir, 'verdict.json');
  const problems = path.join(dir, 'refs-problems.json');
  const ci = path.join(dir, 'ci.json');
  const tamperingScan = path.join(dir, 'tampering-scan-result.json');
  const provenance = path.join(dir, 'provenance.json');
  const allowedModels = path.join(dir, 'allowed-models.json');
  fs.writeFileSync(file, report());
  fs.writeFileSync(problems, '[]');
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  const run = () =>
    spawnSync(
      process.execPath,
      [
        SCRIPT,
        file,
        '--out',
        path.join(dir, 'c.md'),
        '--refs-problems',
        problems,
        '--ci',
        ci,
        '--tampering-scan',
        tamperingScan,
        '--provenance',
        provenance,
        '--allowed-models',
        allowedModels,
      ],
      { encoding: 'utf8' },
    ).stdout.trim();
  assert.strictEqual(run(), 'FAIL');
  fs.writeFileSync(
    ci,
    ciJson({
      checks: [
        {
          name: 'Analyze (javascript-typescript)',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    }),
  );
  assert.strictEqual(run(), 'FAIL');
  fs.writeFileSync(ci, ciJson());
  assert.strictEqual(run(), 'PASS');
  fs.rmSync(dir, { recursive: true });
});

test('CLI is FAIL when --provenance file is missing or malformed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-'));
  const file = path.join(dir, 'verdict.json');
  const problems = path.join(dir, 'refs-problems.json');
  const ci = path.join(dir, 'ci.json');
  const tamperingScan = path.join(dir, 'tampering-scan-result.json');
  const allowedModels = path.join(dir, 'allowed-models.json');
  const out = path.join(dir, 'c.md');
  fs.writeFileSync(file, report());
  fs.writeFileSync(problems, '[]');
  fs.writeFileSync(ci, ciJson());
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  const run = (provenanceFile) =>
    spawnSync(
      process.execPath,
      [
        SCRIPT, file, '--out', out, '--refs-problems', problems,
        '--ci', ci, '--tampering-scan', tamperingScan,
        '--provenance', provenanceFile,
        '--allowed-models', allowedModels,
      ],
      { encoding: 'utf8' },
    ).stdout.trim();
  assert.strictEqual(run(path.join(dir, 'absent.json')), 'FAIL');
  assert.ok(fs.readFileSync(out, 'utf8').includes('provenance missing'));
  const malformed = path.join(dir, 'provenance.json');
  fs.writeFileSync(malformed, JSON.stringify({ ...PROVENANCE, model: '' }));
  assert.strictEqual(run(malformed), 'FAIL');
  assert.ok(fs.readFileSync(out, 'utf8').includes('provenance missing'));
  fs.writeFileSync(malformed, JSON.stringify(PROVENANCE));
  assert.strictEqual(run(malformed), 'PASS');
  fs.rmSync(dir, { recursive: true });
});

const runAllowedModelsVerdict = (allowedModelsList) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-models-'));
  const file = path.join(dir, 'verdict.json');
  const problems = path.join(dir, 'refs-problems.json');
  const ci = path.join(dir, 'ci.json');
  const tamperingScan = path.join(dir, 'tampering-scan-result.json');
  const provenance = path.join(dir, 'provenance.json');
  const allowedModels = path.join(dir, 'allowed-models.json');
  const out = path.join(dir, 'c.md');
  fs.writeFileSync(file, report());
  fs.writeFileSync(problems, '[]');
  fs.writeFileSync(ci, ciJson());
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  fs.writeFileSync(allowedModels, JSON.stringify(allowedModelsList));
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT, file, '--out', out, '--refs-problems', problems,
      '--ci', ci, '--tampering-scan', tamperingScan,
      '--provenance', provenance, '--allowed-models', allowedModels,
    ],
    { encoding: 'utf8' },
  );
  const comment = fs.readFileSync(out, 'utf8');
  fs.rmSync(dir, { recursive: true });
  return { verdict: run.stdout.trim(), comment };
};

test('CLI does not fail when provenance model is in --allowed-models', () => {
  const { verdict, comment } = runAllowedModelsVerdict([PROVENANCE.model]);
  assert.strictEqual(verdict, 'PASS');
  assert.ok(!comment.includes('is not in allowed-models.json'));
});

test('CLI fails when provenance model is not in --allowed-models', () => {
  const { verdict, comment } = runAllowedModelsVerdict(['some-other-model']);
  assert.strictEqual(verdict, 'FAIL');
  assert.ok(comment.includes('is not in allowed-models.json'));
});

test('fails with required checks were not checked when file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'required-checks-'));
  const file = path.join(dir, 'verdict.json');
  const ci = path.join(dir, 'ci.json');
  const commentFile = path.join(dir, 'c.md');
  fs.writeFileSync(file, report());
  fs.writeFileSync(ci, ciJson());
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT,
      file,
      '--out',
      commentFile,
      '--ci',
      ci,
      '--required-checks',
      path.join(dir, 'absent.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.stdout.trim(), 'FAIL');
  const comment = fs.readFileSync(commentFile, 'utf8');
  assert.ok(comment.includes('required checks were not checked'));
  fs.rmSync(dir, { recursive: true });
});

test('fails with required checks were not checked when file content is not a string array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'required-checks-'));
  const file = path.join(dir, 'verdict.json');
  const ci = path.join(dir, 'ci.json');
  const commentFile = path.join(dir, 'c.md');
  const requiredChecksFile = path.join(dir, 'required-checks.json');
  fs.writeFileSync(file, report());
  fs.writeFileSync(ci, ciJson());
  fs.writeFileSync(requiredChecksFile, JSON.stringify({ not: 'an array' }));
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT,
      file,
      '--out',
      commentFile,
      '--ci',
      ci,
      '--required-checks',
      requiredChecksFile,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.stdout.trim(), 'FAIL');
  const comment = fs.readFileSync(commentFile, 'utf8');
  assert.ok(comment.includes('required checks were not checked'));
  fs.rmSync(dir, { recursive: true });
});

test('CLI check-refs adds a coverage problem from --issue', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const file = path.join(root, 'verdict.json');
  fs.writeFileSync(file, report());
  const issue = path.join(root, 'issue.md');
  fs.writeFileSync(issue, ISSUE_MD);
  const problems = path.join(root, 'refs-problems.json');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--check-refs', file, '--root', root, '--out', problems,
      '--issue', issue],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  const written = JSON.parse(fs.readFileSync(problems, 'utf8'));
  assert.strictEqual(written.length, 1);
  assert.ok(written[0].startsWith('report covers 1 of 5'));
  fs.rmSync(root, { recursive: true });
});

test('CLI check-refs fails closed when --issue is unreadable', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const file = path.join(root, 'verdict.json');
  fs.writeFileSync(file, report());
  const problems = path.join(root, 'refs-problems.json');
  spawnSync(
    process.execPath,
    [SCRIPT, '--check-refs', file, '--root', root, '--out', problems,
      '--issue', path.join(root, 'absent.md')],
    { encoding: 'utf8' },
  );
  const written = JSON.parse(fs.readFileSync(problems, 'utf8'));
  assert.ok(written[0].startsWith('issue not readable'));
  fs.rmSync(root, { recursive: true });
});

test('CLI --spec flag fails closed on an invalid v2 spec even without a verdict file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  const spec = path.join(dir, 'spec-lint.json');
  fs.writeFileSync(
    spec,
    JSON.stringify({ format: 'v2', problems: ['custom marker text'] }),
  );
  const out = path.join(dir, 'comment.md');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, path.join(dir, 'verdict.json'), '--out', out, '--spec', spec],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), 'FAIL');
  const comment = fs.readFileSync(out, 'utf8');
  assert.ok(comment.includes('spec invalid: custom marker text'));
  fs.rmSync(dir, { recursive: true });
});

test('CLI --spec flag with a legacy spec keeps the existing PASS comment', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const file = path.join(root, 'verdict.json');
  fs.writeFileSync(file, report());
  const problems = path.join(root, 'refs-problems.json');
  fs.writeFileSync(problems, '[]');
  const ci = path.join(root, 'ci.json');
  fs.writeFileSync(ci, ciJson());
  const spec = path.join(root, 'spec-lint.json');
  fs.writeFileSync(spec, JSON.stringify({ format: 'legacy', problems: [] }));
  const tamperingScan = path.join(root, 'tampering-scan-result.json');
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  const provenance = path.join(root, 'provenance.json');
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  const allowedModels = path.join(root, 'allowed-models.json');
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  const runVerdictCli = (out, extra = []) =>
    spawnSync(
      process.execPath,
      [
        SCRIPT,
        file,
        '--out',
        out,
        '--refs-problems',
        problems,
        '--ci',
        ci,
        '--tampering-scan',
        tamperingScan,
        '--provenance',
        provenance,
        '--allowed-models',
        allowedModels,
        ...extra,
      ],
      { encoding: 'utf8' },
    );
  const outWithSpec = path.join(root, 'c-with-spec.md');
  const outWithoutSpec = path.join(root, 'c-without-spec.md');
  const withSpec = runVerdictCli(outWithSpec, ['--spec', spec]);
  const withoutSpec = runVerdictCli(outWithoutSpec);
  assert.strictEqual(withSpec.stdout.trim(), 'PASS');
  assert.strictEqual(withoutSpec.stdout.trim(), 'PASS');
  const commentWithSpec = fs.readFileSync(outWithSpec, 'utf8');
  const commentWithoutSpec = fs.readFileSync(outWithoutSpec, 'utf8');
  assert.ok(commentWithSpec.includes('Issue format: legacy'));
  assert.strictEqual(
    commentWithSpec.replace('Issue format: legacy\n', ''),
    commentWithoutSpec,
  );
  fs.rmSync(root, { recursive: true });
});

const runCheckRefsCli = (root, specFile) => {
  const file = path.join(root, 'verdict.json');
  const problems = path.join(root, 'refs-problems.json');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--check-refs', file, '--root', root, '--out', problems,
      '--spec', specFile],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  return JSON.parse(fs.readFileSync(problems, 'utf8'));
};

test('CLI check-refs reports id problems from --spec', () => {
  const bothKinds = [ref({ kind: 'impl' }), ref({ kind: 'test' })];
  const verdict = report({
    criteria: [
      criterion('PASS', 'AC-1', { id: 'AC-1', refs: bothKinds }),
      criterion('PASS', 'TR-1', { id: 'TR-1', refs: bothKinds }),
    ],
    invariants: [invariant('INV-1', 'PASS'), invariant('INV-2', 'N/A')],
  });
  const root = makeCheckout({
    'apps/api/x.ts': 'export const x = 1;\n',
    'verdict.json': verdict,
    'spec-lint.json': JSON.stringify(V2_SPEC),
  });
  const written = runCheckRefsCli(root, path.join(root, 'spec-lint.json'));
  assert.deepStrictEqual(written, [
    'issue criterion id missing from report: "DOD-1"',
  ]);
  fs.rmSync(root, { recursive: true });
});

test('CLI check-refs fails closed when --spec is unreadable', () => {
  const root = makeCheckout({
    'apps/api/x.ts': 'export const x = 1;\n',
    'verdict.json': report(),
    'broken.json': '{oops',
  });
  for (const name of ['absent.json', 'broken.json']) {
    const written = runCheckRefsCli(root, path.join(root, name));
    assert.ok(written.some((item) => item.startsWith('spec was not checked')));
  }
  fs.rmSync(root, { recursive: true });
});

test('CLI end to end: --absence-out then --absence feed a computed PASS into the verdict', () => {
  const spec = {
    format: 'v2',
    problems: [],
    items: [
      { id: 'AC-1', section: 'section', type: 'behavior', text: 'first behavior', verify: 'verify' },
      {
        id: 'DOD-1',
        section: 'section',
        type: 'absence',
        text: 'no TODO left',
        verify: 'absent "TODO" in apps/api/x.ts',
      },
    ],
  };
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const verdictFile = path.join(root, 'verdict.json');
  fs.writeFileSync(
    verdictFile,
    report({
      criteria: [
        criterion('PASS', 'model text', {
          id: 'AC-1',
          refs: [ref({ kind: 'impl' }), ref({ kind: 'test' })],
        }),
      ],
    }),
  );
  const specFile = path.join(root, 'spec-lint.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const refsProblems = path.join(root, 'refs-problems.json');
  const absenceFile = path.join(root, 'absence.json');
  const checkRefs = spawnSync(
    process.execPath,
    [
      SCRIPT, '--check-refs', verdictFile, '--root', root, '--out',
      refsProblems, '--spec', specFile, '--absence-out', absenceFile,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(checkRefs.status, 0);
  const absenceEntries = JSON.parse(fs.readFileSync(absenceFile, 'utf8'));
  assert.strictEqual(absenceEntries[0].id, 'DOD-1');
  assert.strictEqual(absenceEntries[0].status, 'PASS');

  const ciFile = path.join(root, 'ci.json');
  fs.writeFileSync(ciFile, ciJson());
  const scopeFile = path.join(root, 'scope.json');
  fs.writeFileSync(scopeFile, JSON.stringify({ out_of_scope: [] }));
  const tamperingScan = path.join(root, 'tampering-scan-result.json');
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  const provenance = path.join(root, 'provenance.json');
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  const allowedModels = path.join(root, 'allowed-models.json');
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  const commentFile = path.join(root, 'comment.md');
  const verdict = spawnSync(
    process.execPath,
    [
      SCRIPT, verdictFile, '--out', commentFile, '--refs-problems',
      refsProblems, '--ci', ciFile, '--spec', specFile, '--absence',
      absenceFile, '--scope', scopeFile, '--tampering-scan', tamperingScan,
      '--provenance', provenance, '--allowed-models', allowedModels,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(verdict.stdout.trim(), 'PASS');
  const comment = fs.readFileSync(commentFile, 'utf8');
  assert.ok(comment.includes('| DOD-1 no TODO left | PASS (computed) |'));
  fs.rmSync(root, { recursive: true });
});

const runApprovalVerdict = (writeApproval) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-'));
  const verdictFile = path.join(dir, 'verdict.json');
  const problems = path.join(dir, 'refs-problems.json');
  const ci = path.join(dir, 'ci.json');
  const specFile = path.join(dir, 'spec-lint.json');
  const approval = path.join(dir, 'spec-approval.json');
  const tamperingScan = path.join(dir, 'tampering-scan-result.json');
  const provenance = path.join(dir, 'provenance.json');
  const allowedModels = path.join(dir, 'allowed-models.json');
  const out = path.join(dir, 'comment.md');
  fs.writeFileSync(verdictFile, report());
  fs.writeFileSync(problems, '[]');
  fs.writeFileSync(ci, ciJson());
  fs.writeFileSync(specFile, JSON.stringify(APPROVAL_LEGACY_SPEC));
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  writeApproval(approval);
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT, verdictFile, '--out', out, '--refs-problems', problems,
      '--ci', ci, '--spec', specFile, '--approval', approval,
      '--tampering-scan', tamperingScan, '--provenance', provenance,
      '--allowed-models', allowedModels,
    ],
    { encoding: 'utf8' },
  );
  const comment = fs.readFileSync(out, 'utf8');
  fs.rmSync(dir, { recursive: true });
  return { verdict: run.stdout.trim(), comment };
};

test('missing approval file fails closed', () => {
  const { verdict, comment } = runApprovalVerdict(() => {});
  assert.strictEqual(verdict, 'FAIL');
  assert.ok(comment.includes('spec approval was not checked'));
});

test('invalid approval file fails closed', () => {
  const variants = [
    '{not json',
    JSON.stringify({ approved_hash: SHA_CURRENT }),
    JSON.stringify({ current_hash: SHA_CURRENT }),
    JSON.stringify({ approved_hash: 'abc', current_hash: SHA_CURRENT }),
    JSON.stringify([]),
  ];
  for (const content of variants) {
    const { verdict, comment } = runApprovalVerdict((file) =>
      fs.writeFileSync(file, content),
    );
    assert.strictEqual(verdict, 'FAIL', content);
    assert.ok(comment.includes('spec approval was not checked'), content);
  }
});

test('CLI passes with a matching approval file', () => {
  const { verdict } = runApprovalVerdict((file) =>
    fs.writeFileSync(file, JSON.stringify(approvalOf(SHA_CURRENT))),
  );
  assert.strictEqual(verdict, 'PASS');
});

test('CLI passes assertion losses with test-removal approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-removal-'));
  const file = path.join(dir, 'verdict.json');
  const problems = path.join(dir, 'refs-problems.json');
  const ci = path.join(dir, 'ci.json');
  const tamperingScan = path.join(dir, 'tampering-scan-result.json');
  const provenance = path.join(dir, 'provenance.json');
  const allowedModels = path.join(dir, 'allowed-models.json');
  const out = path.join(dir, 'c.md');
  fs.writeFileSync(file, report());
  fs.writeFileSync(problems, '[]');
  fs.writeFileSync(ci, ciJson());
  fs.writeFileSync(
    tamperingScan,
    JSON.stringify(scanResult({ assertion_losses: [LOSS] })),
  );
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  const run = (extra) =>
    spawnSync(
      process.execPath,
      [
        SCRIPT, file, '--out', out, '--refs-problems', problems,
        '--ci', ci, '--tampering-scan', tamperingScan,
        '--provenance', provenance, '--allowed-models', allowedModels,
        ...extra,
      ],
      { encoding: 'utf8' },
    ).stdout.trim();
  assert.strictEqual(run([]), 'FAIL');
  assert.strictEqual(run(['--test-removal-approved']), 'PASS');
  fs.rmSync(dir, { recursive: true });
});

test('entry exports the same public API as before the split', () => {
  const entry = require('./acceptance-verdict');
  assert.deepStrictEqual(
    Object.keys(entry).sort(),
    [
      'COMMENT_MARKER',
      'checkBehaviorRefs',
      'checkCoverage',
      'checkIds',
      'checkIssueCoverage',
      'checkRefs',
      'computeAbsenceItems',
      'computeCiItems',
      'countIssueItems',
      'evaluate',
      'parseAllowedModels',
      'parseArgs',
      'parseCiFailures',
      'parseProvenance',
      'parseTamperingScan',
      'readApproval',
      'readRequiredChecks',
      'readScopeResult',
      'readSpecResult',
      'renderComment',
      'VERDICT_NEEDS_HUMAN',
      'needsSecondRun',
      'divergingIds',
      'singleRun',
      'reconcile',
    ].sort(),
  );
});

test('entry re-exports module functions, not copies', () => {
  const entry = require('./acceptance-verdict');
  const { evaluate } = require('./acceptance-verdict/verdict');
  const { renderComment } = require('./acceptance-verdict/render');
  const { checkRefs } = require('./acceptance-verdict/refs');
  const { parseCiFailures } = require('./acceptance-verdict/ci');
  const { countIssueItems } = require('./acceptance-verdict/coverage');
  const { computeAbsenceItems } = require('./acceptance-verdict/computed');
  const { readSpecResult } = require('./acceptance-verdict/inputs');
  assert.strictEqual(entry.evaluate, evaluate);
  assert.strictEqual(entry.renderComment, renderComment);
  assert.strictEqual(entry.checkRefs, checkRefs);
  assert.strictEqual(entry.parseCiFailures, parseCiFailures);
  assert.strictEqual(entry.countIssueItems, countIssueItems);
  assert.strictEqual(entry.computeAbsenceItems, computeAbsenceItems);
  assert.strictEqual(entry.readSpecResult, readSpecResult);
});

test('requiring the entry does not run the CLI', () => {
  const run = spawnSync(
    process.execPath,
    ['-e', "require('./scripts/acceptance-verdict.js')"],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout, '');
  assert.strictEqual(run.stderr, '');
});

// Reads every job's trusted sparse-checkout path list directly from the
// workflow file, keyed by job id (not by position, so adding a job with its
// own checkout cannot shift the lists), so this test breaks the moment a new
// module file is added there but not to a job's list.
const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const SPARSE_HEADER = /^\s+sparse-checkout: \|\s*$/;
const SPARSE_LINE = /^ {12}(\S.*)$/;

const readSparseCheckoutBlocks = () => {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const blocks = new Map();
  let job = null;
  let paths = null;
  for (const line of lines) {
    const jobMatch = JOB_HEADER.exec(line);
    if (jobMatch !== null) job = jobMatch[1];
    const pathMatch = paths === null ? null : SPARSE_LINE.exec(line);
    if (pathMatch !== null) {
      paths.push(pathMatch[1].trim());
      continue;
    }
    paths = null;
    if (SPARSE_HEADER.test(line)) {
      paths = [];
      blocks.set(job, paths);
    }
  }
  return blocks;
};

test('sparse checkout blocks are read by job id', () => {
  const blocks = readSparseCheckoutBlocks();
  assert.deepStrictEqual([...blocks.keys()], ['verify', 'verify-second', 'report']);
  for (const paths of blocks.values()) assert.ok(paths.length > 0);
});

const copyIntoSparseCheckout = (relPath, destRoot) => {
  const src = path.join(ROOT, relPath);
  const dest = path.join(destRoot, relPath);
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
};

const makeSparseCheckoutCopy = (relPaths) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  for (const relPath of relPaths) copyIntoSparseCheckout(relPath, dir);
  return dir;
};

const checkRefsFromCopy = (relPaths) => {
  const verifyCopy = makeSparseCheckoutCopy(relPaths);
  const verdictFile = path.join(verifyCopy, 'verdict.json');
  fs.writeFileSync(
    verdictFile,
    report({
      criteria: [
        criterion('PASS', 'AC', {
          refs: [
            ref({
              path: 'scripts/acceptance-verdict.js',
              line: 1,
              quote: "'use strict'",
            }),
          ],
        }),
      ],
    }),
  );
  const problems = path.join(verifyCopy, 'refs-problems.json');
  const check = spawnSync(
    process.execPath,
    [
      path.join(verifyCopy, 'scripts', 'acceptance-verdict.js'),
      '--check-refs',
      verdictFile,
      '--root',
      verifyCopy,
      '--out',
      problems,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(check.status, 0);
  assert.strictEqual(fs.readFileSync(problems, 'utf8'), '[]');
  fs.rmSync(verifyCopy, { recursive: true });
};

test("CLI runs from copies holding only each job's trusted sparse checkout paths", () => {
  const blocks = readSparseCheckoutBlocks();
  const verifyPaths = blocks.get('verify');
  const secondPaths = blocks.get('verify-second');
  const reportPaths = blocks.get('report');
  for (const paths of [verifyPaths, secondPaths, reportPaths]) {
    assert.ok(paths.includes('scripts/acceptance-verdict/'));
  }

  checkRefsFromCopy(verifyPaths);
  checkRefsFromCopy(secondPaths);

  const reportCopy = makeSparseCheckoutCopy(reportPaths);
  const reportVerdictFile = path.join(reportCopy, 'verdict.json');
  fs.writeFileSync(reportVerdictFile, report());
  const ci = path.join(reportCopy, 'ci.json');
  fs.writeFileSync(ci, ciJson());
  const tamperingScan = path.join(reportCopy, 'tampering-scan-result.json');
  fs.writeFileSync(tamperingScan, JSON.stringify(scanResult()));
  const provenance = path.join(reportCopy, 'provenance.json');
  fs.writeFileSync(provenance, JSON.stringify(PROVENANCE));
  const allowedModels = path.join(reportCopy, 'allowed-models.json');
  fs.writeFileSync(allowedModels, JSON.stringify([PROVENANCE.model]));
  const reportProblems = path.join(reportCopy, 'refs-problems.json');
  fs.writeFileSync(reportProblems, '[]');
  const out = path.join(reportCopy, 'comment.md');
  const verdict = spawnSync(
    process.execPath,
    [
      path.join(reportCopy, 'scripts', 'acceptance-verdict.js'),
      reportVerdictFile,
      '--out',
      out,
      '--refs-problems',
      reportProblems,
      '--ci',
      ci,
      '--tampering-scan',
      tamperingScan,
      '--provenance',
      provenance,
      '--allowed-models',
      allowedModels,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(verdict.status, 0);
  assert.strictEqual(verdict.stdout.trim(), 'PASS');

  fs.rmSync(reportCopy, { recursive: true });
});

test('CLI copy without the module directory fails to load', () => {
  const reportPaths = readSparseCheckoutBlocks().get('report');
  const withoutModules = reportPaths.filter(
    (relPath) => !relPath.startsWith('scripts/acceptance-verdict/'),
  );
  const copy = makeSparseCheckoutCopy(withoutModules);
  const run = spawnSync(
    process.execPath,
    [path.join(copy, 'scripts', 'acceptance-verdict.js')],
    { encoding: 'utf8' },
  );
  assert.notStrictEqual(run.status, 0);
  assert.ok(run.stderr.includes('Cannot find module'));
  assert.ok(run.stderr.includes('acceptance-verdict/'));
  fs.rmSync(copy, { recursive: true });
});

test('CLI copy missing one module file fails to load', () => {
  const reportPaths = readSparseCheckoutBlocks().get('report');
  const copy = makeSparseCheckoutCopy(reportPaths);
  fs.rmSync(path.join(copy, 'scripts', 'acceptance-verdict', 'common.js'));
  const run = spawnSync(
    process.execPath,
    [path.join(copy, 'scripts', 'acceptance-verdict.js')],
    { encoding: 'utf8' },
  );
  assert.notStrictEqual(run.status, 0);
  fs.rmSync(copy, { recursive: true });
});
