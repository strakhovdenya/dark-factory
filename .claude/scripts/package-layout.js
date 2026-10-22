'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Directories whose contents ship to projects. Adding a package directory is a deliberate layout change.
const PACKAGE_DIRS = ['skills', 'agents', 'hooks', 'profile', 'verifier', 'judge', 'ralph'];
// Development-only directories that must never be published.
const FORBIDDEN_PREFIXES = ['.claude', '.factory'];

function normalizeEntry(entry) {
  return entry.split('\\').join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/** Returns a list of error messages for the `files` field of a package.json object. */
function checkPackageLayout(pkg) {
  const files = pkg && pkg.files;
  if (!Array.isArray(files)) {
    return ['package.json: field "files" is missing or not an array'];
  }

  const errors = [];
  const entries = files.filter((entry) => typeof entry === 'string').map(normalizeEntry);

  for (const [i, entry] of files.entries()) {
    if (typeof entry !== 'string') {
      errors.push(`package.json: "files"[${i}] is not a string`);
    }
  }
  for (const entry of files) {
    if (typeof entry !== 'string') continue;
    const normalized = normalizeEntry(entry);
    if (FORBIDDEN_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      errors.push(`package.json: "files" entry "${entry}" must not be under .claude or .factory`);
    }
  }
  for (const dir of PACKAGE_DIRS) {
    if (!entries.includes(dir)) {
      errors.push(`package.json: "files" is missing package directory "${dir}/"`);
    }
  }
  return errors;
}

function checkRepository(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  return checkPackageLayout(pkg);
}

module.exports = { checkPackageLayout, checkRepository, PACKAGE_DIRS };
