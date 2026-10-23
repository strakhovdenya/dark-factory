'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { VERIFIER_WORKFLOW_PATH } = require('../../verifier/round-protocol');
const { factoryRepository } = require('../files');
const { profileUnusable } = require('../context');

const WORKFLOWS_DIR = '.github/workflows';
const FULL_SHA = /^[0-9a-f]{40}$/;
const USES = /^([^/@\s]+\/[^/@\s]+)\/\.github\/workflows\/([^@\s/]+)@(\S+)$/;
const VERIFIER = 'acceptance-verifier.yml';
const JUDGE = 'calibration-judge.yml';
const SPEC_APPROVAL = 'spec-approval.yml';

// --- reading a workflow as text (no YAML dependency) ---

const withoutComment = (value) => value.replace(/(^|\s)#.*$/, '').trim();
const unquote = (value) => {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match === null ? value : match[2];
};
const isIgnorable = (line) => line.trim() === '' || line.trim().startsWith('#');
const indentOf = (line) => /^ */.exec(line)[0].length;

const keyOf = (line, indent) => {
  if (indentOf(line) !== indent) return null;
  const match = /^ *([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
  return match === null ? null : { key: match[1], value: unquote(withoutComment(match[2] ?? '')) };
};

// The jobs of a workflow: `uses` and `with.factory-sha` of each. Only keys at their own level
// count, so a commented line or text deeper in a block scalar proves nothing. Null when the
// structure is not a workflow (no `jobs:`, tabs, no job).
const readJobs = (text) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    block.push(line);
  }
  if (block.some((line) => /^ *\t/.test(line))) return null;
  const body = block.filter((line) => !isIgnorable(line));
  if (body.length === 0) return null;
  const jobIndent = indentOf(body[0]);
  const jobs = [];
  for (const [index, line] of body.entries()) {
    const header = /^ *([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (indentOf(line) !== jobIndent || header === null) continue;
    const members = [];
    for (const next of body.slice(index + 1)) {
      if (indentOf(next) <= jobIndent) break;
      members.push(next);
    }
    if (members.length === 0) continue;
    const memberIndent = indentOf(members[0]);
    const job = { id: header[1], uses: null, factorySha: null };
    for (const [position, member] of members.entries()) {
      const entry = keyOf(member, memberIndent);
      if (entry === null) continue;
      if (entry.key === 'uses') job.uses = entry.value;
      if (entry.key === 'with') {
        const nested = [];
        for (const child of members.slice(position + 1)) {
          if (indentOf(child) <= memberIndent) break;
          nested.push(child);
        }
        const withIndent = nested.length > 0 ? indentOf(nested[0]) : 0;
        for (const child of nested) {
          const option = keyOf(child, withIndent);
          if (option !== null && option.key === 'factory-sha') job.factorySha = option.value;
        }
      }
    }
    jobs.push(job);
  }
  return jobs.length > 0 ? jobs : null;
};

/**
 * Judges a workflow file as the wrapper of a reusable factory workflow.
 * @returns {{ sha: string | null, found: boolean, reasons: string[] }} sha is set when a job is a valid call;
 * found tells that some job calls the workflow at all
 */
const analyzeWrapper = (text, { repository, workflow }) => {
  const jobs = readJobs(text);
  if (jobs === null) return { sha: null, found: false, reasons: ['not a workflow with a "jobs:" block of jobs'] };
  const reasons = [];
  const target = `${repository}/.github/workflows/${workflow}`;
  let found = false;
  for (const job of jobs) {
    const call = job.uses === null ? null : USES.exec(job.uses);
    if (call === null) continue;
    const [, calledRepository, calledWorkflow, ref] = call;
    if (calledWorkflow !== workflow) continue;
    found = true;
    const label = `job "${job.id}"`;
    const problems = [];
    if (calledRepository.toLowerCase() !== repository.toLowerCase()) problems.push(`calls ${calledRepository}, not ${repository}`);
    if (!FULL_SHA.test(ref)) problems.push(`"@${ref}" is not a full 40-character lowercase hex commit SHA`);
    if (job.factorySha === null) problems.push('has no with.factory-sha');
    else if (job.factorySha !== ref) problems.push(`uses ${ref} but with.factory-sha is ${job.factorySha}`);
    if (problems.length === 0) return { sha: ref, found, reasons: [] };
    reasons.push(`${label}: ${problems.join('; ')}`);
  }
  if (!found) reasons.push(`no job calls ${target}@<full commit SHA>`);
  return { sha: null, found, reasons };
};

const listWorkflows = (root) => {
  const dir = path.join(root, ...WORKFLOWS_DIR.split('/'));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ relative: `${WORKFLOWS_DIR}/${name}`, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
};

// A wrapper is required per role; the first valid file in the workflows directory (or exactly the
// given path) is it. Every wrapper pins the same SHA.
const checkRole = ({ files, repository, workflow, label, onlyPath = null, defaultPath = null }) => {
  const candidates = onlyPath === null ? files : files.filter((file) => file.relative === onlyPath);
  const results = candidates.map((file) => ({ file, ...analyzeWrapper(file.text, { repository, workflow }) }));
  const valid = results.find((result) => result.sha !== null);
  if (valid !== undefined) return { sha: valid.sha, valid, problems: [] };
  const mentions = results.filter((result) => result.found || result.file.relative === (onlyPath ?? defaultPath));
  if (mentions.length === 0) {
    const where = onlyPath ?? `${WORKFLOWS_DIR}/`;
    return { sha: null, valid: null, problems: [{ subject: where, reason: `no valid ${label} wrapper: expected a job that calls ${repository}/.github/workflows/${workflow}@<full commit SHA> with the same SHA in with.factory-sha` }] };
  }
  return { sha: null, valid: null, problems: mentions.map((result) => ({ subject: result.file.relative, reason: `not a valid ${label} wrapper: ${result.reasons.join(' | ')}` })) };
};

module.exports = {
  name: 'wrappers',
  analyzeWrapper,
  readJobs,
  run(context) {
    const repository = factoryRepository(context.packageRoot);
    const files = listWorkflows(context.root);
    const loaded = context.profile();
    const problems = [];
    const pins = [];

    const judgeOn = loaded.ok && loaded.profile.judge?.enabled === true;
    const specOn = loaded.ok && (loaded.profile.verifier?.checks ?? []).includes('spec-approval');
    if (!loaded.ok) problems.push(profileUnusable('Judge and spec-approval wrappers'));

    const verifier = checkRole({ files, repository, workflow: VERIFIER, label: 'verifier', defaultPath: VERIFIER_WORKFLOW_PATH });
    problems.push(...verifier.problems);
    if (verifier.sha !== null) pins.push({ role: 'verifier', file: verifier.valid.file.relative, sha: verifier.sha });
    if (judgeOn && verifier.valid !== null && verifier.valid.file.relative !== VERIFIER_WORKFLOW_PATH) {
      problems.push({ subject: verifier.valid.file.relative, reason: `Judge is enabled: the verifier wrapper must be at ${VERIFIER_WORKFLOW_PATH}` });
    }
    if (judgeOn && verifier.valid === null && !verifier.problems.some((problem) => problem.subject === VERIFIER_WORKFLOW_PATH)) {
      problems.push(...checkRole({ files, repository, workflow: VERIFIER, label: 'verifier', onlyPath: VERIFIER_WORKFLOW_PATH }).problems);
    }

    if (judgeOn) {
      const judge = checkRole({ files, repository, workflow: JUDGE, label: 'Calibration Judge' });
      problems.push(...judge.problems);
      if (judge.sha !== null) pins.push({ role: 'Calibration Judge', file: judge.valid.file.relative, sha: judge.sha });
    }
    if (specOn) {
      const spec = checkRole({ files, repository, workflow: SPEC_APPROVAL, label: 'spec-approval' });
      problems.push(...spec.problems);
      if (spec.sha !== null) pins.push({ role: 'spec-approval', file: spec.valid.file.relative, sha: spec.sha });
    }

    if (new Set(pins.map((pin) => pin.sha)).size > 1) {
      const list = pins.map((pin) => `${pin.file} (${pin.role}) ${pin.sha}`).join(', ');
      problems.push({ subject: WORKFLOWS_DIR, reason: `the wrappers pin different commits; one release SHA is required: ${list}` });
    }
    return problems;
  },
};
