'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  computeScope,
  extractAffectsPatterns,
  patternToRegex,
  changedPathFromLine,
} = require('./affects-scope');

const SCRIPT = path.join(__dirname, 'affects-scope.js');

const issueWithAffects = (lines) =>
  `## Контекст\nОписание.\n\n## Affects\n${lines}\n\n## Docs to Read\n- docs/x.md\n`;

test('extractAffectsPatterns reads only backtick paths inside the Affects section', () => {
  const markdown = issueWithAffects('- `scripts/x.js`\n- `docs/x.md`');
  assert.deepStrictEqual(extractAffectsPatterns(markdown), [
    'scripts/x.js',
    'docs/x.md',
  ]);
});

test('unbacktick text does not become a path', () => {
  const markdown = issueWithAffects(
    '- scripts/x.js is mentioned without backticks\n- `docs/x.md`',
  );
  assert.deepStrictEqual(extractAffectsPatterns(markdown), ['docs/x.md']);
});

test('a plain word in backticks with no slash or extension is not a path', () => {
  const markdown = issueWithAffects('- `spec-approved`\n- `docs/x.md`');
  assert.deepStrictEqual(extractAffectsPatterns(markdown), ['docs/x.md']);
});

test('fenced code inside Affects is ignored', () => {
  const markdown = issueWithAffects(
    '- `docs/x.md`\n```\n- `scripts/hidden.js`\n```',
  );
  assert.deepStrictEqual(extractAffectsPatterns(markdown), ['docs/x.md']);
});

test('exact path is covered', () => {
  const markdown = issueWithAffects('- `scripts/x.js`');
  const files = 'M\tscripts/x.js\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('directory prefix path is covered', () => {
  const markdown = issueWithAffects('- `apps/api/`');
  const files = 'A\tapps/api/src/x.ts\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('star does not match across slash', () => {
  const markdown = issueWithAffects('- `scripts/*.js`');
  const files = 'A\tscripts/sub/x.js\n';
  assert.deepStrictEqual(computeScope(markdown, files), {
    out_of_scope: ['scripts/sub/x.js'],
  });
});

test('double star matches across slash', () => {
  const markdown = issueWithAffects('- `apps/**/*.ts`');
  const files = 'A\tapps/api/src/x.ts\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('file outside affects is out of scope', () => {
  const markdown = issueWithAffects('- `scripts/x.js`');
  const files = 'A\tdocs/unrelated.md\n';
  assert.deepStrictEqual(computeScope(markdown, files), {
    out_of_scope: ['docs/unrelated.md'],
  });
});

test('rename checks new path', () => {
  const markdown = issueWithAffects('- `scripts/new-name.js`');
  const files = 'R100\tscripts/old-name.js\tscripts/new-name.js\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('delete checks removed path', () => {
  const markdown = issueWithAffects('- `scripts/removed.js`');
  const files = 'D\tscripts/removed.js\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('path with parentheses is escaped literally', () => {
  const markdown = issueWithAffects('- `apps/api/(x).ts`');
  const files = 'M\tapps/api/(x).ts\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
  const other = 'M\tapps/api/ax.ts\n';
  assert.deepStrictEqual(computeScope(markdown, other), {
    out_of_scope: ['apps/api/ax.ts'],
  });
});

test('empty affects reports all files as out of scope', () => {
  const markdown = issueWithAffects('Нет.');
  const files = 'A\tscripts/x.js\nM\tdocs/y.md\n';
  assert.deepStrictEqual(computeScope(markdown, files), {
    out_of_scope: ['scripts/x.js', 'docs/y.md'],
  });
});

test('star matches within a single path component', () => {
  const markdown = issueWithAffects('- `src/*.ts`');
  const files = 'A\tsrc/index.ts\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('double star at pattern start matches root file', () => {
  const markdown = issueWithAffects('- `**/README.md`');
  const files = 'M\tREADME.md\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('rename ignores uncovered old path', () => {
  const markdown = issueWithAffects('- `scripts/new-name.js`');
  const files = 'R100\tscripts/old-uncovered.js\tscripts/new-name.js\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('regex special characters other than parentheses are escaped literally', () => {
  const markdown = issueWithAffects('- `scripts/a+b.[c].ts`');
  const files = 'M\tscripts/a+b.[c].ts\n';
  assert.deepStrictEqual(computeScope(markdown, files), { out_of_scope: [] });
});

test('duplicate changed path appears once in out_of_scope', () => {
  const markdown = issueWithAffects('- `docs/x.md`');
  const files = 'A\tdocs/unrelated.md\nM\tdocs/unrelated.md\n';
  assert.deepStrictEqual(computeScope(markdown, files), {
    out_of_scope: ['docs/unrelated.md'],
  });
});

test('changedPathFromLine handles M/A, D and R status lines, skipping blanks', () => {
  assert.strictEqual(changedPathFromLine('M\tscripts/x.js'), 'scripts/x.js');
  assert.strictEqual(changedPathFromLine('D\tscripts/gone.js'), 'scripts/gone.js');
  assert.strictEqual(
    changedPathFromLine('R087\told.js\tnew.js'),
    'new.js',
  );
  assert.strictEqual(changedPathFromLine(''), null);
  assert.strictEqual(changedPathFromLine('   '), null);
});

test('patternToRegex anchors an exact pattern at both ends', () => {
  const regex = patternToRegex('scripts/x.js');
  assert.strictEqual(regex.test('scripts/x.js'), true);
  assert.strictEqual(regex.test('scripts/x.js.bak'), false);
  assert.strictEqual(regex.test('other/scripts/x.js'), false);
});

test('parseArgs requires issue, files and --out', () => {
  assert.deepStrictEqual(parseArgs(['issue.md', 'files.txt', '--out', 'scope.json']), {
    issue: 'issue.md',
    files: 'files.txt',
    out: 'scope.json',
  });
  assert.strictEqual(parseArgs(['issue.md', 'files.txt']), null);
  assert.strictEqual(parseArgs(['issue.md', '--out', 'scope.json']), null);
});

test('CLI writes scope.json from issue.md and files.txt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affects-scope-'));
  const issue = path.join(dir, 'issue.md');
  const files = path.join(dir, 'files.txt');
  const out = path.join(dir, 'scope.json');
  fs.writeFileSync(issue, issueWithAffects('- `scripts/x.js`'));
  fs.writeFileSync(files, 'M\tscripts/x.js\nA\tdocs/unrelated.md\n');
  const run = spawnSync(process.execPath, [SCRIPT, issue, files, '--out', out], {
    encoding: 'utf8',
  });
  assert.strictEqual(run.status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {
    out_of_scope: ['docs/unrelated.md'],
  });
  fs.rmSync(dir, { recursive: true });
});

test('CLI reports usage and exits 2 on bad args', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(run.status, 2);
  assert.ok(run.stderr.includes('usage:'));
});
