'use strict';

// Registry of doctor checks. A check is a module with one interface: run(context) returns the
// list of problems it found, or throws Unavailable when its inputs cannot be read (which is
// neither "all good" nor a proven missing setting). Checks only read; the registry runs every
// registered check, so one failure never hides another.
//
// A check object:
//   name         unique name
//   run(context) -> { subject: string, reason: string }[]

/** Thrown by a check whose inputs are unavailable; the report says so instead of passing. */
class Unavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'Unavailable';
  }
}

const validateCheck = (check) => {
  if (!check || typeof check.name !== 'string' || check.name === '') {
    throw new TypeError('a doctor check needs a non-empty name');
  }
  if (typeof check.run !== 'function') throw new TypeError(`check "${check.name}": run must be a function`);
};

const createRegistry = () => {
  const checks = new Map();

  const register = (check) => {
    validateCheck(check);
    if (checks.has(check.name)) throw new Error(`check "${check.name}" is already registered`);
    checks.set(check.name, check);
    return check;
  };

  const names = () => [...checks.keys()];

  // Every check runs. An unavailable check and an unexpected failure are problems of their own:
  // fail closed, never an implicit pass.
  const run = (context) => {
    const problems = [];
    for (const check of checks.values()) {
      try {
        const found = check.run(context);
        if (!Array.isArray(found)) throw new TypeError(`check "${check.name}" did not return a list of problems`);
        for (const problem of found) problems.push({ check: check.name, ...problem });
      } catch (error) {
        const reason = error instanceof Unavailable ? `check unavailable: ${error.message}` : `check failed unexpectedly: ${error.message}`;
        problems.push({ check: check.name, subject: check.name, reason });
      }
    }
    return problems;
  };

  return { register, names, run };
};

module.exports = { Unavailable, createRegistry };
