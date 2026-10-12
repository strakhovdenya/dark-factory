'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  authorizeLabel,
  isLabelPresent,
  isBotLogin,
  parseArgs,
  main,
} = require('./label-authority.js');

const OWNERS = ['strakhovdenya'];
const LABEL = 'manual-verified';

const labeled = (login, label = LABEL) => ({
  event: 'labeled',
  label: { name: label },
  actor: { login },
});

const unlabeled = (login, label = LABEL) => ({
  event: 'unlabeled',
  label: { name: label },
  actor: { login },
});

test('authorizes a label whose last labeled event was set by an owner', () => {
  const result = authorizeLabel([labeled('strakhovdenya')], OWNERS, LABEL);
  assert.deepEqual(result, { authorized: true, actor: 'strakhovdenya' });
});

test('rejects a label set by a non-owner login', () => {
  const result = authorizeLabel([labeled('someone-else')], OWNERS, LABEL);
  assert.equal(result.authorized, false);
});

test('rejects a label set by a bot actor', () => {
  const result = authorizeLabel(
    [labeled('github-actions[bot]')],
    OWNERS,
    LABEL,
  );
  assert.equal(result.authorized, false);
});

test('rejects any login with a [bot] suffix, not only github-actions[bot]', () => {
  const result = authorizeLabel(
    [labeled('some-custom-app[bot]')],
    OWNERS,
    LABEL,
  );
  assert.equal(result.authorized, false);
});

test('rejects a label removed after being set by an owner', () => {
  const events = [labeled('strakhovdenya'), unlabeled('strakhovdenya')];
  const result = authorizeLabel(events, OWNERS, LABEL);
  assert.equal(result.authorized, false);
});

test('rejects a label re-applied by a non-owner after an owner', () => {
  const events = [labeled('strakhovdenya'), labeled('someone-else')];
  const result = authorizeLabel(events, OWNERS, LABEL);
  assert.equal(result.authorized, false);
});

test('rejects an empty timeline', () => {
  const result = authorizeLabel([], OWNERS, LABEL);
  assert.equal(result.authorized, false);
});

test('returns a null actor when no labeled event exists for the label', () => {
  const result = authorizeLabel(
    [unlabeled('strakhovdenya', 'other-label')],
    OWNERS,
    LABEL,
  );
  assert.deepEqual(result, { authorized: false, actor: null });
});

test('a labeled event with no actor login is present but has a null actor', () => {
  const events = [{ event: 'labeled', label: { name: LABEL }, actor: {} }];
  assert.equal(isLabelPresent(events, LABEL), true);
  assert.deepEqual(authorizeLabel(events, OWNERS, LABEL), {
    authorized: false,
    actor: null,
  });
});

test('ignores labeled and unlabeled events for other label names', () => {
  const events = [
    labeled('someone-else', 'other-label'),
    labeled('strakhovdenya'),
    unlabeled('strakhovdenya', 'other-label'),
  ];
  const result = authorizeLabel(events, OWNERS, LABEL);
  assert.deepEqual(result, { authorized: true, actor: 'strakhovdenya' });
});

test('isLabelPresent is true when the last event is labeled, by anyone', () => {
  assert.equal(isLabelPresent([labeled('someone-else')], LABEL), true);
  assert.equal(isLabelPresent([labeled('github-actions[bot]')], LABEL), true);
});

test('isLabelPresent is false when the last event is unlabeled', () => {
  const events = [labeled('strakhovdenya'), unlabeled('strakhovdenya')];
  assert.equal(isLabelPresent(events, LABEL), false);
});

test('isLabelPresent is false when there is no matching event', () => {
  assert.equal(isLabelPresent([], LABEL), false);
  assert.equal(
    isLabelPresent([labeled('strakhovdenya', 'other-label')], LABEL),
    false,
  );
});

test('isBotLogin only matches a [bot] suffix', () => {
  assert.equal(isBotLogin('github-actions[bot]'), true);
  assert.equal(isBotLogin('strakhovdenya'), false);
  assert.equal(isBotLogin('not-a-bot-really'), false);
});

const withTempFiles = (files, run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-authority-'));
  try {
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, content);
      paths[name] = filePath;
    }
    return run(paths);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const captureStdout = (run) => {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    const exitCode = run();
    return { exitCode, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
};

test('CLI prints true for an authorized label', () => {
  withTempFiles(
    {
      'timeline.json': JSON.stringify([labeled('strakhovdenya')]),
      'owners.json': JSON.stringify(OWNERS),
    },
    (paths) => {
      const { exitCode, output } = captureStdout(() =>
        main([
          '--timeline',
          paths['timeline.json'],
          '--owners',
          paths['owners.json'],
          '--label',
          LABEL,
        ]),
      );
      assert.equal(exitCode, 0);
      assert.equal(output.trim(), 'true');
    },
  );
});

test('CLI prints false and exits 0 for an unauthorized label', () => {
  withTempFiles(
    {
      'timeline.json': JSON.stringify([labeled('someone-else')]),
      'owners.json': JSON.stringify(OWNERS),
    },
    (paths) => {
      const { exitCode, output } = captureStdout(() =>
        main([
          '--timeline',
          paths['timeline.json'],
          '--owners',
          paths['owners.json'],
          '--label',
          LABEL,
        ]),
      );
      assert.equal(exitCode, 0);
      assert.equal(output.trim(), 'false');
    },
  );
});

test('CLI prints false and exits 0 on an unreadable file', () => {
  withTempFiles({ 'owners.json': JSON.stringify(OWNERS) }, (paths) => {
    const { exitCode, output } = captureStdout(() =>
      main([
        '--timeline',
        path.join(path.dirname(paths['owners.json']), 'missing.json'),
        '--owners',
        paths['owners.json'],
        '--label',
        LABEL,
      ]),
    );
    assert.equal(exitCode, 0);
    assert.equal(output.trim(), 'false');
  });
});

test('CLI --json prints authorized and actor', () => {
  withTempFiles(
    {
      'timeline.json': JSON.stringify([labeled('strakhovdenya')]),
      'owners.json': JSON.stringify(OWNERS),
    },
    (paths) => {
      const { exitCode, output } = captureStdout(() =>
        main([
          '--timeline',
          paths['timeline.json'],
          '--owners',
          paths['owners.json'],
          '--label',
          LABEL,
          '--json',
        ]),
      );
      assert.equal(exitCode, 0);
      assert.deepEqual(JSON.parse(output.trim()), {
        authorized: true,
        actor: 'strakhovdenya',
        present: true,
      });
    },
  );
});

test('parseArgs rejects missing required flags', () => {
  assert.equal(parseArgs(['--timeline', 'a.json']), null);
});
