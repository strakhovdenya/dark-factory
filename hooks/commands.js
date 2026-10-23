'use strict';

// Consumer-root helpers shared by the hooks, and the executor of the lint and typecheck hooks.
// The consumer root comes only from CLAUDE_PROJECT_DIR and the profile only from loadProfile of
// that root; package resources are required relative to this module.
//
// Executor contract (profile hooks.lint / hooks.typecheck, see profile/schema.json hookCommand):
// every entry whose paths match the changed file runs once, in array order; a spawn error, a
// missing binary or a non-zero exit is reported on stderr and the next entry still runs. {file}
// in argv becomes the absolute path of the changed file in every occurrence; cwd is resolved from
// the consumer root and never interpolated; no shell. The hooks always exit 0 and write no log files.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { minimatch } = require('minimatch');
const { loadProfile } = require('../profile/load');
const { MATCH_OPTIONS, normalizePath } = require('../profile/path-patterns');

const FILE_TOKEN = '{file}';
const HOOK_MATCH_OPTIONS = Object.freeze({ ...MATCH_OPTIONS, nocase: false });

/** The consumer root from a non-empty CLAUDE_PROJECT_DIR; no fallback on cwd or the package. */
const consumerRootOf = (env) => {
  const root = env.CLAUDE_PROJECT_DIR;
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('CLAUDE_PROJECT_DIR is not set: the consumer root is unknown');
  }
  return path.resolve(root);
};

/**
 * Whether an absolute path lies strictly below a directory. Lexical: path.relative compares the
 * drive letter case-insensitively on win32 and gives an absolute result for another drive.
 */
const isInside = (dir, target) => {
  const relative = path.relative(dir, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * Position of an event's file_path in the consumer root: the absolute path as given (a relative
 * one is resolved from the root) and the root-relative path with "/". null outside the root,
 * including another drive.
 * @returns {{ absolute: string, relative: string } | null}
 */
const consumerPath = (root, filePath) => {
  const absolute = path.resolve(root, filePath);
  if (!isInside(root, absolute)) return null;
  return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };
};

const matchesEntry = (relative, entry) =>
  entry.paths.some((pattern) => minimatch(relative, normalizePath(pattern), HOOK_MATCH_OPTIONS));

/** argv with every {file} replaced by the absolute path; each element stays one argument. */
const substituteFile = (argv, absolute) => argv.map((item) => item.split(FILE_TOKEN).join(absolute));

const defaultSpawn = (program, args, options) =>
  spawnSync(program, args, { ...options, shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const outputOf = (result) => [result.stdout, result.stderr].filter(Boolean).join('').trim();

const runEntry = (kind, entry, root, absolute, { spawn, report }) => {
  const argv = substituteFile(entry.command.argv, absolute);
  const cwd = path.resolve(root, entry.command.cwd);
  const result = spawn(argv[0], argv.slice(1), { cwd });
  if (result.error) {
    report(`${kind}: cannot run ${argv[0]} in ${cwd}: ${result.error.message}`);
    return;
  }
  if (result.status === 0) return;
  const exit = result.status === null ? `signal ${result.signal}` : `code ${result.status}`;
  const output = outputOf(result);
  report(`${kind}: ${argv[0]} exited with ${exit} in ${cwd}${output ? `:\n${output}` : ''}`);
};

/**
 * Runs the profile commands of one hook kind for the file of a PostToolUse Write|Edit event.
 * Never throws: every problem is reported, and nothing runs when the event, the root or the
 * profile is unusable.
 * @param {'lint' | 'typecheck'} kind
 * @param {string} raw stdin event
 * @param {{ env?: NodeJS.ProcessEnv, spawn?: typeof defaultSpawn, report?: (line: string) => void }} [deps]
 */
const runHookCommands = (kind, raw, deps = {}) => {
  const env = deps.env ?? process.env;
  const report = deps.report ?? ((line) => process.stderr.write(`${line}\n`));
  const spawn = deps.spawn ?? defaultSpawn;
  try {
    const filePath = JSON.parse(raw)?.tool_input?.file_path;
    if (typeof filePath !== 'string' || filePath === '') throw new Error('hook input has no file_path');
    const root = consumerRootOf(env);
    const entries = loadProfile(root).hooks?.[kind] ?? [];
    const target = consumerPath(root, filePath);
    if (target === null) return;
    for (const entry of entries) {
      if (!matchesEntry(target.relative, entry)) continue;
      try {
        runEntry(kind, entry, root, target.absolute, { spawn, report });
      } catch (error) {
        report(`${kind}: ${error.message}`);
      }
    }
  } catch (error) {
    report(`${kind}: not run (${error.message})`);
  }
};

/** Entrypoint of the lint/typecheck hooks: reads stdin, runs the commands, always exits 0. */
const runCommandHook = (kind) => {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    runHookCommands(kind, raw);
    process.exitCode = 0;
  });
};

module.exports = { FILE_TOKEN, consumerRootOf, isInside, consumerPath, matchesEntry, substituteFile, runHookCommands, runCommandHook };
