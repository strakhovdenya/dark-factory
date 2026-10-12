'use strict';

const fs = require('node:fs');

const usage = () =>
  'usage: node scripts/affects-scope.js <issue.md> <files.txt> --out <scope.json>';

const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const BACKTICK_TOKEN = /`([^`\n]+)`/g;
const HAS_EXTENSION = /\.[^./]+$/;

// A backtick token counts as a path only when it looks like one (INV-2):
// it has a slash, or its last segment has an extension. Plain words in
// backticks (labels, option names) are not paths.
const isPathLike = (token) => token.includes('/') || HAS_EXTENSION.test(token);

// Collects the raw text of the "## Affects" section only, skipping any
// fenced code (matching issue-lint.js's own fence handling) so a code block
// inside the issue can never smuggle in a path.
const extractAffectsSection = (markdown) => {
  let inSection = false;
  let isFenced = false;
  const collected = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      isFenced = !isFenced;
      continue;
    }
    if (isFenced) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      inSection = heading[1].trim().toLowerCase() === 'affects';
      continue;
    }
    if (inSection) collected.push(line);
  }
  return collected.join('\n');
};

const extractAffectsPatterns = (markdown) => {
  const section = extractAffectsSection(markdown);
  const patterns = new Set();
  for (const match of section.matchAll(BACKTICK_TOKEN)) {
    const token = match[1].trim();
    if (isPathLike(token)) patterns.add(token);
  }
  return [...patterns];
};

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;
const escapeChar = (char) => (REGEX_SPECIAL.test(char) ? `\\${char}` : char);

// Translates the pattern body (INV-3): "**/" becomes an optional recursive
// directory prefix (so "**/README.md" also matches a root-level file),
// a lone "**" becomes ".*", a lone "*" never crosses "/", and every other
// character (including "(", ")", ".", "+", "[") is escaped literally.
const translate = (pattern) => {
  let result = '';
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      result += '(?:.*/)?';
      index += 3;
    } else if (pattern.startsWith('**', index)) {
      result += '.*';
      index += 2;
    } else if (pattern[index] === '*') {
      result += '[^/]*';
      index += 1;
    } else {
      result += escapeChar(pattern[index]);
      index += 1;
    }
  }
  return result;
};

// A pattern ending in "/" is a directory prefix (INV-3): any changed path
// starting with it is covered, at any depth. Everything else must match
// exactly.
const patternToRegex = (pattern) => {
  const isDirectoryPrefix = pattern.endsWith('/');
  const body = translate(pattern);
  return new RegExp(isDirectoryPrefix ? `^${body}` : `^${body}$`);
};

// Renames/copies are checked by their new path only (INV-4); a deletion is
// checked by the path that was removed. Everything else (M, A, T, ...) has
// a single path in the second field.
const changedPathFromLine = (line) => {
  const trimmed = line.replace(/\r$/, '');
  if (trimmed.trim() === '') return null;
  const fields = trimmed.split('\t');
  const status = fields[0] ?? '';
  if (status.startsWith('R') || status.startsWith('C')) return fields[2] ?? null;
  return fields[1] ?? null;
};

const changedPathsOf = (filesTxt) => {
  const paths = [];
  const seen = new Set();
  for (const line of filesTxt.split(/\r?\n/)) {
    const changedPath = changedPathFromLine(line);
    if (changedPath === null || seen.has(changedPath)) continue;
    seen.add(changedPath);
    paths.push(changedPath);
  }
  return paths;
};

// Paths and patterns are data (INV-5): nothing here touches the filesystem
// for them, only in-memory string/regex comparison.
const computeScope = (issueMarkdown, filesTxt) => {
  const patterns = extractAffectsPatterns(issueMarkdown).map(patternToRegex);
  const outOfScope = changedPathsOf(filesTxt).filter(
    (changedPath) => !patterns.some((pattern) => pattern.test(changedPath)),
  );
  return { out_of_scope: outOfScope };
};

const parseArgs = (argv) => {
  let issue = null;
  let files = null;
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) return null;
      out = value;
      index += 1;
    } else if (!arg.startsWith('--') && issue === null) {
      issue = arg;
    } else if (!arg.startsWith('--') && files === null) {
      files = arg;
    } else {
      return null;
    }
  }
  return issue !== null && files !== null && out !== null
    ? { issue, files, out }
    : null;
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  let result;
  try {
    const issueMarkdown = fs.readFileSync(args.issue, 'utf8');
    const filesTxt = fs.readFileSync(args.files, 'utf8');
    result = computeScope(issueMarkdown, filesTxt);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  fs.writeFileSync(args.out, JSON.stringify(result));
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  parseArgs,
  main,
  computeScope,
  extractAffectsPatterns,
  patternToRegex,
  changedPathFromLine,
  changedPathsOf,
};
