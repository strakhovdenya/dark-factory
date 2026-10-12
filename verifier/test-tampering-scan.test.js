'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  scan,
  scanDiff,
  classesOf,
} = require('./test-tampering-scan');

const SCRIPT = path.join(__dirname, 'test-tampering-scan.js');

// Built by concatenation, never as a contiguous literal (INV-4): this spec
// file matches the "test" class itself, so a literal marker in its source
// would be a real finding the next time this file is edited.
const ONLY = '.' + 'only(';
const SKIP = '.' + 'skip(';
const XIT = 'xit' + '(';
const XDESCRIBE = 'xdescribe' + '(';
const IT_TODO = 'it' + '.todo(';
const TEST_TODO = 'test' + '.todo(';
const SKIP_MARKERS_FIXTURE = [ONLY, SKIP, XIT, XDESCRIBE, IT_TODO, TEST_TODO];

const ESLINT_DISABLE = 'eslint' + '-disable';
const TS_IGNORE = '@ts-' + 'ignore';
const TS_EXPECT_ERROR = '@ts-expect' + '-error';
const TS_NOCHECK = '@ts-no' + 'check';
const SUPPRESSION_MARKERS_FIXTURE = [
  ESLINT_DISABLE,
  TS_IGNORE,
  TS_EXPECT_ERROR,
  TS_NOCHECK,
];

const CONTINUE_ON_ERROR = 'continue-on-error' + ': true';
const IF_FALSE = 'if' + ': false';

const diffFile = (filePath, { removed = [], added = [], oldStart = 1, newStart = 1 } = {}) => {
  const oldCount = removed.length || 1;
  const newCount = added.length || 1;
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    'index 0000000..1111111 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...removed.map((text) => `-${text}`),
    ...added.map((text) => `+${text}`),
  ];
  return lines.join('\n');
};

const diffPatch = (...files) => `${files.join('\n')}\n`;

// Builds a single-file diff with several separate @@ hunks, for regression
// tests where the same key changes in two unrelated places in one file.
const diffFileWithHunks = (filePath, hunks) => {
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    'index 0000000..1111111 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  for (const { removed = [], added = [], oldStart = 1, newStart = 1 } of hunks) {
    const oldCount = removed.length || 1;
    const newCount = added.length || 1;
    lines.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...removed.map((text) => `-${text}`),
      ...added.map((text) => `+${text}`),
    );
  }
  return lines.join('\n');
};

test('flags an only-style marker in a file matched by a custom config', () => {
  const config = { test: ['*.test.py'] };
  const diff = diffPatch(diffFile('x.test.py', { added: [`line with ${ONLY}`] }));
  const findings = scanDiff(diff, config);
  assert.ok(findings.some((f) => f.includes('x.test.py') && f.includes(ONLY)));
});

test('does not flag an only-style marker in a file not matched by a custom config', () => {
  const config = { test: ['*.test.py'] };
  const diff = diffPatch(diffFile('x.spec.ts', { added: [`line with ${ONLY}`] }));
  assert.deepStrictEqual(scanDiff(diff, config), []);
});

test('exits with code 0 and writes an empty result for a valid config and a clean diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tampering-'));
  const configFile = path.join(dir, 'config.json');
  const diffFilePath = path.join(dir, 'diff.patch');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(configFile, JSON.stringify({ test: ['**/*.spec.js'] }));
  fs.writeFileSync(diffFilePath, diffPatch(diffFile('x.spec.js', { added: ['assert.ok(true);'] })));
  const run = spawnSync(
    process.execPath,
    [SCRIPT, diffFilePath, '--config', configFile, '--out', out],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {
    findings: [],
    assertion_losses: [],
    assertion_moved: 0,
  });
  fs.rmSync(dir, { recursive: true });
});

test('exits with code 1 for a missing config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tampering-'));
  const diffFilePath = path.join(dir, 'diff.patch');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(diffFilePath, diffPatch(diffFile('x.spec.js', { added: ['ok'] })));
  const run = spawnSync(
    process.execPath,
    [SCRIPT, diffFilePath, '--config', path.join(dir, 'missing.json'), '--out', out],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 1);
  assert.strictEqual(fs.existsSync(out), false);
  fs.rmSync(dir, { recursive: true });
});

