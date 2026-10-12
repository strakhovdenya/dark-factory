'use strict';

const fs = require('node:fs');

const RELEVANT_EVENTS = new Set(['labeled', 'unlabeled']);

const isBotLogin = (login) =>
  typeof login === 'string' && login.endsWith('[bot]');

const loginOf = (event) => {
  const login = event?.actor?.login;
  return typeof login === 'string' ? login : null;
};

const labelNameOf = (event) => {
  const name = event?.label?.name;
  return typeof name === 'string' ? name : null;
};

const unauthorized = (actor = null) => ({ authorized: false, actor });

// events must be in chronological order, as the GitHub timeline API returns
// them. Only the most recent labeled/unlabeled event for labelName decides
// current state; unrelated labels and unrelated event types are ignored.
const lastRelevantEvent = (events, labelName) => {
  const relevant = Array.isArray(events)
    ? events.filter(
        (event) =>
          RELEVANT_EVENTS.has(event?.event) &&
          labelNameOf(event) === labelName,
      )
    : [];
  return relevant.length === 0 ? null : relevant[relevant.length - 1];
};

// Whether labelName is currently applied, from the same timeline snapshot
// authorizeLabel reads — callers that also need authorization should read it
// from one timeline fetch instead of a second, separate labels-endpoint call
// (which would race with the events this function and authorizeLabel see).
const isLabelPresent = (events, labelName) => {
  const last = lastRelevantEvent(events, labelName);
  return last !== null && last.event === 'labeled';
};

const authorizeLabel = (events, owners, labelName) => {
  const last = lastRelevantEvent(events, labelName);
  if (last === null || last.event !== 'labeled') return unauthorized();

  const actor = loginOf(last);
  if (actor === null) return unauthorized();

  const ownerSet = new Set(Array.isArray(owners) ? owners : []);
  const authorized = !isBotLogin(actor) && ownerSet.has(actor);
  return { authorized, actor };
};

const usage = () =>
  'usage: node scripts/label-authority.js --timeline <file> ' +
  '--owners <file> --label <name> [--json]';

const parseArgs = (argv) => {
  let timeline = null;
  let owners = null;
  let label = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeline' || arg === '--owners' || arg === '--label') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return null;
      if (arg === '--timeline') timeline = value;
      else if (arg === '--owners') owners = value;
      else label = value;
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      return null;
    }
  }

  return timeline && owners && label ? { timeline, owners, label, json } : null;
};

const readJsonArray = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(data) ? data : [];
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  // Fail closed (INV-5): an unreadable or malformed timeline/owners file
  // means the label is not counted (and not present), not a crashed
  // workflow step.
  let result;
  try {
    const events = readJsonArray(args.timeline);
    const owners = readJsonArray(args.owners);
    result = {
      ...authorizeLabel(events, owners, args.label),
      present: isLabelPresent(events, args.label),
    };
  } catch {
    result = { ...unauthorized(), present: false };
  }

  const output = args.json
    ? JSON.stringify(result)
    : String(result.authorized);
  process.stdout.write(`${output}\n`);
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = { authorizeLabel, isLabelPresent, isBotLogin, parseArgs, main };
