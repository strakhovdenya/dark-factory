'use strict';

// The one source of the shared PRD and plan templates and of their content instructions. The
// `prd` and `plan` skills get the template from this module's CLI:
//   node <root>/node_modules/dark-factory/skills/templates.js <prd|plan> --project <root>
// A project can only add sections after the base, through an overlay file named by
// `overlays.prd` / `overlays.plan` of its profile (a path relative to `.factory/overlays/`):
//   { "sections": [ { "title": "Section title", "body": "Instructions" } ] }
// Nothing here removes, renames or reorders a base section, and no profile value is executed.
// The base is English; the earlier Russian name of every base section stays in its `aliases`, so
// an overlay cannot reintroduce a section under the old name.

const fs = require('node:fs');
const path = require('node:path');
const { loadProfile } = require('../profile/load');

const KINDS = ['prd', 'plan'];
const OVERLAYS_DIR = path.join('.factory', 'overlays');

const PRD_HEADER = `# PRD: {feature name}

**Date**: {current date}
**Status**: Draft
**Affected part of the project**: {app/package from the profile \`apps\`, or several}
**Related issue/backlog item**: {link to an existing GitHub issue, if there is one, or
"new feature — not yet filed as an issue"}`;

/** @type {{ title: string, aliases?: string[], body: string }[]} */
const PRD_SECTIONS = [
  {
    title: 'Goal',
    aliases: ['Цель'],
    body: 'One or two sentences: what this is and why a user of the project needs it.',
  },
  {
    title: 'Context and Project Alignment',
    aliases: ['Контекст и согласованность с проектом'],
    body: `- Which layer/module of the project this touches (by the project's rule files).
- Which existing artifacts, data or contracts of the project this touches — if any, list which.
- Related ADRs (number + one line of the gist), if the feature continues or overlaps an already
  accepted decision.`,
  },
  {
    title: 'Dependencies',
    aliases: ['Зависимости'],
    body: `What must already be DONE before this feature makes technical sense (not just "it would be nice
to do that first", but a real prerequisite). If the feature corresponds to an epic from the
project's epic definitions — copy its \`## Dependencies\` list here item by item (epic/phase number +
current status: DONE/in progress/not started); do not paraphrase it or shorten the list. If some
dependency is not yet DONE, that is no reason to stay silent: put the conflict into
\`## Open Questions\`. If the feature is not tied to an epic and has no explicit technical
prerequisites, write "No explicit dependencies found".`,
  },
  {
    title: 'User Scenarios',
    aliases: ['Пользовательские сценарии'],
    body: '- The user {action} -> {result}',
  },
  {
    title: 'In Scope',
    aliases: ['В скоупе'],
    body: 'A concrete list of what is included in this iteration of the feature.',
  },
  {
    title: 'Out of Scope',
    aliases: ['Не в скоупе'],
    body: `Explicitly what we are not doing now (with a link to the decision, if there is one). If the
feature borders on deferred functionality, say explicitly that this part is left out. If the
feature corresponds to an epic — every item of its \`## Out of Scope\` must be represented here
(in your own words is fine, skipping items is not).`,
  },
  {
    title: 'Key Invariants',
    aliases: ['Ключевые инварианты'],
    body: `Non-obvious rules that constrain the implementation of this feature. Check first the rules from
the project's rule files and the accepted ADRs that concern the affected part.

- **Variation point** (mandatory item) — which part of the feature will change independently
  (provider, policy/rule, format/renderer, storage, pipeline step) and through which existing
  boundary it changes. If the current boundary is enough, say so; if there is no varying part,
  write "No variation point". Do not propose a new abstraction "for the future": it is justified
  only by a second implementation now or one that is already planned.`,
  },
  {
    title: 'Technical Constraints',
    aliases: ['Технические ограничения'],
    body: `Known constraints that must be taken into account (for example: do not bind to a specific
external SDK; unit tests must not depend on external services — by the project's rules).

If the feature introduces a new changeable policy, replacing it later must not require edits to
unrelated orchestration/domain modules.`,
  },
  {
    title: 'Acceptance Criteria',
    aliases: ['Критерии готовности (Acceptance Criteria)', 'Критерии готовности'],
    body: `Verifiable, concrete items — this list must be ready to copy directly into the future GitHub
Issue \`## Acceptance Criteria\`.

- [ ] Criterion 1
- [ ] Criterion 2

If the feature corresponds to an epic — every item of its \`## Acceptance Criteria\` must be
represented here. Any criterion that is not in the source epic but that you add yourself (for
example, by a direct requirement of the project's rules that the epic does not mention
explicitly) — mark with an inline note such as
\`*(added by this PRD, not from the epic definition — rationale: ...)*\`, so that the reader can see
what came from the source and what was added on top.`,
  },
  {
    title: 'Test Requirement (Sketch)',
    aliases: ['Test Requirement (набросок)'],
    body: `Which kinds of tests will be needed (unit / integration / manual verification by the project's
rules) — do not write a detailed test plan; that is decided in the GitHub Issue itself.`,
  },
  {
    title: 'Open Questions',
    aliases: ['Открытые вопросы'],
    body: `Everything to clarify with the user before this can be turned into a backlog task: unclear
scope, potential conflicts with an existing ADR, missing mockups/data.`,
  },
  {
    title: 'Documentation to Update',
    aliases: ['Документация, которую потребуется обновить'],
    body: `If the feature is architectural (a new/removed/renamed module, a changed data flow, a new
external interface, a changed state machine, a new ADR decision) — list what will need updating by
the project's documentation rules: rule files, the ADR file, the relevant documents.`,
  },
  {
    title: 'Proposed Subtask Breakdown (only if this is an epic)',
    aliases: [
      'Предполагаемое дробление на подзадачи (только если это эпик)',
      'Предполагаемое дробление на подзадачи',
      'Proposed Subtask Breakdown',
    ],
    body: `{this section appears only if the feature is an epic (see "Epic mode" of the \`prd\` skill) — otherwise do not include it in the file at all}

A draft, candidate list of topics for future tasks/issues — not the tasks themselves; the \`plan\`
skill splits it into phases and the \`issues\` skill files them as GitHub issues. Each item is the
topic of one task, not the task itself:

1. {short topic name} — {one sentence on what it covers and which Acceptance Criteria item of
   the PRD above falls into it}
2. ...

If the topics naturally depend on each other in order (for example data schema → backend endpoint
→ frontend) — list them in that order; this is a hint about sequence, not a hard requirement.

If the epic is large enough to need a \`-base\` integration branch — say so explicitly here in one
line ("Recommended epic base branch: \`<branch name>\`, because ..."), where the branch name is
derived by the \`prd\` skill rule from the profile's \`branchTemplate\`, but do not create the
branch and do not choose the tracker number — that is a separate manual step.`,
  },
];

