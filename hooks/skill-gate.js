#!/usr/bin/env node
'use strict';

/**
 * Claude Code PreToolUse hook for Write|Edit (gate, fails closed). Blocks (exit 2) an edit until
 * the skills the shared "path to skills" table (profile/skill-rules.js) requires for the file
 * were loaded in this session (recorded by skill-marker.js). The absolute file_path of the event
 * is made relative to the consumer root first; a file outside the root requires no skills.
 * Missing CLAUDE_PROJECT_DIR, session_id or file_path, an unparsable event, a missing or invalid
 * profile and a damaged marker block. Edits made through Bash are not covered.
 */
const { loadProfile } = require('../profile/load');
const { requiredSkillDetailsFor } = require('../profile/skill-rules');
const { consumerRootOf, consumerPath } = require('./commands');
const { allow, block, runGate } = require('./run-gate');
const { readLoaded, isLoaded, sessionIdOf } = require('./skill-marker');

/** @type {import('./run-gate').GateHandler} */
const decide = (raw, env) => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') throw new Error('hook input has no file_path');
  const sessionId = sessionIdOf(input);
  const root = consumerRootOf(env);
  const profile = loadProfile(root);
  const target = consumerPath(root, filePath);
  if (target === null) return allow();
  const { skills, labels } = requiredSkillDetailsFor(profile, [target.relative]);
  if (skills.length === 0) return allow();
  const loaded = readLoaded(sessionId);
  const missing = skills.filter((skill) => !isLoaded(loaded, skill));
  if (missing.length === 0) return allow();
  const area = labels.length > 0 ? ` (${labels.join(', ')})` : '';
  return block(
    `Blocked: editing ${target.relative}${area} requires skills that were not loaded in this ` +
      `session yet: ${missing.join(', ')}. Load each with the Skill tool first, then repeat the edit.`,
  );
};

if (require.main === module) runGate('skill-gate', decide);

module.exports = { decide };
