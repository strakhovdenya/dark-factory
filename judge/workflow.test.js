'use strict';

// Configuration checks of the Calibration Judge workflow, of the example wrapper and of the
// verifier step that feeds Judge, read from the YAML text (no YAML dependency).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJudgeConfig } = require('./config');
const { VERIFIER_STATUS_CONTEXT, VERIFIER_WORKFLOW_PATH, ROUND_ARTIFACTS } = require('../verifier/round-protocol');
const { FIXTURE_PROFILES, profileCopy, enableJudge } = require('../test/helpers/profiles');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const JUDGE_FILE = path.join(WORKFLOWS, 'calibration-judge.yml');
const VERIFIER_FILE = path.join(WORKFLOWS, 'acceptance-verifier.yml');
const WRAPPER_FILE = path.join(ROOT, 'examples', 'wrappers', 'calibration-judge.yml');
const VERIFIER_WRAPPER_FILE = path.join(ROOT, 'examples', 'wrappers', 'acceptance-verifier.yml');
const CLI = path.join(__dirname, 'calibration-judge.js');
const INPUTS_FILE = path.join(__dirname, 'inputs.json');
const TAXONOMY_FILE = path.join(ROOT, 'test', 'fixtures', 'judge', 'taxonomy.json');

const JUDGE = fs.readFileSync(JUDGE_FILE, 'utf8');
const VERIFIER = fs.readFileSync(VERIFIER_FILE, 'utf8');
const WRAPPER = fs.readFileSync(WRAPPER_FILE, 'utf8');
const VERIFIER_WRAPPER = fs.readFileSync(VERIFIER_WRAPPER_FILE, 'utf8');

const linesOf = (text) => text.split(/\r?\n/);

// Text of a top-level key (`on:`, `concurrency:`), up to the next one.
const topLevelBlock = (text, key) => {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  const body = end === -1 ? rest : rest.slice(0, end);
  return [lines[start], ...body].join('\n');
};

const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const STEP_START = /^ {6}- /;

// Jobs keyed by id; each job has its own text and its steps' texts.
const readJobs = (text) => {
  const lines = linesOf(topLevelBlock(text, 'jobs'));
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(1)) {
    const header = JOB_HEADER.exec(line);
    if (header !== null) {
      current = { id: header[1], lines: [] };
      jobs.set(current.id, current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  for (const job of jobs.values()) {
    job.text = job.lines.join('\n');
    // A step starts at `      - ` and continues while lines are indented
    // deeper (or blank); comment lines between steps belong to no step.
    const steps = [];
    let step = null;
    for (const line of job.lines) {
      if (STEP_START.test(line)) {
        step = [line];
        steps.push(step);
      } else if (step !== null && (/^ {8}/.test(line) || line.trim() === '')) {
        step.push(line);
      } else {
        step = null;
      }
    }
    job.steps = steps.map((lines) => lines.join('\n'));
  }
  return jobs;
};

const jobField = (job, field) => {
  const match = new RegExp(`^ {4}${field}: (.+)$`, 'm').exec(job.text);
  return match === null ? null : match[1].trim();
};

const permissionsOf = (job) => {
  const lines = job.lines;
  const start = lines.findIndex((line) => /^ {4}permissions:/.test(line));
  if (start === -1) return null;
  const inline = lines[start].replace(/^ {4}permissions:/, '').trim();
  if (inline !== '') return { inline };
  const entries = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^ {6}([a-z-]+): (\S+)$/.exec(line);
    if (match === null) break;
    entries[match[1]] = match[2];
  }
  return entries;
};

const stepName = (step) => {
  const match = /^ {6}- name: (.+)$/m.exec(step);
  return match === null ? null : match[1].trim();
};

const stepWith = (step, key) => {
  const match = new RegExp(`^ {10}${key}: (.+)$`, 'm').exec(step);
  return match === null ? null : match[1].trim();
};

const usesOf = (step) => {
  const match = /^ {8}uses: (\S+)/m.exec(step);
  return match === null ? null : match[1];
};

const codexSteps = (jobs) =>
  [...jobs.values()].flatMap((job) =>
    job.steps
      .filter((step) => (usesOf(step) ?? '').startsWith('openai/codex-action@'))
      .map((step) => ({ job, step })),
  );

// Minimal evaluator for the GitHub expression subset the job conditions use:
// property paths, string literals, startsWith(), always(), ==, !=, !, &&, || and
// parentheses. A missing property is an empty string, as in GitHub.
const TOKEN = /\s*(\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)/y;

const tokenize = (source) => {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (match === null) {
      if (source.slice(start).trim() === '') break;
      throw new Error(`cannot tokenize: ${source.slice(start)}`);
    }
    tokens.push(match[1]);
  }
  return tokens;
};

const evaluate = (source, context) => {
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const resolve = (name) =>
    name.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), context) ?? '';

  const primary = () => {
    const token = next();
    if (token === '(') {
      const value = or();
      assert.strictEqual(next(), ')');
      return value;
    }
    if (token === '!') return !primary();
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'always' && peek() === '(') {
      next();
      assert.strictEqual(next(), ')');
      return true;
    }
    if (peek() === '(') {
      next();
      const args = [or()];
      while (peek() === ',') {
        next();
        args.push(or());
      }
      assert.strictEqual(next(), ')');
      assert.strictEqual(token, 'startsWith');
      return String(args[0]).toLowerCase().startsWith(String(args[1]).toLowerCase());
    }
    return resolve(token);
  };
  const comparison = () => {
    let value = primary();
    while (peek() === '==' || peek() === '!=') {
      const operator = next();
      const right = primary();
      value = operator === '==' ? value === right : value !== right;
    }
    return value;
  };
  const and = () => {
    let value = comparison();
    while (peek() === '&&') {
      next();
      const right = comparison();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === '||') {
      next();
      const right = and();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  };
  const result = or();
  assert.strictEqual(index, tokens.length, 'expression fully parsed');
  return Boolean(result);
};


const JOBS = readJobs(JUDGE);
const VERIFIER_JOBS = readJobs(VERIFIER);
const JOB_ORDER = ['config', 'collect', 'stage1', 'stage2', 'assemble', 'publish'];
const ABSORB = "${{ github.event_name != 'workflow_dispatch' }}";

