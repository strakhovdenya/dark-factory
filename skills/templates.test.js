'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { FIXTURE_PROFILES, profileCopy } = require('../test/helpers/profiles');
const { REPO_ROOT, installFactoryPackage } = require('../test/helpers/factory-package');
const { buildTemplate, renderTemplate, validateOverlay } = require('./templates');

// Independent expectations: written out here, not taken from the module's own constants.
const PRD_HEADINGS = [
  'Goal',
  'Context and Project Alignment',
  'Dependencies',
  'User Scenarios',
  'In Scope',
  'Out of Scope',
  'Key Invariants',
  'Technical Constraints',
  'Acceptance Criteria',
  'Test Requirement (Sketch)',
  'Open Questions',
  'Documentation to Update',
  'Proposed Subtask Breakdown (only if this is an epic)',
];
// The earlier Russian name of every base section, in the same order; each must stay reserved.
const PRD_RUSSIAN_NAMES = [
  'Цель',
  'Контекст и согласованность с проектом',
  'Зависимости',
  'Пользовательские сценарии',
  'В скоупе',
  'Не в скоупе',
  'Ключевые инварианты',
  'Технические ограничения',
  'Критерии готовности (Acceptance Criteria)',
  'Test Requirement (набросок)',
  'Открытые вопросы',
  'Документация, которую потребуется обновить',
  'Предполагаемое дробление на подзадачи (только если это эпик)',
];
const PLAN_HEADINGS = ['Implementation Phases'];
const PLAN_RUSSIAN_NAMES = ['Фазы реализации'];
const PRD_META = ['**Date**', '**Status**: Draft', '**Affected part of the project**', '**Related issue/backlog item**'];
const PLAN_FIELDS = ['**Goal:**', '**Affects:**', '**Tasks:**', '**Done when:**'];
const CYRILLIC = /\p{Script=Cyrillic}/u;
// The five project sections of the example overlays must not be part of the shared base.
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples', 'profiles');
const PROJECT_SECTIONS = fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
  const file = path.join(EXAMPLES_DIR, entry.name, '.factory', 'overlays', 'prd.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).sections.map((section) => section.title);
});

const headings = (markdown, level = '## ') =>
  markdown
    .split('\n')
    .filter((line) => line.startsWith(level))
    .map((line) => line.slice(level.length));

