#!/usr/bin/env node
'use strict';

/**
 * Claude Code PostToolUse hook for the Skill tool (factory development only).
 * Records the skills loaded in this session so skill-gate-hook.js can require them before edits.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const markerPath = (sessionId) => path.join(os.tmpdir(), `claude-loaded-skills-${sessionId}.json`);

const readLoaded = (file) => {
  if (!fs.existsSync(file)) return [];
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(loaded)) throw new Error(`${file} is not a list of skills`);
  return loaded;
};

/** Adds the skill named in the event to the session marker; throws on unusable input. */
const record = (raw) => {
  const input = JSON.parse(raw);
  const sessionId = input?.session_id;
  const skill = input?.tool_input?.skill;
  if (typeof sessionId !== 'string' || sessionId === '' || typeof skill !== 'string' || skill === '') return;
  const file = markerPath(sessionId);
  // A damaged marker is rebuilt from the skills loaded from now on, so loading a skill repairs it.
  let loaded = [];
  try {
    loaded = readLoaded(file);
  } catch {
    loaded = [];
  }
  if (loaded.includes(skill)) return;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...loaded, skill]));
  fs.renameSync(temporary, file);
};

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    try {
      record(raw);
    } catch (error) {
      process.stderr.write(`skill-marker-hook: ${error.message}\n`);
    }
  });
}

module.exports = { markerPath, readLoaded, record };