const PLAN_HEADER = `# Plan: {feature name}

**PRD:** \`<docs.prd>/PRD-<kebab-name>.md\`
**Date:** {current date}`;

/** @type {{ title: string, aliases?: string[], body: string }[]} */
const PLAN_SECTIONS = [
  {
    title: 'Implementation Phases',
    aliases: ['Фазы реализации'],
    body: `### Phase 1: {name}
**Goal:** What this phase delivers
**Affects:** {apps from the profile \`apps\`, data stores, external interfaces}
**Tasks:**
- [ ] Task 1
- [ ] Task 2

**Done when:** closes item(s) of the PRD \`## Acceptance Criteria\`: "{verbatim or close
quote of the specific AC item}". Do not write a vague criterion such as "works fine" — only what
can be verified and what leads explicitly to a specific AC of the PRD.

### Phase 2: {name}
...

{If the phases together touch several apps of the project (or there are more than two, each an
independently testable step) — add one line after the list of phases: "Recommended epic base
branch: \`<branch name>\`, because ...", where the branch name is derived by the \`plan\` skill rule
from the profile's \`branchTemplate\`. Do not create the branch and do not choose the tracker
number — that is a separate manual step, as in /prd.}`,
  },
];

const BASES = {
  prd: { header: PRD_HEADER, sections: PRD_SECTIONS },
  plan: { header: PLAN_HEADER, sections: PLAN_SECTIONS },
};

/** Case and whitespace-insensitive form of a section title. */
const normalizeTitle = (title) => title.trim().replace(/\s+/g, ' ').toLowerCase();

/** Every name a base section answers to (its title and aliases), with the base title it belongs to. */
const baseNames = (kind) =>
  BASES[kind].sections.flatMap((entry) => [entry.title, ...(entry.aliases ?? [])].map((name) => ({ name, base: entry.title })));

const findClash = (kind, title) => baseNames(kind).find((entry) => normalizeTitle(entry.name) === normalizeTitle(title));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const unknownKind = (kind) => new Error(`unknown template kind "${kind}" (expected ${KINDS.join(' or ')})`);

const renderSection = (title, body) => `## ${title}\n\n${body}`;

/**
 * Markdown of the base template of `kind` followed by `additions` in order. Additions are
 * re-checked against the base names.
 * @param {'prd' | 'plan'} kind
 * @param {{ title: string, body: string }[]} [additions]
 */
function renderTemplate(kind, additions = []) {
  if (!KINDS.includes(kind)) throw unknownKind(kind);
  const { header, sections } = BASES[kind];
  for (const addition of additions) {
    const clash = findClash(kind, addition.title);
    if (clash) throw new Error(`section "${addition.title}" duplicates base section "${clash.base}"`);
  }
  const parts = [
    header,
    ...sections.map((entry) => renderSection(entry.title, entry.body)),
    ...additions.map((entry) => renderSection(entry.title.trim(), entry.body)),
  ];
  return `${parts.join('\n\n')}\n`;
}

/**
 * Checks a parsed overlay and returns its sections. `source` names the overlay file in errors.
 * @param {'prd' | 'plan'} kind
 * @param {any} overlay
 * @param {string} source
 * @returns {{ title: string, body: string }[]}
 */
