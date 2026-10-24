#!/usr/bin/env node
'use strict';

// Publishes a release tag of the factory. Every precondition of the release skill is checked before
// the tag exists: the target is the current commit of origin/main, its package.json and CHANGELOG
// pass release-check, the tag exists neither in this clone nor on origin, and the required CI checks
// succeeded on that commit. Then the owner confirms and only the tag is pushed. The working tree and
// the branches of this clone are not touched. Run it in an ordinary terminal:
//   node .claude/scripts/release-tag.js vX.Y.Z [--dry-run] [--yes]

const childProcess = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline/promises');
const { checkRelease, TAG_PATTERN } = require('./release-check');

const REMOTE = 'origin';
const BRANCH = 'main';
const REQUIRED_CHECKS = ['Test (Linux)', 'Test (Windows)', 'Lint', 'Typecheck'];
const ROOT = path.resolve(__dirname, '..', '..');
const USAGE = 'usage: node .claude/scripts/release-tag.js vX.Y.Z [--dry-run] [--yes]';

class ReleaseTagError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseTagError';
  }
}

const parseArgs = (argv) => {
  const options = { tag: undefined, isDryRun: false, isConfirmed: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.isDryRun = true;
    else if (arg === '--yes') options.isConfirmed = true;
    else if (arg.startsWith('-') || options.tag !== undefined) throw new ReleaseTagError(`unknown argument "${arg}"; ${USAGE}`);
    else options.tag = arg;
  }
  if (options.tag === undefined) throw new ReleaseTagError(USAGE);
  if (!TAG_PATTERN.test(options.tag)) throw new ReleaseTagError(`tag "${options.tag}" must have the form vX.Y.Z; no tag created`);
  return options;
};

