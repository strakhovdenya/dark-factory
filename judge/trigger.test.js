'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EVENT_ROUND, EVENT_LABELED, EVENT_MANUAL, decideTrigger } = require('./trigger');
const { readJudgeConfig } = require('./config');
const { FIXTURE_PROFILES, profileCopy, enableJudge } = require('../test/helpers/profiles');

const LABEL = 'mark-for-analysis';
const OWNERS = ['maintainer'];
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

const labeledBy = (login, label = LABEL) => ({
  event: 'labeled',
  label: { name: label },
  actor: { login },
});

const unlabeledBy = (login, label = LABEL) => ({
  event: 'unlabeled',
  label: { name: label },
  actor: { login },
});

const ownerLabel = [labeledBy('maintainer')];

const enabledConfig = (label = LABEL) => ({ status: 'enabled', reason: 'enabled', label });

const input = (overrides = {}) => ({
  config: enabledConfig(),
  event: EVENT_ROUND,
  verdict: 'FAIL',
  owners: OWNERS,
  pullTimeline: [],
  issueTimeline: [],
  eventLabel: null,
  roundHead: HEAD,
  currentHead: HEAD,
  ...overrides,
});

test('skips when judge disabled in profile', (t) => {
  const variants = [
    (_profile) => {},
    (profile) => {
      profile.judge = { enabled: false };
    },
  ];
  for (const fixture of FIXTURE_PROFILES) {
    for (const mutate of variants) {
      const config = readJudgeConfig({ projectRoot: profileCopy(t, fixture, mutate) });
      for (const event of [EVENT_ROUND, EVENT_LABELED, EVENT_MANUAL]) {
        const result = decideTrigger(
          input({
            config,
            event,
            eventLabel: LABEL,
            pullTimeline: ownerLabel,
            issueTimeline: ownerLabel,
          }),
        );
        assert.strictEqual(result.run, false, `${fixture} ${event}`);
        assert.strictEqual(result.configError, false);
        assert.match(result.reason, /disabled/);
      }
    }
  }
});

test('analyses when enabled and owner set profile label', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const projectRoot = profileCopy(t, fixture, enableJudge(LABEL));
    const config = readJudgeConfig({ projectRoot });
    assert.strictEqual(config.status, 'enabled');
    for (const verdict of ['FAIL', 'NEEDS_HUMAN']) {
      const result = decideTrigger(input({ config, verdict, issueTimeline: ownerLabel }));
      assert.strictEqual(result.run, true, `${fixture} ${verdict}`);
      assert.match(result.reason, /issue/);
    }
    const onPull = decideTrigger(input({ config, pullTimeline: ownerLabel }));
    assert.strictEqual(onPull.run, true);
    assert.match(onPull.reason, /pull request/);
  }
});

test('distinguishes disabled judge from invalid configuration', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const disabled = readJudgeConfig({ projectRoot: profileCopy(t, fixture) });
    const noLabel = readJudgeConfig({
      projectRoot: profileCopy(t, fixture, (profile) => {
        profile.judge = { enabled: true };
      }),
    });
    const noProfile = readJudgeConfig({ projectRoot: profileCopy(t, fixture, (profile) => {
      delete profile.apps;
    }) });
    const badPin = readJudgeConfig({
      projectRoot: profileCopy(t, fixture, enableJudge(LABEL)),
      checkPin: () => {
        throw new Error('wrapper SHA differs from the pinned tag');
      },
    });
    const badTemplate = readJudgeConfig({
      projectRoot: profileCopy(t, fixture, (profile) => {
        enableJudge(LABEL)(profile);
        profile.branchTemplate = 'work/{slug}';
      }),
    });
    const skipped = decideTrigger(input({ config: disabled, pullTimeline: ownerLabel }));
    assert.strictEqual(skipped.configError, false);
    for (const config of [noLabel, noProfile, badPin, badTemplate]) {
      assert.strictEqual(config.status, 'invalid', fixture);
      const result = decideTrigger(
        input({ config, event: EVENT_MANUAL, pullTimeline: ownerLabel }),
      );
      assert.strictEqual(result.run, false);
      assert.strictEqual(result.configError, true);
      assert.notStrictEqual(result.reason, skipped.reason);
    }
    assert.match(noLabel.reason, /labels\.calibration/);
    assert.match(badPin.reason, /pin/);
  }
});

test('a profile that cannot be read is an invalid configuration, never a skip', (t) => {
  const missing = readJudgeConfig({ projectRoot: profileCopy(t, 'monorepo') + '-missing' });
  assert.strictEqual(missing.status, 'invalid');
  assert.match(missing.reason, /Profile not found/);
});

