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
| `Context` (or `Контекст`) | yes | — |
| `Affects` | yes | — |
| `Docs to Read` | yes | — |
| `Key Invariants` | yes | `INV` |
| `Acceptance Criteria` | yes | `AC` |
| `Test Requirement` | yes | `TR` |
| `Definition of Done` | yes | `DOD` |
| `Dependencies` | yes | — |
| `Manual verification (owner, not gated)` | no | — |

A section may have alternative names. The context section is accepted under
both names, `Context` and the earlier Russian `Контекст`; new issues use
`Context`, and neither name is deprecated or given an end date. A heading must match a name exactly (case-sensitive; trailing
spaces are ignored). Code finds a section by any of its names through this
contract; no other list of section names exists.

`Manual verification (owner, not gated)` is optional, holds owner-run checks
and never contains ID items; it is not judged.

## Project overlay

The contract is the core (`issue-contract.json`) plus the project's overlay,
`.github/verifier/issue-contract.overlay.json`, read from the default branch.
A missing file is an empty overlay. The overlay can only add:

```json
{
  "sections": [{ "title": "Rollout", "required": true, "idPrefix": null }],
  "forbiddenPhrases": ["hotfix on prod"]
}
```

A section may also carry `alternativeNames` and an `idPrefix` of its own.
An overlay cannot remove a base section or forbidden phrase, make a required
section optional, change an ID prefix, or reuse a name of an existing section.
Such an overlay, an unknown field or a malformed file makes the issue invalid
(`SPEC_INVALID`) with the reason named; it is never ignored.

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

## Comma-separated lists

A comma-separated list in the text of an item (for example "with columns X, Y,
Z") names a set of required elements, not their order. Position is required
only when the item says so explicitly with "in this order" or "in the given
order". Existing Russian issues state this with «в этом порядке» or «в указанном
порядке»; both forms are recognised the same way.

- Without order: "a table with columns number, key, head_sha" (Russian:
  «таблица с колонками номер, ключ, head_sha») — the presence of all three columns is
  checked; the order of the columns in the implementation is arbitrary.
- With order: "a table with columns in this order: number, key, head_sha"
  (Russian: «таблица с колонками в этом порядке: номер, ключ, head_sha») — the
  order of the columns is part of the requirement and is checked.

## Forbidden wording

Items of Acceptance Criteria, Definition of Done, Test Requirement and Key
Invariants must not contain (case-insensitive) any phrase from
`forbiddenPhrases` in the JSON: they describe manual, local or process-only
steps that the verifier cannot check. Items also must not be conditional:
text starting with `Если ` / `If `, or containing `если применимо` /
`if applicable`. `Context` / `Контекст` and `Manual verification (owner, not gated)` are
not checked.

## Example

```markdown
## Context
Problem: the export CLI (`scripts/export-name.js`) takes the output file name from the argument as is and writes the file under it. A name like `../x.pdf` writes a file outside the export directory.

Why it matters: the name comes from the user, so it is untrusted input that reaches a file system write. A file outside the export directory can overwrite other data.

After the task: the CLI checks the name before writing; a name with a path separator, or an empty one, is rejected with an error and no file is created. Valid names work as before. The restriction is described in `docs/export.md`.

Boundary: the file content format and the export directory do not change; there are no adjacent tasks.

## Affects
- `scripts/export-name.js`
- `scripts/export-name.spec.js`
- `docs/export.md`

## Docs to Read
- `docs/export.md` — section "File names"

## Key Invariants
- INV-1 The name is checked before the output file is written.

## Acceptance Criteria
- [ ] AC-1 [behavior] A valid name is accepted by the CLI. Verify: scripts/export-name.spec.js "accepts valid output name"
- [ ] AC-2 [behavior] Given a name contains a path separator When the CLI checks the name Then the command fails before the file is written. Verify: scripts/export-name.spec.js "rejects path separator before write"
- [ ] AC-3 [doc] The documentation describes the file name restriction. Verify: docs/export.md

## Test Requirement
- [ ] TR-1 [behavior] Given an empty name When the CLI checks the name Then the command fails. Verify: scripts/export-name.spec.js "rejects empty output name"

## Definition of Done
- [ ] DOD-1 [ci] The scripts check on the PR head succeeds. Verify: ci "Test (scripts)"

## Dependencies
None.
```
