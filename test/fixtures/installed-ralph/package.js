'use strict';

// The installed delivery of the packed factory, offline: reading the `npm pack` tarball, laying it
// out as `node_modules/dark-factory` and placing the prepared runtime dependencies next to it.
// Node built-ins only: the controller process of a consumer loads this file as part of its test
// boundary, and nothing here may reach the checkout or a registry.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BLOCK = 512;
const PACKAGE_PREFIX = 'package/';

// Parsed entries by tarball path: one delivery is unpacked many times in a test run.
const parsed = new Map();

const textField = (header, start, length) => {
  const raw = header.subarray(start, start + length).toString('utf8');
  const end = raw.indexOf('\0');
  return end === -1 ? raw : raw.slice(0, end);
};

/**
 * Entries of a gzipped tar as `{ name, type, body }`, with ustar prefixes, pax `path` records and
 * GNU long names applied. Names keep the `package/` prefix npm gives them.
 * @param {string} tarball
 * @returns {{ name: string, type: string, body: Buffer }[]}
 */
const readTarball = (tarball) => {
  if (!parsed.has(tarball)) parsed.set(tarball, parseTarball(tarball));
  return parsed.get(tarball);
};

const parseTarball = (tarball) => {
  const data = zlib.gunzipSync(fs.readFileSync(tarball));
  const entries = [];
  let longName = null;
  for (let offset = 0; offset + BLOCK <= data.length; ) {
    const header = data.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(textField(header, 124, 12).trim() || '0', 8);
    const type = textField(header, 156, 1) || '0';
    const body = data.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (match) longName = match[1];
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = textField(body, 0, body.length);
      continue;
    }
    const prefix = textField(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${textField(header, 0, 100)}` : textField(header, 0, 100));
    longName = null;
    entries.push({ name, type, body });
  }
  return entries;
};

/** Files of the tarball relative to the package root (`package/` removed), sorted. */
const tarballFiles = (tarball) =>
  readTarball(tarball)
    .filter((entry) => entry.type === '0')
    .map((entry) => entry.name.slice(PACKAGE_PREFIX.length))
    .sort();

/** The package.json inside the tarball. */
const packedManifest = (tarball) => {
  const entry = readTarball(tarball).find((item) => item.name === `${PACKAGE_PREFIX}package.json`);
  if (!entry) throw new Error(`${tarball} has no package.json`);
  return JSON.parse(entry.body.toString('utf8'));
};

/**
 * Unpacks the tarball into `target` (the package root). `exclude` names package-relative files
 * that are left out, for a deliberately incomplete delivery.
 */
const extractTarball = (tarball, target, { exclude = [] } = {}) => {
  for (const entry of readTarball(tarball)) {
    if (!entry.name.startsWith(PACKAGE_PREFIX)) throw new Error(`tarball entry outside package/: ${entry.name}`);
    const relative = entry.name.slice(PACKAGE_PREFIX.length).replace(/\/+$/, '');
    if (relative === '' || exclude.includes(relative)) continue;
    if (relative.split('/').includes('..')) throw new Error(`tarball entry leaves the package: ${entry.name}`);
    const full = path.join(target, ...relative.split('/'));
    if (entry.type === '5') {
      fs.mkdirSync(full, { recursive: true });
    } else if (entry.type === '0') {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entry.body);
    } else {
      throw new Error(`unsupported tarball entry type "${entry.type}": ${entry.name}`);
    }
  }
};

/** Top-level package names of a node_modules directory, scoped ones as `@scope/name`. */
const packageNamesIn = (nodeModules) =>
  fs.readdirSync(nodeModules).flatMap((name) => {
    if (name.startsWith('.')) return [];
    if (!name.startsWith('@')) return [name];
    return fs.readdirSync(path.join(nodeModules, name)).map((child) => `${name}/${child}`);
  });

/**
 * What an `npm install --ignore-scripts` of the tarball leaves in `nodeModules`: the package at
 * `dark-factory` and the prepared runtime dependencies (`<runtimeDir>/node_modules`) next to it.
 * `omit` leaves out dependencies by name; `exclude` leaves out package files.
 * @param {string} nodeModules
 * @param {{ tarball: string, runtimeDir: string, omit?: string[], exclude?: string[] }} source
 */
const installPackage = (nodeModules, { tarball, runtimeDir, omit = [], exclude = [] }) => {
  extractTarball(tarball, path.join(nodeModules, 'dark-factory'), { exclude });
  const prepared = path.join(runtimeDir, 'node_modules');
  for (const name of packageNamesIn(prepared)) {
    if (omit.includes(name)) continue;
    fs.cpSync(path.join(prepared, name), path.join(nodeModules, name), { recursive: true });
  }
};

// The lock key a dependency `name` of the package at `from` resolves to: nested first, then each
// enclosing node_modules, as Node and npm resolve it.
const resolveLockKey = (packages, from, name) => {
  for (let base = from; ; ) {
    const key = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (Object.hasOwn(packages, key)) return key;
    if (base === '') return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
};

/**
 * Lock keys (`node_modules/...`) of the full runtime closure of `dependencies`: every package they
 * need transitively through `dependencies` and `optionalDependencies`, never devDependencies. A
 * required package absent from the lock is an error; an absent optional one is skipped.
 * @param {{ packages: Record<string, any> }} lock
 * @param {Record<string, string>} dependencies
 */
const runtimeClosure = (lock, dependencies) => {
  const keys = new Set();
  const visit = (from, deps, isOptional) => {
    for (const name of Object.keys(deps || {})) {
      const key = resolveLockKey(lock.packages, from, name);
      if (key === null) {
        if (isOptional) continue;
        throw new Error(`the lock file has no package for dependency "${name}" of "${from || 'the root'}"`);
      }
      if (keys.has(key)) continue;
      keys.add(key);
      const entry = lock.packages[key];
      visit(key, entry.dependencies, false);
      visit(key, entry.optionalDependencies, true);
    }
  };
  visit('', dependencies, false);
  return [...keys].sort();
};

module.exports = { readTarball, tarballFiles, packedManifest, extractTarball, installPackage, runtimeClosure };
