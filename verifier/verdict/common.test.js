'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { labelOf, isReference } = require('./common');
const { ref } = require('./test-helpers');

test('labelOf uses the id of a v2 entry and the text of a legacy entry', () => {
  assert.strictEqual(labelOf({ id: 'AC-1', text: 'model text' }), 'AC-1');
  assert.strictEqual(labelOf({ id: '', text: 'model text' }), 'model text');
});

test('isReference rejects a reference without a known kind', () => {
  const withoutKind = ref();
  delete withoutKind.kind;
  assert.strictEqual(isReference(withoutKind), false);
  assert.strictEqual(isReference(ref({ kind: 'bogus' })), false);
  assert.strictEqual(isReference(ref()), true);
});
