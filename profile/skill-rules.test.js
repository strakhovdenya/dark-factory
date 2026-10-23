'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadProfile } = require('./load');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { BASE_SKILLS, requiredSkillsFor, requiredSkillDetailsFor } = require('./skill-rules');
const { profileCopy } = require('../test/helpers/profiles');

const root = path.resolve(__dirname, '..');
const FIXTURES = ['monorepo', 'single-package'];
const BASE = ['js-conventions', 'js-gof', 'js-data-structures', 'error-handling', 'modern-javascript'];

const fixture = (name) => loadProfile(path.join(root, 'test', 'fixtures', 'profiles', name));
const withProfile = (name, changes) => ({ ...fixture(name), ...changes });
const affects = (...lines) => `# Issue\n\n## Context\nMentions \`unrelated/other.ts\` here.\n\n## Affects\n${lines.map((line) => `- ${line}`).join('\n')}\n\n## Docs to Read\n- \`docs/read.ts\`\n`;

test('base skills are the five required JS metaskills', () => {
  assert.deepStrictEqual([...BASE_SKILLS], BASE);
});

test('ts file requires base metaskills in both fixture profiles', () => {
  for (const name of FIXTURES) {
    assert.deepStrictEqual(requiredSkillsFor(fixture(name), ['x.ts']), BASE, name);
  }
});

test('profile entry adds its skills to base', () => {
  const profile = withProfile('monorepo', {
    skillRules: [{ path: 'pkg/a', extensions: ['.ts'], label: 'a', skills: ['extra'] }],
  });
  assert.deepStrictEqual(requiredSkillsFor(profile, ['pkg/a/y.ts']), [...BASE, 'extra']);
});

test('markdown outside table requires no skills', () => {
  for (const name of FIXTURES) {
    assert.deepStrictEqual(requiredSkillsFor(fixture(name), ['notes.md']), [], name);
  }
});

test('adr file from profile requires adr skill', () => {
  const profile = withProfile('single-package', { docs: { adr: 'docs/decisions.md' } });
  assert.deepStrictEqual(requiredSkillsFor(profile, ['docs/decisions.md']), ['adr']);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['docs\\decisions.md']), ['adr']);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['./docs//decisions.md']), ['adr']);
  assert.deepStrictEqual(requiredSkillsFor(profile, affects('`docs/decisions.md`')), ['adr']);
});

test('uses affects paths instead of unrelated mentions', () => {
  const profile = withProfile('monorepo', {
    skillRules: [{ path: 'pkg/a', extensions: ['.ts'], label: 'a', skills: ['extra'] }],
  });
  assert.deepStrictEqual(requiredSkillsFor(profile, affects('`notes/readme.md`')), []);
  assert.deepStrictEqual(requiredSkillsFor(profile, affects('`pkg/a/y.ts`')), [...BASE, 'extra']);
  assert.deepStrictEqual(requiredSkillsFor(profile, '# No sections\n\n`x.ts` and `pkg/a/y.ts`\n'), []);
});

test('profile entry cannot drop base skills', () => {
  for (const name of FIXTURES) {
    const loaded = fixture(name);
    const variants = [
      { ...loaded, skillRules: undefined },
      { ...loaded, skillRules: [] },
      {
        ...loaded,
        skillRules: [{ path: 'pkg/a', extensions: ['.ts', '.test.ts'], label: 'x', skills: ['other'] }],
      },
    ];
    for (const profile of variants) {
      const skills = requiredSkillsFor(profile, ['pkg/a/y.ts']);
      for (const skill of BASE) assert.ok(skills.includes(skill), `${name}: ${skill}`);
    }
  }
  const noRules = fixture('single-package');
  assert.strictEqual('skillRules' in noRules, false);
});

test('profile entry matches whole path segment', () => {
  const profile = withProfile('monorepo', {
    skillRules: [{ path: 'pkg/a', extensions: ['.ts'], label: 'a', skills: ['extra'] }],
  });
  assert.deepStrictEqual(requiredSkillsFor(profile, ['pkg/ab/y.ts']), BASE);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['pkg/a']), []);
});

