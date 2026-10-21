#!/usr/bin/env node
'use strict';

/**
 * Claude Code PreToolUse hook for Write|Edit (factory development only).
 * Blocks (exit 2) an edit of a JavaScript file until the skills required for it were loaded in
 * this session (recorded by skill-marker-hook.js). Fails closed: unparsable input or an
 * unreadable marker also block. Edits made through Bash (sed, python) are not covered: the hook
 * cannot tell which files a shell command writes.
 */
const path = require('node:path');
const { isInside } = require('./hook-common');
const { RULES } = require('./required-skills');
const { markerPath, readLoaded } = require('./skill-marker-hook');

const defaultRoot = path.resolve(__dirname, '..', '..');

const isLoaded = (loaded, skill) => loaded.some((name) => name === skill || name.endsWith(`:${skill}`));

/**
 * @param {string} raw hook input
 * @param {{ repoRoot?: string, read?: (sessionId: string) => string[] }} [deps]
 * @returns {{ block: boolean, message?: string }}
 */
const decide = (raw, { repoRoot = defaultRoot, read = (id) => readLoaded(markerPath(id)) } = {}) => {
  try {
    const input = JSON.parse(raw);
    const filePath = input?.tool_input?.file_path;
    const sessionId = input?.session_id;
    if (typeof filePath !== 'string' || filePath === '' || typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('hook input has no file_path or session_id');
    }
    const absolute = path.resolve(repoRoot, filePath);
    if (!isInside(repoRoot, absolute) || isInside(path.join(repoRoot, 'node_modules'), absolute)) {
      return { block: false };
    }
    const rule = RULES.find((candidate) => candidate.extensions.test(absolute));
    if (!rule) return { block: false };
    const loaded = read(sessionId);
    const missing = rule.skills.filter((skill) => !isLoaded(loaded, skill));
    if (missing.length === 0) return { block: false };
    return {
      block: true,
      message:
        `Blocked: this is a ${rule.label} edit, but these skills were not loaded in this session ` +
        `yet: ${missing.join(', ')}. Load each with the Skill tool first, then repeat the edit.`,
    };
  } catch (error) {
    return { block: true, message: `Blocked: skill gate could not decide (${error.message}).` };
  }
};

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    const result = decide(raw);
    if (!result.block) return;
    process.stderr.write(`${result.message}\n`);
    process.exit(2);
  });
}

module.exports = { decide };
