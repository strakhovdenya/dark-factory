'use strict';

const { createRegistry } = require('./registry');
const { REASON_CODES, CONFIG_REASON_CODES } = require('../verdict/result');

// Registration order is the order of reasons in the verdict.
const CORE_CHECKS = [
  require('./spec-approval'),
  require('./affects-scope'),
  require('./computed-items'),
  require('./test-tampering-scan'),
  require('./references'),
  require('./ci-checks'),
  require('./allowed-model'),
];

const BASE_REASON_CODES = [
  ...Object.values(REASON_CODES),
  ...Object.values(CONFIG_REASON_CODES),
];

// A fresh registry holding the core checks; more checks can be registered on it.
const createCoreRegistry = () => {
  const registry = createRegistry({ baseCodes: BASE_REASON_CODES });
  for (const check of CORE_CHECKS) registry.register(check);
  return registry;
};

const coreRegistry = createCoreRegistry();

module.exports = {
  CORE_CHECK_NAMES: CORE_CHECKS.map((check) => check.name),
  BASE_REASON_CODES,
  createCoreRegistry,
  coreRegistry,
};
