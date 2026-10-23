'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HOOK_ENTRIES } = require('../../hooks/entries');
const { readFactoryTagFile } = require('../../verifier/factory-version');
const { factoryRepository, fileStat } = require('../files');

const PACKAGE_NAME = 'dark-factory';
const INSTALLED = 'node_modules/dark-factory';

/** The package installed for the selected project, or the reason there is none usable. */
const installedPackage = (root) => {
  const dir = path.join(root, ...INSTALLED.split('/'));
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(dir)) return { dir, reason: 'not installed in the selected project' };
  let name;
  try {
    name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
  } catch (error) {
    return { dir, reason: `${INSTALLED}/package.json is not readable: ${error.message}` };
  }
  if (name !== PACKAGE_NAME) return { dir, reason: `${INSTALLED}/package.json names "${name}", not "${PACKAGE_NAME}"` };
  return { dir, reason: null };
};

// The package of the selected project (never the running copy of doctor), the hook scripts the
// settings entries run, and the project's pin of the release tag.
module.exports = {
  name: 'package',
  PACKAGE_NAME,
  INSTALLED,
  installedPackage,
  run(context) {
    const problems = [];
    const installed = installedPackage(context.root);
    if (installed.reason !== null) {
      problems.push({ subject: INSTALLED, reason: installed.reason });
    } else {
      for (const script of new Set(HOOK_ENTRIES.map((entry) => entry.script))) {
        const file = path.join(installed.dir, 'hooks', script);
        if (fileStat(file) === null) problems.push({ subject: `${INSTALLED}/hooks/${script}`, reason: 'the hook script is missing from the installed package' });
      }
    }

    try {
      readFactoryTagFile(path.join(context.root, 'package.json'), { repository: factoryRepository(context.packageRoot) });
    } catch (error) {
      problems.push({ subject: 'package.json', reason: error.message });
    }
    return problems;
  },
};
