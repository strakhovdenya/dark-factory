'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { computeAbsenceItems, computeCiItems } = require('./computed');
const { makeCheckout, absenceItem, ciItem, codeqlSuccess, ciJson } =
  require('./test-helpers');

test('absence item passes when the literal is not in the file', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const items = [absenceItem('AC-1', 'TODO', 'apps/api/x.ts')];
  assert.deepStrictEqual(computeAbsenceItems(items, root), [
    {
      id: 'AC-1',
      text: '',
      status: 'PASS',
      summary: 'AC-1: literal "TODO" not found in apps/api/x.ts',
      refs: [],
      computed: true,
    },
  ]);
  fs.rmSync(root, { recursive: true });
});

test('absence item fails when the literal is in the file, naming id, path and literal', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const TODO = 1;\n' });
  const items = [absenceItem('AC-1', 'TODO', 'apps/api/x.ts')];
  const [entry] = computeAbsenceItems(items, root);
  assert.strictEqual(entry.status, 'FAIL');
  assert.ok(entry.summary.includes('AC-1'));
  assert.ok(entry.summary.includes('apps/api/x.ts'));
  assert.ok(entry.summary.includes('TODO'));
  fs.rmSync(root, { recursive: true });
});

test('absence item fails on a path outside the checkout, under .git, a symlink, or an oversized file', (t) => {
  const root = makeCheckout({ '.git/config': 'x' });

  const outside = absenceItem('AC-1', 'x', '../outside.ts');
  assert.strictEqual(computeAbsenceItems([outside], root)[0].status, 'FAIL');

  const dotGit = absenceItem('AC-2', 'x', '.git/config');
  assert.strictEqual(computeAbsenceItems([dotGit], root)[0].status, 'FAIL');

  // Same platform-independent mock as "checkRefs rejects a symlink": no real
  // symlink on disk, just the isFile()-false stat resolveInsideCheckout acts
  // on.
  const linkTarget = path.resolve(fs.realpathSync(root), 'link.ts');
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (targetPath, options) =>
    path.resolve(targetPath) === linkTarget
      ? { isFile: () => false, isSymbolicLink: () => true }
      : originalLstatSync(targetPath, options),
  );
  const link = absenceItem('AC-3', 'x', 'link.ts');
  assert.strictEqual(computeAbsenceItems([link], root)[0].status, 'FAIL');

  fs.writeFileSync(path.join(root, 'big.ts'), 'a'.repeat(2 * 1024 * 1024 + 1));
  const oversized = absenceItem('AC-4', 'x', 'big.ts');
  assert.strictEqual(computeAbsenceItems([oversized], root)[0].status, 'FAIL');

  fs.rmSync(root, { recursive: true });
});

test('absence item treats a regex-like literal as a plain substring', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'axb\n' });
  const items = [absenceItem('AC-1', 'a.b*', 'apps/api/x.ts')];
  assert.strictEqual(computeAbsenceItems(items, root)[0].status, 'PASS');
  fs.rmSync(root, { recursive: true });
});

test('ci item passes on a matching successful check-run', () => {
  const items = [ciItem('DOD-1', 'Test (scripts)')];
  const raw = ciJson({
    checks: [
      codeqlSuccess,
      { name: 'Test (scripts)', status: 'completed', conclusion: 'success' },
    ],
  });
  const [entry] = computeCiItems(items, raw);
  assert.strictEqual(entry.status, 'PASS');
});

test('ci item fails when the check-run is missing, in progress, or failed', () => {
  const items = [ciItem('DOD-1', 'Test (scripts)')];
  const missing = ciJson({ checks: [codeqlSuccess] });
  assert.strictEqual(computeCiItems(items, missing)[0].status, 'FAIL');

  const inProgress = ciJson({
    checks: [
      codeqlSuccess,
      { name: 'Test (scripts)', status: 'in_progress', conclusion: null },
    ],
  });
  assert.strictEqual(computeCiItems(items, inProgress)[0].status, 'FAIL');

  const failed = ciJson({
    checks: [
      codeqlSuccess,
      { name: 'Test (scripts)', status: 'completed', conclusion: 'failure' },
    ],
  });
  assert.strictEqual(computeCiItems(items, failed)[0].status, 'FAIL');
});

test('legacy issue ci/absence items are not computed deterministically', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'TODO\n' });
  assert.deepStrictEqual(computeAbsenceItems(null, root), []);
  assert.deepStrictEqual(computeCiItems(null, ciJson()), []);
  fs.rmSync(root, { recursive: true });
});
