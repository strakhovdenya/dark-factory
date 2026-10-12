'use strict';

const fs = require('node:fs');
const { patternToRegex, changedPathsOf } = require('./affects-scope');
const { authorizeLabel } = require('./label-authority');

const usage = () =>
  'usage: node scripts/factory-separation.js --files <file> ' +
  '--timeline <file> --owners <file> --config <file> [--json]';

const matchesAny = (patterns, changedPath) =>
  patterns.some((pattern) => pattern.test(changedPath));

// The classifier proper (AC-1..AC-4): a plain list of already-resolved
// changed paths against the two side pattern lists (already-built regexes).
const classifyPaths = (changedPaths, specPatterns, verifierPatterns) => ({
  spec: changedPaths.some((changedPath) => matchesAny(specPatterns, changedPath)),
  verifier: changedPaths.some((changedPath) =>
    matchesAny(verifierPatterns, changedPath),
  ),
});

// git diff --name-status text in, classification out. changedPathsOf is
// affects-scope.js's own rename/delete/dedup rule (INV-2, TR-1), reused
// directly rather than reimplemented.
const classify = (filesTxt, specPatterns, verifierPatterns) =>
  classifyPaths(changedPathsOf(filesTxt), specPatterns, verifierPatterns);

// The two sides' file patterns and the gate label name are project-specific
// values (INV-7) — read from a trusted config, never hardcoded here.
const readConfig = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const specPatterns = data.specPatterns.map(patternToRegex);
  const verifierPatterns = data.verifierPatterns.map(patternToRegex);
  const label = data.label;
  if (typeof label !== 'string' || label === '') {
    throw new Error('config.label must be a non-empty string');
  }
  return { specPatterns, verifierPatterns, label };
};

const parseArgs = (argv) => {
  let files = null;
  let timeline = null;
  let owners = null;
  let config = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === '--files' ||
      arg === '--timeline' ||
      arg === '--owners' ||
      arg === '--config'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return null;
      if (arg === '--files') files = value;
      else if (arg === '--timeline') timeline = value;
      else if (arg === '--owners') owners = value;
      else config = value;
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      return null;
    }
  }

  return files && timeline && owners && config
    ? { files, timeline, owners, config, json }
    : null;
};

const readJsonArray = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(data) ? data : [];
};

// Fail-closed (mirrors label-authority.js's own CLI, INV-3/INV-4): an
// unreadable or malformed timeline/owners file means the label is not
// counted, not a crashed job.
const authorizationFor = (args, label) => {
  try {
    const events = readJsonArray(args.timeline);
    const owners = readJsonArray(args.owners);
    return authorizeLabel(events, owners, label);
  } catch {
    return { authorized: false, actor: null };
  }
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  let config;
  let classification;
  try {
    config = readConfig(args.config);
    const filesTxt = fs.readFileSync(args.files, 'utf8');
    classification = classify(filesTxt, config.specPatterns, config.verifierPatterns);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const bothSides = classification.spec && classification.verifier;
  const label = bothSides
    ? authorizationFor(args, config.label)
    : { authorized: null, actor: null };

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...classification, label })}\n`);
  }

  if (!bothSides) return 0;
  return label.authorized ? 0 : 1;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  classify,
  classifyPaths,
  changedPathsOf,
  readConfig,
  parseArgs,
  main,
};
