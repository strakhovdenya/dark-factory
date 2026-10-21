'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildSchema } = require('./schema');

const TAXONOMY = {
  primary_cause: ['ISSUE_DEFECT', 'IMPLEMENTATION_DEFECT'],
  verdict: ['PASS', 'FAIL', 'UNDECIDABLE'],
};

test('resolves every taxonomy reference into an enum', () => {
  const template = {
    type: 'object',
    properties: {
      primary_cause: { $taxonomy: 'primary_cause' },
      nested: {
        type: 'array',
        items: { observed_verdict: { $taxonomy: 'verdict' } },
      },
    },
  };

  const schema = buildSchema(template, TAXONOMY);

  assert.deepStrictEqual(schema.properties.primary_cause, {
    type: 'string',
    enum: ['ISSUE_DEFECT', 'IMPLEMENTATION_DEFECT'],
  });
  assert.deepStrictEqual(schema.properties.nested.items.observed_verdict, {
    type: 'string',
    enum: ['PASS', 'FAIL', 'UNDECIDABLE'],
  });
  assert.ok(!JSON.stringify(schema).includes('$taxonomy'));
});

test('rejects unknown taxonomy key', () => {
  const template = { field: { $taxonomy: 'not_a_real_key' } };
  assert.throws(
    () => buildSchema(template, TAXONOMY),
    /unknown taxonomy key: not_a_real_key/,
  );
});

test('does not mutate the input template or taxonomy', () => {
  const template = { field: { $taxonomy: 'verdict' } };
  const templateCopy = JSON.parse(JSON.stringify(template));
  const taxonomyCopy = JSON.parse(JSON.stringify(TAXONOMY));
  buildSchema(template, TAXONOMY);
  assert.deepStrictEqual(template, templateCopy);
  assert.deepStrictEqual(TAXONOMY, taxonomyCopy);
});
