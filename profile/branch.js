'use strict';

// Task branches are named by the profile's branchTemplate, for example
// "task/ISSUE-{issue}-{slug}": {issue} is the issue number, {slug} any
// non-empty text. Everything else in the template is literal text.

const ISSUE = '{issue}';
const SLUG = '{slug}';
const PLACEHOLDER = /(\{issue\}|\{slug\})/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const escapeRegex = (text) => text.replace(REGEX_SPECIAL, '\\$&');

// A regex matching a whole branch name; group 1 is the issue number. A
// repeated {issue} must repeat the same number.
const branchPattern = (template) => {
  if (!template.includes(ISSUE)) {
    throw new Error(`branch template "${template}" has no ${ISSUE} placeholder`);
  }
  let issueSeen = false;
  const source = template
    .split(PLACEHOLDER)
    .map((part) => {
      if (part === SLUG) return '.+';
      if (part !== ISSUE) return escapeRegex(part);
      if (issueSeen) return '\\1';
      issueSeen = true;
      return '([0-9]+)';
    })
    .join('');
  return new RegExp(`^${source}$`);
};

// The issue number of a task branch, or null when the branch is not one.
const issueNumberOfBranch = (template, branch) => {
  const match = branchPattern(template).exec(branch);
  return match === null ? null : Number(match[1]);
};

const MAX_SLUG_LENGTH = 50;

// Lower-case title, every run of characters outside [a-z0-9] replaced by "-", no "-" at the ends,
// at most MAX_SLUG_LENGTH characters; an empty result is "issue".
const slugify = (title) => {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug || 'issue';
};

// The task branch of an issue by the profile template. The name must be recognized by
// issueNumberOfBranch of the same template as the same issue; a template that cannot do that is
// a configuration error.
const branchNameFor = (template, issue, title) => {
  if (!Number.isInteger(issue) || issue < 1) throw new TypeError(`branchNameFor: invalid issue number ${issue}`);
  const name = template.split(ISSUE).join(String(issue)).split(SLUG).join(slugify(title));
  const recognized = issueNumberOfBranch(template, name);
  if (recognized !== issue) {
    throw new Error(`branchTemplate "${template}" does not recognize its own branch name "${name}" as issue ${issue}`);
  }
  return name;
};

const usage = () => 'usage: node profile/branch.js --project <project-root> --branch <name>';

const parseArgs = (argv) => {
  const options = { project: null, branch: null };
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (value === undefined) return null;
    if (argv[index] === '--project') options.project = value;
    else if (argv[index] === '--branch') options.branch = value;
    else return null;
  }
  return options.project !== null && options.branch !== null ? options : null;
};

// Prints the issue number, or nothing for a branch that is not a task branch.
// An invalid profile or template exits 1.
const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  try {
    const issue = issueNumberOfBranch(require('./load').loadProfile(args.project).branchTemplate, args.branch);
    process.stdout.write(issue === null ? '' : `${issue}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = { MAX_SLUG_LENGTH, branchPattern, issueNumberOfBranch, slugify, branchNameFor, parseArgs, main };
