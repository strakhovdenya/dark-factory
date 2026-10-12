#!/usr/bin/env node
'use strict';

/**
 * Claude Code PostToolUse hook for Write|Edit events (factory development only, non-blocking).
 * Runs the repository's local `eslint --fix` on the single edited .js file.
 */
const fs = require('node:fs');
const path = require('node:path');
const { editedJsFile, defaultSpawn, runAsHook } = require('./hook-common');

const defaultRoot = path.resolve(__dirname, '..', '..');

/**
 * @param {string} raw
 * @param {{ repoRoot?: string, spawn?: (bin: string, args: string[], options: { cwd: string }) => unknown }} [deps]
 */
const handle = (raw, { repoRoot = defaultRoot, spawn = defaultSpawn } = {}) => {
  const file = editedJsFile(raw, repoRoot);
  if (!file) return;
  const eslintBin = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(eslintBin)) return;
  spawn(eslintBin, ['--fix', file], { cwd: repoRoot });
};

if (require.main === module) runAsHook((raw) => handle(raw));

module.exports = { handle };
