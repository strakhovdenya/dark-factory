'use strict';

// The only GitHub reads of doctor, all against the selected project (`cwd` is its root, so `gh`
// resolves the repository from that working tree even when doctor is started elsewhere). A failed
// call is reported as unavailable, never as a missing setting. The secret is read by name only.

const childProcess = require('node:child_process');

const GH_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const QUERIES = Object.freeze({
  labels: { args: ['label', 'list', '--limit', '1000', '--json', 'name'], fields: ['name'] },
  secrets: { args: ['secret', 'list', '--json', 'name'], fields: ['name'] },
  variables: { args: ['variable', 'list', '--json', 'name,value'], fields: ['name', 'value'] },
});

const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0] || 'no message';

/**
 * @param {string} root
 * @param {{ args: string[], fields: string[] }} query
 * @returns {{ ok: true, items: any[] } | { ok: false, subject: string, reason: string }}
 */
const run = (root, { args, fields }) => {
  const label = `gh ${args.slice(0, 2).join(' ')}`;
  const result = childProcess.spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES });
  if (result.error) return { ok: false, subject: label, reason: `${label} did not run: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, subject: label, reason: `${label} exited with ${result.status}: ${firstLine(result.stderr)}` };
  let items;
  try {
    items = JSON.parse(result.stdout);
  } catch {
    return { ok: false, subject: label, reason: `${label} printed output that is not JSON` };
  }
  const isValid = Array.isArray(items) && items.every((item) => item !== null && typeof item === 'object' && fields.every((field) => typeof item[field] === 'string'));
  if (!isValid) return { ok: false, subject: label, reason: `${label} printed JSON that is not a list with ${fields.join(', ')}` };
  return { ok: true, items };
};

/** Memoized reads, so one doctor run asks GitHub once per kind. */
const createGithub = (root) => {
  const cache = new Map();
  const read = (kind) => {
    if (!cache.has(kind)) cache.set(kind, run(root, QUERIES[kind]));
    return cache.get(kind);
  };
  return { labels: () => read('labels'), secrets: () => read('secrets'), variables: () => read('variables') };
};

module.exports = { createGithub, QUERIES };
