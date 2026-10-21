'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy, enableJudge } = require('../test/helpers/profiles');
const { snapshotOf, originOf, sandbox, writeFile, FACTORY_SHA, HEAD_SHA } = require('../test/helpers/snapshot');

const CLI = path.join(__dirname, 'calibration-judge.js');
const INPUTS = path.join(__dirname, 'inputs.json');

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('config prints the state of the judge settings and fails only for a defect', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const common = [
      '--factory-repository', 'owner/factory',
      '--factory-dir', sandbox(t),
      '--wrapper-sha', FACTORY_SHA,
    ];
    const disabled = run(['config', '--project', profileCopy(t, fixture), ...common]);
    assert.strictEqual(disabled.status, 0, disabled.stderr);
    assert.strictEqual(JSON.parse(disabled.stdout).status, 'disabled');

    // Enabled, but the project has no pinned factory release to match: a configuration error.
    const root = profileCopy(t, fixture, enableJudge('mark-for-analysis'));
    const unpinned = run(['config', '--project', root, ...common]);
    assert.strictEqual(unpinned.status, 0, unpinned.stderr);
    const answer = JSON.parse(unpinned.stdout);
    assert.strictEqual(answer.status, 'invalid');
    assert.match(answer.reason, /factory pin is not confirmed/);

    const missing = run(['config', '--project', path.join(root, 'nowhere'), ...common]);
    assert.strictEqual(JSON.parse(missing.stdout).status, 'invalid');

    assert.strictEqual(run(['config', '--project', root]).status, 2);
  }
});

test('branch template commands use the profile of the project', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = profileCopy(t, fixture, (profile) => {
      profile.branchTemplate = 'work/{issue}/{slug}';
    });
    const dir = sandbox(t);
    const issue = run(['issue-number', '--branch', 'work/42/name', '--project', root]);
    assert.strictEqual(issue.stdout.trim(), '42', fixture);
    const other = run(['issue-number', '--branch', 'task/ISSUE-42-name', '--project', root]);
    assert.strictEqual(other.status, 0);
    assert.strictEqual(other.stdout.trim(), '');

    writeFile(dir, 'pulls.json', [
      { number: 5, head: { ref: 'work/41/a', repo: { full_name: 'o/r' } } },
      { number: 6, head: { ref: 'work/42/a', repo: { full_name: 'o/r' } } },
    ]);
    const found = run(['find-pr', '--pulls', path.join(dir, 'pulls.json'), '--issue', '42', '--repository', 'o/r', '--project', root]);
    assert.strictEqual(found.stdout.trim(), '6', fixture);

    writeFile(dir, 'pull.json', { number: 6, head_ref: 'work/42/a', head_repo: 'o/r', commit_shas: [HEAD_SHA] });
    writeFile(dir, 'round.json', { pr_number: 6, head_sha: HEAD_SHA });
    const checkArgs = (pullFile) => [
      'check-pr', '--pull', path.join(dir, pullFile), '--round', path.join(dir, 'round.json'),
      '--repository', 'o/r', '--project', root,
    ];
    assert.strictEqual(run(checkArgs('pull.json')).status, 0, fixture);
    writeFile(dir, 'other.json', { number: 6, head_ref: 'task/ISSUE-42-a', head_repo: 'o/r', commit_shas: [HEAD_SHA] });
    const rejected = run(checkArgs('other.json'));
    assert.strictEqual(rejected.status, 1);
    assert.match(rejected.stderr, /not on a task branch/);

    const brokenRoot = profileCopy(t, fixture, (profile) => {
      delete profile.apps;
    });
    assert.strictEqual(run(['issue-number', '--branch', 'x', '--project', brokenRoot]).status, 1);
  }
});

