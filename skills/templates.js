'use strict';

// The one source of the shared PRD and plan templates and of their content instructions. The
// `prd` and `plan` skills get the template from this module's CLI:
//   node <root>/node_modules/dark-factory/skills/templates.js <prd|plan> --project <root>
// A project can only add sections after the base, through an overlay file named by
// `overlays.prd` / `overlays.plan` of its profile (a path relative to `.factory/overlays/`):
//   { "sections": [ { "title": "Section title", "body": "Instructions" } ] }
// Nothing here removes, renames or reorders a base section, and no profile value is executed.

const fs = require('node:fs');
const path = require('node:path');
const { loadProfile } = require('../profile/load');

const KINDS = ['prd', 'plan'];
const OVERLAYS_DIR = path.join('.factory', 'overlays');
const ACCEPTANCE_TITLE = 'Критерии готовности (Acceptance Criteria)';

const PRD_HEADER = `# PRD: {название фичи}

**Дата**: {текущая дата}
**Статус**: Draft
**Затрагиваемая часть проекта**: {приложение/пакет из \`apps\` профиля, либо несколько}
**Связанный issue/backlog-пункт**: {ссылка на существующий GitHub issue, если уже есть, либо
"новая фича — ещё не заведена как issue"}`;

/** @type {{ title: string, aliases?: string[], body: string }[]} */
const PRD_SECTIONS = [
  {
    title: 'Цель',
    body: 'Одно-два предложения: что и зачем это нужно пользователю проекта.',
  },
  {
    title: 'Контекст и согласованность с проектом',
    body: `- Какой слой/модуль проекта это затрагивает (по файлам правил проекта).
- Какие существующие артефакты, данные или контракты проекта это затрагивает — если да,
  перечисли какие.
- Связанные ADR (номер + одна строка сути), если фича продолжает или пересекается с уже принятым
  решением.`,
  },
  {
    title: 'Зависимости',
    body: `Что должно уже быть DONE, прежде чем эта фича имеет смысл технически (не просто "было бы неплохо
сделать сначала", а реальная предпосылка). Если фича соответствует эпику из определения эпиков
проекта — скопируй сюда его \`## Dependencies\` список пункт за пунктом (номер эпика/фазы + текущий
статус: DONE/в работе/не начато), не пересказывай своими словами и не сокращай список. Если какая-то
зависимость ещё не DONE — это не повод молчать, вынеси конфликт в \`## Открытые вопросы\`. Если
фича не завязана на эпик и явных технических предпосылок нет — напиши "Явных зависимостей не
найдено".`,
  },
  {
    title: 'Пользовательские сценарии',
    body: '- Пользователь {действие} -> {результат}',
  },
  {
    title: 'В скоупе',
    body: 'Конкретный список того, что входит в эту итерацию фичи.',
  },
  {
    title: 'Не в скоупе',
    body: `Явно то, что не делаем сейчас (со ссылкой на решение, если оно есть). Если фича граничит с
отложенной функциональностью, явно скажи, что эта часть остаётся за скобками. Если фича
соответствует эпику — каждый пункт его \`## Out of Scope\` должен быть представлен здесь (своими
словами нормально, пропускать пункты — нет).`,
  },
  {
    title: 'Ключевые инварианты',
    body: `Неочевидные правила, которые ограничивают реализацию этой фичи. Проверяй в первую очередь правила
из файлов правил проекта и принятые ADR, которые касаются затрагиваемой части.

- **Точка вариативности** (обязательный пункт) — какая часть фичи будет меняться независимо
  (провайдер, политика/правило, формат/рендерер, хранилище, шаг пайплайна) и через какую
  существующую границу она меняется. Если текущей границы хватает — так и напиши; если
  вариативной части нет — напиши "Точки вариативности нет". Не предлагай новую абстракцию «на
  будущее»: она оправдана только второй реализацией сейчас или уже запланированной.`,
  },
  {
    title: 'Технические ограничения',
    body: `Известные ограничения, которые нужно учесть (например: не привязываться к конкретному внешнему
SDK; unit-тесты не должны зависеть от внешних сервисов — по правилам проекта).

Если фича вводит новую изменяемую политику, её последующая замена не должна требовать правок
несвязанных модулей оркестрации/домена.`,
  },
  {
    title: ACCEPTANCE_TITLE,
    aliases: ['Acceptance Criteria'],
    body: `Проверяемые, конкретные пункты — этот список должен быть готов к прямому копированию в будущий
GitHub Issue \`## Acceptance Criteria\`.

- [ ] Критерий 1
- [ ] Критерий 2

Если фича соответствует эпику — каждый пункт его \`## Acceptance Criteria\` должен быть представлен
здесь. Любой критерий, которого нет в исходном эпике, но который ты добавляешь сам (например, по
прямому требованию правил проекта, не упомянутому явно в эпике) — помечай инлайн-пометкой вроде
\`*(добавлено этим PRD, не из определения эпика — обоснование: ...)*\`, чтобы при чтении было видно,
что взято из источника, а что добавлено сверху.`,
  },
  {
    title: 'Test Requirement (набросок)',
    body: `Какие типы тестов понадобятся (unit / интеграционные / ручная проверка по правилам проекта) — не
пиши тест-план в деталях, это решается в самом GitHub Issue.`,
  },
  {
    title: 'Открытые вопросы',
    body: `Всё, что нужно уточнить у пользователя, прежде чем это можно будет оформить как задачу в backlog:
неясности в скоупе, потенциальные конфликты с существующим ADR, недостающие мокапы/данные.`,
  },
  {
    title: 'Документация, которую потребуется обновить',
    body: `Если фича архитектурная (новый/удалённый/переименованный модуль, изменённый data flow, новый
внешний интерфейс, изменённый конечный автомат, новое ADR-решение) — перечисли, что потребует
обновления по правилам документации проекта: файлы правил, файл ADR, соответствующие документы.`,
  },
  {
    title: 'Предполагаемое дробление на подзадачи (только если это эпик)',
    body: `{раздел появляется, только если фича — эпик (см. "Режим эпика" скилла \`prd\`) — иначе не включай его в файл вообще}

Черновой, кандидатный список тем для будущих задач/issues — не сами задачи, это разбивает скилл
\`plan\` на фазы, а скилл \`issues\` заводит как GitHub issues. Каждый пункт — тема одной задачи, не
сама задача:

1. {короткое название темы} — {одно предложение, что она покрывает и какой Acceptance Criteria
   из PRD выше в неё попадает}
2. ...

Если темы естественно зависят друг от друга по порядку (например, схема данных → backend endpoint
→ frontend) — перечисли их в этом порядке; это подсказка для последовательности, не жёсткое
требование.

Если эпик достаточно большой, чтобы потребовать \`-base\` интеграционную ветку — явно скажи это
здесь одной строкой ("Рекомендуется epic base branch: \`<имя ветки>\`, т.к. ..."), где имя ветки
выведено по правилу скилла \`prd\` из \`branchTemplate\` профиля, но не создавай ветку и не
выбирай номер трекера — это отдельный ручной шаг.`,
  },
];

