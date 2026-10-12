'use strict';

// Registry of deterministic verifier checks. A check is a module with one
// interface: run(context) returns the list of FAIL reasons it finds, each
// with a code the check declared at registration. The verdict calls checks
// only through a registry; the project profile picks which of them run.
//
// A check object:
//   name           unique name, used in the profile (verifier.checks)
//   stage          'spec': judged before the model report (scope, approval);
//                  'report': judged next to the model report, also when there
//                  is none (then context.report is null)
//   codes          reason codes the check may emit (strings)
//   run(context)   -> reasons
//   prepareReport  optional (report, context) -> report, applied to a parsed
//                  model report before it is judged
//   note           optional (context) -> string | null, shown in the comment

const STAGES = new Set(['spec', 'report']);

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

const validateCheck = (check) => {
  if (check === null || typeof check !== 'object') {
    throw new TypeError('check must be an object');
  }
  const { name } = check;
  if (!isNonEmptyString(name)) {
    throw new TypeError('check name must be a non-empty string');
  }
  if (!STAGES.has(check.stage)) {
    throw new TypeError(`check "${name}": stage must be "spec" or "report"`);
  }
  const { codes } = check;
  if (!Array.isArray(codes) || codes.length === 0 || !codes.every(isNonEmptyString)) {
    throw new TypeError(`check "${name}": codes must be a non-empty list of strings`);
  }
  if (typeof check.run !== 'function') {
    throw new TypeError(`check "${name}": run must be a function`);
  }
  for (const hook of ['prepareReport', 'note']) {
    if (check[hook] !== undefined && typeof check[hook] !== 'function') {
      throw new TypeError(`check "${name}": ${hook} must be a function`);
    }
  }
};

// baseCodes are the codes the verdict core itself emits; they never change
// when a check is registered.
const createRegistry = ({ baseCodes = [] } = {}) => {
  const checks = new Map();
  const base = new Set(baseCodes);

  const register = (check) => {
    validateCheck(check);
    if (checks.has(check.name)) {
      throw new Error(`check "${check.name}" is already registered`);
    }
    const entry = Object.freeze({ ...check, codes: Object.freeze([...check.codes]) });
    checks.set(check.name, entry);
    return entry;
  };

  const names = () => [...checks.keys()];

  // The closed list of reason codes: the core's own plus every code a
  // registered check declared.
  const reasonCodes = () => {
    const codes = new Set(base);
    for (const check of checks.values()) {
      for (const code of check.codes) codes.add(code);
    }
    return codes;
  };

  // Splits the names a profile enables into registered checks (in
  // registration order, so the order of reasons does not depend on the
  // order of the profile list) and unknown names.
  const select = (enabled) => {
    const wanted = new Set(enabled);
    const selected = [...checks.values()].filter((check) => wanted.has(check.name));
    const unknown = [...wanted].filter((name) => !checks.has(name));
    return { checks: selected, unknown };
  };

  // Runs one check; a reason with a code the check did not declare is a
  // defect in the check, never a silent extension of the closed list.
  const runCheck = (check, context) => {
    const reasons = check.run(context);
    if (!Array.isArray(reasons)) {
      throw new TypeError(`check "${check.name}" did not return a list of reasons`);
    }
    for (const reason of reasons) {
      if (!check.codes.includes(reason?.code)) {
        throw new Error(
          `check "${check.name}" returned reason code "${reason?.code}" it did not declare`,
        );
      }
    }
    return reasons;
  };

  return { register, names, reasonCodes, select, runCheck };
};

module.exports = { STAGES, createRegistry };