const writeOverlay = (root, name, content) => {
  const file = path.join(root, '.factory', 'overlays', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

/** A temporary consumer of a fixture profile; `overlays` is the profile setting, `files` the overlay files. */
/** @typedef {{ overlays?: Record<string, string>, files?: Record<string, unknown> }} ConsumerOptions */

/** @type {(t: any, fixture: string, options?: ConsumerOptions) => string} */
const consumer = (t, fixture, { overlays, files = {} } = {}) => {
  const root = profileCopy(t, fixture, (profile) => {
    if (overlays !== undefined) profile.overlays = overlays;
  });
  for (const [name, content] of Object.entries(files)) writeOverlay(root, name, content);
  return root;
};

const THREE = [
  { title: 'Первый раздел', body: 'Тело первого.\n\n- пункт' },
  { title: 'Второй раздел', body: 'Тело второго.' },
  { title: 'Третий раздел', body: 'Тело третьего.' },
];

test('overlay adds sections to prd template', (t) => {
  for (const fixture of FIXTURE_PROFILES) {
    const root = consumer(t, fixture, { overlays: { prd: 'prd.json' }, files: { 'prd.json': { sections: THREE } } });
    const out = buildTemplate('prd', root);
    assert.deepEqual(headings(out), [...PRD_HEADINGS, ...THREE.map((section) => section.title)], fixture);
    assert.ok(out.startsWith('# PRD: {feature name}'), fixture);
    for (const meta of PRD_META) assert.ok(out.includes(meta), `${fixture}: ${meta}`);
    assert.ok(out.includes('No variation point'), 'content instructions of the base are kept');
    let from = out.indexOf('## Первый раздел');
    for (const section of THREE) {
      const at = out.indexOf(`## ${section.title}\n\n${section.body}`);
      assert.ok(at >= from, `${fixture}: ${section.title} follows the previous one with its body`);
      from = at;
    }
  }
});

test('overlay adds sections to plan template', (t) => {
  const sections = [
    { title: 'Риски', body: 'Что может пойти не так.' },
    { title: 'Допущения', body: 'На что опираемся.' },
  ];
  for (const fixture of FIXTURE_PROFILES) {
    const root = consumer(t, fixture, { overlays: { plan: 'plan.json' }, files: { 'plan.json': { sections } } });
    const out = buildTemplate('plan', root);
    assert.deepEqual(headings(out), [...PLAN_HEADINGS, 'Риски', 'Допущения'], fixture);
    assert.ok(out.startsWith('# Plan: {feature name}'), fixture);
    assert.ok(out.includes('**PRD:**') && out.includes('**Date:**'), fixture);
    assert.deepEqual(headings(out, '### '), ['Phase 1: {name}', 'Phase 2: {name}'], fixture);
    for (const field of PLAN_FIELDS) assert.ok(out.includes(field), `${fixture}: ${field}`);
    assert.ok(out.indexOf('Recommended epic base branch') < out.indexOf('## Риски'), 'base ends before the additions');
    assert.ok(out.endsWith('## Допущения\n\nНа что опираемся.\n'), fixture);
  }
});

test('no overlay yields base template', (t) => {
  const settings = [undefined, {}];
  for (const fixture of FIXTURE_PROFILES) {
    for (const overlays of settings) {
      const root = consumer(t, fixture, { overlays });
      const prd = buildTemplate('prd', root);
      assert.deepEqual(headings(prd), PRD_HEADINGS, fixture);
      for (const meta of PRD_META) assert.ok(prd.includes(meta), `${fixture}: ${meta}`);
      const plan = buildTemplate('plan', root);
      assert.deepEqual(headings(plan), PLAN_HEADINGS, fixture);
      for (const field of PLAN_FIELDS) assert.ok(plan.includes(field), field);
      assert.equal(PROJECT_SECTIONS.length, 5);
      for (const text of [prd, plan]) {
        for (const title of PROJECT_SECTIONS) assert.ok(!text.includes(title), `${fixture}: ${title}`);
      }
    }
  }
});

test('rejects overlay removing base template section', (t) => {
  const root = consumer(t, 'monorepo', {
    overlays: { prd: 'prd.json' },
    files: { 'prd.json': { removeSections: ['Acceptance Criteria'], sections: [] } },
  });
  assert.throws(() => buildTemplate('prd', root), /removeSections is not allowed.*Acceptance Criteria/s);
  assert.throws(() => buildTemplate('prd', root), (/** @type {Error} */ error) => error.message.includes('prd.json'));
});

test('rejects overlay renaming or duplicating base section', (t) => {
  const reject = (fixture, kind, overlay, expect) => {
    const root = consumer(t, fixture, { overlays: { [kind]: 'o.json' }, files: { 'o.json': overlay } });
    assert.throws(() => buildTemplate(kind, root), expect, JSON.stringify(overlay));
  };
  // The same shape for every base section of both kinds: new name, earlier Russian name and
  // spelling variants (case, runs of whitespace, tabs) are all duplicates of that base section.
  const bases = [
    ...PRD_HEADINGS.map((title, index) => ({ kind: 'prd', title, old: PRD_RUSSIAN_NAMES[index] })),
    ...PLAN_HEADINGS.map((title, index) => ({ kind: 'plan', title, old: PLAN_RUSSIAN_NAMES[index] })),
  ];
  for (const fixture of FIXTURE_PROFILES) {
    for (const { kind, title, old } of bases) {
      const variants = [title, ' ' + title.toUpperCase() + ' ', title.toLowerCase().replace(/ /g, '  '), old, old.toUpperCase(), old.replace(/ /g, '\t')];
      for (const variant of variants) {
        reject(fixture, kind, { sections: [{ title: variant, body: 'x' }] }, new RegExp('duplicates base section "' + title.replace(/[()]/g, '\\$&') + '"'));
        reject(fixture, kind, { sections: [{ title: 'Ok', body: 'a\n\n## ' + variant + '\n\nb' }] }, /has a heading .* that duplicates base section/);
      }
      reject(fixture, kind, { removeSections: [old], sections: [{ title: old, body: 'x' }] }, /removeSections is not allowed/);
    }
    // Acceptance Criteria stays reserved under its English name and the earlier forms.
    for (const variant of ['acceptance   criteria', 'Критерии\tготовности (acceptance criteria)', 'Критерии готовности']) {
      reject(fixture, 'prd', { sections: [{ title: variant, body: 'x' }] }, /duplicates base section "Acceptance Criteria"/);
    }
    // The shorter earlier names of the epic breakdown section stay reserved too.
    for (const variant of ['Предполагаемое дробление на подзадачи', 'Proposed Subtask Breakdown']) {
      reject(fixture, 'prd', { sections: [{ title: variant, body: 'x' }] }, /duplicates base section "Proposed Subtask Breakdown/);
    }
  }
  assert.throws(() => renderTemplate('prd', [{ title: 'Goal', body: 'x' }]), /duplicates base section/);
  assert.throws(() => renderTemplate('prd', [{ title: 'Цель', body: 'x' }]), /duplicates base section "Goal"/);
});

test('fails when referenced overlay file is missing', (t) => {
  for (const kind of /** @type {const} */ (['prd', 'plan'])) {
    const root = consumer(t, 'monorepo', { overlays: { [kind]: 'absent.json' } });
    assert.throws(() => buildTemplate(kind, root), (/** @type {Error} */ error) => error.message.includes('absent.json') && /cannot be read/.test(error.message));
  }
});

test('rejects malformed template overlays', (t) => {
  const ok = { title: 'Раздел', body: 'x' };
  /** @type {[any, RegExp][]} */
  const cases = [
    ['{ not json', /not valid|JSON/i],
    [[], /expected an object/],
    [{ sections: [ok], extra: 1 }, /unknown field "extra"/],
    [{ sections: 'x' }, /"sections" must be an array/],
    [{}, /"sections" must be an array/],
    [{ sections: ['x'] }, /sections\[0\] must be an object/],
    [{ sections: [{ ...ok, extra: 1 }] }, /sections\[0\]: unknown field "extra"/],
    [{ sections: [{ title: 5, body: 'x' }] }, /sections\[0\]\.title must be a string/],
    [{ sections: [{ title: 'Раздел' }] }, /sections\[0\]\.body must be a string/],
    [{ sections: [{ title: 'Раздел', body: null }] }, /sections\[0\]\.body must be a string/],
    [{ sections: [{ title: '   ', body: 'x' }] }, /sections\[0\]\.title must not be empty/],
    [{ sections: [{ title: 'Два\nряда', body: 'x' }] }, /sections\[0\]\.title must be a single line/],
    [{ sections: [{ title: 'A\rB', body: 'x' }] }, /single line/],
    [{ sections: [{ title: 'Раздел', body: 'a\n\n## цель\n\nb' }] }, /sections\[0\]\.body has a heading .*"цель"/],
    [{ sections: [ok, { title: ' РАЗДЕЛ ', body: 'y' }] }, /sections\[1\]\.title " ?РАЗДЕЛ ?|is used twice/],
  ];
  for (const [content, expect] of cases) {
    const root = consumer(t, 'single-package', { overlays: { prd: 'prd.json' }, files: { 'prd.json': content } });
    assert.throws(
      () => buildTemplate('prd', root),
      (/** @type {Error} */ error) => expect.test(error.message) && error.message.includes('prd.json'),
      JSON.stringify(content),
    );
  }
  assert.deepEqual(validateOverlay('prd', { sections: [] }, 'x.json'), []);
});

test('rejects template overlay paths outside project overlay directory', (t) => {
  const root = consumer(t, 'monorepo');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'prd.json'), JSON.stringify({ sections: [{ title: 'Чужой', body: 'x' }] }));
  fs.writeFileSync(path.join(root, '.factory', 'secret.json'), JSON.stringify({ sections: [{ title: 'Чужой', body: 'x' }] }));
  fs.mkdirSync(path.join(root, '.factory', 'overlays'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.factory', 'overlays', 'link'), 'junction');

  const absolute = path.join(outside, 'prd.json');
  for (const configured of [absolute, '/etc/prd.json', 'C:\\prd.json', '../secret.json', 'a/../../secret.json', '..\\secret.json', 'link/prd.json']) {
    const profilePath = path.join(root, '.factory', 'profile.json');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profile.overlays = { prd: configured };
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    assert.throws(
      () => buildTemplate('prd', root),
      (/** @type {Error} */ error) => error.message.includes(configured) && !error.message.includes('Чужой'),
      configured,
    );
  }
});

test('accepts overlay file names that start with two dots', (t) => {
  const sections = [{ title: 'Раздел', body: '# Вложенный\n\ntext' }];
  const root = consumer(t, 'monorepo', { overlays: { prd: '..prd.json' }, files: { '..prd.json': { sections } } });
  assert.ok(buildTemplate('prd', root).endsWith('## Раздел\n\n# Вложенный\n\ntext\n'));
});

test('does not load overlays for unselected template kind', (t) => {
  for (const [selected, other] of /** @type {const} */ ([['prd', 'plan'], ['plan', 'prd']])) {
    const root = consumer(t, 'single-package', { overlays: { [other]: 'missing.json' } });
    assert.equal(buildTemplate(selected, root), renderTemplate(selected));
    const broken = consumer(t, 'monorepo', { overlays: { [other]: 'broken.json' }, files: { 'broken.json': '{ nope' } });
    assert.equal(buildTemplate(selected, broken), renderTemplate(selected));
  }
});

// Real process of the installed CLI

const TEMPLATE_CLI = ['node_modules', 'dark-factory', 'skills', 'templates.js'];

/** A consumer in a directory with a space in its name, with the package installed under it. */
/** @type {(t: any, fixture: string, options?: ConsumerOptions) => { root: string, skillCopy: string }} */
const installedConsumer = (t, fixture, { overlays, files = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template consumer '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(REPO_ROOT, 'test', 'fixtures', 'profiles', fixture, '.factory', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (overlays !== undefined) profile.overlays = overlays;
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory', 'profile.json'), JSON.stringify(profile));
  for (const [name, content] of Object.entries(files)) writeOverlay(root, name, content);
  installFactoryPackage(path.join(root, 'node_modules'), { metaskills: 'none' });
  const skillCopy = path.join(root, '.claude', 'skills', 'prd');
  fs.mkdirSync(skillCopy, { recursive: true });
  return { root, skillCopy };
};

/** Runs the installed CLI as a separate Node process; ajv comes from this repository. */
const runCli = (root, cwd, args) => {
  const nodePath = [path.join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const result = childProcess.spawnSync(process.execPath, [path.join(root, ...TEMPLATE_CLI), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: nodePath },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const snapshotTree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test('installed template CLI renders English base templates in both profiles', (t) => {
  const prdOverlay = { sections: [{ title: 'Раздел проекта', body: 'Инструкции проекта.' }] };
  const planOverlay = { sections: [{ title: 'Риски плана', body: 'Что учесть.' }] };
  for (const fixture of FIXTURE_PROFILES) {
    const plain = installedConsumer(t, fixture);
    const withOverlay = installedConsumer(t, fixture, {
      overlays: { prd: 'prd.json', plan: 'nested/plan.json' },
      files: { 'prd.json': prdOverlay, 'nested/plan.json': planOverlay },
    });
    const before = snapshotTree(plain.root);

    const prd = runCli(plain.root, plain.skillCopy, ['prd', '--project', plain.root]);
    assert.equal(prd.status, 0, prd.stderr);
    assert.deepEqual(headings(prd.stdout), PRD_HEADINGS, fixture);
    assert.equal(prd.stdout, renderTemplate('prd'));
    const plan = runCli(plain.root, plain.skillCopy, ['plan', '--project', plain.root]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.deepEqual(headings(plan.stdout), PLAN_HEADINGS, fixture);
    assert.deepEqual(headings(plan.stdout, '### '), ['Phase 1: {name}', 'Phase 2: {name}'], fixture);
    for (const field of PLAN_FIELDS) assert.ok(plan.stdout.includes(field), `${fixture}: ${field}`);
    for (const meta of PRD_META) assert.ok(prd.stdout.includes(meta), `${fixture}: ${meta}`);
    for (const [kind, out] of [['prd', prd.stdout], ['plan', plan.stdout]]) {
      assert.doesNotMatch(out, CYRILLIC, `${fixture}: the ${kind} base has no Russian text`);
    }
    for (const name of [...PRD_RUSSIAN_NAMES, ...PLAN_RUSSIAN_NAMES]) {
      assert.ok(!headings(prd.stdout).includes(name) && !headings(plan.stdout).includes(name), `${fixture}: ${name} is not a separate section`);
    }
    assert.deepEqual(snapshotTree(plain.root), before, 'no document is created');

    const prdWith = runCli(withOverlay.root, withOverlay.skillCopy, ['prd', '--project', withOverlay.root]);
    assert.equal(prdWith.status, 0, prdWith.stderr);
    assert.deepEqual(headings(prdWith.stdout), [...PRD_HEADINGS, 'Раздел проекта'], fixture);
    assert.ok(prdWith.stdout.endsWith('## Раздел проекта\n\nИнструкции проекта.\n'));
    const planWith = runCli(withOverlay.root, withOverlay.skillCopy, ['plan', '--project', withOverlay.root]);
    assert.equal(planWith.status, 0, planWith.stderr);
    assert.deepEqual(headings(planWith.stdout), [...PLAN_HEADINGS, 'Риски плана'], fixture);
  }
});

test('template CLI reports errors without fallback output', (t) => {
  const good = installedConsumer(t, 'monorepo');
  const badProfile = installedConsumer(t, 'single-package', { overlays: { issue: 'issue.json' } });
  const broken = installedConsumer(t, 'monorepo', { overlays: { prd: 'broken.json' }, files: { 'broken.json': '{ nope' } });
  const missing = installedConsumer(t, 'single-package', { overlays: { plan: 'gone.json' } });
  const removing = installedConsumer(t, 'monorepo', {
    overlays: { prd: 'rm.json' },
    files: { 'rm.json': { removeSections: ['Acceptance Criteria'], sections: [] } },
  });
  const cases = [
    { target: good, args: ['unknown', '--project', good.root], stderr: /unknown template kind "unknown"/ },
    { target: good, args: ['issue', '--project', good.root], stderr: /unknown template kind "issue"/ },
    { target: good, args: ['prd'], stderr: /usage/ },
    { target: good, args: ['prd', '--project'], stderr: /usage/ },
    { target: good, args: ['prd', '--project', 'relative/root'], stderr: /absolute/ },
    { target: badProfile, args: ['prd', '--project', badProfile.root], stderr: /overlays\.issue/ },
    { target: good, args: ['prd', '--project', path.join(good.root, 'nowhere')], stderr: /Profile not found/ },
    { target: broken, args: ['prd', '--project', broken.root], stderr: /broken\.json/ },
    { target: missing, args: ['plan', '--project', missing.root], stderr: /gone\.json/ },
    { target: removing, args: ['prd', '--project', removing.root], stderr: /removeSections.*Acceptance Criteria/s },
  ];
  for (const { target, args, stderr } of cases) {
    const result = runCli(target.root, target.skillCopy, args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '', `no template on stdout: ${args.join(' ')}`);
    assert.match(result.stderr, stderr, args.join(' '));
  }
});