test('exits with code 1 for an invalid config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tampering-'));
  const configFile = path.join(dir, 'config.json');
  const diffFilePath = path.join(dir, 'diff.patch');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(configFile, '{oops');
  fs.writeFileSync(diffFilePath, diffPatch(diffFile('x.spec.js', { added: ['ok'] })));
  const run = spawnSync(
    process.execPath,
    [SCRIPT, diffFilePath, '--config', configFile, '--out', out],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 1);
  assert.strictEqual(fs.existsSync(out), false);
  fs.rmSync(dir, { recursive: true });
});

test('flags each skip-style marker in an added test line', () => {
  const config = { test: ['**/*.spec.ts'] };
  for (const marker of SKIP_MARKERS_FIXTURE) {
    const diff = diffPatch(diffFile('x.spec.ts', { added: [`line with ${marker}`] }));
    const findings = scanDiff(diff, config);
    assert.ok(
      findings.some((f) => f.includes(marker)),
      `expected a finding for marker ${marker}`,
    );
  }
});

test('does not flag a skip-style marker present only in a removed line', () => {
  const config = { test: ['**/*.spec.ts'] };
  const diff = diffPatch(
    diffFile('x.spec.ts', {
      removed: [`line with ${ONLY}`],
      added: ['line without a marker'],
    }),
  );
  assert.deepStrictEqual(scanDiff(diff, config), []);
});

test('flags added lint/type suppressions in test, workflow and config file classes', () => {
  const config = {
    test: ['**/*.spec.ts'],
    workflow: ['.github/workflows/*.yml'],
    config: ['**/tsconfig.json'],
  };
  for (const marker of SUPPRESSION_MARKERS_FIXTURE) {
    const diff = diffPatch(diffFile('x.spec.ts', { added: [`line with ${marker}`] }));
    assert.ok(
      scanDiff(diff, config).some((f) => f.includes(marker)),
      `expected a finding for marker ${marker} in the test class`,
    );
  }
  const workflowDiff = diffPatch(
    diffFile('.github/workflows/x.yml', { added: [`  # ${ESLINT_DISABLE}`] }),
  );
  assert.ok(
    scanDiff(workflowDiff, config).some((f) => f.includes('.github/workflows/x.yml')),
  );
  const configDiff = diffPatch(diffFile('tsconfig.json', { added: [`  // ${TS_IGNORE}`] }));
  assert.ok(scanDiff(configDiff, config).some((f) => f.includes('tsconfig.json')));
});

test('does not flag a suppression added in application code', () => {
  const config = {
    test: ['**/*.spec.ts'],
    workflow: ['.github/workflows/*.yml'],
    config: ['**/tsconfig.json'],
  };
  const diff = diffPatch(
    diffFile('apps/api/src/x.service.ts', { added: [`  // ${TS_IGNORE}`] }),
  );
  assert.deepStrictEqual(scanDiff(diff, config), []);
});

test('flags added continue-on-error and if: false in a workflow file', () => {
  const config = { workflow: ['.github/workflows/*.yml'] };
  const diff = diffPatch(
    diffFile('.github/workflows/x.yml', {
      added: [`  ${CONTINUE_ON_ERROR}`, `  ${IF_FALSE}`],
    }),
  );
  const findings = scanDiff(diff, config);
  assert.ok(findings.some((f) => f.includes(CONTINUE_ON_ERROR)));
  assert.ok(findings.some((f) => f.includes(IF_FALSE)));
});

test('does not flag continue-on-error outside .github/workflows', () => {
  const config = { workflow: ['.github/workflows/*.yml'] };
  const diff = diffPatch(diffFile('docs/example.yml', { added: [`  ${CONTINUE_ON_ERROR}`] }));
  assert.deepStrictEqual(scanDiff(diff, config), []);
});

test('flags a decreased coverageThreshold value', () => {
  const config = { config: ['**/package.json'] };
  const diff = diffPatch(
    diffFile('apps/api/package.json', {
      removed: ['"branches": 68,'],
      added: ['"branches": 60,'],
    }),
  );
  const findings = scanDiff(diff, config);
  assert.ok(
    findings.some(
      (f) => f.includes('branches') && f.includes('68') && f.includes('60'),
    ),
  );
});

test('does not flag an increased coverageThreshold value', () => {
  const config = { config: ['**/package.json'] };
  const diff = diffPatch(
    diffFile('apps/api/package.json', {
      removed: ['"branches": 68,'],
      added: ['"branches": 90,'],
    }),
  );
  assert.deepStrictEqual(scanDiff(diff, config), []);
});