test('non-adr markdown does not require adr', () => {
  const profile = withProfile('single-package', { docs: { adr: 'docs/decisions.md' } });
  assert.deepStrictEqual(requiredSkillsFor(profile, ['notes/decisions.md']), []);
});

test('adr rule needs docs.adr and the exact file', () => {
  const plain = fixture('single-package');
  assert.deepStrictEqual(requiredSkillsFor(plain, ['docs/decisions.md']), []);
  const profile = withProfile('single-package', { docs: { adr: 'docs/decisions.md' } });
  // a directory is mentioned conservatively for code skills, but never adds adr
  for (const input of [affects('`docs/`'), affects('`docs`'), ['docs/'], ['docs']]) {
    assert.ok(!requiredSkillsFor(profile, input).includes('adr'));
  }
  const directory = withProfile('single-package', { docs: { adr: 'docs/adr/' } });
  for (const input of [['docs/adr/'], ['docs/adr']]) {
    assert.ok(!requiredSkillsFor(directory, input).includes('adr'));
  }
});

test('matches normalized directories and compound file extensions', () => {
  const profile = withProfile('monorepo', {
    skillRules: [
      { path: 'src', extensions: ['.test.ts'], label: 'tests', skills: ['tests'] },
      { path: '.', extensions: ['.css'], label: 'css', skills: ['styles'] },
      { path: 'packages\\ui', extensions: ['.tsx'], label: 'ui', skills: ['ui'] },
    ],
  });
  // compound extension is a file name suffix; a plain .ts file is not a test file
  assert.deepStrictEqual(requiredSkillsFor(profile, ['src/a.test.ts']), [...BASE, 'tests']);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['src/a.ts']), BASE);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['src/.test.ts']), BASE);
  // root entry covers the project, separators are normalized
  assert.deepStrictEqual(requiredSkillsFor(profile, ['a\\b\\c.css']), ['styles']);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['packages/ui/Button.tsx']), [...BASE, 'ui']);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['./packages//ui/Button.tsx']), [...BASE, 'ui']);
  // a directory mention is conservative: any entry whose area it overlaps
  assert.deepStrictEqual(requiredSkillsFor(profile, ['src/']), [...BASE, 'tests', 'styles']);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['packages']), []);
  assert.deepStrictEqual(requiredSkillsFor(profile, ['packages/']), [...BASE, 'styles', 'ui']);
  assert.deepStrictEqual(requiredSkillsFor(profile, affects('`src/`')), [...BASE, 'tests', 'styles']);
  assert.deepStrictEqual(requiredSkillsFor(profile, affects('`src/`', '`src/`')), [...BASE, 'tests', 'styles']);
  // a glob keeps its suffix filter
  assert.deepStrictEqual(requiredSkillsFor(profile, affects('`src/**/*.test.ts`')), [...BASE, 'tests']);
  assert.deepStrictEqual(requiredSkillsFor(profile, affects('`src/**/*.md`')), []);
  // a hidden directory without a trailing slash is a directory, not a file
  const hidden = withProfile('monorepo', {
    skillRules: [{ path: '.tools', extensions: ['.sh'], label: 'tools', skills: ['shell'] }],
  });
  assert.deepStrictEqual(requiredSkillsFor(hidden, affects('`.tools`')), [...BASE, 'shell']);
  // paths outside the project match nothing
  assert.deepStrictEqual(requiredSkillsFor(profile, ['../src/a.ts', '/src/a.ts']), []);
});

test('string and array forms use the same table', () => {
  for (const name of FIXTURES) {
    const profile = fixture(name);
    const paths = ['packages/storefront/a.tsx', 'notes.md'];
    const text = affects(...paths.map((p) => `\`${p}\``));
    assert.deepStrictEqual(requiredSkillsFor(profile, text), requiredSkillsFor(profile, paths));
  }
});

