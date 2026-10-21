'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  FORMAT_VERSION,
  PART_NAMES,
  STATE_SAVED,
  STATE_ABSENT,
  STATE_UNUSED,
  STATE_UNAVAILABLE,
  SnapshotError,
  buildSnapshot,
  writeSnapshotFile,
  parseSnapshot,
  checkSnapshotOrigin,
  main,
} = require('./policy-snapshot');
const { loadCore } = require('./issue-contract');
const { FIXTURE_PROFILES } = require('../test/helpers/profiles');
const { readText, verdictOf } = require('../test/helpers/verdict');

const {
  FACTORY_SHA,
  HEAD_SHA,
  OVERLAY,
  sandbox,
  trustedCheckout,
  renderedModelFiles,
  originOf,
} = require('../test/helpers/snapshot');

const RUN_ID = 4242;
const RUN_ATTEMPT = 2;
const SECRET = 'sk-test-secret-value';
const ORIGIN = originOf();

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

test('captures effective rules with separate factory and project origins', (t) => {
  process.env.OPENAI_API_KEY = SECRET;
  t.after(() => delete process.env.OPENAI_API_KEY);
  for (const fixture of FIXTURE_PROFILES) {
    const projectDir = trustedCheckout(t, fixture);
    const profileText = readText(projectDir, '.factory', 'profile.json');
    const files = renderedModelFiles(t);
    const snapshot = buildSnapshot({ projectDir, origin: ORIGIN, modelRan: true, ...files });

    assert.strictEqual(snapshot.format_version, FORMAT_VERSION);
    assert.deepStrictEqual(snapshot.origin, ORIGIN);
    assert.notStrictEqual(snapshot.origin.factory_sha, snapshot.origin.project_sha);
    assert.deepStrictEqual(Object.keys(snapshot.parts).sort(), [...PART_NAMES].sort());
    for (const [name, part] of Object.entries(snapshot.parts)) {
      assert.strictEqual(part.state, STATE_SAVED, `${fixture} ${name}`);
      assert.strictEqual(part.sha256, sha256(part.content), `${fixture} ${name}`);
    }
    assert.strictEqual(snapshot.parts.profile.content, profileText);
    const enabled = JSON.parse(profileText).verifier.checks;
    assert.deepStrictEqual(JSON.parse(snapshot.parts.enabled_checks.content), enabled);
    assert.match(snapshot.parts.risk_zones.content, /billing_data/);
    assert.match(snapshot.parts.prompt.content, /Verify the pull request/);
    assert.match(snapshot.parts.schema.content, /criteria/);

    const contract = JSON.parse(snapshot.parts.issue_contract.content);
    const core = loadCore();
    assert.strictEqual(contract.sections.length, core.sections.length + OVERLAY.sections.length);
    assert.ok(contract.forbiddenPhrases.includes('to be decided'));

    assert.ok(!JSON.stringify(snapshot).includes(SECRET), 'no secret reaches the snapshot');

    const parsed = parseSnapshot(JSON.stringify(snapshot));
    assert.strictEqual(parsed.ok, true);
    const round = {
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      headSha: HEAD_SHA,
      verifierCommit: FACTORY_SHA,
    };
    assert.deepStrictEqual(checkSnapshotOrigin(snapshot, round), { ok: true, attempt: RUN_ATTEMPT });
  }
});

test('records absent and unused parts with reasons', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const projectDir = trustedCheckout(t, fixture, {
      overlay: null,
      without: ['.github/verifier/owners.json'],
    });
    const snapshot = buildSnapshot({ projectDir, origin: ORIGIN, modelRan: false });
    const { parts } = snapshot;

    assert.strictEqual(parts.issue_contract_overlay.state, STATE_ABSENT);
    assert.strictEqual(parts.owners.state, STATE_ABSENT);
    for (const name of ['issue_contract_overlay', 'owners']) {
      assert.match(parts[name].reason, /not in the trusted checkout/);
      assert.strictEqual(parts[name].content, undefined);
    }
    for (const name of ['prompt', 'schema']) {
      assert.strictEqual(parts[name].state, STATE_UNUSED, name);
      assert.match(parts[name].reason, /model did not run/);
    }
    assert.strictEqual(parts.issue_contract.state, STATE_SAVED);
    assert.deepStrictEqual(JSON.parse(parts.issue_contract.content), loadCore());

    const outFile = path.join(sandbox(t), 'snapshot.json');
    writeSnapshotFile(outFile, snapshot);
    assert.strictEqual(parseSnapshot(fs.readFileSync(outFile, 'utf8')).ok, true);
  }
});

test('an overlay that cannot be applied is kept and marked unavailable', (t) => {
  const projectDir = trustedCheckout(t, 'monorepo', { overlay: /** @type {any} */ ({ sections: 'broken' }) });
  const { parts } = buildSnapshot({ projectDir, origin: ORIGIN, modelRan: false });
  assert.strictEqual(parts.issue_contract_overlay.state, STATE_SAVED);
  assert.strictEqual(parts.issue_contract.state, STATE_UNAVAILABLE);
  assert.match(parts.issue_contract.reason, /overlay/);
});

const initRepository = (dir) => {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'trusted');
  return git('rev-parse', 'HEAD').trim();
};

const cliArgs = (projectDir, outFile, projectSha, extra = []) => [
  'write',
  '--project', projectDir,
  '--out', outFile,
  '--factory-sha', FACTORY_SHA,
  '--requested-ref', projectSha,
  '--head-sha', HEAD_SHA,
  '--run-id', String(RUN_ID),
  '--run-attempt', String(RUN_ATTEMPT),
  ...extra,
];

const quiet = (t) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => {
    process.stderr.write = write;
  });
};

