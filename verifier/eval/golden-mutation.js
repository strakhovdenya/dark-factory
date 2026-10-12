'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PATCH_HEADER = /^(diff --git |--- .+\r?\n\+\+\+ )/m;
const OPTION_FLAGS = {
  '--repo': 'repo',
  '--base': 'base',
  '--head': 'head',
  '--patch': 'patchFile',
  '--out-dir': 'outDir',
};

const usage = () =>
  'usage: node scripts/golden-mutation.js --repo <dir> --base <sha> ' +
  '--head <sha> --patch <file> --out-dir <dir>';

// An operational failure of the case itself (bad patch, conflict, unknown
// commit): the case cannot be judged, which is a run failure, not a verdict.
class RunFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunFailure';
  }
}

// Only an argument array reaches git: no shell, no interpolated paths or SHAs.
const git = (repo, args, { env = {} } = {}) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw new RunFailure(`git ${args[0]} failed: ${detail}`);
  }
};

const assertSha = (value, label) => {
  if (!SHA_PATTERN.test(value)) {
    throw new RunFailure(`${label} must be a 40 hex commit sha`);
  }
};

const readPatch = (patchPath) => {
  let bytes;
  try {
    bytes = fs.readFileSync(patchPath);
  } catch {
    throw new RunFailure('mutation patch cannot be read');
  }
  const text = bytes.toString('utf8');
  if (text.trim() === '') throw new RunFailure('mutation patch is empty');
  if (!PATCH_HEADER.test(text)) {
    throw new RunFailure('mutation patch is not a unified diff');
  }
  return bytes;
};

// The patch is applied to a scratch index only, so the resulting tree exists
// as data (git objects) without any checkout of mutated code being executed.
const buildMutatedTree = (repo, head, patchPath) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-mutation-'));
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    git(repo, ['read-tree', head], { env });
    git(repo, ['apply', '--cached', '--', patchPath], { env });
    return git(repo, ['write-tree'], { env }).trim();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

const applyMutation = ({ repo, base, head, patchFile, outDir }) => {
  assertSha(base, 'base');
  assertSha(head, 'head');
  const patchPath = path.resolve(patchFile);
  const patchBytes = readPatch(patchPath);
  const current = git(repo, ['rev-parse', 'HEAD']).trim();
  if (current !== head) throw new RunFailure('worktree is not at head sha');
  const mergeBase = git(repo, ['merge-base', base, head]).trim();
  const headTree = git(repo, ['rev-parse', `${head}^{tree}`]).trim();
  const treeSha = buildMutatedTree(repo, head, patchPath);
  if (treeSha === headTree) {
    throw new RunFailure('mutation patch changes nothing');
  }
  git(repo, ['apply', '--', patchPath]);
  const diff = git(repo, ['diff', mergeBase, treeSha]);
  const files = git(repo, ['diff', '--name-status', mergeBase, treeSha]);
  const metadata = {
    head_sha: head,
    base_sha: base,
    patch_sha256: crypto.createHash('sha256').update(patchBytes).digest('hex'),
    tree_sha: treeSha,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'diff.patch'), diff);
  fs.writeFileSync(path.join(outDir, 'files.txt'), files);
  fs.writeFileSync(
    path.join(outDir, 'mutation.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  );
  return metadata;
};

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!Object.hasOwn(OPTION_FLAGS, flag) || value === undefined) {
      throw new Error(usage());
    }
    const key = OPTION_FLAGS[flag];
    options[key] = value;
  }
  for (const key of Object.values(OPTION_FLAGS)) {
    if (options[key] === undefined) throw new Error(usage());
  }
  return options;
};

const main = (argv) => {
  try {
    applyMutation(parseArgs(argv));
    return 0;
  } catch (error) {
    if (error instanceof RunFailure) {
      console.error(`run failure: ${error.message}`);
      return 1;
    }
    console.error(error.message);
    return 2;
  }
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { RunFailure, applyMutation, parseArgs, main };