test('rejects unsupported input', () => {
  const profile = fixture('monorepo');
  assert.throws(() => requiredSkillsFor(profile, undefined), TypeError);
  assert.throws(() => requiredSkillsFor(profile, /** @type {any} */ ([1])), TypeError);
  assert.throws(() => requiredSkillsFor(null, []), TypeError);
  assert.throws(() => requiredSkillsFor({ docs: { adr: 5 } }, []), TypeError);
  const bad = [{ path: '../x', extensions: ['.ts'], skills: ['s'] }, { path: 'a', skills: ['s'] }, { path: 5 }];
  for (const rule of bad) {
    assert.throws(() => requiredSkillsFor({ skillRules: [rule] }, ['a/b.ts']), TypeError);
  }
});

test('base set matches the package content', () => {
  const baseSet = JSON.parse(fs.readFileSync(path.join(root, 'skills', 'base-set.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepStrictEqual(
    baseSet.processSkills.map((s) => s.name),
    ['prd', 'plan', 'issues', 'task-lifecycle', 'epic-discovery', 'adr'],
  );
  assert.deepStrictEqual(
    baseSet.jsMetaskills.map((s) => s.name).sort(),
    [...BASE, 'data-structures'].sort(),
  );
  assert.deepStrictEqual(baseSet.agents.map((a) => a.name), ['research', 'codebase-scan', 'verify', 'pr-writer']);
  for (const skill of [...baseSet.processSkills, ...baseSet.jsMetaskills]) {
    if (skill.source.kind === 'package-dir') {
      assert.ok(fs.existsSync(path.join(root, skill.source.path, 'SKILL.md')), skill.name);
    } else {
      assert.strictEqual(skill.source.kind, 'npm');
      assert.strictEqual(skill.source.version, pkg.dependencies[skill.source.package], skill.name);
    }
  }
  for (const agent of baseSet.agents) assert.ok(fs.existsSync(path.join(root, agent.path)), agent.name);
  assert.deepStrictEqual(baseSet.requiredJsSkills, BASE);
  const [codeReview] = baseSet.runtimeSkills;
  assert.strictEqual(codeReview.name, 'code-review');
  assert.strictEqual(codeReview.source.version.profileField, 'sandbox.claudeCodeVersion');
});

test('metaskills are a runtime dependency and exist in the installed package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.metaskills);
  assert.strictEqual(pkg.devDependencies.metaskills, undefined);
  const baseSet = require('../skills/base-set.json');
  for (const skill of baseSet.jsMetaskills.filter((s) => s.source.kind === 'npm')) {
    const file = path.join(root, 'node_modules', skill.source.package, skill.source.path, 'SKILL.md');
    assert.ok(fs.existsSync(file), skill.name);
  }
});

test('verify agent reads gates from the profile and has no project commands', () => {
  const text = fs.readFileSync(path.join(root, 'agents', 'verify.md'), 'utf8');
  for (const needle of ['apps[].gate', 'apps[].path', 'NOT RUN', 'NOT COVERED', 'No checks were run']) {
    assert.ok(text.includes(needle), needle);
  }
  assert.ok(!text.includes(['apps', 'api'].join('/')));
  assert.ok(!text.includes('test:e2e'));
});

test('issues and task-lifecycle use the installed factory linter and contract', () => {
  const read = (name) => fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
  const issues = read('issues');
  assert.ok(issues.includes('node node_modules/dark-factory/verifier/issue-lint.js <file> --require-v2'));
  assert.ok(issues.includes('node_modules/dark-factory/verifier/issue-contract.md'));
  for (const text of [issues, read('task-lifecycle')]) {
    assert.ok(!text.includes('.github/verifier/issue-contract.md'));
  }
  assert.ok(!issues.includes('scripts/issue-lint.js'));
  assert.ok(!read('task-lifecycle').includes('git-closure-gate-hook.js'));
  const adr = read('adr');
  assert.ok(!adr.includes('FILE_RULES'));
  assert.ok(adr.includes('docs.adr') && adr.includes('no ADR file is\n  configured'));
});

const SKILL_GATE = path.join(root, 'hooks', 'skill-gate.js');
const gateMessage = (projectRoot, relative) => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectRoot };
  const input = JSON.stringify({ session_id: `skill-rules-test-${process.pid}-none`, tool_input: { file_path: path.join(projectRoot, relative) } });
  const result = spawnSync(process.execPath, [SKILL_GATE], { input, encoding: 'utf8', cwd: os.tmpdir(), env });
  assert.strictEqual(result.status, 2, result.stderr);
  return result.stderr;
};

