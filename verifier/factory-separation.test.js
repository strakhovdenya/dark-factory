'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { patternToRegex } = require('./affects-scope');
const {
  classify,
  classifyPaths,
  changedPathsOf,
  readConfig,
  parseArgs,
} = require('./factory-separation');

const SCRIPT = path.join(__dirname, 'factory-separation.js');

// Test fixtures (INV-7 allows literals here): the same shape as the real
// trusted .github/verifier/factory-separation.json.
const LABEL_NAME = 'factory-cross-change';
const CONFIG_FIXTURE = {
  specPatterns: [
    '.claude/skills/issues/**',
    'scripts/issue-lint.js',
    'scripts/issue-lint.spec.js',
  ],
  verifierPatterns: [
    '.github/verifier/prompt.md',
    '.github/verifier/schema.json',
    'scripts/acceptance-verdict.js',
    'scripts/acceptance-verdict.spec.js',
    'scripts/acceptance-verdict/**',
    '.github/workflows/acceptance-verifier.yml',
  ],
  label: LABEL_NAME,
};

const SPEC_PATTERNS = CONFIG_FIXTURE.specPatterns.map(patternToRegex);
const VERIFIER_PATTERNS = CONFIG_FIXTURE.verifierPatterns.map(patternToRegex);

const classifyFixture = (changedPaths) =>
  classifyPaths(changedPaths, SPEC_PATTERNS, VERIFIER_PATTERNS);

const OWNERS = ['strakhovdenya'];

const labeledBy = (login, labelName = LABEL_NAME) => [
  { event: 'labeled', label: { name: labelName }, actor: { login } },
];

let dir;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-separation-'));
});

test.afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeJson = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

const writeText = (name, text) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

const runCli = ({ files, timeline = [], owners = OWNERS, config = CONFIG_FIXTURE }) => {
  const filesFile = writeText('files.txt', files);
  const timelineFile = writeJson('timeline.json', timeline);
  const ownersFile = writeJson('owners.json', owners);
  const configFile = writeJson('config.json', config);
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--files',
      filesFile,
      '--timeline',
      timelineFile,
      '--owners',
      ownersFile,
      '--config',
      configFile,
    ],
    { encoding: 'utf8' },
  );
};

test('classifies spec-only changes', () => {
  assert.deepStrictEqual(classifyFixture(['.claude/skills/issues/SKILL.md']), {
    spec: true,
    verifier: false,
  });
});

test('classifies a change inside scripts/acceptance-verdict/ as verifier-side', () => {
  assert.deepStrictEqual(classifyFixture(['scripts/acceptance-verdict/verdict.js']), {
    spec: false,
    verifier: true,
  });
});

test('classifies a change touching both sides', () => {
  assert.deepStrictEqual(
    classifyFixture(['scripts/issue-lint.js', 'scripts/acceptance-verdict/refs.js']),
    { spec: true, verifier: true },
  );
});

test('does not classify contract files as either side', () => {
  assert.deepStrictEqual(
    classifyFixture([
      '.github/verifier/issue-contract.json',
      '.github/verifier/issue-contract.md',
    ]),
    { spec: false, verifier: false },
  );
});

test('classifies renamed and deleted paths the same way as affects-scope.js', () => {
  const filesTxt = [
    'R100\t.claude/skills/issues/SKILL.md\tscripts/acceptance-verdict/verdict.js',
    'D\tscripts/issue-lint.js',
  ].join('\n');
  assert.deepStrictEqual(changedPathsOf(filesTxt), [
    'scripts/acceptance-verdict/verdict.js',
    'scripts/issue-lint.js',
  ]);
  assert.deepStrictEqual(classify(filesTxt, SPEC_PATTERNS, VERIFIER_PATTERNS), {
    spec: true,
    verifier: true,
  });
});

test('does not classify a similarly-named sibling file as inside scripts/acceptance-verdict/', () => {
  assert.deepStrictEqual(classifyFixture(['scripts/acceptance-verdict-legacy.js']), {
    spec: false,
    verifier: false,
  });
});

