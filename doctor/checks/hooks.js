'use strict';

const { HOOK_ENTRIES, commandFor, entryId } = require('../../hooks/entries');
const { readJsonFile } = require('../files');

const SETTINGS = '.claude/settings.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const collapse = (command) => command.trim().replace(/\s+/g, ' ');

// The command of a settings hook is a shell string; it counts only when it is the contract
// command (the installed script by CLAUDE_PROJECT_DIR, the path quoted, the failure handling of
// its kind). A script name inside echo or a comment proves nothing.
const hooksOf = (settings, entry) => {
  const groups = settings.hooks?.[entry.event];
  if (!Array.isArray(groups)) return [];
  return groups.filter((group) => isObject(group) && group.matcher === entry.matcher).flatMap((group) => (Array.isArray(group.hooks) ? group.hooks : []));
};

const isWired = (settings, entry) => hooksOf(settings, entry).some((hook) => isObject(hook) && hook.type === 'command' && typeof hook.command === 'string' && collapse(hook.command) === commandFor(entry));

const describeMiss = (settings, entry) => {
  const near = hooksOf(settings, entry).find((hook) => isObject(hook) && typeof hook.command === 'string' && hook.command.includes(entry.script));
  if (near === undefined) return `missing: no ${entry.event} hook for matcher "${entry.matcher}" runs ${entry.script}; expected command: ${commandFor(entry)}`;
  return `wrong: the ${entry.event} hook for matcher "${entry.matcher}" is ${JSON.stringify(near.command)}${near.type === 'command' ? '' : ` of type ${JSON.stringify(near.type)}`}, expected ${commandFor(entry)}`;
};

// The six entries of the five hooks in the project's `.claude/settings.json`, read as data.
module.exports = {
  name: 'hooks',
  run(context) {
    const read = readJsonFile(context.root, SETTINGS);
    if (read.state === 'invalid') return [{ subject: SETTINGS, reason: read.reason }];
    if (read.state === 'ok' && !isObject(read.value)) return [{ subject: SETTINGS, reason: 'must be a JSON object' }];
    if (read.state === 'ok' && read.value.hooks !== undefined && !isObject(read.value.hooks)) return [{ subject: SETTINGS, reason: '"hooks" must be an object' }];
    const settings = read.state === 'ok' ? read.value : {};
    const fileNote = read.state === 'missing' ? ` (${SETTINGS} does not exist)` : '';
    return HOOK_ENTRIES.filter((entry) => !isWired(settings, entry)).map((entry) => ({ subject: `${SETTINGS} ${entryId(entry)}`, reason: `${describeMiss(settings, entry)}${fileNote}` }));
  },
};
