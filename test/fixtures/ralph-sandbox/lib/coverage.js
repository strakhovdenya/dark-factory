'use strict';

// Checks of the two maps of preserved reference scenarios (the sandbox map cases.json and the
// controller map ralph-controller/integration-cases.json) against the verbatim source snapshots
// and the executable Docker integration file. Pure: the caller reads the files. Used by the
// ordinary guards (ralph/sandbox-cases.test.js, ralph/controller-cases.test.js, no Docker) and by
// the integration file itself. A map row records where a scenario is executable; it never records
// a run result, which only the CI job proves.

const INTEGRATION_FILE = 'test/integration/ralph-sandbox.test.js';
const MAPPED = 'integration-mapped';
const DESTINATIONS = ['portable', 'integration', 'both'];

// The Docker scenarios of the reference controller suites assigned to the integration task.
const CONTROLLER_SCENARIOS = [
  ['agent.test.js.txt', 'sandboxed agent receives only explicit credentials'],
  ['agent.test.js.txt', 'timed out sandboxed agent stops its container'],
  ['agent.test.js.txt', 'finished sandboxed agent leaves no container'],
  ['agent.test.js.txt', 'controller exit stops active agent containers'],
  ['agent.test.js.txt', 'sandboxed agent cannot write .git (no fsmonitor or hooks for host git)'],
  ['workspace.test.js.txt', 'runProjectGate runs inside sandbox without network'],
  ['workspace.test.js.txt', 'dependency install runs inside sandbox'],
  ['workspace.test.js.txt', 'a failed sandbox install keeps its full output in a log named in the error'],
  ['workspace.test.js.txt', 'a gate check cannot plant anything in .git'],
  ['run.test.js.txt', 'startup removes leftover ralph containers'],
  ['run.test.js.txt', 'startup leaves unlabelled containers running'],
];

const sourceTestNames = (text) => [...String(text).matchAll(/^test\('([^']+)'/gm)].map((match) => match[1]);

// Names of the integration tests: `scenario('<name>'` and `test('<name>'` at the start of a line.
const integrationTestNames = (text) => [...String(text).matchAll(/^(?:scenario|test)\('([^']+)'/gm)].map((match) => match[1]);

// `test/integration/ralph-sandbox.test.js "a"; "b"` -> ['a', 'b']; null when the reference is malformed.
function referencedTests(reference) {
  if (typeof reference !== 'string' || !reference.startsWith(`${INTEGRATION_FILE} `)) return null;
  const names = [...reference.slice(INTEGRATION_FILE.length).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return names.length > 0 ? names : null;
}

const hasAssertions = (entry) => Array.isArray(entry.assertions) && entry.assertions.length > 0 && entry.assertions.every((item) => typeof item === 'string' && item !== '');

// Problems of one row's integration reference and status.
function integrationProblems(entry, testNames) {
  const problems = [];
  const names = referencedTests(entry.integration);
  if (names === null) problems.push(`no executable integration test named (expected ${INTEGRATION_FILE} "<test name>")`);
  for (const name of names || []) {
    if (!testNames.includes(name)) problems.push(`integration test "${name}" does not exist in ${INTEGRATION_FILE}`);
  }
  if (typeof entry.status !== 'string' || !entry.status.includes(MAPPED)) problems.push(`status must say "${MAPPED}"`);
  if (/\bpass(ed)?\b|\bsucce/i.test(String(entry.status))) problems.push('status claims a run result; a map records coverage, the CI run proves the result');
  return problems;
}

/**
 * @param {{ cases: any[] }} map cases.json
 * @param {{ sourceNames: string[], testNames: string[] }} input
 * @returns {{ scenario: string, reason: string }[]}
 */
function checkSandboxMap(map, { sourceNames, testNames }) {
  const problems = [];
  const add = (scenario, reason) => problems.push({ scenario, reason });
  const rows = Array.isArray(map?.cases) ? map.cases : [];
  for (const name of sourceNames) {
    const count = rows.filter((entry) => entry.source === name).length;
    if (count === 0) add(name, 'row missing from the map');
    if (count > 1) add(name, 'row listed more than once');
  }
  for (const entry of rows) {
    const name = String(entry.source);
    if (!sourceNames.includes(entry.source)) add(name, 'not a test of the source snapshot');
    if (!hasAssertions(entry)) add(name, 'empty list of assertions');
    if (!DESTINATIONS.includes(entry.destination)) add(name, `unknown destination ${JSON.stringify(entry.destination)}`);
    if (entry.destination === 'portable') {
      if (entry.integration !== undefined) add(name, 'a portable row names no integration test');
      continue;
    }
    for (const reason of integrationProblems(entry, testNames)) add(name, reason);
  }
  return problems;
}

/**
 * @param {{ cases: any[] }} map integration-cases.json
 * @param {{ sources: Record<string, string>, testNames: string[] }} input sources: snapshot file name -> text
 * @returns {{ scenario: string, reason: string }[]}
 */
function checkControllerMap(map, { sources, testNames }) {
  const problems = [];
  const add = (scenario, reason) => problems.push({ scenario, reason });
  const rows = Array.isArray(map?.cases) ? map.cases : [];
  for (const [source, name] of CONTROLLER_SCENARIOS) {
    const count = rows.filter((entry) => entry.source === source && entry.test === name).length;
    if (count === 0) add(name, `row missing from the map (${source})`);
    if (count > 1) add(name, 'row listed more than once');
  }
  for (const entry of rows) {
    const name = String(entry.test);
    const isExpected = CONTROLLER_SCENARIOS.some(([source, test]) => source === entry.source && test === entry.test);
    if (!isExpected) add(name, 'not a Docker scenario assigned to the integration task');
    if (!sourceTestNames(sources[entry.source] || '').includes(entry.test)) add(name, `no test of this name in the snapshot ${entry.source}`);
    if (!hasAssertions(entry)) add(name, 'empty list of assertions');
    for (const reason of integrationProblems(entry, testNames)) add(name, reason);
  }
  return problems;
}

module.exports = {
  INTEGRATION_FILE,
  MAPPED,
  CONTROLLER_SCENARIOS,
  sourceTestNames,
  integrationTestNames,
  referencedTests,
  checkSandboxMap,
  checkControllerMap,
};
