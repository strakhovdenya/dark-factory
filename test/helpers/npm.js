'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The npm-cli.js of the running Node (npm itself, not whatever package manager started the tests). */
const npmCli = () => {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((file) => file && path.basename(file) === 'npm-cli.js' && fs.existsSync(file));
  if (!found) throw new Error('npm-cli.js of the running Node is not found; npm cannot run');
  return found;
};

module.exports = { npmCli };