const LABELLED_RULES = [
  { path: 'pkg/ui', extensions: ['.tsx'], label: 'ui', skills: ['ui-patterns', 'js-gof'] },
  { path: 'pkg', extensions: ['.tsx', '.css'], label: 'pkg', skills: ['styles'] },
  { path: 'pkg/ui', extensions: ['.tsx'], label: 'ui', skills: ['a11y'] },
  { path: 'other', extensions: ['.tsx'], label: 'other area', skills: ['other'] },
];

test('hook details preserve requiredSkillsFor results and project labels', (t) => {
  for (const name of FIXTURES) {
    const profile = withProfile(name, { skillRules: LABELLED_RULES, docs: { adr: 'docs/adr.md' } });
    const cases = [
      [['pkg/ui/Button.tsx'], [...BASE, 'ui-patterns', 'styles', 'a11y'], ['ui', 'pkg']],
      [['pkg/ui/x.css'], ['styles'], ['pkg']],
      [['src/a.ts'], BASE, []],
      [['docs/adr.md'], ['adr'], []],
      [['pkg/ui/Button.tsx', 'docs/adr.md'], [...BASE, 'adr', 'ui-patterns', 'styles', 'a11y'], ['ui', 'pkg']],
      [affects('`pkg/ui/Button.tsx`'), [...BASE, 'ui-patterns', 'styles', 'a11y'], ['ui', 'pkg']],
      [['notes.md'], [], []],
    ];
    for (const [input, skills, labels] of cases) {
      const details = requiredSkillDetailsFor(profile, input);
      assert.deepStrictEqual(details, { skills, labels }, `${name}: ${input}`);
      assert.deepStrictEqual(requiredSkillsFor(profile, input), details.skills, `${name}: ${input}`);
    }
    const projectRoot = profileCopy(t, name, (copy) => {
      copy.skillRules = LABELLED_RULES;
    });
    const message = gateMessage(projectRoot, 'pkg/ui/Button.tsx');
    assert.ok(message.includes('editing pkg/ui/Button.tsx (ui, pkg) requires'), name);
    assert.ok(message.includes(`session yet: ${[...BASE, 'ui-patterns', 'styles', 'a11y'].join(', ')}.`), name);
  }
});

test('hook details ignore unmatched labels without weakening base skills', (t) => {
  for (const name of FIXTURES) {
    const profile = withProfile(name, { skillRules: LABELLED_RULES });
    const details = requiredSkillDetailsFor(profile, ['src/main.ts']);
    assert.deepStrictEqual(details, { skills: BASE, labels: [] }, name);
    assert.ok(!requiredSkillDetailsFor(profile, ['pkg/ui/Button.tsx']).labels.includes('other area'));
    const projectRoot = profileCopy(t, name, (copy) => {
      copy.skillRules = LABELLED_RULES;
    });
    const message = gateMessage(projectRoot, 'src/main.ts');
    assert.ok(message.includes('editing src/main.ts requires'), name);
    for (const label of ['other area', '(ui', '(pkg']) assert.ok(!message.includes(label), `${name}: ${label}`);
    assert.ok(message.includes(`session yet: ${BASE.join(', ')}.`), name);
  }
});
