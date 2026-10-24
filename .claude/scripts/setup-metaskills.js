#!/usr/bin/env node
'use strict';

/**
 * Bootstrap (run by hand, no longer a postinstall): copies skills of the `metaskills` package into <root>/.claude/skills/<name>.
 *
 * Claude Code looks for skills at .claude/skills/<name>/SKILL.md, while the package keeps them in
 * node_modules/metaskills/skills/<name>. Symlinks and junctions do not fit (they do not list as
 * directories and do not survive a clone), so plain directories are copied. The copies are git-ignored.
 * The tracked .claude/skills/modern-javascript is not in SKILLS and is never touched.
 *
 * Never fails: a missing package is skipped silently.
 */
const fs = require('node:fs');
const path = require('node:path');

const SKILLS = ['data-structures', 'js-data-structures', 'js-conventions', 'error-handling', 'js-gof'];

const removeExisting = (dest) => {
  const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (!stat) return;
  // A link is removed as a link, without following it
  if (stat.isSymbolicLink()) fs.unlinkSync(dest);
  else fs.rmSync(dest, { recursive: true, force: true });
};

/**
 * Copies the listed skills; returns the names actually copied.
 * @param {string} root
 * @param {{ log: Function, warn: Function }} [log]
 * @returns {string[]}
 */
const setupMetaskills = (root, log = console) => {
  const source = path.join(root, 'node_modules', 'metaskills', 'skills');
  const target = path.join(root, '.claude', 'skills');
  /** @type {string[]} */
  const copied = [];

  if (!fs.existsSync(source)) {
    log.log('setup-metaskills: metaskills is not installed, skipping');
    return copied;
  }

  fs.mkdirSync(target, { recursive: true });
  for (const name of SKILLS) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) {
      log.warn(`setup-metaskills: ${name} is missing in the package, skipping`);
      continue;
    }
    const dest = path.join(target, name);
    removeExisting(dest);
    fs.cpSync(from, dest, { recursive: true });
    copied.push(name);
  }
  log.log(`setup-metaskills: copied skills: ${copied.length}`);
  return copied;
};

if (require.main === module) {
  // Root comes from an argument or from this file's location, never from the process cwd
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', '..');
  try {
    setupMetaskills(root);
  } catch (error) {
    console.warn('setup-metaskills: failed to copy skills:', error);
  }
}

module.exports = { SKILLS, setupMetaskills };