const needsOf = (job) => {
  const value = jobField(job, 'needs');
  if (value === null) return [];
  return value.replace(/[[\]]/g, '').split(',').map((name) => name.trim());
};

const stepNamed = (job, name) => {
  const step = job.steps.find((candidate) => stepName(candidate) === name);
  assert.notStrictEqual(step, undefined, `${job.id} has step ${name}`);
  return step;
};

const stepField = (step, key) => {
  const match = new RegExp(`^ {8}${key}: (.+)$`, 'm').exec(step);
  return match === null ? null : match[1].trim();
};

// Runs the job conditions the way GitHub does: a job runs when its condition holds and, unless
// the condition says always(), only if every job it needs ran and succeeded. `outputs` holds
// the outputs of the jobs that ran.
const schedule = ({ github, outputs }) => {
  const result = {};
  for (const id of JOB_ORDER) {
    const job = JOBS.get(id);
    const condition = jobField(job, 'if') ?? 'true';
    const needs = needsOf(job);
    const needed = Object.fromEntries(
      needs.map((name) => [name, { result: result[name] ?? 'skipped', outputs: result[name] === 'success' ? (outputs[name] ?? {}) : {} }]),
    );
    const blocked = !/always\(\)/.test(condition) && needs.some((name) => result[name] !== 'success');
    const ran = !blocked && evaluate(condition, { github, needs: needed });
    result[id] = ran ? 'success' : 'skipped';
  }
  return result;
};

const COLLECT_READY = { skip: 'false', failed: 'false', pr_number: '7', model_allowed: 'true' };

test('job reader finds every Judge job', () => {
  assert.deepStrictEqual([...JOBS.keys()], JOB_ORDER);
  for (const job of JOBS.values()) assert.ok(job.steps.length > 0, job.id);
});

test('is a reusable workflow that reads project settings from the default branch', () => {
  const on = topLevelBlock(JUDGE, 'on');
  const triggers = linesOf(on)
    .map((line) => /^ {2}([a-z_]+):/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
  assert.deepStrictEqual(triggers, ['workflow_call']);
  assert.match(on, / {6}factory-sha:\n(?: {8}.*\n)*? {8}required: true/);
  assert.match(on, / {6}OPENAI_API_KEY:\n(?: {8}.*\n)*? {8}required: true/);
  for (const name of ['judge-model', 'verifier-model', 'pr', 'run-id', 'run-attempt']) {
    assert.match(on, new RegExp(` {6}${name}:\\n(?: {8}.*\\n)*? {8}required: false`), name);
  }
  assert.match(JUDGE, /\.github\/calibration\/taxonomy\.json/);
  assert.match(JUDGE, /\.github\/calibration\/allowed-models\.json/);
  assert.doesNotMatch(JUDGE, /task\/ISSUE-/);
  assert.doesNotMatch(JUDGE, /JUDGE_BRANCH_PREFIX|^ {2}JUDGE_LABEL:/m);
  assert.match(JUDGE, /^permissions: \{\}$/m);
});

test('skips model and publication for absent or disabled judge in both profiles', (t) => {
  const events = [
    { event_name: 'workflow_run', event: { workflow_run: { conclusion: 'failure' } } },
    { event_name: 'workflow_run', event: { workflow_run: { conclusion: 'success' } } },
    { event_name: 'pull_request_target', event: {} },
    { event_name: 'issues', event: {} },
    { event_name: 'workflow_dispatch', event: {} },
  ];
  const variants = {
    'no judge section': (_profile) => {},
    'judge disabled': (profile) => {
      profile.judge = { enabled: false };
    },
    'judge disabled with a label': (profile) => {
      profile.judge = { enabled: false };
      profile.labels = { ...profile.labels, calibration: 'mark-for-analysis' };
    },
  };
  const modelJobs = [...JOBS.values()]
    .filter((job) => job.steps.some((step) => (usesOf(step) ?? '').startsWith('openai/codex-action@')))
    .map((job) => job.id);
  assert.deepStrictEqual(modelJobs, ['stage1', 'stage2']);

  for (const fixture of FIXTURE_PROFILES) {
    for (const [name, mutate] of Object.entries(variants)) {
      const config = readJudgeConfig({ projectRoot: profileCopy(t, fixture, mutate) });
      assert.strictEqual(config.status, 'disabled', `${fixture} ${name}`);
      const enabled = String(/** @type {string} */ (config.status) === 'enabled');
      for (const github of events) {
        const result = schedule({
          github,
          outputs: {
            config: { enabled },
            collect: COLLECT_READY,
            stage1: { has_result: 'true' },
          },
        });
        assert.strictEqual(result.config, 'success', `${fixture} ${name} ${github.event_name}`);
        for (const id of JOB_ORDER.slice(1)) {
          assert.strictEqual(result[id], 'skipped', `${fixture} ${name} ${github.event_name} ${id}`);
        }
      }
    }

    // The same events run the whole chain once the profile enables Judge.
    const enabledConfig = readJudgeConfig({
      projectRoot: profileCopy(t, fixture, enableJudge('mark-for-analysis')),
    });
    assert.strictEqual(enabledConfig.status, 'enabled');
    for (const github of events) {
      const result = schedule({
        github,
        outputs: {
          config: { enabled: 'true' },
          collect: COLLECT_READY,
          stage1: { has_result: 'true' },
        },
      });
      assert.deepStrictEqual(Object.values(result), Array(JOB_ORDER.length).fill('success'), github.event_name);
    }
  }
});

test('configuration errors end an automatic run without error and fail a manual one', () => {
  const config = JOBS.get('config');
  const step = stepNamed(config, 'Read Judge configuration');
  assert.match(step, /id: config/);
  assert.match(step, /::error::Calibration Judge configuration error/);
  assert.match(step, /\$GITHUB_STEP_SUMMARY/);
  assert.match(step, /if \[ "\$EVENT_NAME" = "workflow_dispatch" \]; then exit 1; fi/);
  assert.match(step, /calibration-judge\.js config --project trusted/);
  assert.match(step, /--wrapper-sha "\$FACTORY_SHA"/);
  assert.strictEqual(jobField(config, 'continue-on-error'), null);
  assert.match(config.text, /enabled: \$\{\{ steps\.config\.outputs\.enabled \}\}/);
  // A manual run on another branch than the default one would read the settings from it.
  assert.match(step, /a manual run must start on the default branch/);
  for (const id of JOB_ORDER.slice(1)) {
    const condition = jobField(JOBS.get(id), 'if');
    assert.ok(/needs\.config\.outputs\.enabled == 'true'|needs\.collect\.result == 'success'|needs\.assemble\.result == 'success'|needs\.collect\.outputs\.skip == 'false'/.test(condition), id);
  }
});

test('every start passes through one trigger decision', () => {
  const identify = stepNamed(JOBS.get('collect'), 'Identify pull request');
  assert.strictEqual(identify.match(/check-trigger/g).length, 1);
  assert.match(identify, /--config meta\/config\.json/);
  assert.match(identify, /--owners trusted\/\.github\/verifier\/owners\.json/);
  assert.match(identify, /workflow_run\) TRIGGER_ARGS\+=\(--event round\)/);
  assert.match(identify, /workflow_dispatch\) TRIGGER_ARGS\+=\(--event manual\)/);
  assert.match(identify, /--event labeled --event-label "\$EVENT_LABEL"/);
  assert.doesNotMatch(identify, /--label /);
  assert.match(identify, /issue-number --branch "\$BRANCH" --project trusted/);
  assert.match(identify, /check-pr --pull meta\/pull\.json\s*\\?\s*--round meta\/round\.json --repository "\$REPO" --project trusted/);
  const target = stepNamed(JOBS.get('collect'), 'Locate pull request of a label event');
  assert.match(target, /find-pr --pulls meta\/pulls\.json/);
  assert.match(target, /JUDGE_LABEL: \$\{\{ needs\.config\.outputs\.label \}\}/);
  const raw = stepNamed(JOBS.get('collect'), 'Build raw inputs');
  assert.match(raw, /issue-number --branch "\$BRANCH" --project trusted/);
  assert.doesNotMatch(JUDGE, /=~ \^task|startswith\(\$prefix\)/);
});

