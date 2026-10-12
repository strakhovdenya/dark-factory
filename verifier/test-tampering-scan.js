'use strict';

const fs = require('node:fs');
const { patternToRegex } = require('./affects-scope');

const usage = () =>
  'usage: node scripts/test-tampering-scan.js <diff.patch> --config ' +
  '<tampering-scan.json> --out <tampering-scan-result.json>';

// Skip-style markers (INV-4's fixtures assemble these by concatenation so
// this file's own tests never trip the scanner it tests).
const SKIP_MARKERS = ['.only(', '.skip(', 'xit(', 'xdescribe(', 'it.todo(', 'test.todo('];
const SUPPRESSION_MARKERS = ['eslint-disable', '@ts-ignore', '@ts-expect-error', '@ts-nocheck'];
const WORKFLOW_MARKERS = ['continue-on-error: true', 'if: false'];
const ASSERTION_MARKERS = ['expect(', 'assert.'];
const SUPPRESSION_CLASSES = ['test', 'workflow', 'config'];

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const NEW_FILE_PATH = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const NUMERIC_KV = /"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?)\s*,?\s*$/;

// Parses a unified diff into per-file added/removed lines (INV-3: no
// filesystem access, just the diff text) and, per file, the same lines
// grouped by hunk. Per-hunk grouping lets scanCoverageThreshold pair a
// removed/added value only within the hunk it actually changed, instead of
// across the whole file, where an unrelated same-named key elsewhere could
// otherwise steal the pairing slot and hide a real decrease.
const parseDiff = (diffText) => {
  const files = [];
  let current = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const closeHunk = () => {
    if (current !== null && hunk !== null) current.hunks.push(hunk);
    hunk = null;
  };
  for (const rawLine of diffText.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    const fileHeader = FILE_HEADER.exec(line);
    if (fileHeader) {
      closeHunk();
      current = { path: fileHeader[2], added: [], removed: [], hunks: [] };
      files.push(current);
      continue;
    }
    if (current === null) continue;
    const newPath = NEW_FILE_PATH.exec(line);
    if (newPath) {
      current.path = newPath[1];
      continue;
    }
    const hunkHeader = HUNK_HEADER.exec(line);
    if (hunkHeader) {
      closeHunk();
      hunk = { added: [], removed: [] };
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      const entry = { line: newLine, text: line.slice(1) };
      current.added.push(entry);
      if (hunk !== null) hunk.added.push(entry);
      newLine += 1;
    } else if (line.startsWith('-')) {
      const entry = { line: oldLine, text: line.slice(1) };
      current.removed.push(entry);
      if (hunk !== null) hunk.removed.push(entry);
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  closeHunk();
  return files;
};

// Union of every matching class (INV-9), not first-match: a path matching
// both "test" and "config" is checked under both.
const classesOf = (filePath, config) => {
  const matched = [];
  for (const [className, patterns] of Object.entries(config)) {
    const regexes = patterns.map(patternToRegex);
    if (regexes.some((regex) => regex.test(filePath))) matched.push(className);
  }
  return matched;
};

const scanSkipMarkers = (file, classes) => {
  if (!classes.includes('test')) return [];
  const findings = [];
  for (const { line, text } of file.added) {
    for (const marker of SKIP_MARKERS) {
      if (text.includes(marker)) {
        findings.push(
          `${file.path}:${line}: skip-style marker "${marker}" added in test file`,
        );
      }
    }
  }
  return findings;
};

const scanSuppressions = (file, classes) => {
  const relevant = classes.filter((name) => SUPPRESSION_CLASSES.includes(name));
  if (relevant.length === 0) return [];
  const findings = [];
  for (const { line, text } of file.added) {
    for (const marker of SUPPRESSION_MARKERS) {
      if (text.includes(marker)) {
        findings.push(
          `${file.path}:${line}: lint/type suppression "${marker}" added in ` +
            `${relevant.join('/')} file`,
        );
      }
    }
  }
  return findings;
};

const scanWorkflowMarkers = (file, classes) => {
  if (!classes.includes('workflow')) return [];
  const findings = [];
  for (const { line, text } of file.added) {
    for (const marker of WORKFLOW_MARKERS) {
      if (text.includes(marker)) {
        findings.push(`${file.path}:${line}: "${marker}" added in workflow file`);
      }
    }
  }
  return findings;
};

// Pairs a removed numeric "key": value with the next added line for the same
// key, in order of appearance within one hunk, and flags a decrease (TR-3:
// an unrelated key in the same block increasing does not hide a different
// key's decrease). Pairing is scoped to a single hunk, not the whole file:
// an unrelated same-named key changed elsewhere in the file must not steal
// the pairing slot and hide a real decrease in a different hunk.
const scanCoverageThreshold = (file, classes) => {
  if (!classes.includes('config')) return [];
  const findings = [];
  for (const hunk of file.hunks) {
    const removedByKey = new Map();
    for (const { text } of hunk.removed) {
      const match = NUMERIC_KV.exec(text.trim());
      if (!match) continue;
      const [, key, value] = match;
      if (!removedByKey.has(key)) removedByKey.set(key, []);
      removedByKey.get(key).push(Number(value));
    }
    const consumedByKey = new Map();
    for (const { text } of hunk.added) {
      const match = NUMERIC_KV.exec(text.trim());
      if (!match) continue;
      const [, key, value] = match;
      const removedValues = removedByKey.get(key);
      if (!removedValues) continue;
      const consumed = consumedByKey.get(key) ?? 0;
      if (consumed >= removedValues.length) continue;
      consumedByKey.set(key, consumed + 1);
      const removedValue = removedValues[consumed];
      const addedValue = Number(value);
      if (addedValue < removedValue) {
        findings.push(
          `${file.path}: coverageThreshold value for "${key}" decreased from ` +
            `${removedValue} to ${addedValue}`,
        );
      }
    }
  }
  return findings;
};

const isAssertion = ({ text }) =>
  ASSERTION_MARKERS.some((marker) => text.includes(marker));

const testFileAssertions = (files, config) => {
  const result = [];
  for (const file of files) {
    if (!classesOf(file.path, config).includes('test')) continue;
    const toEntry = ({ text }) => ({ key: text.trim(), isCovered: false });
    result.push({
      path: file.path,
      removed: file.removed.filter(isAssertion).map(toEntry),
      added: file.added.filter(isAssertion).map(toEntry),
    });
  }
  return result;
};

// Step 1: a removed assertion is moved when the same trimmed text is
// added in any test-class file of this diff; each added line covers at most
// one removed line. Step 2: what stays uncovered is compared per file, so an
// assertion edited in place cancels out in its own file, while new, different
// assertions in another file never compensate for a loss. Matching is by text
// only: a removed line identical to an unrelated line added elsewhere (a
// generic `expect(x).toBeDefined();`) counts as moved.
const scanAssertions = (files, config) => {
  const assertions = testFileAssertions(files, config);
  const availableByKey = new Map();
  for (const { added } of assertions) {
    for (const entry of added) {
      if (!availableByKey.has(entry.key)) availableByKey.set(entry.key, []);
      availableByKey.get(entry.key).push(entry);
    }
  }
  let movedCount = 0;
  for (const { removed } of assertions) {
    for (const entry of removed) {
      const candidates = availableByKey.get(entry.key);
      const target = candidates?.find((candidate) => !candidate.isCovered);
      if (target === undefined) continue;
      target.isCovered = true;
      entry.isCovered = true;
      movedCount += 1;
    }
  }
  const countUncovered = (entries) =>
    entries.filter((entry) => !entry.isCovered).length;
  const losses = [];
  for (const { path: filePath, removed, added } of assertions) {
    const lost = countUncovered(removed) - countUncovered(added);
    if (lost > 0) losses.push({ path: filePath, lost });
  }
  return { losses, movedCount };
};

const scanFile = (file, config) => {
  const classes = classesOf(file.path, config);
  return [
    ...scanSkipMarkers(file, classes),
    ...scanSuppressions(file, classes),
    ...scanWorkflowMarkers(file, classes),
    ...scanCoverageThreshold(file, classes),
  ];
};

// Result shape written by the CLI (INV-2).
const scan = (diffText, config) => {
  const files = parseDiff(diffText);
  const findings = [];
  for (const file of files) findings.push(...scanFile(file, config));
  const { losses, movedCount } = scanAssertions(files, config);
  return {
    findings,
    assertion_losses: losses,
    assertion_moved: movedCount,
  };
};

const scanDiff = (diffText, config) => scan(diffText, config).findings;

const isConfigShape = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (patterns) =>
      Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === 'string'),
  );

const parseArgs = (argv) => {
  let diff = null;
  let config = null;
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      const value = argv[index + 1];
      if (!value) return null;
      config = value;
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) return null;
      out = value;
      index += 1;
    } else if (!arg.startsWith('--') && diff === null) {
      diff = arg;
    } else {
      return null;
    }
  }
  return diff !== null && config !== null && out !== null ? { diff, config, out } : null;
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  let configData;
  try {
    configData = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (!isConfigShape(configData)) {
    process.stderr.write('config must map class names to arrays of pattern strings\n');
    return 1;
  }
  let diffText;
  try {
    diffText = fs.readFileSync(args.diff, 'utf8');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  fs.writeFileSync(args.out, JSON.stringify(scan(diffText, configData)));
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  parseArgs,
  main,
  scan,
  scanDiff,
  parseDiff,
  classesOf,
  scanFile,
  isConfigShape,
};
