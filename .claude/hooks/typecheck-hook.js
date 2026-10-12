#!/usr/bin/env node
'use strict';

/**
 * Claude Code PostToolUse hook for Write|Edit events (factory development only, non-blocking).
 * Runs the repository's local `tsc --noEmit` (checkJs) from the repository root after a .js edit.
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
  if (!editedJsFile(raw, repoRoot)) return;
  const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscBin)) return;
  spawn(tscBin, ['--noEmit'], { cwd: repoRoot });
};

if (require.main === module) runAsHook((raw) => handle(raw));

module.exports = { handle };