test('labeled path executes only default-branch files', () => {
  const on = topLevelBlock(WRAPPER, 'on');
  assert.match(on, /^ {2}pull_request_target:\n {4}types: \[labeled\]\n {4}branches: \[main\]\n/m);
  assert.doesNotMatch(JUDGE, /github\.event\.pull_request\.head/);
  const collect = JOBS.get('collect');
  const checkouts = collect.steps.filter((step) => (usesOf(step) ?? '').startsWith('actions/checkout@'));
  assert.strictEqual(checkouts.length, 2);
  const [project, factory] = checkouts;
  assert.strictEqual(stepWith(project, 'path'), 'trusted');
  assert.strictEqual(stepWith(project, 'ref'), '${{ github.sha }}');
  assert.match(project, /^ {12}\.factory$/m);
  assert.match(project, /^ {12}\.github\/verifier$/m);
  assert.strictEqual(stepWith(factory, 'path'), 'factory');
  for (const call of collect.text.match(/\bnode \S+/g) ?? []) {
    assert.match(call, /^node factory\//);
  }
});

// A verifier run started by workflow_run names the default branch in its own metadata, so the
// condition must not filter on head_branch: the PR is read from the round's artifacts and
// checked by check-pr.
test('skips verifier runs that are not rounds', () => {
  const condition = jobField(JOBS.get('config'), 'if');
  assert.doesNotMatch(condition, /head_branch/);
  const contextOf = (conclusion) => ({
    github: { event_name: 'workflow_run', event: { workflow_run: { conclusion, head_branch: 'main' } } },
  });
  assert.strictEqual(evaluate(condition, contextOf('success')), true);
  assert.strictEqual(evaluate(condition, contextOf('failure')), true);
  assert.strictEqual(evaluate(condition, contextOf('skipped')), false);
  assert.strictEqual(evaluate(condition, contextOf('cancelled')), false);
  assert.strictEqual(evaluate(condition, { github: { event_name: 'workflow_dispatch', event: {} } }), true);

  const collect = JOBS.get('collect');
  const identify = stepNamed(collect, 'Identify pull request');
  assert.match(identify, /art\/verdict-report\/verdict-report\.json/);
  assert.match(collect.text, /pr_number: \$\{\{ steps\.state\.outputs\.pr_number \}\}/);
  assert.match(collect.text, /head_sha: \$\{\{ steps\.pr\.outputs\.head_sha \}\}/);
});

test('uses the shared round constants instead of project settings', () => {
  assert.doesNotMatch(JUDGE, /VERIFIER_WORKFLOW: \.github/);
  assert.doesNotMatch(JUDGE, /VERIFIER_CONTEXT: Acceptance/);
  const protocol = stepNamed(JOBS.get('collect'), 'Read round protocol');
  assert.match(protocol, /calibration-judge\.js round-protocol/);

  const run = spawnSync(process.execPath, [CLI, 'round-protocol'], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), {
    status_context: VERIFIER_STATUS_CONTEXT,
    workflow_path: VERIFIER_WORKFLOW_PATH,
    artifacts: ROUND_ARTIFACTS,
  });

  // The verifier sets the status under the same context, and the wrapper convention names the
  // workflow and the path the constants name.
  assert.match(VERIFIER, new RegExp(`-f context="${VERIFIER_STATUS_CONTEXT}"`));
  assert.match(VERIFIER_WRAPPER, new RegExp(`^name: ${VERIFIER_STATUS_CONTEXT}$`, 'm'));
  assert.strictEqual(VERIFIER_WORKFLOW_PATH, '.github/workflows/acceptance-verifier.yml');
  assert.match(WRAPPER, new RegExp(`workflows: \\[${VERIFIER_STATUS_CONTEXT}\\]`));
});