test('flags a decreased coverageThreshold value even when another value in the same block increased', () => {
  const config = { config: ['**/package.json'] };
  const diff = diffPatch(
    diffFile('apps/api/package.json', {
      removed: ['"branches": 68,', '"statements": 91,'],
      added: ['"branches": 60,', '"statements": 95,'],
    }),
  );
  const findings = scanDiff(diff, config);
  assert.ok(
    findings.some(
      (f) => f.includes('branches') && f.includes('68') && f.includes('60'),
    ),
  );
  assert.ok(!findings.some((f) => f.includes('statements')));
});

test('an unrelated same-named key increasing in an earlier hunk does not hide a decrease in a later hunk', () => {
  const config = { config: ['**/package.json'] };
  const diff = diffPatch(
    diffFileWithHunks('apps/api/package.json', [
      {
        removed: ['"branches": 10,'],
        added: ['"branches": 90,'],
        oldStart: 5,
        newStart: 5,
      },
      {
        removed: ['"branches": 68,'],
        added: ['"branches": 60,'],
        oldStart: 40,
        newStart: 40,
      },
    ]),
  );
  const findings = scanDiff(diff, config);
  assert.ok(
    findings.some(
      (f) => f.includes('branches') && f.includes('68') && f.includes('60'),
    ),
  );
});

const TEST_CONFIG = { test: ['**/*.spec.ts'] };

const assertionLines = (count, prefix = 'a') =>
  Array.from({ length: count }, (_, index) => `assert.ok(${prefix}${index});`);

const deletedFile = (filePath, removed) =>
  [
    `diff --git a/${filePath} b/${filePath}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${filePath}`,
    '+++ /dev/null',
    `@@ -1,${removed.length} +0,0 @@`,
    ...removed.map((text) => `-${text}`),
  ].join('\n');