test('keeps a contract file neutral even when mixed with a spec-side change', () => {
  assert.deepStrictEqual(
    classifyFixture(['.github/verifier/issue-contract.json', 'scripts/issue-lint.js']),
    { spec: true, verifier: false },
  );
});

test('classifies an empty list of changed paths as neither side', () => {
  assert.deepStrictEqual(classifyFixture([]), { spec: false, verifier: false });
});

test('readConfig builds patterns and label from a trusted config file', () => {
  const configFile = writeJson('config.json', CONFIG_FIXTURE);
  const config = readConfig(configFile);
  assert.strictEqual(config.label, LABEL_NAME);
  assert.strictEqual(config.specPatterns[0].test('.claude/skills/issues/SKILL.md'), true);
  assert.strictEqual(
    config.verifierPatterns[4].test('scripts/acceptance-verdict/verdict.js'),
    true,
  );
});

test('CLI exits 1 when both sides change without a label', () => {
  const run = runCli({
    files: 'M\tscripts/issue-lint.js\nM\tscripts/acceptance-verdict/verdict.js\n',
  });
  assert.strictEqual(run.status, 1);
});

test('CLI exits 0 when both sides change with an authorized label', () => {
  const run = runCli({
    files: 'M\tscripts/issue-lint.js\nM\tscripts/acceptance-verdict/verdict.js\n',
    timeline: labeledBy('strakhovdenya'),
  });
  assert.strictEqual(run.status, 0);
});

test('CLI exits 1 when the label is present but not set by an authorized owner', () => {
  const run = runCli({
    files: 'M\tscripts/issue-lint.js\nM\tscripts/acceptance-verdict/verdict.js\n',
    timeline: labeledBy('someone-else'),
  });
  assert.strictEqual(run.status, 1);
});

test('CLI exits 1 when the label was set by a bot login', () => {
  const run = runCli({
    files: 'M\tscripts/issue-lint.js\nM\tscripts/acceptance-verdict/verdict.js\n',
    timeline: labeledBy('some-app[bot]'),
  });
  assert.strictEqual(run.status, 1);
});

test('CLI exits 0 when only the spec side changes without a label', () => {
  const run = runCli({ files: 'M\tscripts/issue-lint.js\n' });
  assert.strictEqual(run.status, 0);
});

test('CLI exits 0 when only the verifier side changes without a label', () => {
  const run = runCli({ files: 'M\tscripts/acceptance-verdict/verdict.js\n' });
  assert.strictEqual(run.status, 0);
});

test('CLI reports usage and exits 2 on bad args', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(run.status, 2);
  assert.ok(run.stderr.includes('usage:'));
});

test('CLI --json reports classification and label authorization', () => {
  const filesFile = writeText(
    'files.txt',
    'M\tscripts/issue-lint.js\nM\tscripts/acceptance-verdict/verdict.js\n',
  );
  const timelineFile = writeJson('timeline.json', labeledBy('strakhovdenya'));
  const ownersFile = writeJson('owners.json', OWNERS);
  const configFile = writeJson('config.json', CONFIG_FIXTURE);
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--files',
      filesFile,
      '--timeline',
      timelineFile,
      '--owners',
      ownersFile,
      '--config',
      configFile,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0);
  assert.deepStrictEqual(JSON.parse(run.stdout), {
    spec: true,
    verifier: true,
    label: { authorized: true, actor: 'strakhovdenya' },
  });
});

test('parseArgs requires --files, --timeline, --owners and --config', () => {
  assert.deepStrictEqual(
    parseArgs([
      '--files',
      'a.txt',
      '--timeline',
      't.json',
      '--owners',
      'o.json',
      '--config',
      'c.json',
    ]),
    { files: 'a.txt', timeline: 't.json', owners: 'o.json', config: 'c.json', json: false },
  );
  assert.strictEqual(parseArgs(['--files', 'a.txt']), null);
});
