#!/usr/bin/env node
'use strict';

// Runs Ralph from a Windows clone in WSL, on the Linux file system, in one command:
//   node node_modules/dark-factory/bin/ralph-wsl.js [--config <path>]
// (also `dark-factory-ralph-wsl`). The `wsl` section of the local run config names the distribution,
// the service clone inside it and the runs root there; nothing else is guessed.
//
// Host mode (Windows): reads `.ralph/config.json` (never writes it), checks the distribution and the
// service clone, fast-forwards the clone to the default branch of `origin`, runs `npm ci` when the
// lock changed, then starts the inner mode through wsl.exe. The agent token travels by name through
// WSLENV, never in an argument. Inner mode (WSL, `--inner`, the config on stdin): refuses to touch
// anything while a live run holds the lock, moves the previous runs into `<runsRoot>/archive/<time>/`,
// prunes the archive, writes the clone's config and starts the controller as its own process.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadLocalConfig, lockPathFor, statePathFor, LOCAL_CONFIG_RELATIVE_PATH } = require('../ralph/config');

const TOKEN_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';
const KEEP_ARCHIVES = 5;
const MAX_ARCHIVE_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_DIR = 'archive';
const ARCHIVE_NAME = /^\d{8}-\d{6}$/;
const PREVIOUS_RUN = /^issue-\d+(-sessions)?$/;
const CONTROLLER_RELATIVE = ['node_modules', 'dark-factory', 'ralph', 'run.js'];
const COMMAND_RELATIVE = ['node_modules', 'dark-factory', 'bin', 'ralph-wsl.js'];
const FRESH_LOCK_MS = 10000;
const USAGE = 'usage: node node_modules/dark-factory/bin/ralph-wsl.js [--config <path>]';

class RalphWslError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RalphWslError';
  }
}

const parseArgs = (argv) => {
  const options = { config: LOCAL_CONFIG_RELATIVE_PATH, inner: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--inner') options.inner = true;
    else if (arg === '--config' && argv[index + 1] !== undefined) options.config = argv[++index];
    else throw new RalphWslError(`Unknown argument ${arg}\n${USAGE}`);
  }
  return options;
};

// --- host mode ---

const posixJoin = (base, ...parts) => [base.replace(/\/+$/, ''), ...parts].join('/');

