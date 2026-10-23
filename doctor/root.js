'use strict';

// The project doctor looks at: the git root of the given path (or of the current directory), and
// its current branch. No fallback: outside git, with a missing path or without git it is an error,
// and the directory of the package is never substituted.

const fs = require('node:fs');
const path = require('node:path');
const { runGit, realPath } = require('../bin/setup');

class LocationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocationError';
  }
}

/** @param {{ projectPath?: string, cwd: string }} options */
const resolveRoot = ({ projectPath, cwd }) => {
  const isExplicit = projectPath !== undefined;
  const start = isExplicit ? path.resolve(cwd, projectPath) : cwd;
  let real;
  try {
    real = realPath(start);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new LocationError(`${isExplicit ? 'project path' : 'current directory'} "${start}" is not an existing directory`);
  }
  const result = runGit(real, ['rev-parse', '--show-toplevel']);
  if (result.error) throw new LocationError(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) throw new LocationError(`"${start}" is not inside a git repository`);
  return realPath(result.stdout.trim());
};

/** The branch name, or null for a detached HEAD. */
const currentBranch = (root) => {
  const result = runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (result.error) throw new LocationError(`cannot run git: ${result.error.message}`);
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return null;
  throw new LocationError(`git symbolic-ref failed in ${root}: ${String(result.stderr).trim()}`);
};

module.exports = { resolveRoot, currentBranch, LocationError };
