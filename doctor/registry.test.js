'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry, Unavailable } = require('./registry');

test('runs every check and keeps unavailable and failing checks as problems', () => {
  const registry = createRegistry();
  registry.register({ name: 'found', run: () => [{ subject: 'a', reason: 'broken' }] });
  registry.register({ name: 'unreadable', run: () => { throw new Unavailable('no input'); } });
  registry.register({ name: 'crashing', run: () => { throw new Error('boom'); } });
  registry.register({ name: 'clean', run: () => [] });
  assert.deepEqual(registry.run({}), [
    { check: 'found', subject: 'a', reason: 'broken' },
    { check: 'unreadable', subject: 'unreadable', reason: 'check unavailable: no input' },
    { check: 'crashing', subject: 'crashing', reason: 'check failed unexpectedly: boom' },
  ]);
});

test('rejects a duplicate name and a check without run', () => {
  const registry = createRegistry();
  registry.register({ name: 'one', run: () => [] });
  assert.throws(() => registry.register({ name: 'one', run: () => [] }), /already registered/);
  assert.throws(() => registry.register({ name: 'two' }), /run must be a function/);
});
