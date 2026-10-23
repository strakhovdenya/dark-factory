---
name: plan
description: Splits a PRD into implementation phases. Use when there is a ready PRD (in the docs.prd directory of the project profile) and a development plan with independent phases is needed.
---

# Plan Generator

Read the PRD: `$ARGUMENTS` — if it is a file path, read it directly; if it is a kebab-case feature
name, look for `PRD-$ARGUMENTS.md` in the `docs.prd` directory from `.factory/profile.json`. If the
`docs.prd` field is missing and no path is given, ask the user.

If the PRD file is not found, report it and stop; do not make up the content of the PRD.

A PRD may be an earlier one with Russian section names (`Цель`, `В скоупе`, `Не в скоупе`,
`Критерии готовности (Acceptance Criteria)`, `Открытые вопросы`, `Предполагаемое дробление на
подзадачи` and so on) or a new one with English names (`Goal`, `In Scope`, `Out of Scope`,
`Acceptance Criteria`, `Open Questions`, `Proposed Subtask Breakdown`). Read both the same way; do
not translate or rename sections of an existing PRD.

Create an implementation plan and save it to the file `PLAN-<kebab-name>.md` (the same kebab-case
feature name as in the PRD file) in the `docs.plans` directory from `.factory/profile.json`. If the
`docs.plans` field is missing, do not choose a directory yourself; ask the user. If the directory
does not exist, create it.

This plan is a draft layout of the PRD into phases, not the GitHub issues themselves. The next step
after the plan is the `issues` skill, which files each phase as a milestone and each task as an
issue (the source of truth). The start of implementation of any phase still goes through the usual
Plan-first / Issue-first / Branch-first protocol of the `task-lifecycle` skill — this skill neither
replaces nor speeds it up.

## Plan structure

Get the template from the installed factory package — it is the only source of the structure and of
the content instructions of the sections; do not keep your own copy of the template. `<root>` is
the explicit absolute project root (the repository root), the path in quotes if it contains
spaces; the command does not depend on the current directory:

```sh
node "<root>/node_modules/dark-factory/skills/templates.js" plan --project "<root>"
```

The printed Markdown is the base of the document plus the project's additional sections (from the
profile overlay); they come after the base. Use the printed template whole and in its order. If the
command failed (non-zero code, the reason in stderr), stop and report the reason to the user; do
not substitute a template from memory.

Epic branch. Do not assemble the base branch name by hand: it is built by the existing
`branchNameFor` from the package's `profile/branch.js` — `branchNameFor(profile.branchTemplate,
<tracker number>, "<short epic name>-base")`:

```sh
node -e "const [root, issue, name] = process.argv.slice(1); const p = root + '/node_modules/dark-factory/'; const { loadProfile } = require(p + 'profile/load'); const { branchNameFor } = require(p + 'profile/branch'); console.log(branchNameFor(loadProfile(root).branchTemplate, Number(issue), name + '-base'))" "<root>" <tracker number> "<short epic name>"
```

The tracker number is known only after the tracking issue is filed; until it exists, state the rule
(`branchTemplate`, tracker number, the short epic name with the `-base` suffix) rather than making
up a number.

## Phase decomposition rules

- Each phase must deliver a working result.
- Phases are independent; it is possible to stop after any of them.
- The first phase is the minimal working path (Tracer Bullet).
- No more than five tasks in one phase.
- Apps of the project (different `apps[].path`) of one feature are different phases (do not mix
  tasks of different apps, for example backend and frontend, in one phase).
- **Cut tasks by complete capabilities, not by mechanical steps.** The chain "create an interface"
  → "create an implementation" → "wire it up" is not a decomposition: each such task leaves an
  unused boundary or unconnected code, and the next PR rewrites the previous one. Right: "add
  capability X through the existing boundary, with the first implementation and tests", then "add
  policy Y without changing consumers".
- If the PRD names a variation point, the task that introduces it puts the boundary in place at
  once together with the first implementation — so that the following tasks extend the behavior
  without edits to consumers.
- Do not create placeholder tasks for an abstraction that neither the current nor the next task
  needs.
- **Tests for the changed code are part of the same task that changes the code, not a separate
  "write tests" task at the end of the phase.** If the project checks the coverage of changes
  (patch coverage) as a mandatory status check when merging every single PR, then a PR that adds
  code not covered by tests physically cannot be merged on its own until a separate PR with tests
  for it arrives. In autonomous execution (for example, the Ralph loop, where each task = a
  separate PR) this makes the whole stack of the phase's tasks unmergeable until the last one
  arrives. Split the tasks so that each one that changes application source code includes the tests
  for this change in itself; a separate "test" task is acceptable only for end-to-end/integration
  coverage that physically cannot appear earlier than all the code of the phase exists (for
  example, an e2e scenario on top of several phases).

## Self-check before saving the file

Before writing the plan file — reread the draft and check it against the PRD:

- Each phase closes a concrete item of the PRD `## Acceptance Criteria` (in an earlier PRD,
  `## Критерии готовности (Acceptance Criteria)`) — recheck that the reference is right (open the
  PRD and find the item verbatim, not from memory).
- All the ACs of the PRD in sum are covered by some phase — none is lost or doubled without reason.
- Any reference to an ADR/section of a rule file/line number in another file is opened and
  confirmed, not estimated by eye.

## Rules

- Read the PRD carefully — the plan must cover all the items of the PRD `## Acceptance Criteria`.
- Do not add tasks that are not in the PRD (neither in `## In Scope` nor in `## Proposed Subtask
  Breakdown`, if the PRD contains it) — this skill lays the PRD out into phases, it does not invent
  a new scope.
- If the PRD is incomplete or open questions remain in it (`## Open Questions` is not empty), ask
  the user a question before creating the plan instead of building a plan on top of uncertainty.
- This skill does not create or edit code, branches, commits or GitHub issues — only the plan file
  itself. Issues are filed by the separate `issues` skill.
