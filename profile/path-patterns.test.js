'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isProtectedPath, isDocOnlyPath, denyGlobOf } = require('./path-patterns');

test('applies profile glob semantics', () => {
  for (const match of [isDocOnlyPath, isProtectedPath]) {
    assert.equal(match('README.md', ['*.md']), true);
    assert.equal(match('docs/guide.md', ['*.md']), false);
    assert.equal(match('README.md', ['**/*.md']), true);
    assert.equal(match('a/b/c/notes.md', ['**/*.md']), true);
    assert.equal(match('docs/a.txt', ['docs/']), true);
    assert.equal(match('docs/deep/er/b.png', ['docs/']), true);
    assert.equal(match('docs/x.ts', ['**/docs/']), true);
    assert.equal(match('pkg/docs/x.ts', ['**/docs/']), true);
    assert.equal(match('src/a.ts', ['{src,lib}/*.ts']), true);
  }
  assert.equal(isProtectedPath('docs\\win\\path.txt', ['docs/']), true, 'backslashes are separators');
});

test('does not treat patterns as string prefixes', () => {
  for (const match of [isDocOnlyPath, isProtectedPath]) {
    assert.equal(match('docs/a/b.md', ['*.md']), false);
    assert.equal(match('src/docs/x.ts', ['docs/']), false);
    assert.equal(match('docs-old/x.ts', ['docs/']), false);
    assert.equal(match('scripts-old/x.js', ['scripts/']), false);
  }
});

test('protected paths ignore case and cover the directory path itself', () => {
  assert.equal(isProtectedPath('Scripts/x.js', ['scripts/']), true);
  assert.equal(isProtectedPath('.GitHub/workflows/a.yml', ['.github/']), true);
  assert.equal(isProtectedPath('scripts', ['scripts/']), true);
  assert.equal(isDocOnlyPath('README.MD', ['**/*.md']), false, 'doc-only is case-sensitive');
  assert.equal(isDocOnlyPath('docs', ['docs/']), false);
});

test('a "!" or "#" pattern is a literal, never a negation or a comment', () => {
  assert.equal(isProtectedPath('src/a.ts', ['!src/']), false);
  assert.equal(isProtectedPath('src/a.ts', ['#src/']), false);
});

test('deny glob of a directory entry covers its content', () => {
  assert.equal(denyGlobOf('scripts/'), 'scripts/**');
  assert.equal(denyGlobOf('**/*.md'), '**/*.md');
});
