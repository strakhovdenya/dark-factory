---
name: prd
description: Creates a PRD document for a new project feature in a structure consistent with the project's documentation, used when the requirements of a feature must be described before it goes into a plan and GitHub Issues.
---

# PRD generator

Create a PRD (Product Requirements Document) for the following feature: $ARGUMENTS

Save the result to the file `PRD-$ARGUMENTS.md` (translate the feature name to English and
kebab-case, for example `PRD-cover-letter-export.md`) in the `docs.prd` directory from
`.factory/profile.json`. If the profile has no `docs.prd` field, do not choose a directory
yourself; ask the user where to save the PRD. If the directory does not exist, create it.

This PRD is not a GitHub Issue. It is a "what and why" level document that precedes them: after the
PRD is agreed with the user, the next step is the `plan` skill (split the PRD into phases), then the
`issues` skill (file the phases/tasks as milestones/issues on GitHub — the source of truth). For a
feature that fits into one PR (not an epic — see "Epic mode" below) the task is filed as one GitHub
Issue directly, in the same format (the "Issue format" section of the `issues` skill), without an
intermediate plan file. Do not substitute these steps — the PRD must not contain a detailed
implementation plan (that is the job of the Issue itself, per the `issues` skill ("Issue format"),
at the Issue-first protocol stage of the `task-lifecycle` skill).

## Before writing

Read (briefly, only the needed sections — not whole files):

- The project rule files from `ruleFiles` of the `.factory/profile.json` profile (architecture,
  repository structure, rules mandatory for the feature).
- The project's ADR file (`docs.adr` of the profile), if it is configured — check whether the
  feature contradicts an accepted decision or belongs to a topic already closed by a decision (if
  it contradicts, do not silently ignore it; put it into the `## Open Questions` section below).
- The project's scope-rules document or backlog, if there is one — so as not to propose a feature
  that secretly moves deferred functionality into the current scope.
- Open issues/milestones on GitHub (`gh issue list`, and also the GitHub Project `githubProject`
  of the profile, if it is set) — to check that the feature does not duplicate what is already in
  progress or already done.
- **If the feature is already described as an epic/phase** — find it by the rules of the
  `epic-discovery` skill. Read the **whole** section of this epic (Goal/Business Value/Scope/Out of
  Scope/Dependencies/Acceptance Criteria), not only Goal — it is a mandatory source, not reference
  context: the "In Scope"/"Out of Scope"/"Acceptance Criteria" sections of the resulting PRD must
  be built as an explicit item-by-item reconciliation with this list, not a retelling from memory.
  Do not trust a progress summary file as a source of status (see the same skill).

When reading existing documents, accept both name sets: earlier PRDs and plans have Russian section
names (`Цель`, `В скоупе`, `Критерии готовности (Acceptance Criteria)` and so on), new ones are
English. Do not translate or rename sections of existing documents.

## Document structure

Get the template from the installed factory package — it is the only source of the structure and of
the content instructions of the sections; do not keep your own copy of the template. `<root>` is
the explicit absolute project root (the repository root), the path in quotes if it contains
spaces; the command does not depend on the current directory:

```sh
node "<root>/node_modules/dark-factory/skills/templates.js" prd --project "<root>"
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

## Epic mode

If the feature is, by its scale, an epic (several logically complete pieces of work that make no
sense to close in one PR — for example, it touches several apps of the project, or consists of
several independently testable steps), include in the document the section "## Proposed Subtask
Breakdown (only if this is an epic)" from the printed template. If the feature fits into one PR,
do not include this section at all (do not leave an empty heading).

If you are not sure whether it is an epic, ask the user explicitly instead of guessing.

This draft list is material for the `plan` skill (splitting into phases), not ready GitHub issues.
The final issues (with an exact `## Affects` and `## Acceptance Criteria` in the format of the
`issues` skill) are filed by that skill from the plan; this skill does not create them.

## Self-check before saving the file

Before writing the PRD file, reread your own draft and check it against the sources — do not rely
on the memory of what you just read:

- **Every statement about the project's mechanics** (invariants, service behavior, behavior of
  migrations/seed scripts and the like) — recheck verbatim against the source file, not against a
  retelling. The wording of invariants in the rule files is deliberately precise, and paraphrasing
  easily turns it into a statement with the opposite meaning.
- **Every reference to a line range** in a project document — open the file and confirm the range;
  do not estimate by eye.
- **If the feature corresponds to an epic** — check line by line the resulting `## In Scope`,
  `## Out of Scope`, `## Dependencies`, `## Acceptance Criteria` against the original lists of the
  epic: every source item is represented, and any item added on top of the source is explicitly
  marked (see the rule above).
- **The variation point** in `## Key Invariants` is either named together with the boundary through
  which it changes, or explicitly marked as absent; there is no empty or vague item ("the code
  must be flexible").
- If the self-check found an inaccuracy, fix it before saving the file; do not save a draft with a
  known error in the expectation of a later edit.

## Rules

- Write concretely — no filler.
- Acceptance criteria must be verifiable (checkbox format, no vague wording like "works well").
- Do not describe HOW to implement (code, concrete files, steps) — only WHAT and WHY. HOW is the
  subject of the GitHub Issue itself, written separately at the Issue-first protocol stage, already
  on the task branch.
- If the feature description is short or ambiguous, ask clarifying questions until you fully
  understand it, before creating the file. In particular clarify: which apps of the project are
  affected, whether the feature is in the current scope or is deferred functionality, whether there
  is a ready mockup/reference.
- Explicitly check the feature for a conflict with already accepted ADRs (the `docs.adr` file, if
  configured) and with the project's scope rules. If there is a conflict, do not hush it up and do
  not rewrite the decision yourself; put it into `## Open Questions` and ask the user directly.
- Do not move deferred functionality into the current scope without an explicit request from the
  user.
- This skill does not create or edit code, branches, commits — only the PRD file itself.
