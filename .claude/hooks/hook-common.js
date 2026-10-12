'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// path.relative is case-insensitive on Windows (d:\ vs D:\) and reports a different
// drive as an absolute result, so it replaces a startsWith compare.
const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
};

/** Returns the absolute path of an edited .js file inside the repository, or null. */
const editedJsFile = (raw, repoRoot) => {
  let filePath;
  try {
    filePath = JSON.parse(raw)?.tool_input?.file_path;
  } catch {
    return null;
  }
  if (typeof filePath !== 'string' || !/\.js$/.test(filePath)) return null;
  const absolute = path.resolve(repoRoot, filePath);
  if (!isInside(repoRoot, absolute)) return null;
  if (isInside(path.join(repoRoot, 'node_modules'), absolute)) return null;
  return absolute;
};

const defaultSpawn = (bin, args, options) =>
  spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', ...options });

/** Reads stdin to the end, runs the handler and always exits with 0 (the hooks never block). */
const runAsHook = (handler) => {
  let raw = '';
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    try {
      handler(raw);
    } catch {
      // best-effort: never block the tool call on a hook failure
    }
    process.exit(0);
  });
};

module.exports = { isInside, editedJsFile, defaultSpawn, runAsHook };
