'use strict';

// The project command of the integration profiles (install, dependency sync, gate) inside the
// stub image: `node /opt/ralph-fixture/bin/step.js <step> [options]`. It always prints where it
// runs as evidence, then does what the options say, in this order:
//   --wait-registry <host>       retry CONNECT through the run's proxy until the tunnel opens
//   --install-factory            copy the prepared factory and its runtime dependencies into ./node_modules
//   --omit-setup                 ...without the package's bin/setup.js
//   --omit-dependency <name>     ...without that runtime dependency
//   --lock                       write fixture-deps.lock from the dependencies of ./package.json
//   --net-probe <json>           probe the network (probes.js probeNetwork plan) and print the result
//   --git-probe                  try to write a hook into /workspace/.git and a file in the working tree
//   --plant-hook                 write a hook into /workspace/.git; a failure is the exit code
//   --require-loopback           fail unless the only interface is lo
//   --fail-if-exists <file>      fail when the file exists in the cwd
//   --fail                       fail
// No shell and no network access other than the given probes.

const fs = require('node:fs');
const path = require('node:path');
const { whereAmI, printEvidence, viaProxy, probeNetwork, interfaces } = require('../lib/probes');

const FACTORY_MODULES = path.join(__dirname, '..', 'factory', 'node_modules');
const WAIT_REGISTRY_MS = 45000;

function parseArgs(argv) {
  const options = { step: argv[0], omitDependencies: [] };
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index];
    const takesValue = ['--wait-registry', '--omit-dependency', '--net-probe', '--fail-if-exists'].includes(name);
    const value = takesValue ? argv[++index] : true;
    if (name === '--omit-dependency') options.omitDependencies.push(value);
    else options[name.replace(/^--/, '')] = value;
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitRegistry(host) {
  const deadline = Date.now() + WAIT_REGISTRY_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await viaProxy(host);
    if (last.status === 200) return last;
    await sleep(500);
  }
  throw new Error(`the registry ${host} is not reachable through the proxy: ${JSON.stringify(last)}`);
}

function installFactory(options) {
  const target = path.join(process.cwd(), 'node_modules');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(FACTORY_MODULES)) {
    if (options.omitDependencies.includes(name)) continue;
    fs.cpSync(path.join(FACTORY_MODULES, name), path.join(target, name), { recursive: true });
  }
  if (options['omit-setup']) fs.rmSync(path.join(target, 'dark-factory', 'bin', 'setup.js'));
}

function writeLock() {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  fs.writeFileSync('fixture-deps.lock', `${JSON.stringify(manifest.dependencies || {}, null, 2)}\n`);
}

const attempt = (fn) => {
  try {
    fn();
    return 'written';
  } catch (error) {
    return error.code || error.message;
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  printEvidence(whereAmI(options.step));
  if (options['wait-registry']) printEvidence({ step: options.step, registry: await waitRegistry(options['wait-registry']) });
  if (options['install-factory']) installFactory(options);
  if (options.lock) writeLock();
  if (options['net-probe']) printEvidence({ step: options.step, network: await probeNetwork(JSON.parse(options['net-probe'])) });
  if (options['git-probe']) {
    const hook = attempt(() => fs.writeFileSync('/workspace/.git/hooks/pre-commit', '#!/bin/sh\necho planted\n'));
    const tree = attempt(() => fs.writeFileSync('/workspace/gate-tree-probe.txt', 'written by the gate\n'));
    printEvidence({ step: options.step, git: { hook, tree } });
  }
  if (options['plant-hook']) fs.writeFileSync('/workspace/.git/hooks/pre-commit', '#!/bin/sh\necho planted\n');
  if (options['require-loopback'] && interfaces().join(',') !== 'lo') throw new Error(`not isolated: interfaces ${interfaces().join(',')}`);
  if (options['fail-if-exists'] && fs.existsSync(options['fail-if-exists'])) throw new Error(`${options['fail-if-exists']} exists`);
  if (options.fail) throw new Error(`${options.step} fails on purpose`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 3;
});
