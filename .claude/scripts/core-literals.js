'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Source of truth for the project-literal rule (PRD "core without project literals").
// The core-literal-scan agent follows this list. This file is outside the scanned area.
const FORBIDDEN_LITERALS = ['apps/api', 'apps/web', 'jobflow', 'cards', 'supabase', 'prisma'];
// Forbidden everywhere in the core except the package metadata files below.
const OWNER_LITERAL = 'strakhovdenya';
const METADATA_FILES = ['package.json', 'README.md'];

function normalizeEntry(entry) {
  return entry.split('\\').join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalRegExp(literal) {
  // Whole-word match: neighbours must not be letters or digits.
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(literal)}(?![a-z0-9])`, 'i');
}

const RULES = [
  ...FORBIDDEN_LITERALS.map((literal) => ({ literal, regexp: literalRegExp(literal), skip: [] })),
  { literal: OWNER_LITERAL, regexp: literalRegExp(OWNER_LITERAL), skip: METADATA_FILES },
];

function listTrackedFiles(rootDir) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '-z'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`core-literals: cannot list tracked files in ${rootDir}: ${error.message}`);
  }
  return output.split('\0').filter(Boolean);
}

function readPackageFilesField(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  if (!Array.isArray(pkg.files) || pkg.files.some((entry) => typeof entry !== 'string')) {
    throw new Error('core-literals: package.json field "files" is missing or not an array of strings');
  }
  return pkg.files.map(normalizeEntry);
}

function isInCore(file, packageEntries) {
  if (METADATA_FILES.includes(file)) return true;
  return packageEntries.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

/**
 * Searches the package content (tracked files under the package.json "files" entries,
 * plus package.json and README.md) for project literals.
 * Returns [{ file, line, literal }]; throws when the tree cannot be determined.
 */
function findLiterals(rootDir) {
  const packageEntries = readPackageFilesField(rootDir);
  const findings = [];
  for (const file of listTrackedFiles(rootDir)) {
    if (!isInCore(file, packageEntries)) continue;
    const fullPath = path.join(rootDir, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath);
    if (content.includes(0)) continue;
    const rules = RULES.filter((rule) => !rule.skip.includes(file));
    const lines = content.toString('utf8').split(/\r?\n/);
    for (const [i, text] of lines.entries()) {
      for (const rule of rules) {
        if (rule.regexp.test(text)) findings.push({ file, line: i + 1, literal: rule.literal });
      }
    }
  }
  return findings;
}

function formatFinding({ file, line, literal }) {
  return `${file}:${line}: project literal "${literal}"`;
}

module.exports = { findLiterals, formatFinding, FORBIDDEN_LITERALS, OWNER_LITERAL, METADATA_FILES };