test('does not flag assertions moved from one test file into several', () => {
  const lines = assertionLines(10);
  const diff = diffPatch(
    diffFile('big.spec.ts', { removed: lines }),
    diffFile('part1.spec.ts', { added: lines.slice(0, 4) }),
    diffFile('part2.spec.ts', { added: lines.slice(4) }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, []);
  assert.strictEqual(result.assertion_moved, 10);
});

test('flags assertions removed in one file even when another file adds new ones', () => {
  const diff = diffPatch(
    diffFile('a.spec.ts', { removed: assertionLines(5, 'old') }),
    diffFile('b.spec.ts', { added: assertionLines(5, 'new') }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, [{ path: 'a.spec.ts', lost: 5 }]);
  assert.ok(!result.findings.some((f) => f.includes('assertion')));
});

test('does not flag an assertion edited in place', () => {
  const diff = diffPatch(
    diffFile('x.spec.ts', {
      removed: ['assert.strictEqual(a, b);'],
      added: ['assert.strictEqual(a, c);'],
    }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, []);
  assert.strictEqual(result.assertion_moved, 0);
});

test('flags assertions edited during a split as lost', () => {
  const lines = assertionLines(10);
  const moved = [...lines.slice(0, 8), 'assert.ok(changed1);', 'assert.ok(changed2);'];
  const diff = diffPatch(
    diffFile('big.spec.ts', { removed: lines }),
    diffFile('part1.spec.ts', { added: moved.slice(0, 5) }),
    diffFile('part2.spec.ts', { added: moved.slice(5) }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, [{ path: 'big.spec.ts', lost: 2 }]);
  assert.strictEqual(result.assertion_moved, 8);
});

test('matches each added assertion line to at most one removed line', () => {
  const diff = diffPatch(
    diffFile('a.spec.ts', { removed: ['assert.ok(x);', 'assert.ok(x);'] }),
    diffFile('b.spec.ts', { added: ['assert.ok(x);'] }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, [{ path: 'a.spec.ts', lost: 1 }]);
  assert.strictEqual(result.assertion_moved, 1);
});

test('does not treat an assertion moved into a non-test file as moved', () => {
  const diff = diffPatch(
    diffFile('a.spec.ts', { removed: ['assert.ok(x);'] }),
    diffFile('src/helper.ts', { added: ['assert.ok(x);'] }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, [{ path: 'a.spec.ts', lost: 1 }]);
  assert.strictEqual(result.assertion_moved, 0);
});

test('ignores assertion lines removed from files outside the test class', () => {
  const diff = diffPatch(diffFile('src/helper.ts', { removed: assertionLines(3) }));
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, []);
  assert.strictEqual(result.assertion_moved, 0);
});

test('matches moved assertion lines regardless of surrounding whitespace', () => {
  const diff = diffPatch(
    diffFile('a.spec.ts', { removed: ['    expect(value).toBe(1);'] }),
    diffFile('b.spec.ts', { added: ['\texpect(value).toBe(1);  '] }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, []);
  assert.strictEqual(result.assertion_moved, 1);
});

test('flags a deleted test file as lost assertions', () => {
  const removed = ["const x = require('x');", ...assertionLines(4)];
  const diff = diffPatch(deletedFile('gone.spec.ts', removed));
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, [{ path: 'gone.spec.ts', lost: 4 }]);
});

test('does not flag a deleted test file whose assertions were moved', () => {
  const lines = assertionLines(4);
  const diff = diffPatch(
    deletedFile('gone.spec.ts', lines),
    diffFile('kept.spec.ts', { added: lines }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.deepStrictEqual(result.assertion_losses, []);
  assert.strictEqual(result.assertion_moved, 4);
});

test('counts one removed line as moved once when several identical lines are added', () => {
  const diff = diffPatch(
    diffFile('a.spec.ts', { removed: ['assert.ok(x);'] }),
    diffFile('b.spec.ts', {
      added: ['assert.ok(x);', 'assert.ok(x);', 'assert.ok(x);'],
    }),
  );
  const result = scan(diff, TEST_CONFIG);
  assert.strictEqual(result.assertion_moved, 1);
  assert.deepStrictEqual(result.assertion_losses, []);
});

const runCli = (diff, config) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tampering-scan-'));
  const diffPath = path.join(dir, 'diff.patch');
  const configPath = path.join(dir, 'config.json');
  const outPath = path.join(dir, 'out.json');
  fs.writeFileSync(diffPath, diff);
  fs.writeFileSync(configPath, JSON.stringify(config));
  const run = spawnSync(
    process.execPath,
    [SCRIPT, diffPath, '--config', configPath, '--out', outPath],
    { encoding: 'utf8' },
  );
  const output =
    run.status === 0 ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: run.status, output };
};

test('writes assertion fields to the output file', () => {
  const diff = diffPatch(
    diffFile('a.spec.ts', { removed: ['assert.ok(x);', 'assert.ok(y);'] }),
    diffFile('b.spec.ts', { added: ['assert.ok(x);'] }),
  );
  const { status, output } = runCli(diff, TEST_CONFIG);
  assert.strictEqual(status, 0);
  assert.deepStrictEqual(output, {
    findings: [],
    assertion_losses: [{ path: 'a.spec.ts', lost: 1 }],
    assertion_moved: 1,
  });
});

test('writes empty losses and zero moved for a diff without test files', () => {
  const diff = diffPatch(diffFile('src/app.ts', { added: ['const x = 1;'] }));
  const { status, output } = runCli(diff, TEST_CONFIG);
  assert.strictEqual(status, 0);
  assert.deepStrictEqual(output.assertion_losses, []);
  assert.strictEqual(output.assertion_moved, 0);
});

test('returns no findings for a clean diff', () => {
  const config = {
    test: ['**/*.spec.ts'],
    workflow: ['.github/workflows/*.yml'],
    config: ['**/package.json'],
  };
  const diff = diffPatch(
    diffFile('x.spec.ts', { added: ['assert.ok(true);'] }),
    diffFile('.github/workflows/x.yml', { added: ['  run: echo hi'] }),
    diffFile('apps/api/package.json', { added: ['"name": "x",'] }),
  );
  assert.deepStrictEqual(scanDiff(diff, config), []);
});

test('classesOf applies the union of matching classes (INV-9)', () => {
  const config = { test: ['**/*.spec.ts'], config: ['**/*.spec.ts'] };
  assert.deepStrictEqual(classesOf('x.spec.ts', config).sort(), ['config', 'test']);
});

test('parseArgs requires diff, --config and --out', () => {
  assert.deepStrictEqual(
    parseArgs(['diff.patch', '--config', 'c.json', '--out', 'o.json']),
    { diff: 'diff.patch', config: 'c.json', out: 'o.json' },
  );
  assert.strictEqual(parseArgs(['diff.patch', '--config', 'c.json']), null);
  assert.strictEqual(parseArgs(['diff.patch', '--out', 'o.json']), null);
});

test('CLI reports usage and exits 2 on bad args', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(run.status, 2);
  assert.ok(run.stderr.includes('usage:'));
});
