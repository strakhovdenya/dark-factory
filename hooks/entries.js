'use strict';

// The six settings entries of the five hooks, as one description. `factory doctor` checks a
// project's `.claude/settings.json` against it and hooks/settings-entry.test.js proves that the
// JSON in hooks/README.md says the same. Nothing here writes settings: a project adds the entries
// itself (see hooks/README.md).

const PACKAGE_HOOKS_DIR = 'node_modules/dark-factory/hooks';

// A gate fails closed (`|| exit 2` turns any failure of the process into a block); a helper never
// blocks (`|| true`).
const KIND_SUFFIX = Object.freeze({ gate: '|| exit 2', helper: '|| true' });

/** @type {ReadonlyArray<Readonly<{ event: string, matcher: string, script: string, kind: 'gate' | 'helper' }>>} */
const HOOK_ENTRIES = Object.freeze(
  /** @type {{ event: string, matcher: string, script: string, kind: 'gate' | 'helper' }[]} */ ([
    { event: 'PreToolUse', matcher: 'Bash', script: 'closure-gate.js', kind: 'gate' },
    { event: 'PreToolUse', matcher: 'mcp__github__issue_write', script: 'closure-gate.js', kind: 'gate' },
    { event: 'PreToolUse', matcher: 'Write|Edit', script: 'skill-gate.js', kind: 'gate' },
    { event: 'PostToolUse', matcher: 'Skill', script: 'skill-marker.js', kind: 'helper' },
    { event: 'PostToolUse', matcher: 'Write|Edit', script: 'lint.js', kind: 'helper' },
    { event: 'PostToolUse', matcher: 'Write|Edit', script: 'typecheck.js', kind: 'helper' },
  ]).map((entry) => Object.freeze(entry)),
);

/** The shell command of an entry: the installed script by `CLAUDE_PROJECT_DIR`, the path quoted. */
const commandFor = ({ script, kind }) => `node "$CLAUDE_PROJECT_DIR/${PACKAGE_HOOKS_DIR}/${script}" ${KIND_SUFFIX[kind]}`;

/** A name for reports: event, matcher and script. */
const entryId = ({ event, matcher, script }) => `${event}/${matcher}/${script}`;

module.exports = { HOOK_ENTRIES, PACKAGE_HOOKS_DIR, KIND_SUFFIX, commandFor, entryId };
