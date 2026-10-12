'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { checkRefs, checkRefsWithNotes, checkBehaviorRefs } = require('./refs');
const {
  ref,
  criterion,
  invariant,
  report,
  makeCheckout,
  specItem,
} = require('./test-helpers');

test('checkRefs accepts a matching quote, ignoring whitespace', () => {
  const root = makeCheckout({
    'apps/api/x.ts': 'a\n  export   const x = 1;\n',
  });
  const parsed = JSON.parse(
    report({
      criteria: [
        criterion('PASS', 'AC', {
          refs: [ref({ line: 2, quote: 'export const x' })],
        }),
      ],
    }),
  );
  assert.deepStrictEqual(checkRefs(parsed, root), []);
  fs.rmSync(root, { recursive: true });
});

test('checkRefs reports a missing file, bad line and wrong quote', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const refs = [
    ref({ path: 'apps/api/absent.ts' }),
    ref({ line: 99 }),
    ref({ quote: 'something else' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const problems = checkRefs(parsed, root);
  assert.strictEqual(problems.length, 3);
  assert.ok(problems[0].includes('file not readable'));
  assert.ok(problems[1].includes('past the end'));
  assert.ok(problems[2].includes('quote not found'));
  fs.rmSync(root, { recursive: true });
});

test('checkRefs rejects paths that escape the checkout or hit .git', () => {
  const root = makeCheckout({ '.git/config': 'export const x', 'a.ts': 'x' });
  const refs = [
    ref({ path: '../outside.ts' }),
    ref({ path: '.git/config' }),
    ref({ path: path.resolve(root, '..', 'other.ts') }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const problems = checkRefs(parsed, root);
  assert.strictEqual(problems.length, 3);
  for (const problem of problems) assert.ok(problem.includes('outside'));
  fs.rmSync(root, { recursive: true });
});

// A real symlink needs elevated privileges on Windows (no developer mode),
// which made this test environment-dependent. resolveInsideCheckout only
// ever asks fs.lstatSync().isFile() to reject a symlink target, so mocking
// that one call exercises the same rejection path deterministically on
// every platform, with no real symlink on disk.
test('checkRefs rejects a symlink', (t) => {
  const root = makeCheckout({});
  const target = path.resolve(fs.realpathSync(root), 'link.ts');
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (targetPath, options) =>
    path.resolve(targetPath) === target
      ? { isFile: () => false, isSymbolicLink: () => true }
      : originalLstatSync(targetPath, options),
  );
  const parsed = JSON.parse(
    report({
      criteria: [criterion('PASS', 'AC', { refs: [ref({ path: 'link.ts' })] })],
    }),
  );
  assert.strictEqual(checkRefs(parsed, root).length, 1);
  fs.rmSync(root, { recursive: true });
});

test('checkRefs prints the rejected quote', () => {
  const root = makeCheckout({ 'apps/api/x.ts': 'export const x = 1;\n' });
  const refs = [ref({ quote: 'export const x = 1;},{"' })];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const problems = checkRefs(parsed, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('"export const x = 1;},{\\""'));
  fs.rmSync(root, { recursive: true });
});

const linesFile = (lines) => lines.join('\n') + '\n';

test('accepts a quote after stripping markdown bold markers from both sides', () => {
  const root = makeCheckout({
    'render.js': linesFile(['one', "  text += '**Provenance**';", 'three']),
  });
  const refs = [
    ref({ path: 'render.js', line: 2, quote: "text += 'Provenance';" }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  assert.deepStrictEqual(checkRefs(parsed, root), []);
  fs.rmSync(root, { recursive: true });
});

test('still rejects a quote whose content differs beyond markdown markup', () => {
  const root = makeCheckout({
    'render.js': linesFile(['one', "  text += '**Provenance**';", 'three']),
  });
  const refs = [
    ref({ path: 'render.js', line: 2, quote: 'text += **Unrelated**;' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const problems = checkRefs(parsed, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('quote not found'));
  fs.rmSync(root, { recursive: true });
});

test('accepts a quote that writes a tab as a literal backslash-t', () => {
  const root = makeCheckout({
    'files.txt': linesFile(['M\tscripts/a.js', 'A\tapps/x/y.ts']),
  });
  const refs = [
    ref({ path: 'files.txt', line: 2, quote: 'A\\tapps/x/y.ts' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  assert.deepStrictEqual(checkRefs(parsed, root), []);
  fs.rmSync(root, { recursive: true });
});

test('still rejects a quote whose content differs beyond a literal backslash-t', () => {
  const root = makeCheckout({
    'files.txt': linesFile(['M\tscripts/a.js', 'A\tapps/x/y.ts']),
  });
  const refs = [
    ref({ path: 'files.txt', line: 2, quote: 'A\\tapps/other/y.ts' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const problems = checkRefs(parsed, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('quote not found'));
  fs.rmSync(root, { recursive: true });
});

test('accepts a quote of a line that contains a literal backslash-t', () => {
  const root = makeCheckout({
    'code.js': linesFile(['one', "const sep = 'a\\tb';", 'three']),
  });
  const refs = [
    ref({ path: 'code.js', line: 2, quote: "const sep = 'a\\tb';" }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  assert.deepStrictEqual(checkRefs(parsed, root), []);
  fs.rmSync(root, { recursive: true });
});

test('accepts a quote after stripping backtick markers from both sides', () => {
  const root = makeCheckout({
    'doc.md': linesFile(['one', 'Set the `STORAGE_ROOT` env var.', 'three']),
  });
  const refs = [
    ref({ path: 'doc.md', line: 2, quote: 'Set the STORAGE_ROOT env var.' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  assert.deepStrictEqual(checkRefs(parsed, root), []);
  fs.rmSync(root, { recursive: true });
});

test('still rejects a backtick-marked quote whose content differs beyond markdown markup', () => {
  const root = makeCheckout({
    'doc.md': linesFile(['one', 'Set the `STORAGE_ROOT` env var.', 'three']),
  });
  const refs = [
    ref({ path: 'doc.md', line: 2, quote: 'Set the `OTHER_VAR` env var.' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const problems = checkRefs(parsed, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('quote not found'));
  fs.rmSync(root, { recursive: true });
});

test('accepts when only the quote carries markdown markers absent from the line', () => {
  const root = makeCheckout({
    'render.js': linesFile(['one', "  text += 'Provenance';", 'three']),
  });
  const refs = [
    ref({ path: 'render.js', line: 2, quote: "text += '**Provenance**';" }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  assert.deepStrictEqual(checkRefs(parsed, root), []);
  fs.rmSync(root, { recursive: true });
});

test('rejects a quote consisting only of markdown markers, not a match on every line', () => {
  const root = makeCheckout({
    'render.js': linesFile(['one', 'two', 'three', 'four', 'five']),
  });
  const refs = [ref({ path: 'render.js', line: 3, quote: '**' })];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const problems = checkRefs(parsed, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('no content once markdown markers'));
  fs.rmSync(root, { recursive: true });
});

test('quote on the cited line is accepted without a shift note', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile(['a', 'b', 'export const x = 1;', 'd', 'e']),
  });
  const parsed = JSON.parse(
    report({
      criteria: [
        criterion('PASS', 'AC', {
          refs: [ref({ line: 3, quote: 'export const x' })],
        }),
      ],
    }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, []);
  fs.rmSync(root, { recursive: true });
});

test('quote one line above or below the cited line is accepted with a shift note', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile([
      'one',
      'export const a = 1;',
      'three',
      'four',
      'export const b = 2;',
      'six',
    ]),
  });
  const refs = [
    ref({ line: 3, quote: 'export const a' }),
    ref({ line: 4, quote: 'export const b' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, [
    { list: 'criteria', entry: 0, ref: 0, cited: 3, found: 2 },
    { list: 'criteria', entry: 0, ref: 1, cited: 4, found: 5 },
  ]);
  fs.rmSync(root, { recursive: true });
});

test('quote two lines above or below the cited line is accepted with a shift note', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile([
      'export const a = 1;',
      'two',
      'three',
      'export const b = 2;',
      'five',
    ]),
  });
  const refs = [
    ref({ line: 3, quote: 'export const a' }),
    ref({ line: 2, quote: 'export const b' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, [
    { list: 'criteria', entry: 0, ref: 0, cited: 3, found: 1 },
    { list: 'criteria', entry: 0, ref: 1, cited: 2, found: 4 },
  ]);
  fs.rmSync(root, { recursive: true });
});

test('quote three lines away from the cited line is rejected', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile([
      'export const a = 1;',
      'two',
      'three',
      'four',
      'five',
      'six',
      'export const b = 2;',
    ]),
  });
  const refs = [
    ref({ line: 4, quote: 'export const a' }),
    ref({ line: 4, quote: 'export const b' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.strictEqual(problems.length, 2);
  for (const problem of problems) assert.ok(problem.includes('quote not found'));
  assert.deepStrictEqual(notes, []);
  fs.rmSync(root, { recursive: true });
});

test('invented quote absent from the whole window is rejected', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile(['one', 'export const a = 1;', 'three', 'four', 'five']),
  });
  const refs = [ref({ line: 3, quote: 'assert.strictEqual(noId.failures[0]' })];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('quote not found'));
  assert.deepStrictEqual(notes, []);
  fs.rmSync(root, { recursive: true });
});

test('equal distance picks the line above', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile([
      'export const x = 1;',
      'cited marker line',
      'export const x = 1;',
    ]),
  });
  const refs = [ref({ line: 2, quote: 'export const x' })];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, [
    { list: 'criteria', entry: 0, ref: 0, cited: 2, found: 1 },
  ]);
  fs.rmSync(root, { recursive: true });
});

test('nearest matching line wins and the cited line needs no shift', () => {
  const root = makeCheckout({
    'apps/api/near.ts': linesFile([
      'export const near = 1;',
      'two',
      'cited',
      'export const near = 1;',
      'five',
    ]),
    'apps/api/exact.ts': linesFile([
      'export const near = 1;',
      'export const near = 1;',
    ]),
  });
  const refs = [
    ref({ path: 'apps/api/near.ts', line: 3, quote: 'export const near' }),
    ref({ path: 'apps/api/exact.ts', line: 2, quote: 'export const near' }),
  ];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, [
    { list: 'criteria', entry: 0, ref: 0, cited: 3, found: 4 },
  ]);
  fs.rmSync(root, { recursive: true });
});

test('window is clipped at the start of the file', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile(['one', 'export const x = 1;']),
  });
  const refs = [ref({ line: 1, quote: 'export const x' })];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, [
    { list: 'criteria', entry: 0, ref: 0, cited: 1, found: 2 },
  ]);
  fs.rmSync(root, { recursive: true });
});

test('line past the end is still rejected with the window', () => {
  const root = makeCheckout({
    'apps/api/x.ts': 'one\nexport const x = 1;\n',
  });
  const refs = [ref({ line: 4, quote: 'export const x' })];
  const parsed = JSON.parse(
    report({ criteria: [criterion('PASS', 'AC', { refs })] }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('past the end'));
  assert.deepStrictEqual(notes, []);
  fs.rmSync(root, { recursive: true });
});

test('shift note for an invariant reference names the invariants list', () => {
  const root = makeCheckout({
    'apps/api/x.ts': linesFile(['export const x = 1;', 'two', 'three']),
  });
  const parsed = JSON.parse(
    report({
      invariants: [
        invariant('INV-1', 'PASS', {
          refs: [ref({ line: 2, quote: 'export const x' })],
        }),
      ],
    }),
  );
  const { problems, notes } = checkRefsWithNotes(parsed, root);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, [
    { list: 'invariants', entry: 0, ref: 0, cited: 2, found: 1 },
  ]);
  fs.rmSync(root, { recursive: true });
});

const BEHAVIOR_SPEC_ITEMS = [specItem('AC-1', 'behavior', 'a behavior item')];
const DOC_SPEC_ITEMS = [specItem('AC-1', 'doc', 'a doc item')];

const behaviorReport = (refs) =>
  JSON.parse(
    report({ criteria: [criterion('PASS', 'model text', { id: 'AC-1', refs })] }),
  );

test('behavior PASS without an impl reference fails', () => {
  const parsed = behaviorReport([ref({ kind: 'test' })]);
  const problems = checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS);
  assert.deepStrictEqual(problems, [
    'behavior item passed without impl and test references: AC-1',
  ]);
});

test('behavior PASS without a test reference fails', () => {
  const parsed = behaviorReport([ref({ kind: 'impl' })]);
  const problems = checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS);
  assert.deepStrictEqual(problems, [
    'behavior item passed without impl and test references: AC-1',
  ]);
});

test('behavior PASS with impl and test references does not fail', () => {
  const parsed = behaviorReport([
    ref({ kind: 'impl' }),
    ref({ kind: 'test', path: 'apps/api/x.spec.ts' }),
  ]);
  assert.deepStrictEqual(checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS), []);
});

test('behavior PASS accepts a ci reference in place of impl', () => {
  const parsed = behaviorReport([
    ref({ kind: 'ci' }),
    ref({ kind: 'test', path: 'apps/api/x.spec.ts' }),
  ]);
  assert.deepStrictEqual(checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS), []);
});

test('behavior PASS accepts a config reference in place of impl', () => {
  const parsed = behaviorReport([
    ref({ kind: 'config' }),
    ref({ kind: 'test', path: 'apps/api/x.spec.ts' }),
  ]);
  assert.deepStrictEqual(checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS), []);
});

test('behavior PASS with a config reference but no test reference still fails', () => {
  const parsed = behaviorReport([ref({ kind: 'config' })]);
  const problems = checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS);
  assert.deepStrictEqual(problems, [
    'behavior item passed without impl and test references: AC-1',
  ]);
});

test('behavior PASS with a doc reference in place of impl still fails', () => {
  const parsed = behaviorReport([
    ref({ kind: 'doc' }),
    ref({ kind: 'test', path: 'apps/api/x.spec.ts' }),
  ]);
  const problems = checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS);
  assert.deepStrictEqual(problems, [
    'behavior item passed without impl and test references: AC-1',
  ]);
});

test('behavior PASS without impl, ci or config reference still fails', () => {
  const parsed = behaviorReport([ref({ kind: 'test' })]);
  const problems = checkBehaviorRefs(parsed, BEHAVIOR_SPEC_ITEMS);
  assert.deepStrictEqual(problems, [
    'behavior item passed without impl and test references: AC-1',
  ]);
});

test('doc PASS with a single doc reference does not fail', () => {
  const parsed = behaviorReport([ref({ kind: 'doc' })]);
  assert.deepStrictEqual(checkBehaviorRefs(parsed, DOC_SPEC_ITEMS), []);
});

test('legacy PASS without a test reference does not fail', () => {
  const parsed = behaviorReport([ref({ kind: 'impl' })]);
  assert.deepStrictEqual(checkBehaviorRefs(parsed, null), []);
});
