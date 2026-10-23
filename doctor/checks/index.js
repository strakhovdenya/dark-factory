'use strict';

const { createRegistry } = require('../registry');

// Registration order is the order of the report.
const CHECKS = [
  require('./profile'),
  require('./trusted-configs'),
  require('./github'),
  require('./models'),
  require('./wrappers'),
  require('./hooks'),
  require('./package'),
  require('./setup'),
];

const createDoctorRegistry = () => {
  const registry = createRegistry();
  for (const check of CHECKS) registry.register(check);
  return registry;
};

module.exports = { createDoctorRegistry };