test('fails snapshot formation without a partial file', (t) => {
  quiet(t);
  const projectDir = trustedCheckout(t, 'single-package');
  const projectSha = initRepository(projectDir);
  const out = sandbox(t);
  const files = renderedModelFiles(t);
  const modelArgs = ['--model-ran', 'true', '--prompt', files.promptFile, '--schema', files.schemaFile];
  const leftovers = () => fs.readdirSync(out);

  const good = path.join(out, 'good.json');
  assert.strictEqual(main(cliArgs(projectDir, good, projectSha, modelArgs)), 0);
  assert.deepStrictEqual(leftovers(), ['good.json']);

  const unwritable = path.join(out, 'missing-dir', 'snapshot.json');
  assert.strictEqual(main(cliArgs(projectDir, unwritable, projectSha, modelArgs)), 1);
  assert.ok(!fs.existsSync(path.dirname(unwritable)));

  const noPrompt = path.join(out, 'no-prompt.json');
  const missingPrompt = ['--model-ran', 'true', '--prompt', path.join(out, 'none.md'), '--schema', files.schemaFile];
  assert.strictEqual(main(cliArgs(projectDir, noPrompt, projectSha, missingPrompt)), 1);

  const staleRef = path.join(out, 'stale-ref.json');
  assert.strictEqual(main(cliArgs(projectDir, staleRef, 'e'.repeat(40), modelArgs)), 1);

  const unreadable = path.join(projectDir, '.github', 'verifier', 'required-checks.json');
  fs.rmSync(unreadable);
  fs.mkdirSync(unreadable);
  const broken = path.join(out, 'unreadable.json');
  assert.strictEqual(main(cliArgs(projectDir, broken, projectSha, modelArgs)), 1);

  assert.deepStrictEqual(leftovers(), ['good.json']);
});

test('write errors leave neither the file nor a temporary one', (t) => {
  const out = sandbox(t);
  const snapshot = buildSnapshot({
    projectDir: trustedCheckout(t, 'monorepo'),
    origin: ORIGIN,
    modelRan: false,
  });
  const failing = {
    ...fs,
    existsSync: fs.existsSync,
    writeFileSync: (file, data, options) => {
      fs.writeFileSync(file, String(data).slice(0, 10), options);
      throw new Error('disk full');
    },
  };
  const outFile = path.join(out, 'snapshot.json');
  assert.throws(() => writeSnapshotFile(outFile, snapshot, { fsApi: failing }), SnapshotError);
  assert.deepStrictEqual(fs.readdirSync(out), []);

  writeSnapshotFile(outFile, snapshot);
  assert.throws(() => writeSnapshotFile(outFile, snapshot), /already exists/);
  assert.strictEqual(parseSnapshot(fs.readFileSync(outFile, 'utf8')).ok, true);
});

const cloneSnapshot = (snapshot) => JSON.parse(JSON.stringify(snapshot));

test('rejects unsupported, damaged and unattributed snapshots', (t) => {
  const projectDir = trustedCheckout(t, 'monorepo');
  const snapshot = buildSnapshot({ projectDir, origin: ORIGIN, modelRan: false });
  const reasonOf = (mutate) => {
    const copy = cloneSnapshot(snapshot);
    mutate(copy);
    const parsed = parseSnapshot(JSON.stringify(copy));
    assert.strictEqual(parsed.ok, false);
    return parsed.reason;
  };
  assert.match(reasonOf((copy) => { copy.format_version = 99; }), /version 99 is not supported/);
  assert.match(reasonOf((copy) => { delete copy.format_version; }), /not supported/);
  assert.match(reasonOf((copy) => { copy.parts.profile.content += ' '; }), /profile does not match its hash/);
  assert.match(reasonOf((copy) => { delete copy.parts.owners; }), /owners is missing/);
  assert.match(reasonOf((copy) => { delete copy.origin; }), /no origin/);
  assert.strictEqual(parseSnapshot('{ not json').ok, false);
  const newer = parseSnapshot(JSON.stringify({ format_version: 2, anything: true }));
  assert.match(newer.reason, /version 2 is not supported/);
});

test('does not alter verifier verdicts', (t) => {
  quiet(t);
  for (const fixture of FIXTURE_PROFILES) {
    const fixtures = path.join(__dirname, '..', 'test', 'fixtures');
    const root = path.join(fixtures, 'profiles', fixture);
    const casesDir = path.join(fixtures, 'verifier', 'golden', fixture);
    const names = fs.readdirSync(casesDir).sort();
    const verdicts = (label) =>
      names.map((name) => {
        const { summary } = verdictOf(root, path.join(casesDir, name));
        return { label, name, verdict: summary.verdict, reasons: summary.reasons };
      });
    const strip = (rows) => rows.map(({ name, verdict, reasons }) => ({ name, verdict, reasons }));

    const without = strip(verdicts('without snapshot'));

    const projectDir = trustedCheckout(t, fixture);
    const projectSha = initRepository(projectDir);
    const out = sandbox(t);
    assert.strictEqual(main(cliArgs(projectDir, path.join(out, 'ok.json'), projectSha, ['--model-ran', 'false'])), 0);
    const afterSuccess = strip(verdicts('after a formed snapshot'));

    assert.strictEqual(main(cliArgs(projectDir, path.join(out, 'no', 'x.json'), projectSha, ['--model-ran', 'false'])), 1);
    const afterFailure = strip(verdicts('after a failed snapshot'));

    assert.deepStrictEqual(afterSuccess, without, fixture);
    assert.deepStrictEqual(afterFailure, without, fixture);
    assert.ok(without.some(({ verdict }) => verdict === 'PASS'), fixture);
    assert.ok(without.some(({ verdict }) => verdict === 'FAIL') || fixture === 'single-package', fixture);
  }
});