test('skips PASS even with owner label', () => {
  const result = decideTrigger(
    input({ verdict: 'PASS', issueTimeline: ownerLabel, pullTimeline: ownerLabel }),
  );
  assert.strictEqual(result.run, false);
});

test('skips pass verdict', () => {
  const result = decideTrigger(input({ verdict: 'PASS', pullTimeline: ownerLabel }));
  assert.strictEqual(result.run, false);
  assert.match(result.reason, /verdict/);
});

test('skips FAIL without label', () => {
  const result = decideTrigger(input());
  assert.strictEqual(result.run, false);
  assert.match(result.reason, /no label/);
});

test('skips NEEDS_HUMAN without label', () => {
  const result = decideTrigger(input({ verdict: 'NEEDS_HUMAN' }));
  assert.strictEqual(result.run, false);
});

test('skips label set by non-owner', () => {
  const byStranger = decideTrigger(input({ issueTimeline: [labeledBy('stranger')] }));
  const byBot = decideTrigger(input({ pullTimeline: [labeledBy('github-actions[bot]')] }));
  const byBotOwner = decideTrigger(
    input({
      owners: ['maintainer[bot]'],
      pullTimeline: [labeledBy('maintainer[bot]')],
    }),
  );
  assert.strictEqual(byStranger.run, false);
  assert.strictEqual(byBot.run, false);
  assert.strictEqual(byBotOwner.run, false);
});

test('skips when label was removed', () => {
  const result = decideTrigger(
    input({ pullTimeline: [labeledBy('maintainer'), unlabeledBy('maintainer')] }),
  );
  assert.strictEqual(result.run, false);
});

test('skips when verdict is missing or unknown', () => {
  for (const verdict of [undefined, null, '', 'pass', 'ERROR', 'UNKNOWN']) {
    const result = decideTrigger(
      input({ verdict, pullTimeline: ownerLabel, issueTimeline: ownerLabel }),
    );
    assert.strictEqual(result.run, false, String(verdict));
  }
});

test('without an issue timeline only the pull request label counts', () => {
  const result = decideTrigger(input({ issueTimeline: null, pullTimeline: ownerLabel }));
  assert.strictEqual(result.run, true);
});

test('handles late labels and current head completion', () => {
  const late = input({ event: EVENT_LABELED, eventLabel: LABEL, pullTimeline: ownerLabel });
  assert.strictEqual(decideTrigger(late).run, true);

  const older = decideTrigger({ ...late, roundHead: OLD_HEAD });
  const missing = decideTrigger({ ...late, roundHead: null });
  assert.strictEqual(older.run, false);
  assert.strictEqual(missing.run, false);
  assert.match(older.reason, /not finished on the current head/);

  const nextRound = decideTrigger(
    input({
      event: EVENT_ROUND,
      roundHead: HEAD,
      currentHead: OLD_HEAD,
      issueTimeline: ownerLabel,
    }),
  );
  assert.strictEqual(nextRound.run, true);
});

test('ignores label events for other labels', () => {
  const result = decideTrigger(
    input({ event: EVENT_LABELED, eventLabel: 'bug', pullTimeline: ownerLabel }),
  );
  assert.strictEqual(result.run, false);
});

test('runs once when both issue and pull request are labeled', () => {
  const result = decideTrigger(input({ issueTimeline: ownerLabel, pullTimeline: ownerLabel }));
  assert.strictEqual(result.run, true);
  assert.strictEqual(typeof result.reason, 'string');
});

test('uses the label name of the profile', () => {
  const timeline = [labeledBy('maintainer', 'another-name')];
  const other = decideTrigger(input({ pullTimeline: timeline }));
  const named = decideTrigger(
    input({ config: enabledConfig('another-name'), pullTimeline: timeline }),
  );
  assert.strictEqual(other.run, false);
  assert.strictEqual(named.run, true);
});

test('skips an unknown trigger event', () => {
  const result = decideTrigger(input({ event: 'push', pullTimeline: ownerLabel }));
  assert.strictEqual(result.run, false);
});

test('manual dispatch bypasses automatic label and verdict conditions only', () => {
  const manual = { event: EVENT_MANUAL, verdict: 'PASS', pullTimeline: [], issueTimeline: [] };
  assert.strictEqual(decideTrigger(input(manual)).run, true);
  assert.strictEqual(decideTrigger(input({ ...manual, verdict: '' })).run, true);
  const disabled = decideTrigger(input({ ...manual, config: { status: 'disabled' } }));
  assert.strictEqual(disabled.run, false);
  const invalid = decideTrigger(
    input({ ...manual, config: { status: 'invalid', reason: 'profile cannot be used' } }),
  );
  assert.strictEqual(invalid.run, false);
  assert.strictEqual(invalid.configError, true);
});
