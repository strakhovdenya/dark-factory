'use strict';

// The one matcher for the path patterns of the profile: protectedPaths and docOnlyPathPatterns.
// The glob dialect is the one of hooks paths (minimatch: *, **, {a,b}); a pattern is never read
// as a plain string prefix. Paths and patterns are relative to the consumer root.
//
//  - "*.md" covers files in the root only, "**/*.md" covers any depth.
//  - An entry that ends with "/" ("docs/") stands for everything below it ("docs/**").
//  - protectedPaths ignore letter case on every platform, and "X/" also covers the path "X"
//    itself (a file or a link put where the directory was).
//  - docOnlyPathPatterns are case-sensitive.

const { minimatch } = require('minimatch');

const MATCH_OPTIONS = Object.freeze({
  dot: true,
  matchBase: false,
  nonegate: true,
  nocomment: true,
});

/** A path or pattern with "/" separators and no leading "./". */
const normalizePath = (value) => String(value).replace(/\\/g, '/').replace(/^(\.\/)+/, '');

// The globs one profile entry stands for. `withSelf` adds the directory path itself for a "X/"
// entry (protected paths only).
const globsOf = (pattern, withSelf) => {
  const normalized = normalizePath(pattern);
  if (!normalized.endsWith('/')) return [normalized];
  const dir = normalized.replace(/\/+$/, '');
  return withSelf ? [`${dir}/**`, dir] : [`${dir}/**`];
};

const matchesAny = (filePath, patterns, { nocase, withSelf }) => {
  const target = normalizePath(filePath);
  const options = { ...MATCH_OPTIONS, nocase };
  return patterns.some((pattern) => globsOf(pattern, withSelf).some((glob) => minimatch(target, glob, options)));
};

/**
 * Whether a changed path falls under one of the profile's protectedPaths (case-insensitive).
 * @param {string} filePath
 * @param {readonly string[]} patterns
 */
const isProtectedPath = (filePath, patterns) => matchesAny(filePath, patterns, { nocase: true, withSelf: true });

/**
 * Whether a changed path is documentation by the profile's docOnlyPathPatterns (case-sensitive).
 * @param {string} filePath
 * @param {readonly string[]} patterns
 */
const isDocOnlyPath = (filePath, patterns) => matchesAny(filePath, patterns, { nocase: false, withSelf: false });

/**
 * Glob form of a protectedPaths entry for an Edit/Write deny rule: "X/" becomes "X/**".
 * @param {string} pattern
 */
const denyGlobOf = (pattern) => globsOf(pattern, false)[0];

module.exports = { MATCH_OPTIONS, normalizePath, isProtectedPath, isDocOnlyPath, denyGlobOf };