test('has no status or label permissions or calls', () => {
  for (const job of JOBS.values()) {
    const permissions = permissionsOf(job);
    assert.notStrictEqual(permissions, null, `${job.id} declares permissions`);
    assert.notStrictEqual(permissions.statuses, 'write', job.id);
    assert.notStrictEqual(permissions.issues, 'write', job.id);
    const canWritePr = permissions['pull-requests'] === 'write';
    assert.strictEqual(canWritePr, job.id === 'publish', job.id);
  }
  assert.doesNotMatch(JUDGE, /\/labels/);
  assert.doesNotMatch(JUDGE, /--add-label|--remove-label/);
  assert.doesNotMatch(JUDGE, /-X POST "repos\/\$REPO\/statuses/);
  assert.doesNotMatch(JUDGE, /-f state=/);
  const wrapperJob = permissionsOf(readJobs(WRAPPER).get('calibration-judge'));
  assert.notStrictEqual(wrapperJob.statuses, 'write');
  assert.notStrictEqual(wrapperJob.issues, 'write');
  assert.match(WRAPPER, /^permissions: \{\}$/m);
});

test('reads project files from the default branch and code from the factory release', () => {
  for (const job of JOBS.values()) {
    const checkouts = job.steps.filter((step) => (usesOf(step) ?? '').startsWith('actions/checkout@'));
    const factory = checkouts.filter((step) => stepWith(step, 'path') === 'factory');
    assert.strictEqual(factory.length, 1, `${job.id} checks out the factory`);
    assert.strictEqual(stepWith(factory[0], 'repository'), '${{ env.FACTORY_REPOSITORY }}', job.id);
    assert.strictEqual(stepWith(factory[0], 'ref'), '${{ inputs.factory-sha }}', job.id);

    const project = checkouts.filter((step) => stepWith(step, 'path') === 'trusted');
    for (const step of project) {
      assert.strictEqual(stepWith(step, 'ref'), '${{ github.sha }}', job.id);
      assert.strictEqual(stepWith(step, 'repository'), null, job.id);
    }
    const prHead = checkouts.filter((step) => stepWith(step, 'path') === null);
    for (const step of prHead) {
      assert.notStrictEqual(stepWith(step, 'ref'), '${{ github.sha }}', job.id);
    }
    for (const step of checkouts) assert.strictEqual(stepWith(step, 'persist-credentials'), 'false', job.id);

    const nodeCalls = job.text.match(/\bnode \S+/g) ?? [];
    for (const call of nodeCalls) assert.match(call, /^node factory\//, job.id);
    assert.doesNotMatch(job.text, /trusted\/scripts|trusted\/judge/, job.id);
  }
  const configs = ['config', 'collect', 'stage1', 'stage2', 'assemble'];
  for (const id of configs) {
    const trusted = JOBS.get(id).steps.filter((step) => stepWith(step, 'path') === 'trusted');
    assert.strictEqual(trusted.length, 1, id);
  }
  assert.ok(JOBS.get('publish').steps.every((step) => stepWith(step, 'path') !== 'trusted'));
});

test('preserves advisory permissions and trusted runtime layout', () => {
  // The model key is declared once and reaches only the two model steps.
  const keyUses = JUDGE.match(/secrets\.\w+/g) ?? [];
  assert.deepStrictEqual(keyUses, ['secrets.OPENAI_API_KEY', 'secrets.OPENAI_API_KEY']);
  const models = codexSteps(JOBS);
  assert.deepStrictEqual(models.map(({ job }) => job.id), ['stage1', 'stage2']);
  for (const { step } of models) {
    assert.match(step, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  }
  assert.doesNotMatch(WRAPPER, /secrets: inherit/);
  assert.match(WRAPPER, /^ {4}secrets:\n {6}OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}$/m);

  // The CLI loads in every job from the factory checkout. Jobs that read the profile install
  // the production dependencies first; the others (the model jobs among them) need none.
  const withoutDependencies = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-checkout-'));
  for (const directory of ['judge', 'profile', 'verifier']) {
    fs.cpSync(path.join(ROOT, directory), path.join(withoutDependencies, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(withoutDependencies, 'package.json'));
  const loaded = spawnSync(
    process.execPath,
    [path.join(withoutDependencies, 'judge', 'calibration-judge.js')],
    { encoding: 'utf8' },
  );
  assert.strictEqual(loaded.status, 2, loaded.stderr);
  assert.doesNotMatch(loaded.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  fs.rmSync(withoutDependencies, { recursive: true, force: true });

  for (const [id, job] of JOBS) {
    const names = job.steps.map(stepName);
    const firstNode = job.steps.findIndex((step) => /\bnode factory\//.test(step));
    if (firstNode === -1) continue;
    const factory = job.steps.findIndex((step) => stepWith(step, 'path') === 'factory');
    assert.ok(factory !== -1 && factory < firstNode, `${id}: factory is checked out before it runs`);
    const installs = names.indexOf('Install factory dependencies');
    if (['config', 'collect'].includes(id)) {
      assert.ok(installs !== -1 && installs < firstNode, `${id}: installs dependencies first`);
      assert.match(job.steps[installs], /npm ci --omit=dev --ignore-scripts/);
    } else {
      assert.strictEqual(installs, -1, `${id} needs no dependencies`);
    }
  }
});

test('exposes model key only to model steps with verifier pin', () => {
  const pins = (text) => new Set(text.match(/openai\/codex-action@\S+/g));
  assert.deepStrictEqual(pins(JUDGE), pins(VERIFIER));
  assert.strictEqual(pins(VERIFIER).size, 1);
  const codexVersion = (text) => /^ {2}CODEX_VERSION: (\S+)$/m.exec(text)[1];
  assert.strictEqual(codexVersion(JUDGE), codexVersion(VERIFIER));
  for (const { step } of codexSteps(JOBS)) {
    assert.strictEqual(stepWith(step, 'codex-version'), '${{ env.CODEX_VERSION }}');
    assert.strictEqual(stepWith(step, 'safety-strategy'), 'drop-sudo');
    assert.strictEqual(stepWith(step, 'sandbox'), 'read-only');
  }
});

const downloadsOf = (job) =>
  job.steps
    .filter((step) => (usesOf(step) ?? '').startsWith('actions/download-artifact@'))
    .map((step) => stepWith(step, 'name'));

test('isolates stage one from full package', () => {
  const [stage1, stage2] = codexSteps(JOBS);
  assert.notStrictEqual(stage1.job.id, stage2.job.id);
  assert.deepStrictEqual(downloadsOf(stage1.job), ['judge-independent']);
  assert.doesNotMatch(stage1.job.text, /judge-full|verdict|policy/);
  assert.deepStrictEqual(downloadsOf(stage2.job), ['judge-full', 'judge-stage1']);
  const output1 = stepWith(stage1.step, 'output-file');
  const output2 = stepWith(stage2.step, 'output-file');
  assert.notStrictEqual(output1, output2);
  assert.doesNotMatch(stage2.job.text, new RegExp(`> ${output1.replace('.', '\\.')}`));

  const independentUpload = JOBS.get('collect').steps.find((step) => stepWith(step, 'name') === 'judge-independent');
  assert.strictEqual(stepWith(independentUpload, 'path'), 'pkg/independent/');
});

test('stage one does not receive previous round', () => {
  const inputs = JSON.parse(fs.readFileSync(INPUTS_FILE, 'utf8'));
  const previousRoundFiles = inputs.fullOnlyInputs
    .filter(({ key }) => /^(previous|round|policy)/.test(key) || key.endsWith('Diff'))
    .map(({ path: file }) => file);
  assert.ok(previousRoundFiles.includes('previous-round.json'));
  assert.ok(previousRoundFiles.includes('policy-status.json'));
  const independentFiles = inputs.independentInputs.map(({ path: file }) => file);
  for (const file of previousRoundFiles) {
    assert.ok(!independentFiles.includes(file), `${file} is not independent`);
  }

  const [stage1] = codexSteps(JOBS);
  assert.strictEqual(stage1.job.id, 'stage1');
  assert.deepStrictEqual(downloadsOf(stage1.job), ['judge-independent']);
  assert.doesNotMatch(stage1.job.text, /judge-meta|judge-full|context\//);
  for (const file of previousRoundFiles) {
    assert.ok(!stage1.job.text.includes(file), `stage 1 mentions ${file}`);
  }

  const collect = JOBS.get('collect');
  const build = stepNamed(collect, 'Build previous round inputs');
  assert.match(build, /calibration-judge\.js previous-round /);
  const independentUpload = collect.steps.find((step) => stepWith(step, 'name') === 'judge-independent');
  assert.doesNotMatch(independentUpload, /context|previous/);
  const metaUpload = collect.steps.find((step) => stepWith(step, 'name') === 'judge-meta');
  assert.match(metaUpload, /^ {12}pkg\/context\/$/m);
  const assemble = JOBS.get('assemble');
  assert.match(assemble.text, /--previous context\/previous-round\.json/);
  assert.match(assemble.text, /--transitions context\/round-transitions\.json/);
});

test('compares rounds on the same terms', () => {
  const collect = JOBS.get('collect');
  const raw = stepNamed(collect, 'Build raw inputs');
  const previous = stepNamed(collect, 'Build previous round inputs');
  const current = stepNamed(collect, 'Read policy snapshot of the round');

  // Both rounds get their base commit as the merge base with the PR base tip.
  for (const step of [raw, previous]) {
    assert.match(step, /\/compare\/\$BASE_TIP\.\.\.\$\w+" --jq '\.merge_base_commit\.sha'/);
  }
  assert.doesNotMatch(previous, /base_sha: null/);

  // Both rounds read their rules from their own policy snapshot, selected like the verdict
  // artifact; nothing is read from the project's current settings or by the factory SHA.
  assert.match(current, /read-snapshot --inputs factory\/judge\/inputs\.json/);
  assert.match(current, /--provenance art\/verdict\/provenance\.json/);
  assert.match(previous, /read-snapshot --inputs "\$INPUTS"/);
  assert.match(previous, /--provenance prev\/raw\/provenance\.json/);
  assert.match(previous, /--run-id "\$PREV_RUN" --run-attempt "\$PREV_ATTEMPT"/);
  assert.match(previous, /policy-diff --current raw --previous prev\/raw/);
  for (const step of [current, previous]) {
    assert.match(step, /\.created_at <= \$end/);
    assert.match(step, /\(\.expired \| not\)/);
  }
  assert.doesNotMatch(JUDGE, /contents\/\$CONFIG|\?ref=\$VERIFIER_COMMIT|pinned-configs/);
  assert.doesNotMatch(JUDGE, /cp -R trusted\/\.github raw/);

  // "First round" (--previous none) is used only when no earlier round exists.
  const noneLines = linesOf(previous).filter((line) => /=none$/.test(line.trim()));
  assert.deepStrictEqual(noneLines.map((line) => line.trim()), ['PREV_PKG=none', 'PREV_TRANSITIONS=none']);
  assert.match(previous, /if \[ "\$PREV_STATUS" = "absent" \]; then\n\s+PREV_PKG=none\n\s+PREV_TRANSITIONS=none\n/);
  assert.match(previous, /if \[ -n "\$PREV_PKG" \] && node /);
  assert.match(previous, /if \[ -n "\$PREV_TRANSITIONS" \]; then/);
});

test('checks judge model before model steps', () => {
  for (const { job, step } of codexSteps(JOBS)) {
    assert.strictEqual(stepWith(step, 'model'), '${{ inputs.judge-model }}');
    assert.doesNotMatch(step, /verifier-model/);
    assert.match(jobField(job, 'needs'), /collect/);
    assert.match(jobField(job, 'if'), /needs\.collect\.outputs\.model_allowed == 'true'/);
  }
  const collect = JOBS.get('collect');
  assert.match(collect.text, /model_allowed: \$\{\{ steps\.model\.outputs\.allowed \}\}/);
  const modelStep = stepNamed(collect, 'Check judge model');
  assert.match(modelStep, /calibration-judge\.js check-model "\$JUDGE_MODEL"/);
  assert.match(modelStep, /JUDGE_MODEL: \$\{\{ inputs\.judge-model \}\}/);
  assert.match(modelStep, /--allowlist trusted\/\.github\/calibration\/allowed-models\.json/);
  // The verifier's own list is a historical rule of the round and is read from the snapshot only.
  assert.doesNotMatch(JUDGE, /\.github\/verifier\/allowed-models\.json/);
  // The round's recorded model comes first; the current setting is a marked fallback.
  assert.match(modelStep, /jq -r '\.model \/\/ empty' raw\/provenance\.json/);
  assert.match(modelStep, /verifier_model_historical = false/);
  assert.match(modelStep, /VERIFIER_MODEL_VAR: \$\{\{ inputs\.verifier-model \}\}/);
});

test('verifier report uploads historical comment', () => {
  const report = VERIFIER_JOBS.get('report');
  const names = report.steps.map(stepName);
  const uploads = report.steps.filter((step) => (usesOf(step) ?? '').startsWith('actions/upload-artifact@'));
  assert.strictEqual(uploads.length, 1);
  const [upload] = uploads;
  assert.strictEqual(stepWith(upload, 'name'), 'verdict-report');
  assert.match(upload, /^ {8}if: always\(\)$/m);
  assert.match(upload, /^ {12}verdict-report\.json$/m);
  assert.match(upload, /^ {12}comment\.md$/m);
  assert.match(upload, /^ {12}timeline\.json$/m);

  const write = report.steps.find((step) => stepName(step) === 'Write verdict report');
  assert.match(write, /^ {8}if: always\(\)$/m);
  assert.match(write, /PR_NUMBER: \$\{\{ needs\.verify\.outputs\.pr_number \}\}/);
  assert.match(write, /HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(write, /RESULT: \$\{\{ steps\.verdict\.outputs\.result \}\}/);
  assert.match(write, /> verdict-report\.json; then/);

  // Both steps come last, after the comment and the status are published, so they cannot affect either.
  assert.deepStrictEqual(names.slice(-2), ['Write verdict report', 'Upload verdict report']);
  assert.ok(names.indexOf('Compute verdict and comment') !== -1);
  assert.ok(names.indexOf('Set commit status') < names.length - 2);
});

test('verifier report uploads machine result', () => {
  const report = VERIFIER_JOBS.get('report');
  const compute = stepNamed(report, 'Compute verdict and comment');
  const call = compute.split('\n').find((line) => line.includes('factory/verifier/verdict.js verdict.json'));
  assert.ok(call !== undefined);
  assert.match(call, /--out comment\.md --result-out result\.json/);

  const upload = report.steps.find((step) => stepWith(step, 'name') === 'verdict-report');
  assert.match(upload, /^ {12}result\.json$/m);

  // The verify jobs neither produce nor upload the machine result.
  for (const id of ['verify', 'verify-second']) {
    assert.doesNotMatch(VERIFIER_JOBS.get(id).text, /--result-out|(^|\s)result\.json/m);
  }
});

test('verifier forms policy snapshot without changing the job result', () => {
  const verify = VERIFIER_JOBS.get('verify');
  const names = verify.steps.map(stepName);
  const form = stepNamed(verify, 'Form policy snapshot');
  const upload = stepNamed(verify, 'Upload policy snapshot');
  const outcome = stepNamed(verify, 'Policy snapshot upload outcome');

  // Neither the forming nor the uploading nor the reporting of the outcome can fail the job.
  for (const step of [form, upload, outcome]) assert.match(step, /^ {8}continue-on-error: true$/m);
  assert.match(form, /^ {8}if: always\(\) && steps\.pin\.outcome == 'success'/m);
  assert.match(form, /exit 0\s*$/);
  assert.match(form, /::warning::Policy snapshot was not formed/);
  assert.match(form, /\$GITHUB_STEP_SUMMARY/);

  // A fresh directory outside the PR checkout, written by the factory command.
  assert.match(form, /SNAPSHOT_DIR=\$\(mktemp -d "\$RUNNER_TEMP\/policy-snapshot\.XXXXXX"\)/);
  assert.match(form, /node factory\/verifier\/policy-snapshot\.js write --project trusted/);
  assert.match(form, /--out "\$SNAPSHOT_DIR\/policy-snapshot\.json"/);
  assert.match(form, /--factory-sha "\$FACTORY_SHA"/);
  assert.match(form, /FACTORY_SHA: \$\{\{ inputs\.factory-sha \}\}/);
  assert.match(form, /REQUESTED_REF: \$\{\{ github\.sha \}\}/);
  assert.match(form, /--model-ran "\$MODEL_RAN"/);

  // Only the file this step formed in this run is uploaded, as a separate artifact.
  assert.match(upload, /^ {8}if: always\(\) && steps\.snapshot\.outputs\.formed == 'true'$/m);
  assert.strictEqual(stepWith(upload, 'path'), '${{ steps.snapshot.outputs.file }}');
  assert.strictEqual(stepWith(upload, 'name'), ROUND_ARTIFACTS.policySnapshot);
  assert.match(form, /echo "file=\$SNAPSHOT_DIR\/policy-snapshot\.json" >> "\$GITHUB_OUTPUT"/);
  assert.match(outcome, /\$GITHUB_STEP_SUMMARY/);
  assert.match(outcome, /::warning::Policy snapshot was formed but not uploaded/);

  // It comes after everything the verdict reads and leaves those steps and their uploads alone.
  assert.ok(names.indexOf('Decide second run') < names.indexOf('Form policy snapshot'));
  assert.ok(names.indexOf('Policy snapshot upload outcome') < names.indexOf('Upload verdict'));
  assert.doesNotMatch(stepNamed(verify, 'Upload verdict'), /policy/);
  assert.doesNotMatch(stepNamed(verify, 'Decide second run'), /policy/);
  assert.doesNotMatch(verify.text.replace(/policy-snapshot|policy snapshot|Policy snapshot|snapshot/g, ''), /policy/);

  // `Report` and `Verify second` never read the snapshot.
  const outputs = /outputs:\n((?: {6}.*\n)+)/.exec(verify.text)[1];
  assert.doesNotMatch(outputs, /snapshot/);
  for (const id of ['verify-second', 'report']) {
    const job = VERIFIER_JOBS.get(id);
    assert.doesNotMatch(job.text, /policy-snapshot|policy_snapshot/, id);
    assert.ok(!downloadsOf(job).includes(ROUND_ARTIFACTS.policySnapshot), id);
  }
});

test('keeps analysis artifact and does not cancel rounds', () => {
  const assemble = JOBS.get('assemble');
  const publish = JOBS.get('publish');
  const isAnalysisUpload = (step) =>
    (usesOf(step) ?? '').startsWith('actions/upload-artifact@') && stepWith(step, 'name') === 'calibration-analysis';
  const upload = assemble.steps.find(isAnalysisUpload);
  assert.strictEqual(stepWith(upload, 'path'), 'calibration-analysis.json');
  assert.strictEqual(stepWith(upload, 'retention-days'), '90');
  // The analysis is kept outside the publication queue: a cancelled pending publication cannot
  // lose it. Publication only reads it back.
  assert.doesNotMatch(assemble.text, /^ {4}concurrency:/m);
  assert.strictEqual(publish.steps.filter(isAnalysisUpload).length, 0);
  assert.deepStrictEqual(downloadsOf(publish), ['calibration-analysis']);
  assert.match(jobField(publish, 'needs'), /assemble/);
  assert.match(jobField(publish, 'if'), /needs\.assemble\.result == 'success'/);
  // No workflow-level group: rounds of different PRs never wait on or cancel each other;
  // publications of one PR are serialised by the job group.
  assert.strictEqual(topLevelBlock(JUDGE, 'concurrency'), null);
  assert.match(
    publish.text,
    /^ {4}concurrency:\n {6}group: calibration-judge-publish-\$\{\{ needs\.collect\.outputs\.pr_number \}\}\n {6}cancel-in-progress: false$/m,
  );
  assert.doesNotMatch(JUDGE, /cancel-in-progress: true/);
});

test('reports expected failures as analysis errors on automatic runs', () => {
  const automatic = { event_name: 'workflow_run', event: { workflow_run: { conclusion: 'failure' } } };
  const manual = { event_name: 'workflow_dispatch', event: {} };
  const absorbs = (github) => evaluate(ABSORB.slice(3, -2), { github });

  for (const job of JOBS.values()) {
    assert.strictEqual(jobField(job, 'continue-on-error'), null, `${job.id}: not supported on a called job`);
  }
  assert.doesNotMatch(WRAPPER, /continue-on-error/);

  // Collecting the round: every step that can fail on expected causes absorbs the failure of an
  // automatic run and still fails a manual one.
  const collect = JOBS.get('collect');
  for (const name of [
    'Locate pull request of a label event',
    'Resolve round',
    'Download verifier artifacts of the round',
    'Identify pull request',
    'Read policy snapshot of the round',
    'Build raw inputs',
    'Build previous round inputs',
  ]) {
    const value = stepField(stepNamed(collect, name), 'continue-on-error');
    assert.strictEqual(value, ABSORB, name);
  }
  assert.strictEqual(absorbs(automatic), true);
  assert.strictEqual(absorbs(manual), false);

  // The model calls: a failed or timed-out call is absorbed in its own job.
  for (const { step } of codexSteps(JOBS)) assert.match(step, /^ {8}continue-on-error: true$/m);

  // The jobs after a failure turn the state into an analysis error.
  const state = stepNamed(collect, 'Record collection state');
  assert.match(state, /^ {8}if: always\(\)$/m);
  assert.match(state, /echo "failed=\$FAILED"/);
  assert.match(state, /::error::Calibration Judge could not collect the inputs of the round/);
  for (const output of ['failed', 'failure_reason', 'skip', 'pr_number']) {
    assert.match(collect.text, new RegExp(`${output}: \\$\\{\\{ steps\\.state\\.outputs\\.${output} \\}\\}`));
  }
  const assembleStep = stepNamed(JOBS.get('assemble'), 'Assemble analysis');
  assert.match(assembleStep, /--input-error "inputs of the round could not be collected/);
  assert.match(assembleStep, /--model-error "judge model is not allowed/);

  const scenarios = [
    {
      name: 'inputs failed after the pull request was known',
      outputs: { collect: { skip: 'false', failed: 'true', pr_number: '7', model_allowed: '' } },
      expected: ['success', 'success', 'skipped', 'skipped', 'success', 'success'],
    },
    {
      name: 'inputs failed before any pull request was known',
      outputs: { collect: { skip: 'false', failed: 'true', pr_number: '', model_allowed: '' } },
      expected: ['success', 'success', 'skipped', 'skipped', 'skipped', 'skipped'],
    },
    {
      name: 'model rejected',
      outputs: { collect: { skip: 'false', failed: 'false', pr_number: '7', model_allowed: 'false' } },
      expected: ['success', 'success', 'skipped', 'skipped', 'success', 'success'],
    },
    {
      name: 'stage 1 produced no result',
      outputs: { collect: COLLECT_READY, stage1: { has_result: 'false' } },
      expected: ['success', 'success', 'success', 'skipped', 'success', 'success'],
    },
    {
      name: 'nothing to analyse',
      outputs: { collect: { skip: 'true', failed: 'false', pr_number: '', model_allowed: '' } },
      expected: ['success', 'success', 'skipped', 'skipped', 'skipped', 'skipped'],
    },
  ];
  for (const { name, outputs, expected } of scenarios) {
    const result = schedule({ github: automatic, outputs: { config: { enabled: 'true' }, ...outputs } });
    assert.deepStrictEqual(Object.values(result), expected, name);
  }
});

test('publishes model rejection without calling model', () => {
  const prefixMatch = /--model-error "([^"$]*)\$/.exec(JUDGE);
  assert.notStrictEqual(prefixMatch, null);
  const prefix = prefixMatch[1];
  assert.ok(prefix.startsWith('judge model is not allowed'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-workflow-'));
  const file = (name, data) => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, JSON.stringify(data));
    return full;
  };
  const manifest = file('manifest.json', {
    round_key: { repository: 'o/r', verifier_run_id: 1, verifier_run_attempt: 1 },
    head_sha: null,
    inputs: {},
  });
  const assembledFile = path.join(dir, 'analysis.json');
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const common = [
    '--manifest',
    manifest,
    '--stage1',
    path.join(dir, 'absent-stage1.json'),
    '--stage2',
    path.join(dir, 'absent-stage2.json'),
    '--taxonomy',
    TAXONOMY_FILE,
    '--out',
    assembledFile,
  ];
  const assembled = cli(['assemble', ...common, '--model-error', `${prefix}judge model is not in allowlist: x`]);
  assert.strictEqual(assembled.status, 0, assembled.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(assembledFile, 'utf8')).error.stage, 'model');

  const collectFailure = cli(['assemble', ...common, '--input-error', 'inputs of the round could not be collected: raw inputs failed']);
  assert.strictEqual(collectFailure.status, 0, collectFailure.stderr);
  const failed = JSON.parse(fs.readFileSync(assembledFile, 'utf8'));
  assert.strictEqual(failed.error.stage, 'manifest');
  assert.match(failed.error.problems[0], /raw inputs failed/);
  assert.strictEqual(failed.analysis, null);

  cli(['assemble', ...common, '--model-error', `${prefix}judge model is not in allowlist: x`]);
  const commentFile = path.join(dir, 'comment.md');
  const published = cli([
    'publish',
    assembledFile,
    '--comments',
    file('comments.json', []),
    '--author',
    'bot',
    '--repository',
    'o/r',
    '--run-id',
    '1',
    '--run-attempt',
    '1',
    '--inputs',
    INPUTS_FILE,
    '--out',
    commentFile,
  ]);
  assert.strictEqual(published.status, 0, published.stderr);
  const comment = fs.readFileSync(commentFile, 'utf8');
  assert.match(comment, /\(stage: model\)/);
  assert.match(comment, /judge model is not allowed/);

  for (const { job } of codexSteps(JOBS)) {
    const condition = jobField(job, 'if');
    const context = {
      needs: {
        collect: { outputs: { skip: 'false', failed: 'false', model_allowed: 'false' } },
        stage1: { outputs: { has_result: 'true' } },
      },
    };
    assert.strictEqual(evaluate(condition, context), false, job.id);
    context.needs.collect.outputs.model_allowed = 'true';
    assert.strictEqual(evaluate(condition, context), true, job.id);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish step calls the retrying publish-round CLI, not gh api directly', () => {
  const step = stepNamed(JOBS.get('publish'), 'Publish comment');
  assert.match(step, /calibration-judge\.js publish-round/);
  assert.doesNotMatch(step, /gh api -X PATCH/);
  assert.doesNotMatch(step, /gh api -X POST/);
});

// The write path (`publish-round`, run here through its exported runner with a stubbed `exec`
// instead of a real `gh` call) rereads the comment right before merging/writing and again
// right after to verify the write actually landed, retrying a write that appears lost instead
// of declaring success on the first attempt regardless.
test('publish rereads before write and verifies after', (t) => {
  const { runPublishRound } = require('./calibration-judge.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-publish-round-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assembledFile = path.join(dir, 'assembled.json');
  fs.writeFileSync(
    assembledFile,
    JSON.stringify({
      round_key: { repository: 'o/r', verifier_run_id: 1, verifier_run_attempt: 1 },
      head_sha: null,
      inputs: {},
      error: { stage: 'model', problems: ['boom'] },
      independent: null,
      analysis: null,
    }),
  );
  const argsFor = (runId, maxAttempts) => [
    assembledFile,
    '--repository',
    'o/r',
    '--pr',
    '9',
    '--author',
    'bot',
    '--run-id',
    String(runId),
    '--run-attempt',
    '1',
    '--inputs',
    INPUTS_FILE,
    '--max-attempts',
    String(maxAttempts),
  ];
  const bodyFileOf = (args) => {
    const field = args.find((arg) => arg.startsWith('body=@'));
    return field.slice('body=@'.length);
  };

  // The verify read right after the first write finds nothing (simulating a concurrent
  // overwrite), so a second reread/merge/write attempt is needed.
  let server = [];
  let dropNextWrite = true;
  const paginateCalls = [];
  const retryingExec = (_file, args) => {
    if (args[0] === 'api' && args.includes('--paginate')) {
      assert.ok(args.includes('--slurp'), 'gh api call must pass --slurp');
      paginateCalls.push(args);
      // `--slurp` wraps every page's own array into one outer array (a single page here).
      return JSON.stringify([server]);
    }
    const body = fs.readFileSync(bodyFileOf(args), 'utf8');
    if (dropNextWrite) {
      dropNextWrite = false;
      server = [];
      return '';
    }
    server = [{ id: 1, user: { login: 'bot' }, body }];
    return '';
  };
  const succeeded = runPublishRound(argsFor(1, 3), { exec: retryingExec });
  assert.strictEqual(succeeded, 0);
  assert.ok(paginateCalls.length >= 4, `expected rereads, got ${paginateCalls.length}`);

  // Every write appears lost: the command must fail instead of retrying forever.
  let lostServer = [];
  const alwaysLosingExec = (_file, args) => {
    if (args[0] === 'api' && args.includes('--paginate')) return JSON.stringify([lostServer]);
    lostServer = [];
    return '';
  };
  const failed = runPublishRound(argsFor(2, 2), { exec: alwaysLosingExec });
  assert.strictEqual(failed, 1);
});

test('example wrapper declares every start and calls the pinned workflow', () => {
  const on = topLevelBlock(WRAPPER, 'on');
  const triggers = linesOf(on)
    .map((line) => /^ {2}([a-z_]+):/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
  assert.deepStrictEqual(triggers, ['workflow_run', 'pull_request_target', 'issues', 'workflow_dispatch']);
  assert.match(on, /workflows: \[Acceptance Verifier\]/);
  assert.match(on, /types: \[completed\]/);
  assert.match(on, /^ {2}issues:\n {4}types: \[labeled\]\n/m);
  assert.match(on, / {6}pr:\n(?: {8}.*\n)*? {8}required: true/);
  assert.match(on, / {6}run_id:\n(?: {8}.*\n)*? {8}required: false/);
  assert.match(on, / {6}run_attempt:\n(?: {8}.*\n)*? {8}required: false/);

  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.match(WRAPPER, new RegExp(`uses: \\S+/\\.github/workflows/calibration-judge\\.yml@${sha}$`, 'm'));
  assert.match(WRAPPER, new RegExp(`^ {6}factory-sha: ${sha}$`, 'm'));
  assert.match(WRAPPER, /^ {6}judge-model: \$\{\{ vars\.CALIBRATION_JUDGE_MODEL \}\}$/m);
  assert.match(WRAPPER, /^ {6}verifier-model: \$\{\{ vars\.VERIFIER_MODEL \}\}$/m);
  assert.match(WRAPPER, /^ {6}pr: \$\{\{ inputs\.pr \}\}$/m);
  assert.match(WRAPPER, /^ {6}run-id: \$\{\{ inputs\.run_id \}\}$/m);
  assert.match(WRAPPER, /^ {6}run-attempt: \$\{\{ inputs\.run_attempt \}\}$/m);
  assert.doesNotMatch(WRAPPER, /continue-on-error/);
});
