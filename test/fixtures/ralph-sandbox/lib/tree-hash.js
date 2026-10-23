'use strict';

// One hash of a directory tree: every regular file's relative path ("/" separators, sorted) and
// content. Shared by the integration test on the host and the stub inside the container, so the
// installed package copy can be compared on both sides with the same rule.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function listFiles(root, relative = '') {
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) return listFiles(root, child);
    return entry.isFile() ? [child] : [];
  });
}

/** sha256 of the tree, or null when `root` does not exist. */
function treeHash(root) {
  if (!fs.existsSync(root)) return null;
  const hash = crypto.createHash('sha256');
  for (const file of listFiles(root).sort()) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

module.exports = { treeHash, listFiles };
