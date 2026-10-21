'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Judge uses the verifier modules of the core instead of copies of them. The
// check substitutes those modules and loads Judge's own modules afresh, so a
// copy of the logic inside judge/ would not call the substitutes.

const CORE_LABEL_AUTHORITY = require.resolve('../verifier/label-authority');
const CORE_COMMON = require.resolve('../verifier/verdict/common');

const loadWithStubs = (t, modulePath, stubs) => {
  const target = require.resolve(modulePath);
  const saved = new Map();
  const remember = (key) => saved.set(key, require.cache[key]);
  remember(target);
  delete require.cache[target];
  for (const [key, exports] of Object.entries(stubs)) {
    remember(key);
    const stub = { id: key, filename: key, loaded: true, exports };
    require.cache[key] = /** @type {NodeJS.Module} */ (/** @type {unknown} */ (stub));
  }
  t.after(() => {
    for (const [key, original] of saved) {
      if (original === undefined) delete require.cache[key];
      else require.cache[key] = original;
    }
  });
  return require(target);
};

test('trigger and transitions call core verifier functions', (t) => {
  const asked = [];
  const authorizeLabel = (timeline, owners, label) => {
    asked.push({ timeline, owners, label });
    return { authorized: true, actor: 'stub' };
  };
  const { decideTrigger } = loadWithStubs(t, './trigger', {
    [CORE_LABEL_AUTHORITY]: { authorizeLabel },
  });
  const decision = decideTrigger({
    config: { status: 'enabled', label: 'calibration-label' },
    event: 'round',
    verdict: 'FAIL',
    owners: ['someone'],
    pullTimeline: ['pull-event'],
    issueTimeline: [],
  });
  assert.strictEqual(decision.run, true);
  assert.deepStrictEqual(asked, [
    { timeline: ['pull-event'], owners: ['someone'], label: 'calibration-label' },
  ]);

  const seenCriteria = [];
  const seenInvariants = [];
  const stubCommon = {
    isObject: (value) => value !== null && typeof value === 'object',
    isCriterion: (value) => (seenCriteria.push(value), true),
    isInvariant: (value) => (seenInvariants.push(value), true),
  };
  const { roundStatuses } = loadWithStubs(t, './transitions', { [CORE_COMMON]: stubCommon });
  const criterion = { id: 'AC-1', status: 'whatever', refs: [] };
  const invariant = { id: 'INV-1', status: 'whatever', refs: [] };
  const statuses = roundStatuses({ verdict: { criteria: [criterion], invariants: [invariant] } });
  assert.deepStrictEqual(seenCriteria, [criterion]);
  assert.deepStrictEqual(seenInvariants, [invariant]);
  assert.deepStrictEqual(statuses.items.get('AC-1').statuses, ['whatever']);
});

test('judge keeps no copy of the core verifier modules', () => {
  const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.js'));
  for (const copy of ['label-authority.js', 'common.js']) {
    assert.ok(!files.includes(copy), `${copy} must come from verifier/`);
  }
  const coreDirs = [path.dirname(CORE_LABEL_AUTHORITY), path.dirname(CORE_COMMON)];
  assert.ok(coreDirs.every((dir) => !dir.startsWith(__dirname)));
});