const PLAN_HEADER = `# Plan: {название фичи}

**PRD:** \`<docs.prd>/PRD-<kebab-name>.md\`
**Дата:** {текущая дата}`;

/** @type {{ title: string, aliases?: string[], body: string }[]} */
const PLAN_SECTIONS = [
  {
    title: 'Фазы реализации',
    body: `### Фаза 1: {название}
**Цель:** Что даёт эта фаза
**Затрагивает:** {приложения из \`apps\` профиля, хранилища данных, внешние интерфейсы}
**Задачи:**
- [ ] Задача 1
- [ ] Задача 2

**Когда готова:** закрывает пункт(ы) \`## Критерии готовности\` PRD: "{дословная или близкая
цитата конкретного AC-пункта}". Не пиши расплывчатый критерий вроде "работает нормально" —
только то, что можно проверить и что явно ведёт к конкретному AC из PRD.

### Фаза 2: {название}
...

{Если фазы вместе затрагивают несколько приложений проекта (или их больше двух, и каждая — независимо
тестируемый шаг) — добавь после списка фаз одну строку: "Рекомендуется epic base branch:
\`<имя ветки>\`, т.к. ...", где имя ветки выведено по правилу скилла \`plan\` из \`branchTemplate\`
профиля. Не создавай ветку и не выбирай номер трекера — это отдельный ручной шаг, как в /prd.}`,
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
