'use strict';

// The factory as a project of itself, for the tests of its own connection: the REAL files of this
// repository (profile, settings, package.json, lock, .gitignore, trusted configs, wrappers and its
// own tracked tools) copied into a temporary git repository, next to the REAL installed release
// (node_modules/dark-factory of this checkout, the pinned git tag) with its runtime dependencies.
// The copies of skills and agents are laid out by the setup of that installed release. Nothing of
// the working sources of the package is used, and no file is changed to make a test pass.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, runtimeDependencyPaths } = require('./factory-package');
const { tempDir, isolateGit, gitIn } = require('./ralph');

const INSTALLED = path.join(REPO_ROOT, 'node_modules', 'dark-factory');
const PROJECT_FILES = ['.factory/profile.json', 'package.json', 'package-lock.json', '.gitignore', '.claude/settings.json'];

// The files of the working tree that Git would commit (tracked, or new and not ignored).
const trackedFiles = (...prefixes) =>
  String(childProcess.execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...prefixes], { cwd: REPO_ROOT, encoding: 'utf8' }))
    .split(String.fromCharCode(0))
    .filter((file) => file !== '' && fs.existsSync(path.join(REPO_ROOT, file)));

const copyFile = (from, to, relative) => {
  fs.mkdirSync(path.dirname(path.join(to, relative)), { recursive: true });
  fs.copyFileSync(path.join(from, relative), path.join(to, relative));
};

/**
 * @param {import('node:test').TestContext} t
 * @returns {{ root: string, installed: string, files: string[] }} `files` are the project files copied from the repository
 */
const makeFactoryProject = (t) => {
  if (!fs.existsSync(path.join(INSTALLED, 'package.json'))) {
    throw new Error('node_modules/dark-factory is not installed; run npm ci first (the factory runs on its own release)');
  }
  isolateGit(t);
  const root = path.join(tempDir(t, 'factory-project-'), 'dark-factory');
  fs.mkdirSync(root);
  gitIn(root, 'init', '-q', '-b', 'main');

  const files = [
    ...PROJECT_FILES,
    ...trackedFiles('.github/verifier', '.github/workflows/verifier-wrapper.yml', '.github/workflows/spec-approval-wrapper.yml'),
    ...trackedFiles('.claude/skills', '.claude/agents'),
  ];
  for (const relative of files) copyFile(REPO_ROOT, root, relative);

  const modules = path.join(root, 'node_modules');
  fs.cpSync(INSTALLED, path.join(modules, 'dark-factory'), { recursive: true });
  for (const dependency of runtimeDependencyPaths()) {
    const source = path.join(REPO_ROOT, dependency);
    if (!fs.existsSync(source)) throw new Error(`runtime dependency ${dependency} is not installed; run npm ci first`);
    fs.cpSync(source, path.join(modules, dependency.slice('node_modules/'.length)), { recursive: true });
  }

  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-qm', 'the factory');
  const setup = childProcess.spawnSync(process.execPath, [path.join(modules, 'dark-factory', 'bin', 'setup.js'), '--consumer-root', root], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, INIT_CWD: '', NODE_PATH: '' },
  });
  if (setup.status !== 0) throw new Error(`the setup of the installed release failed: ${setup.stderr}`);
  return { root, installed: path.join(modules, 'dark-factory'), files };
};

module.exports = { makeFactoryProject, INSTALLED };
