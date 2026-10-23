#!/usr/bin/env node
'use strict';

/**
 * Claude Code PostToolUse hook for Write|Edit (non-blocking). Runs the profile's hooks.typecheck
 * commands that match the changed file (see commands.js); never runs hooks of another kind and
 * has no default commands. Always exits 0; problems are reported on stderr.
 */
const { runHookCommands, runCommandHook } = require('./commands');

/** @param {string} raw stdin event @param {Parameters<typeof runHookCommands>[2]} [deps] */
const handle = (raw, deps) => runHookCommands('typecheck', raw, deps);

if (require.main === module) runCommandHook('typecheck');

module.exports = { handle };
