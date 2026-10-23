'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Unavailable } = require('./registry');

/**
 * Reads a JSON file of the project. `missing` and `invalid` are told apart from a usable file.
 * @returns {{ state: 'missing' } | { state: 'invalid', reason: string } | { state: 'ok', raw: string, value: any }}
 */
const readJsonFile = (root, relative) => {
  const file = path.join(root, ...relative.split('/'));
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', reason: `cannot be read: ${error.message}` };
  }
  try {
    return { state: 'ok', raw, value: JSON.parse(raw) };
  } catch (error) {
    return { state: 'invalid', reason: `is not valid JSON: ${error.message}` };
  }
};

/** A regular file (links followed) or null. */
const fileStat = (file) => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
};

const GITHUB_REPOSITORY = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/;

/**
 * "owner/name" of the factory repository from the metadata of the executing package. Nothing is
 * hard-coded: an executing package without GitHub repository metadata makes the wrapper and
 * pin checks unavailable.
 */
const factoryRepository = (packageRoot) => {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Unavailable(`the executing package.json is not readable: ${error.message}`);
  }
  const repository = manifest.repository;
  const url = typeof repository === 'string' ? repository : repository?.url;
  const match = typeof url === 'string' ? GITHUB_REPOSITORY.exec(url) : null;
  if (match === null) throw new Unavailable('the executing package.json has no GitHub "repository" to compare the factory references with');
  return match[1];
};

module.exports = { readJsonFile, fileStat, factoryRepository };
