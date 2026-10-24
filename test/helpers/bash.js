'use strict';

// Bash as Claude Code runs the hook commands of settings: Bash on Linux, Git Bash on Windows, never
// the WSL bash of System32. There is no skip when it is missing: the hooks are documented for this
// shell only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const findBash = () => {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (git.status === 0) candidates.push(path.resolve(git.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe'));
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, `Git Bash not found (tried: ${candidates.join(', ')}); the hooks need Bash/Git Bash`);
  return found;
};

module.exports = { findBash };