function validateOverlay(kind, overlay, source) {
  const fail = (message) => {
    throw new Error(`Invalid template overlay ${source}: ${message}`);
  };
  if (!isPlainObject(overlay)) return fail('expected an object {"sections": [...]}');
  if ('removeSections' in overlay) {
    const removed = Array.isArray(overlay.removeSections) ? overlay.removeSections.map(String).join(', ') : String(overlay.removeSections);
    fail(`removeSections is not allowed: an overlay can only add sections, it cannot remove or rename "${removed}"`);
  }
  for (const key of Object.keys(overlay)) {
    if (key !== 'sections') fail(`unknown field "${key}"`);
  }
  if (!Array.isArray(overlay.sections)) fail('"sections" must be an array');
  const seen = new Set();
  return overlay.sections.map((entry, index) => {
    const where = `sections[${index}]`;
    if (!isPlainObject(entry)) fail(`${where} must be an object {"title", "body"}`);
    for (const key of Object.keys(entry)) {
      if (key !== 'title' && key !== 'body') fail(`${where}: unknown field "${key}"`);
    }
    if (typeof entry.title !== 'string') fail(`${where}.title must be a string`);
    if (typeof entry.body !== 'string') fail(`${where}.body must be a string`);
    const title = entry.title.trim();
    if (title === '') fail(`${where}.title must not be empty`);
    if (/[\r\n]/.test(title)) fail(`${where}.title must be a single line`);
    const clash = findClash(kind, title);
    if (clash) fail(`${where}.title "${title}" duplicates base section "${clash.base}"; a base section cannot be replaced or renamed`);
    const heading = /^#{1,2}[ 	]+(.+?)[ 	]*$/gm;
    for (const [, text] of entry.body.matchAll(heading)) {
      const bodyClash = findClash(kind, text);
      if (bodyClash) fail(`${where}.body has a heading "${text}" that duplicates base section "${bodyClash.base}"`);
    }
    const key = normalizeTitle(title);
    if (seen.has(key)) fail(`${where}.title "${title}" is used twice`);
    seen.add(key);
    return { title, body: entry.body };
  });
}

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * Absolute path of an overlay file named by the profile: a relative path that stays inside
 * `<root>/.factory/overlays/` by name and by realpath, and exists.
 * @param {string} projectRoot
 * @param {string} configured
 */
function resolveOverlayPath(projectRoot, configured) {
  const overlaysDir = path.join(path.resolve(projectRoot), OVERLAYS_DIR);
  const reject = (reason) => {
    throw new Error(`Template overlay path "${configured}" ${reason}; expected a file inside ${overlaysDir}`);
  };
  if (path.posix.isAbsolute(configured) || path.win32.isAbsolute(configured)) reject('is absolute');
  if (configured.split(/[\\/]+/).includes('..')) reject('contains a ".." segment');
  const file = path.resolve(overlaysDir, configured);
  if (!isInside(overlaysDir, file)) reject('is outside the overlay directory');
  let realFile;
  try {
    realFile = fs.realpathSync(file);
  } catch (error) {
    throw new Error(`Template overlay file ${file} cannot be read: ${error.message}`, { cause: error });
  }
  if (!isInside(fs.realpathSync(overlaysDir), realFile)) reject('resolves outside the overlay directory');
  return file;
}

/**
 * The template of `kind` for the consumer at `projectRoot`: the base plus the sections of the
 * overlay the profile names for this kind. Only that overlay is read. Throws on any problem;
 * there is no fallback to the base.
 * @param {'prd' | 'plan'} kind
 * @param {string} projectRoot
 */
function buildTemplate(kind, projectRoot) {
  if (!KINDS.includes(kind)) throw unknownKind(kind);
  const configured = loadProfile(projectRoot).overlays?.[kind];
  if (configured === undefined) return renderTemplate(kind);
  const file = resolveOverlayPath(projectRoot, configured);
  let overlay;
  try {
    overlay = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`Template overlay ${file} cannot be read as JSON: ${error.message}`, { cause: error });
  }
  return renderTemplate(kind, validateOverlay(kind, overlay, file));
}

const usage = () => `usage: node skills/templates.js <${KINDS.join('|')}> --project <absolute project root>`;

const parseArgs = (argv) => {
  const [kind, flag, root, ...rest] = argv;
  if (kind === undefined || flag !== '--project' || root === undefined || rest.length > 0) return null;
  return { kind, root };
};

/** Prints the template to stdout; any error exits non-zero with the reason on stderr. */
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  try {
    if (!KINDS.includes(args.kind)) throw unknownKind(args.kind);
    if (!path.isAbsolute(args.root)) throw new Error(`--project must be an absolute path, got "${args.root}"`);
    process.stdout.write(buildTemplate(args.kind, args.root));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { KINDS, OVERLAYS_DIR, PRD_SECTIONS, PLAN_SECTIONS, normalizeTitle, renderTemplate, validateOverlay, resolveOverlayPath, buildTemplate, main };