test('check-trigger answers run, skip or error', (t) => {
  const dir = sandbox(t);
  writeFile(dir, 'owners.json', ['maintainer']);
  writeFile(dir, 'timeline.json', [
    { event: 'labeled', label: { name: 'mark-for-analysis' }, actor: { login: 'maintainer' } },
  ]);
  const answer = (config, event = 'round', verdict = 'FAIL') => {
    writeFile(dir, 'config.json', config);
    const result = run([
      'check-trigger', '--event', event, '--verdict', verdict,
      '--config', path.join(dir, 'config.json'),
      '--owners', path.join(dir, 'owners.json'),
      '--pull-timeline', path.join(dir, 'timeline.json'),
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const enabled = { status: 'enabled', label: 'mark-for-analysis' };
  assert.match(answer(enabled), /^run: /);
  assert.match(answer(enabled, 'round', 'PASS'), /^skip: /);
  assert.match(answer(enabled, 'manual', ''), /^run: manual/);
  assert.match(answer({ status: 'disabled' }, 'manual', ''), /^skip: judge is disabled/);
  assert.match(answer({ status: 'invalid', reason: 'profile cannot be used' }), /^error: profile cannot be used/);
});

test('read-snapshot restores the rules of a round and policy-diff compares two rounds', (t) => {
  const runId = 321;
  const make = (fixture, options) =>
    snapshotOf(t, fixture, { origin: originOf({ run_id: runId, run_attempt: 1 }), ...options });
  const round = (snapshot) => {
    const dir = sandbox(t);
    writeFile(dir, 'snapshot.json', snapshot);
    writeFile(dir, 'provenance.json', { verifier_commit: FACTORY_SHA });
    const args = [
      'read-snapshot', '--inputs', INPUTS, '--provenance', path.join(dir, 'provenance.json'),
      '--run-id', String(runId), '--run-attempt', '2', '--head-sha', HEAD_SHA,
      '--out-dir', path.join(dir, 'trusted'), '--status-out', path.join(dir, 'policy-status.json'),
    ];
    return { dir, args: (...extra) => [...args, ...extra] };
  };

  for (const fixture of FIXTURE_PROFILES) {
    const before = round(make(fixture));
    const ok = run(before.args('--snapshot', path.join(before.dir, 'snapshot.json')));
    assert.strictEqual(ok.stdout.trim(), 'present', ok.stderr);
    const status = JSON.parse(fs.readFileSync(path.join(before.dir, 'policy-status.json'), 'utf8'));
    assert.strictEqual(status.attempt, 1);
    assert.ok(!('files' in status), 'the status record carries no file content');
    assert.ok(fs.existsSync(path.join(before.dir, 'trusted', 'verifier', 'prompt.md')));

    const after = round(
      make(fixture, {
        files: { '.github/verifier/owners.json': ['someone-else'] },
      }),
    );
    run(after.args('--snapshot', path.join(after.dir, 'snapshot.json')));
    const patch = path.join(after.dir, 'policy-diff.patch');
    const diff = run([
      'policy-diff', '--current', after.dir, '--previous', before.dir, '--inputs', INPUTS, '--out', patch,
    ]);
    assert.strictEqual(diff.status, 0, diff.stderr);
    const text = fs.readFileSync(patch, 'utf8');
    assert.match(text, /^--- previous\/project\/owners\.json$/m);
    assert.match(text, /^\+.*someone-else/m);
    assert.match(text, /^# unchanged: project\/profile\.json$/m);

    const first = run(['policy-diff', '--current', after.dir, '--previous', 'none', '--inputs', INPUTS]);
    assert.match(first.stdout, /first round/);

    // No snapshot file: the status says so and no rule file is written.
    const none = round(make(fixture));
    const missing = run(none.args('--missing-reason', 'the artifact has expired'));
    assert.strictEqual(missing.stdout.trim(), 'absent');
    assert.ok(!fs.existsSync(path.join(none.dir, 'trusted')));
    const reason = JSON.parse(fs.readFileSync(path.join(none.dir, 'policy-status.json'), 'utf8')).reason;
    assert.strictEqual(reason, 'the artifact has expired');
  }
  assert.strictEqual(run(['read-snapshot']).status, 2);
});