// `wsl.exe -l -q` prints UTF-16LE.
const decodeList = (output) => {
  const text = Buffer.isBuffer(output) ? (output.includes(0) ? output.toString('utf16le') : output.toString('utf8')) : String(output || '');
  return text.replace(/\0/g, '').replace(/^﻿/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

// wsl.exe -d <distro> --exec <file> <args...>: the distribution runs the program directly, no shell.
const createWslTools = ({ spawn, distro, clone }) => {
  const run = (file, args, options = {}) => spawn('wsl.exe', ['-d', distro, '--exec', file, ...args], { encoding: 'utf8', maxBuffer: 1 << 26, ...options });
  const strict = (file, args, options = {}) => {
    const result = run(file, args, options);
    if (result.error || result.status !== 0) {
      const detail = result.error ? result.error.message : String(result.stderr || '').trim().replace(/\/\/[^/@\s]+@/g, '//***@');
      throw new RalphWslError(`${file} ${args.join(' ')} failed in ${distro}${detail ? `: ${detail}` : ''}`);
    }
    return String(result.stdout || '').trim();
  };
  return { run, strict, git: (...args) => strict('git', ['-C', clone, ...args]) };
};

const tokenEnv = (env) => {
  if (!env[TOKEN_NAME]) return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'WSLENV') || 'WSLENV';
  const names = (env[key] || '').split(':').filter(Boolean);
  const isListed = names.some((name) => name.split('/')[0] === TOKEN_NAME);
  return { ...env, [key]: (isListed ? names : [...names, TOKEN_NAME]).join(':') };
};

const hostMode = ({ configPath, spawn, platform, env, log }) => {
  if (platform !== 'win32') throw new RalphWslError('The host mode of dark-factory-ralph-wsl runs on Windows; inside WSL use ralph/run.js directly.');
  const config = loadLocalConfig(configPath);
  if (config.wsl === undefined) throw new RalphWslError(`${configPath} has no "wsl" section { distro, clone, runsRoot }`);
  const { distro, clone } = config.wsl;

  const listed = spawn('wsl.exe', ['-l', '-q'], { encoding: 'buffer', maxBuffer: 1 << 20 });
  if (listed.error || listed.status !== 0) throw new RalphWslError('wsl.exe -l -q failed: is WSL installed?');
  if (!decodeList(listed.stdout).includes(distro)) throw new RalphWslError(`WSL distribution "${distro}" is not installed (wsl.exe -l -q)`);

  const wsl = createWslTools({ spawn, distro, clone });
  if (wsl.git('status', '--porcelain', '--', '.', ':!.ralph') !== '') throw new RalphWslError(`The service clone ${clone} has uncommitted changes; clean it first`);
  let defaultRef;
  try {
    defaultRef = wsl.git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  } catch {
    throw new RalphWslError(`The service clone ${clone} does not know the default branch of origin; run "git remote set-head origin -a" there`);
  }
  const branch = defaultRef.replace(/^origin\//, '');
  if (wsl.git('rev-parse', '--abbrev-ref', 'HEAD') !== branch) throw new RalphWslError(`The service clone ${clone} is not on the default branch ${branch}`);

  // No committed lockfile counts as a lock that is not there: compared before and after the merge.
  const lockBlob = () => {
    const result = wsl.run('git', ['-C', clone, 'rev-parse', 'HEAD:package-lock.json']);
    return result.status === 0 ? String(result.stdout || '').trim() : null;
  };
  const lockBefore = lockBlob();
  log(`wsl: updating ${clone} to ${defaultRef}`);
  wsl.git('fetch', 'origin');
  wsl.git('merge', '--ff-only', defaultRef);
  const isInstalled = wsl.run('test', ['-f', posixJoin(clone, ...CONTROLLER_RELATIVE)]).status === 0;
  if (!isInstalled || lockBlob() !== lockBefore) {
    log('wsl: npm ci');
    wsl.strict('npm', ['--prefix', clone, 'ci'], { stdio: ['ignore', 'inherit', 'inherit'] });
  }

  const inner = spawn('wsl.exe', ['-d', distro, '--exec', 'node', posixJoin(clone, ...COMMAND_RELATIVE), '--inner'], {
    env: tokenEnv(env),
    input: JSON.stringify(config),
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (inner.error) throw new RalphWslError(`Cannot start the inner mode: ${inner.error.message}`);
  return typeof inner.status === 'number' ? inner.status : 1;
};

// --- inner mode ---

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const stampOf = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

const readLockPid = (lockPath) => {
  try {
    const pid = JSON.parse(fs.readFileSync(lockPath, 'utf8'))?.pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
};

const isLockJustCreated = (lockPath, now) => {
  try {
    return now.getTime() - fs.statSync(lockPath).mtimeMs < FRESH_LOCK_MS;
  } catch {
    return false;
  }
};

const archivePreviousRuns = (runsRoot, now) => {
  const stateName = path.basename(statePathFor(runsRoot));
  const names = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : [];
  const moved = names.filter((name) => PREVIOUS_RUN.test(name) || name === stateName);
  if (moved.length === 0) return null;
  const target = path.join(runsRoot, ARCHIVE_DIR, stampOf(now));
  fs.mkdirSync(target, { recursive: true });
  for (const name of moved) fs.renameSync(path.join(runsRoot, name), path.join(target, name));
  return target;
};

const pruneArchive = (runsRoot, now) => {
  const root = path.join(runsRoot, ARCHIVE_DIR);
  if (!fs.existsSync(root)) return;
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ARCHIVE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const [index, name] of names.entries()) {
    const location = path.join(root, name);
    const isExcess = index >= KEEP_ARCHIVES;
    const isOld = now.getTime() - fs.statSync(location).mtimeMs > MAX_ARCHIVE_AGE_DAYS * DAY_MS;
    if (isExcess || isOld) fs.rmSync(location, { recursive: true, force: true });
  }
};

const innerMode = ({ input, spawn, env, now, isAlive, log }) => {
  let config;
  try {
    config = JSON.parse(input);
  } catch (error) {
    throw new RalphWslError(`The inner mode got an invalid config on stdin: ${error.message}`);
  }
  const { clone, runsRoot } = config.wsl || {};
  if (typeof clone !== 'string' || typeof runsRoot !== 'string' || !path.isAbsolute(clone) || !path.isAbsolute(runsRoot)) {
    throw new RalphWslError('The inner mode needs wsl.clone and wsl.runsRoot as absolute paths');
  }
  if (!env[TOKEN_NAME]) throw new RalphWslError(`${TOKEN_NAME} is not set in WSL: export it on Windows (it is passed through WSLENV)`);

  const lockPath = lockPathFor(runsRoot);
  const pid = readLockPid(lockPath);
  if (pid === null && isLockJustCreated(lockPath, now)) throw new RalphWslError(`Another Ralph run is starting (${lockPath} was just created); nothing was moved`);
  if (pid !== null && isAlive(pid)) throw new RalphWslError(`Another Ralph run is active (PID ${pid}, ${lockPath}); nothing was moved`);

  const archived = archivePreviousRuns(runsRoot, now);
  if (archived) log(`archived previous runs to ${archived}`);
  pruneArchive(runsRoot, now);

  const { wsl, ...rest } = config;
  const configFile = path.join(clone, LOCAL_CONFIG_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify({ ...rest, runsRoot: wsl.runsRoot }, null, 2)}\n`);

  const result = spawn(process.execPath, [path.join(clone, ...CONTROLLER_RELATIVE), '--config', LOCAL_CONFIG_RELATIVE_PATH], {
    cwd: clone,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw new RalphWslError(`Cannot start the controller: ${result.error.message}`);
  return typeof result.status === 'number' ? result.status : 1;
};

/**
 * @param {string[]} [argv]
 * @param {{ cwd?: string, spawn?: any, platform?: string, env?: any, now?: () => Date, isAlive?: (pid: number) => boolean,
 *   readInput?: () => string, log?: (line: string) => void, logError?: (line: string) => void }} [deps]
 */
const main = (
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    spawn = childProcess.spawnSync,
    platform = process.platform,
    env = process.env,
    now = () => new Date(),
    isAlive = isProcessAlive,
    readInput = () => fs.readFileSync(0, 'utf8'),
    log = console.log,
    logError = console.error,
  } = {},
) => {
  try {
    const options = parseArgs(argv);
    if (options.inner) return innerMode({ input: readInput(), spawn, env, now: now(), isAlive, log });
    return hostMode({ configPath: path.resolve(cwd, options.config), spawn, platform, env, log });
  } catch (error) {
    logError(error.message);
    return 1;
  }
};

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, KEEP_ARCHIVES, MAX_ARCHIVE_AGE_DAYS };
