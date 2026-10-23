#!/usr/bin/env node
'use strict';

/**
 * Claude Code PostToolUse hook for the Skill tool (non-blocking). Records the skill loaded in
 * this session in the session marker, which the skill gate and the closure gate read.
 *
 * The marker is `<os tmpdir>/claude-loaded-skills-<session_id>.json`: a JSON array of skill
 * names. A missing file is an empty set. A damaged marker (invalid JSON, not an array of
 * strings) makes the gates block; a new Skill event rebuilds it from an empty set with only the
 * skill loaded now, so earlier entries that cannot be trusted are not restored. The file is
 * replaced through a temporary file in the same directory and a rename; concurrent updates are
 * not merged.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

const sessionIdOf = (input) => {
  const sessionId = input?.session_id;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('hook input has no session_id');
  }
  if (!SESSION_ID.test(sessionId)) throw new Error(`session_id has unsupported characters: ${sessionId}`);
  return sessionId;
};

const markerPath = (sessionId) => path.join(os.tmpdir(), `claude-loaded-skills-${sessionId}.json`);

/** Skills recorded for the session; throws when the marker is damaged. */
const readLoaded = (sessionId) => {
  const file = markerPath(sessionId);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`cannot read skill marker ${file}: ${error.message}`, { cause: error });
  }
  let loaded;
  try {
    loaded = JSON.parse(text);
  } catch (error) {
    throw new Error(`skill marker ${file} is not valid JSON: ${error.message}`, { cause: error });
  }
  const isValid = Array.isArray(loaded) && loaded.every((name) => typeof name === 'string');
  if (!isValid) throw new Error(`skill marker ${file} is not a list of skill names`);
  return loaded;
};

/** A skill counts as loaded under its own name or as "<plugin>:<name>". */
const isLoaded = (loaded, skill) => loaded.some((name) => name === skill || name.endsWith(`:${skill}`));

/** Adds the skill named in a Skill event to its session marker; throws on unusable input. */
const record = (raw) => {
  const input = JSON.parse(raw);
  const sessionId = sessionIdOf(input);
  const skill = input?.tool_input?.skill;
  if (typeof skill !== 'string' || skill.trim() === '') throw new Error('Skill event has no skill name');
  let loaded;
  try {
    loaded = readLoaded(sessionId);
  } catch (error) {
    process.stderr.write(`skill-marker: rebuilding damaged marker (${error.message})\n`);
    loaded = [];
  }
  if (loaded.includes(skill)) return;
  const file = markerPath(sessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify([...loaded, skill]));
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
};

const main = () => {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    try {
      record(raw);
    } catch (error) {
      process.stderr.write(`skill-marker: ${error.message}\n`);
    }
    process.exitCode = 0;
  });
};

if (require.main === module) main();

module.exports = { markerPath, readLoaded, isLoaded, record, sessionIdOf };
