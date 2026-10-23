#!/usr/bin/env node
'use strict';

// Public command: `factory doctor [<project-path>]`. Checks that the factory is connected to the
// selected project: its working tree, and the labels, secret and variables of the project's
// GitHub. It only reads: it fixes nothing, installs nothing, fetches nothing and starts no CI,
// Docker, Ralph or model. Exit code 0 only when no problem is found.
//
// The checks are loaded when the command runs, so a package delivered without its doctor/
// directory ends with a clear message instead of a bare stack trace.

const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: factory doctor [<project-path>]';

const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  if (command !== 'doctor' || rest.length > 1 || rest.some((arg) => arg.startsWith('-'))) return null;
  return { projectPath: rest[0] };
};

const formatReport = ({ root, branch, problems }) => {
  const lines = [`factory doctor: ${root}`, `branch: ${branch === null ? 'detached HEAD' : branch}`];
  if (problems.length === 0) {
    lines.push('No problems found.');
  } else {
    lines.push(`${problems.length} problem${problems.length === 1 ? '' : 's'} found:`);
    for (const { subject, reason } of problems) lines.push(`- ${subject}: ${reason}`);
  }
  return lines.join('\n');
};

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, out?: (text: string) => void, err?: (text: string) => void }} [io]
 */
const main = (argv = process.argv.slice(2), { cwd = process.cwd(), out = console.log, err = console.error } = {}) => {
  const args = parseArgs(argv);
  if (args === null) {
    err(USAGE);
    return 2;
  }
  let modules;
  try {
    modules = {
      ...require('../doctor/root'),
      ...require('../doctor/context'),
      ...require('../doctor/checks'),
    };
  } catch (error) {
    err(`factory doctor: the package is incomplete, a doctor module cannot be loaded: ${error.message}`);
    return 1;
  }
  const { resolveRoot, currentBranch, LocationError, createContext, createDoctorRegistry } = modules;
  try {
    const root = resolveRoot({ projectPath: args.projectPath, cwd });
    const branch = currentBranch(root);
    const problems = createDoctorRegistry().run(createContext({ root, packageRoot: PACKAGE_ROOT }));
    out(formatReport({ root, branch, problems }));
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    const isLocation = error instanceof LocationError;
    err(`factory doctor: ${isLocation ? '' : 'unexpected failure, nothing was verified: '}${error.message}`);
    return 2;
  }
};

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, formatReport };