/** git and gh in the repository root; a spawn error or a non-zero exit is an error. */
const createTools = ({ root, spawn }) => {
  const run = (tool, args) => {
    const result = spawn(tool, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (result.error) throw new ReleaseTagError(`cannot run ${tool}: ${result.error.message}`);
    if (result.status !== 0) throw new ReleaseTagError(`${tool} ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
    return String(result.stdout);
  };
  return { git: (...args) => run('git', args), gh: (...args) => run('gh', args) };
};

// The GitHub repository of the configured origin URL (not rewritten by insteadOf), so the check runs
// are read from the same repository the tag is pushed to.
const GITHUB_URL = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

const originRepository = (git) => {
  const url = git('config', '--get', `remote.${REMOTE}.url`).trim();
  const match = GITHUB_URL.exec(url);
  if (!match) throw new ReleaseTagError(`${REMOTE} (${url}) is not a GitHub repository; no tag created`);
  return `${match[1]}/${match[2]}`;
};

// Every check run of a required name from GitHub Actions must have succeeded, at least one each.
const checkRunProblems = (gh, repository, sha) => {
  let runs;
  try {
    runs = JSON.parse(gh('api', `repos/${repository}/commits/${sha}/check-runs?per_page=100`)).check_runs;
  } catch (error) {
    if (error instanceof ReleaseTagError) throw error;
    throw new ReleaseTagError(`check runs of ${sha} are not readable: ${error.message}`);
  }
  if (!Array.isArray(runs)) throw new ReleaseTagError(`check runs of ${sha} are not readable: no check_runs list`);
  const problems = [];
  for (const name of REQUIRED_CHECKS) {
    const named = runs.filter((item) => item && item.name === name && item.app && item.app.slug === 'github-actions');
    if (named.length === 0) problems.push(`check "${name}" has no GitHub Actions run on ${sha}`);
    for (const run of named) {
      if (run.status !== 'completed') problems.push(`check "${name}" is ${run.status} on ${sha}`);
      else if (run.conclusion !== 'success') problems.push(`check "${name}" concluded ${run.conclusion} on ${sha}`);
    }
  }
  return problems;
};

const isOnRemote = (git, tag) => git('ls-remote', '--tags', REMOTE, `refs/tags/${tag}`).trim() !== '';

/** Checks every precondition without creating anything; returns the commit to tag. */
const prepareRelease = ({ tag, git, gh }) => {
  const repository = originRepository(git);
  git('fetch', '--quiet', '--no-tags', REMOTE, `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`);
  const sha = git('rev-parse', '--verify', `refs/remotes/${REMOTE}/${BRANCH}^{commit}`).trim();
  const read = (file) => git('show', `${sha}:${file}`);
  const problems = checkRelease(tag, read('package.json'), read('CHANGELOG.md'));
  if (git('tag', '--list', tag).trim() !== '') problems.push(`tag ${tag} already exists in this clone`);
  if (isOnRemote(git, tag)) problems.push(`tag ${tag} already exists on ${REMOTE}; a published tag is never moved`);
  problems.push(...checkRunProblems(gh, repository, sha));
  if (problems.length > 0) throw new ReleaseTagError(`no tag created:\n- ${problems.join('\n- ')}`);
  return sha;
};

/** Asks the owner to type the tag name; no terminal, end of input or Ctrl+C confirms nothing. */
const askOwner = async (tag, sha) => {
  if (!process.stdin.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise((resolve) => prompt.once('close', () => resolve(null)));
  prompt.once('SIGINT', () => prompt.close());
  try {
    const question = prompt.question(`Push ${tag} -> ${sha} to ${REMOTE}? It is public and never moved. Type ${tag} to confirm: `);
    const answer = await Promise.race([question, closed]);
    return typeof answer === 'string' && answer.trim() === tag;
  } finally {
    prompt.close();
  }
};

// A failed push leaves no tag in the clone; if the tag reached origin anyway, it is public and stays.
const pushTag = (git, tag) => {
  try {
    git('push', '--quiet', REMOTE, `refs/tags/${tag}`);
    return;
  } catch (error) {
    let isPublished = false;
    try {
      isPublished = isOnRemote(git, tag);
    } catch {
      throw new ReleaseTagError(`${error.message}\nwhether ${tag} reached ${REMOTE} is unknown: check with git ls-remote --tags ${REMOTE}; the tag stays in this clone`);
    }
    if (isPublished) return;
    try {
      git('tag', '-d', tag);
    } catch (cleanup) {
      throw new ReleaseTagError(`${error.message}\n${tag} is not on ${REMOTE}; removing it from this clone failed too: ${cleanup.message}`);
    }
    throw error;
  }
};

/**
 * @param {{ tag: string, isDryRun?: boolean, isConfirmed?: boolean, git: (...args: string[]) => string, gh: (...args: string[]) => string, confirm?: (tag: string, sha: string) => Promise<boolean>, log?: (line: string) => void }} options
 */
const releaseTag = async ({ tag, isDryRun = false, isConfirmed = false, git, gh, confirm = askOwner, log = console.log }) => {
  const sha = prepareRelease({ tag, git, gh });
  log(`release-tag: ${tag} -> ${sha} (${REMOTE}/${BRANCH}), all checks passed`);
  if (isDryRun) {
    log('release-tag: dry run, no tag created');
    return { sha, isTagged: false };
  }
  if (!isConfirmed && !(await confirm(tag, sha))) {
    log('release-tag: not confirmed, no tag created (run it in a terminal, or pass --yes on the owner\'s decision)');
    return { sha, isTagged: false };
  }
  git('tag', '-a', tag, '-m', `Release ${tag}`, sha);
  pushTag(git, tag);
  log(`release-tag: pushed ${tag}; commit SHA for the wrappers: ${sha}`);
  log('release-tag: the Release workflow creates the GitHub Release: gh run list --workflow release.yml');
  return { sha, isTagged: true };
};

/** Exit code: 0 for a pushed tag or a passed dry run, 1 otherwise. */
const main = async (argv = process.argv.slice(2), { root = ROOT, spawn = childProcess.spawnSync, confirm = askOwner, log = console.log, logError = console.error } = {}) => {
  try {
    const options = parseArgs(argv);
    const result = await releaseTag({ ...options, ...createTools({ root, spawn }), confirm, log });
    return result.isTagged || options.isDryRun ? 0 : 1;
  } catch (error) {
    logError(`release-tag: ${error.message}`);
    return 1;
  }
};

if (require.main === module) main().then((code) => (process.exitCode = code));

module.exports = { main, releaseTag, parseArgs, REQUIRED_CHECKS, ReleaseTagError };
