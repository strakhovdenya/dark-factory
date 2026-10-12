'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { lint, parseArgs } = require('./issue-lint');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(__dirname, 'issue-lint.js');
const CONTRACT_PATH = path.join(ROOT, '.github', 'verifier', 'issue-contract.json');
const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

const validIssue = () => `## Контекст
Описание.

## Affects
- scripts/x.js

## Docs to Read
- docs/x.md

## Key Invariants
- INV-1 Инвариант соблюдается.

## Acceptance Criteria
- [ ] AC-1 [behavior] Поведение проверяется тестом. Verify: scripts/x.spec.js "works"
- [ ] AC-2 [doc] Документация обновлена. Verify: docs/x.md
- [ ] AC-3 [config] Конфигурация обновлена. Verify: config/x.json
- [ ] AC-4 [absence] Старый литерал отсутствует. Verify: absent "old" in scripts/x.js

## Test Requirement
- [ ] TR-1 [behavior] Регрессия покрыта тестом. Verify: scripts/x.spec.js "regression"

## Definition of Done
- [ ] DOD-1 [ci] Проверка CI успешна. Verify: ci "Test (scripts)"

## Dependencies
Нет.
`;

const replace = (from, to) => validIssue().replace(from, to);
const problems = (markdown) => lint(markdown, CONTRACT, { requireV2: true }).problems;

const runCli = (markdown, extra = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-lint-'));
  const issue = path.join(dir, 'issue.md');
  fs.writeFileSync(issue, markdown);
  const run = spawnSync(process.execPath, [SCRIPT, issue, ...extra], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  return { dir, run };
};

test('parseArgs accepts contract, require-v2 and out', () => {
  assert.deepStrictEqual(parseArgs(['i.md', '--contract', 'c.json', '--require-v2', '--out', 'o.json']), {
    file: 'i.md', contract: 'c.json', requireV2: true, out: 'o.json',
  });
});

test('CLI emits the documented JSON shape and exits 0 for valid v2', () => {
  const { dir, run } = runCli(validIssue());
  assert.strictEqual(run.status, 0);
  const result = JSON.parse(run.stdout);
  assert.strictEqual(result.format, 'v2');
  assert.deepStrictEqual(result.problems, []);
  assert.ok(result.items.some((item) => item.id === 'AC-1' && item.type === 'behavior'));
  fs.rmSync(dir, { recursive: true });
});

test('CLI writes JSON to --out and exits 1 when problems exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-lint-'));
  const issue = path.join(dir, 'issue.md');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(issue, replace('## Dependencies\nНет.\n', ''));
  const run = spawnSync(process.execPath, [SCRIPT, issue, '--require-v2', '--out', out], { encoding: 'utf8', cwd: ROOT });
  assert.strictEqual(run.status, 1);
  assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).problems.some((p) => p.includes('Dependencies')));
  fs.rmSync(dir, { recursive: true });
});

test('CLI exits 2 on usage error', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT });
  assert.strictEqual(run.status, 2);
});

test('rejects a missing required section and names it', () => {
  assert.ok(problems(replace('## Dependencies\nНет.\n', '')).includes('missing required section: Dependencies'));
});

test('rejects AC item without ID', () => {
  assert.ok(problems(replace('- [ ] AC-2 [doc]', '- [ ] [doc]')).some((p) => p.includes('invalid item syntax')));
});

test('rejects AC item without type', () => {
  assert.ok(problems(replace('AC-2 [doc]', 'AC-2')).some((p) => p.includes('invalid item syntax')));
});

test('rejects an unknown item type', () => {
  assert.ok(problems(replace('AC-2 [doc]', 'AC-2 [mystery]')).some((p) => p.includes('unknown item type')));
});

test('rejects an item without Verify', () => {
  assert.ok(problems(replace('. Verify: docs/x.md', '')).some((p) => p.includes('invalid item syntax')));
});

test('rejects behavior Verify that does not match its grammar', () => {
  assert.ok(problems(replace('Verify: scripts/x.spec.js "works"', 'Verify: scripts/x.js')).some((p) => p.includes('grammar for type behavior')));
});

test('rejects doc Verify that does not match its grammar', () => {
  assert.ok(problems(replace('Verify: docs/x.md', 'Verify: two paths')).some((p) => p.includes('grammar for type doc')));
});

test('rejects config Verify that does not match its grammar', () => {
  assert.ok(problems(replace('Verify: config/x.json', 'Verify: config/x.json extra')).some((p) => p.includes('grammar for type config')));
});

test('rejects ci Verify that does not match its grammar', () => {
  assert.ok(problems(replace('Verify: ci "Test (scripts)"', 'Verify: Test (scripts)')).some((p) => p.includes('grammar for type ci')));
});

test('rejects absence Verify that does not match its grammar', () => {
  assert.ok(problems(replace('Verify: absent "old" in scripts/x.js', 'Verify: scripts/x.js')).some((p) => p.includes('grammar for type absence')));
});

test('rejects a duplicate ID', () => {
  assert.ok(problems(replace('AC-2 [doc]', 'AC-1 [doc]')).some((p) => p.includes('duplicate ID')));
});

test('rejects an ID prefix belonging to another section', () => {
  assert.ok(problems(replace('DOD-1 [ci]', 'AC-9 [ci]')).some((p) => p.includes('does not match section Definition of Done')));
});

test('rejects a conditional item in a checked section', () => {
  assert.ok(problems(replace('Поведение проверяется тестом', 'Если применимо поведение проверяется тестом')).some((p) => p.includes('conditional item')));
});

test('rejects a forbidden phrase in a checked section', () => {
  assert.ok(problems(replace('Документация обновлена', 'Документация проверяется локально')).some((p) => p.includes('forbidden phrase')));
});

test('allows forbidden wording in Context and Manual verification', () => {
  const markdown = validIssue().replace('Описание.', 'Проверяется локально.').replace('## Dependencies\nНет.', '## Manual verification (owner, not gated)\n- Проверить вручную.\n\n## Dependencies\nНет.');
  assert.deepStrictEqual(problems(markdown), []);
});

test('allows conditional wording in Context and Manual verification', () => {
  const markdown = validIssue().replace('Описание.', 'Если применимо, описание.').replace('## Dependencies\nНет.', '## Manual verification (owner, not gated)\n- If applicable inspect it.\n\n## Dependencies\nНет.');
  assert.deepStrictEqual(problems(markdown), []);
});

test('legacy body passes without require-v2', () => {
  const result = lint('## Acceptance Criteria\n- old criterion\n', CONTRACT);
  assert.deepStrictEqual(result, { format: 'legacy', problems: [], items: [] });
});

test('legacy body fails with require-v2', () => {
  const result = lint('## Acceptance Criteria\n- old criterion\n', CONTRACT, { requireV2: true });
  assert.strictEqual(result.format, 'legacy');
  assert.deepStrictEqual(result.problems, ['legacy format is not allowed']);
});

test('ignores item-looking lines inside fenced code', () => {
  const markdown = validIssue().replace('## Dependencies', '```\n- [ ] AC-9 [behavior] locally bad. Verify: nope\n```\n\n## Dependencies');
  assert.deepStrictEqual(problems(markdown), []);
});

test('the example fenced block in issue-contract.md passes with require-v2', () => {
  const md = fs.readFileSync(path.join(ROOT, '.github', 'verifier', 'issue-contract.md'), 'utf8');
  const match = md.match(/## Пример\s+```markdown\n([\s\S]*?)\n```/);
  assert.ok(match, 'example block not found');
  assert.deepStrictEqual(lint(match[1], CONTRACT, { requireV2: true }).problems, []);
});
