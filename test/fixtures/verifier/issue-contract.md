# Issue contract (format v2)

This document explains the machine-checkable issue format. The rules
themselves live in `issue-contract.json` next to this file; that JSON is the
only source of rules for code (issue linter, verifier). This file is the
explanation for people and for the `issues` skill. It describes only the
format of an issue body, not how an issue is written or how a PR is judged.

## Parsing rules

- A section is a level-2 heading: `## <title>`.
- Only top-level list items count as items; nested items are part of their
  parent.
- Lines inside fenced code (```` ``` ```` or `~~~`) are never items and are not
  checked.

## Sections

| Section | Required | ID prefix |
| --- | --- | --- |
| `Контекст` | yes | — |
| `Affects` | yes | — |
| `Docs to Read` | yes | — |
| `Key Invariants` | yes | `INV` |
| `Acceptance Criteria` | yes | `AC` |
| `Test Requirement` | yes | `TR` |
| `Definition of Done` | yes | `DOD` |
| `Dependencies` | yes | — |
| `Manual verification (owner, not gated)` | no | — |

`Manual verification (owner, not gated)` is optional, holds owner-run checks
and never contains ID items; it is not judged.

## Item syntax

Checkable items (Acceptance Criteria, Definition of Done, Test Requirement):

```text
- [ ] AC-1 [behavior] <text>. Verify: <how>
```

- ID is `<prefix>-<n>`, `n` starts at 1; the prefix must match the section
  (`AC` in Acceptance Criteria, `DOD` in Definition of Done, `TR` in Test
  Requirement). An ID is unique within the issue.
- `[type]` is one of the item types below.
- `Verify:` follows the text after `. ` and must match the grammar of the type.

Invariants (Key Invariants):

```text
- INV-1 <text>
```

## Item types and `Verify:` grammar

| Type | Meaning | `Verify:` grammar |
| --- | --- | --- |
| `behavior` | runtime behavior proven by a named test | `Verify: <spec file path> "<test name>"` |
| `doc` | content of a documentation file | `Verify: <path>` |
| `config` | content of a configuration file | `Verify: <path>` |
| `ci` | a CI check on the PR head succeeds | `Verify: ci "<CI check name>"` |
| `absence` | a literal must not occur in a file | `Verify: absent "<literal>" in <path>` |

## Перечисления через запятую

A comma-separated list in the text of an item (for example «с колонками X, Y,
Z») names a set of required elements, not their order. Position is required
only when the item says so explicitly with «в этом порядке» or «в указанном
порядке».

- Без порядка: «таблица с колонками номер, ключ, head_sha» — проверяется
  наличие всех трёх колонок; порядок колонок в реализации произвольный.
- С порядком: «таблица с колонками в этом порядке: номер, ключ, head_sha» —
  порядок колонок входит в требование и проверяется.

## Forbidden wording

Items of Acceptance Criteria, Definition of Done, Test Requirement and Key
Invariants must not contain (case-insensitive) any phrase from
`forbiddenPhrases` in the JSON: they describe manual, local or process-only
steps that the verifier cannot check. Items also must not be conditional:
text starting with `Если ` / `If `, or containing `если применимо` /
`if applicable`. `Контекст` and `Manual verification (owner, not gated)` are
not checked.

## Пример

```markdown
## Контекст
Экспорт должен отдавать PDF с человекочитаемым именем файла.

## Affects
- `src/export/download-name.js`
- `src/export/download-name.spec.js`
- `docs/export.md`
- `config/export.json`

## Docs to Read
- `docs/export.md` — раздел «Имена файлов»

## Key Invariants
- INV-1 Каноническое имя артефакта на диске не меняется.
- INV-2 Имя файла не содержит символов разделителя пути.

## Acceptance Criteria
- [ ] AC-1 [behavior] buildDownloadName возвращает имя вида Company_Role_CV.pdf. Verify: src/export/download-name.spec.js "builds company and role name"
- [ ] AC-2 [doc] docs/export.md описывает формат имени файла. Verify: docs/export.md
- [ ] AC-3 [config] config/export.json задаёт суффикс CV. Verify: config/export.json
- [ ] AC-4 [absence] В модуле нет старого имени 04_cv_export.pdf. Verify: absent "04_cv_export.pdf" in src/export/download-name.js

## Test Requirement
- [ ] TR-1 [behavior] Тест отклоняет имя с символом слэша. Verify: src/export/download-name.spec.js "rejects slash in name"

## Definition of Done
- [ ] DOD-1 [ci] Проверка тестов на голове PR успешна. Verify: ci "Test (scripts)"

## Dependencies
Нет.
```
