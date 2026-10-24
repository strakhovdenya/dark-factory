'use strict';

// The real `npm pack --dry-run --json` of this repository: what a project receives. The
// development tooling of the factory (.claude/), its own profile (.factory/) and the installed
// release in node_modules/ must never be in it, and the package directories must not be missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { npmCli } = require('../../test/helpers/npm');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_DIRECTORIES = require('../../package.json').files;
const inDirectory = (directory) => (directory.endsWith('/') ? directory : `${directory}/`);

const packedFiles = () => {
  const inherited = Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name));
  const env = { ...Object.fromEntries(inherited), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const result = childProcess.spawnSync(process.execPath, [npmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `npm pack failed: ${result.stderr}`);
  const [report] = JSON.parse(result.stdout);
  return report.files.map((file) => file.path.replaceAll(path.sep, '/'));
};

test('npm pack excludes .claude and .factory', () => {
  // The inputs of the exclusion exist: without them the absence below would prove nothing.
  for (const present of ['.claude/settings.json', '.claude/skills/release/SKILL.md', '.factory/profile.json', 'node_modules/dark-factory/package.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, present)), `${present} is part of the checkout the package is built from`);
  }

  const files = packedFiles();
  assert.ok(files.length > PACKAGE_DIRECTORIES.length, `the list of packed files is real, not empty (${files.length} files)`);
  for (const required of ['package.json', 'bin/setup.js', 'bin/doctor.js', 'skills/base-set.json', 'agents/verify.md', 'hooks/skill-gate.js', 'verifier/verdict.js', 'ralph/run.js', 'profile/schema.json']) {
    assert.ok(files.includes(required), `${required} is packed`);
  }
  for (const directory of PACKAGE_DIRECTORIES) {
    assert.ok(files.some((file) => file.startsWith(inDirectory(directory))), `${directory} has packed files`);
  }

  const leaked = files.filter((file) => /^(\.claude|\.factory|\.github|node_modules|docs|examples|test)\//.test(file));
  assert.deepEqual(leaked, [], 'only package directories are shipped');
  for (const file of files) {
    assert.ok(file === 'package.json' || file === 'README.md' || file === 'LICENSE' || PACKAGE_DIRECTORIES.some((directory) => file.startsWith(inDirectory(directory))), `unexpected packed file ${file}`);
  }
});
