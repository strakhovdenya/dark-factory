'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  OverlayError,
  buildContract,
  canonicalNames,
  loadCore,
  mergeOverlay,
} = require('./issue-contract');

const core = loadCore();
const titles = (contract) => contract.sections.map((section) => section.title);
const reject = (overlay, expected) =>
  assert.throws(() => mergeOverlay(core, overlay), (error) => {
    assert.ok(error instanceof OverlayError);
    assert.match(error.message, expected);
    return true;
  });

test('overlay adds section and forbidden phrase', () => {
  const contract = mergeOverlay(core, {
    sections: [{ title: 'Rollout', required: true, idPrefix: null }],
    forbiddenPhrases: ['hotfix on prod'],
  });
  assert.deepStrictEqual(titles(contract), [...titles(core), 'Rollout']);
  assert.ok(contract.forbiddenPhrases.includes('hotfix on prod'));
  for (const phrase of core.forbiddenPhrases) assert.ok(contract.forbiddenPhrases.includes(phrase));
  assert.deepStrictEqual(core.sections.length + 1, contract.sections.length);
});

test('overlay may add a section with its own ID prefix', () => {
  const contract = mergeOverlay(core, {
    sections: [{ title: 'Risks', required: false, idPrefix: 'RSK', alternativeNames: ['Риски'] }],
  });
  assert.strictEqual(canonicalNames(contract).get('Риски'), 'Risks');
});

test('rejects overlay removing base section', () => {
  reject({ removeSections: ['Acceptance Criteria'] }, /remove base section: Acceptance Criteria/);
});

test('rejects overlay removing forbidden phrase', () => {
  reject({ removeForbiddenPhrases: ['manually'] }, /remove base forbidden phrase: manually/);
});

test('rejects overlay weakening base section', () => {
  reject({ sections: [{ title: 'Acceptance Criteria', required: false, idPrefix: 'AC' }] }, /Acceptance Criteria/);
  reject({ sections: [{ title: 'Acceptance Criteria', required: true, idPrefix: 'XX' }] }, /Acceptance Criteria/);
  reject({ sections: [{ title: 'Context', required: false }] }, /section Context already exists/);
  reject({ sections: [{ title: 'Rollout', required: true, idPrefix: 'AC' }] }, /idPrefix AC is already used/);
});

test('rejects unknown overlay fields and malformed overlays', () => {
  reject({ itemTypes: {} }, /unknown field: itemTypes/);
  reject([], /must be a JSON object/);
  reject({ sections: [{ title: 'X' }] }, /required must be true or false/);
  reject({ forbiddenPhrases: [''] }, /forbiddenPhrases/);
});

test('missing overlay file yields core contract', () => {
  const missing = path.join(os.tmpdir(), 'no-such-dir-issue-contract', 'overlay.json');
  assert.deepStrictEqual(buildContract(missing), core);
});

test('buildContract rejects an overlay file that is not JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-contract-'));
  const file = path.join(dir, 'overlay.json');
  fs.writeFileSync(file, '{oops');
  assert.throws(() => buildContract(file), OverlayError);
  fs.rmSync(dir, { recursive: true });
});

test('core gives the context section the alternative name Context', () => {
  const section = core.sections.find((item) => item.title === 'Контекст');
  assert.deepStrictEqual(section.alternativeNames, ['Context']);
});
