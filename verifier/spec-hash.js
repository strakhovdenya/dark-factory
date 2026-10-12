'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { isBotLogin } = require('./label-authority');

const APPROVAL_AUTHOR = 'github-actions[bot]';
const MARKER_PATTERN = /^<!-- spec-approved sha256=([0-9a-f]{64}) -->/;
const CHECKBOX_PATTERN = /^(\s*)([-*+])\s*\[[ xX]\]/gm;
const TRAILING_SPACES = /[ \t]+$/gm;
const TRAILING_NEWLINES = /\n+$/;

const marker = (sha) => `<!-- spec-approved sha256=${sha} -->`;

// Ticking a checkbox (Ralph, the GitHub UI) is not a change of the spec.
const normalize = (body) =>
  String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CHECKBOX_PATTERN, '$1$2 [ ]')
    .replace(TRAILING_SPACES, '')
    .replace(TRAILING_NEWLINES, '');

const hash = (body) =>
  crypto.createHash('sha256').update(normalize(body), 'utf8').digest('hex');

const approvalHashOf = (comment) => {
  if (comment?.user?.login !== APPROVAL_AUTHOR) return null;
  if (typeof comment.body !== 'string') return null;
  const match = MARKER_PATTERN.exec(comment.body);
  return match === null ? null : match[1];
};

// comments must be in chronological order, as the GitHub issue comments API
// returns them: the last approval comment wins.
const findApproval = (comments) => {
  if (!Array.isArray(comments)) return null;
  let approved = null;
  for (const comment of comments) {
    const sha = approvalHashOf(comment);
    if (sha !== null) approved = sha;
  }
  return approved;
};

const isAuthorizedSender = (sender, owners) =>
  typeof sender === 'string' &&
  !isBotLogin(sender) &&
  Array.isArray(owners) &&
  owners.includes(sender);

const approvalComment = (body, sender, owners) => {
  if (!isAuthorizedSender(sender, owners)) return null;
  const sha = hash(body);
  return (
    `${marker(sha)}\n` +
    `Spec approved by ${sender}. Normalized body sha256: \`${sha}\`.\n` +
    'The acceptance verifier fails if the issue body changes after this ' +
    'comment; re-apply the label to approve a new version.\n'
  );
};

const USAGE =
  'usage:\n' +
  '  spec-hash.js hash <body-file>\n' +
  '  spec-hash.js approve --body <file> --sender <login> --owners <file> ' +
  '--out <comment.md>\n' +
  '  spec-hash.js check --body <file> --comments <file> ' +
  '--out <spec-approval.json>';

const OPTION_NAMES = new Set([
  '--body',
  '--sender',
  '--owners',
  '--comments',
  '--out',
]);

const parseOptions = (argv) => {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!OPTION_NAMES.has(name) || !value || value.startsWith('--')) {
      return null;
    }
    options[name.slice(2)] = value;
  }
  return options;
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const runHash = (args) => {
  if (args.length !== 1) return null;
  process.stdout.write(`${hash(fs.readFileSync(args[0], 'utf8'))}\n`);
  return 0;
};

const runApprove = ({ body, sender, owners, out }) => {
  if (!body || !sender || !owners || !out) return null;
  const text = fs.readFileSync(body, 'utf8');
  const comment = approvalComment(text, sender, readJson(owners));
  if (comment === null) {
    process.stdout.write(`skipped: ${sender} may not approve the spec\n`);
    return 0;
  }
  fs.writeFileSync(out, comment);
  process.stdout.write('approved\n');
  return 0;
};

const runCheck = ({ body, comments, out }) => {
  if (!body || !comments || !out) return null;
  const result = {
    approved_hash: findApproval(readJson(comments)),
    current_hash: hash(fs.readFileSync(body, 'utf8')),
  };
  fs.writeFileSync(out, JSON.stringify(result));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
};

const withOptions = (run) => (args) => {
  const options = parseOptions(args);
  return options === null ? null : run(options);
};

const COMMANDS = new Map([
  ['hash', runHash],
  ['approve', withOptions(runApprove)],
  ['check', withOptions(runCheck)],
]);

// Operational errors (a missing or malformed file) exit 1 without printing a
// hash or writing an output file, so callers fail closed.
const main = (argv = process.argv.slice(2)) => {
  const command = COMMANDS.get(argv[0]);
  let code = null;
  try {
    code = command === undefined ? null : command(argv.slice(1));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (code === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  return code;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  APPROVAL_AUTHOR,
  marker,
  normalize,
  hash,
  findApproval,
  approvalComment,
  main,
};
