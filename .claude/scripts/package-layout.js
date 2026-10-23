'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Directories whose contents ship to projects. Adding a package directory is a deliberate layout change.
const PACKAGE_DIRS = ['bin', 'skills', 'agents', 'hooks', 'doctor', 'profile', 'verifier', 'judge', 'ralph'];
// Development-only directories that must never be published.
const FORBIDDEN_PREFIXES = ['.claude', '.factory'];

function normalizeEntry(entry) {
  return entry.split('\\').join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

// Package directories whose tests and type checks the root scripts must cover explicitly.
const CHECKED_DIRS = ['bin', 'doctor'];

/**
 * Returns a list of error messages for the `files` field of a package.json object and, when given,
 * for the test glob and the typecheck include list that must cover the setup payload.
 */
function checkPackageLayout(pkg, tsconfig) {
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
  const testScript = pkg.scripts && pkg.scripts.test;
  for (const dir of CHECKED_DIRS) {
    if (typeof testScript !== 'string' || !testScript.includes(`"${dir}/**/*.test.js"`)) {
      errors.push(`package.json: "scripts.test" does not run "${dir}/**/*.test.js"`);
    }
    if (tsconfig && !(Array.isArray(tsconfig.include) && tsconfig.include.includes(`${dir}/**/*.js`))) {
      errors.push(`tsconfig.json: "include" is missing "${dir}/**/*.js"`);
    }
  }
  return errors;
}

function checkRepository(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const tsconfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'tsconfig.json'), 'utf8'));
  return checkPackageLayout(pkg, tsconfig);
}

module.exports = { checkPackageLayout, checkRepository, PACKAGE_DIRS };
