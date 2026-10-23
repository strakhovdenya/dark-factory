---
name: issues
description: Creates GitHub issues and milestones from a plan file (in the profile's docs.plans directory) and sets the format and verifiability rules for any single issue created by hand through gh issue create. Use when there is a ready plan with phases, and ALWAYS before creating or editing the body of any issue.
---

# Issues Generator

Read the plan from the file: $ARGUMENTS

If `$ARGUMENTS` is not given, ask the user for the path to the plan file
(`PLAN-<kebab-name>.md` in the `docs.plans` directory of `.factory/profile.json`); do not make it up.
If the file is not found, report it and stop.

For every phase of the plan create a milestone, and for every task inside the phase create a GitHub
Issue with the `gh` CLI. Every created issue is also added to the repository's GitHub Project
(`gh project item-add`) — one board for all epics, not only the current one.

These GitHub issues are the **source of truth for creating and executing tasks** (they replace any
old file backlog or task board). They do not start implementation by themselves — work on a
specific issue still goes through the usual Plan-first / Issue-first / Branch-first protocol of
the `task-lifecycle` skill (Issue-first is already satisfied here by the very existence of an issue
with a full body — see "Issue format" below).

This skill is not the only way to file an issue: for a single task outside an epic (no PRD/plan)
the issue is created with the same Body format directly through `gh issue create`, without a plan —
a plan/milestone is needed only when several tasks are grouped into the phases of an epic. In that
case the source for `Docs to Read`/`Key Invariants`/`Affects` is not a PRD (there is none) but a
direct reading of the affected code — the "Checking against the real code" section below applies
all the more strictly, since there is no PRD backing to provide these fields ready-made.

**Load this skill before any `gh issue create` and before editing an issue body with `gh issue
edit`, even for a single task without a plan.** The format and the verifiability rules below are
needed exactly for it: an ad-hoc issue without a plan most often gets items that the verifier
cannot check, and turns the report `UNVERIFIABLE`.

## Before creating — the project and the duplicate check

- Find the repository's GitHub Project: its number is set by the `githubProject` field of
  `.factory/profile.json` (check it with `gh project list --owner :owner`). Use that Project; do not
  create a new Project without an explicit request from the user. If the profile has no number and
  `gh project list` for the repository owner returned an empty list (no Project exists or it is not
  linked yet), tell the user and ask whether to create a new one (`gh project create
  --owner :owner --title "..."` + `gh project link <number> --owner :owner --repo :owner/:repo`)
  before continuing.
- `gh` does not create issues idempotently — when the skill is run again on the same plan, avoid
  creating duplicates yourself:
  - `gh api repos/:owner/:repo/milestones --paginate` — check whether a milestone for the same phase
    of the same epic already exists before creating a new one. Match by **epic identifier and phase
    number**, not by the whole title: take the titles of the existing milestones and look for
    `<epic id> · Phase <N>` or `<epic id> · Фаза <N>` (the earlier milestones were created with
    the Russian word `Фаза`; both words mean the same phase). The text after the number may
    differ. A milestone of another epic, or of the same epic with another phase number, is not a
    match. The epic identifier is the one found in step 1 below (`EPIC-NN`, or the kebab name taken
    from the plan file name). A milestone that is found is reused as it is: do not rename it, do
    not change its description, and attach the issues to its existing title.
  - `gh issue list --search "in:title <task text>" --state all` — check whether an issue with the
    same title already exists (within the corresponding milestone) before creating a new one. If
    the issue already exists but is not yet on the Project, still perform the Project step for it
    (step 6); do not skip it together with the issue creation.

If something already exists, skip its creation and report it in the final summary; do not create a
duplicate and do not ask the user about every single match.

## Procedure

1. Read the whole plan file (all `### Phase N: ...` sections), and also the PRD that the plan
   refers to in its header (`**PRD:** ...`) — whole, not only the headings. The Issue Body (see
   "Issue format" below) requires fields (`Docs to Read`, `Key Invariants`, `Test Requirement`)
   that are not in the plan itself — they are taken from the PRD (`## Docs to Read`/equivalent,
   `## Key Invariants`, `## Test Requirement`), not invented. `## Context` is assembled from the
   PRD sections `## Goal`, `## Context and Project Alignment` and `## Out of Scope` (see "Context:
   why, not only what" below).
   Read both name sets: new PRDs and plans use the English names above, while earlier documents
   use the Russian ones. In a PRD: `Goal`/`Цель`, `Context and Project Alignment`/`Контекст и
   согласованность с проектом`, `Out of Scope`/`Не в скоупе`, `Key Invariants`/`Ключевые
   инварианты`, `Test Requirement (Sketch)`/`Test Requirement (набросок)`, `Acceptance
   Criteria`/`Критерии готовности (Acceptance Criteria)`. In a plan: phase headings `### Phase N:
   ...`/`### Фаза N: ...` and the labels `Goal:`/`Цель:`, `Affects:`/`Затрагивает:`,
   `Tasks:`/`Задачи:` (the checklist `- [ ] ...` under it), `Done when:`/`Когда готова:`. Also find
   the epic identifier — usually in the H1 of the plan (`# Plan: ... (EPIC-NN / Phase MM)`) or the
   PRD; if there is no explicit `EPIC-NN`, use the short kebab name of the feature from the plan
   file name (`PLAN-<kebab-name>.md`) as the identifier.
2. For every phase create a milestone, **with the epic prefix in the title** (unless the duplicate
   check above found one for this epic and phase — then reuse it); without the prefix, with
   several parallel epics, different milestones "Phase 1: …" are indistinguishable:
   ```
   gh api repos/:owner/:repo/milestones -f title="EPIC-NN · Phase N: name" -f description="Phase goal (from the plan's '**Goal:**')"
   ```
   (if the epic has no number — `<kebab-name> · Phase N: name`).
3. For every task (a line `- [ ] ...` under `**Tasks:**`) inside the phase — **before fixing the
   text of its issue** — perform three mandatory steps (different tasks of one phase usually touch
   different files and different decisions, so all steps are done separately for each task, not
   once for the whole phase):
   - check the files that will go into its `Affects` against the real code, without relying only on
     the plan/PRD text (see "Checking against the real code" below);
   - check the architectural impact of the task and turn a significant result into a concrete
     `INV-n` (see "Architectural impact" below);
   - if this check or the analysis of the task revealed an implementation fork (two or more valid
     ways) — ask the user which variant to choose, and record the answer in `Key Invariants` (see
     "Implementation forks" below); do not carry an open fork into the issue.
4. Compose a draft of the issue body by the rules of the "Issue format" section below. Before
   fixing it as final, run the `research` agent with the brief from the section "Independent
   review of the issue draft" below, giving it **the whole text of the body draft** and the path
   `node_modules/dark-factory/verifier/issue-contract.md` — not the history of the current
   session and not the text of the plan/PRD. Each returned remark must either be fixed in the
   draft or be explicitly recorded in `Key Invariants` with the reason why it is rejected — before
   moving to the next step.
5. Create the Issue for this task, attached to its milestone:
   ```
   gh issue create --title "..." --body "..." --label "..." --milestone "EPIC-NN · Phase N: name"
   ```
   (for a reused milestone, pass its existing title exactly as it is on GitHub).
6. Add the just created (or the found existing) issue to the GitHub Project (the number found in
   the "Before creating" step):
   ```
   gh project item-add <project-number> --owner :owner --url <issue-url>
   ```
   (`gh issue create` prints the URL of the created issue — use it directly, do not assemble it by
   hand.)
7. After all issues are created, show the user a summary: how many milestones/issues were created,
   how many were added to the Project, how many were skipped as duplicates, links to the created
   issues (`gh issue create` returns the URL).

## Checking against the real code (mandatory before fixing the issue text)

The plan and the PRD are written *before* diving into implementation details — they cannot know
about discrepancies visible only in the code itself (for example: a data query does not fetch the
needed field, an existing spec file mocks data in a shape incompatible with what the task will
need, or the code base already has a helper/pattern that must be reused rather than duplicated in
several places). Therefore, before writing the final text of `Affects`/`Docs to Read`/`Key
Invariants`:

- Open and read (not from memory of the plan/PRD, but actually) every file that will go into
  `Affects` — not only the few lines quoted in the plan.
- Check that the mentioned line numbers/function signatures are still current — the plan/PRD may
  have been written before the latest code changes.
- Write explicitly into `Affects`/`Key Invariants` any discrepancies found between "as documented
  in the plan/PRD" and "as it actually is in the code" — do not silently fit the issue Body to the
  expectations of the plan.
- If the affected code already has a ready pattern/helper for what the task requires (for example,
  a neighbouring service already builds a similar value in a similar way) — name it directly in
  `Affects`, so that the executor reuses it instead of inventing a second way next to it.

## Architectural impact (mandatory for every task)

The principle is low coupling: behavior changes behind an existing boundary, not by editing
consumers (check the project rules from the profile's `ruleFiles`). From the code you have read,
answer for the task:

1. Which existing boundary (module, service, contract) owns the behavior that the task adds or
   changes? If the PRD named a variation point, it is that one.
2. Does a new dependency between modules appear, or does the task fit the existing public
   contract?
3. If the task introduces a new abstraction — is the variation point real (a second implementation
   now or already planned), or is it a placeholder "for the future"? Remove the placeholder from
   the task.

Write a significant result into `Key Invariants` as a concrete `INV-n` about a boundary or the
direction of a dependency that can be checked by imports and calls, for example: "`INV-2` The
export orchestrator depends only on the `Exporter` contract; it does not import a concrete
renderer" or "`INV-3` The provider SDK is imported only inside the `ai-provider` module". Do not
write a vague invariant such as "the code is loosely coupled" / "the solution is extensible": the
verifier cannot check it. If the task does not touch boundaries (an edit inside one function,
documentation), do not add an invariant. The choice between two valid placements of logic is a
fork, and the user decides it (see below).

## Implementation forks — clarify with the user in advance, do not leave them to the issue executor

If for the task there is more than one equally valid way to implement it (two places where the
logic can be put; whether to introduce a new shared helper or duplicate code; in what order to
apply transformations) — **do not leave this fork open in the issue** ("can do it this way or
that") and do not count on the executor resolving it well along the way.

Instead: **state the fork you found and its variants and ask the user which to choose**
(`AskUserQuestion`); do not choose silently yourself and do not guess. After getting the answer,
record it in the issue with an explicit, standard note in `Key Invariants`, for example:

```
**Resolved decision (do not re-litigate/ask):** <chosen variant> — <short reason>.
Rejected alternative: <variant> — <why not it>.
```

This note signals to the executor: the question is already settled with the user, exactly this
variant must be implemented, rather than weighing the alternatives again or stopping to ask.

If after checking against the real code and analyzing the forks honest uncertainty still remains
(there is not enough data even after reading the code and asking the user), do not create the
issue in its current form; first clarify the missing part with the user.

## Issue format

The only source of the issue body format is `node_modules/dark-factory/verifier/issue-contract.md`
(the contract of the installed factory; there is no need to copy it into the project). Before
creating or editing an issue, read that file and compose **only a v2** body that passes the linter
of the installed factory: `node node_modules/dark-factory/verifier/issue-lint.js <file> --require-v2`
from the project root (the output must have no `problems`). The project's issue structure is
extended only by `.github/verifier/issue-contract.overlay.json` (the contract and its overlay from
the core); the profile does not set a second issue template overlay — the profile's `overlays`
concerns only the PRD and the plan.
Do not duplicate here lists of sections, ID prefixes, types or the `Verify:` grammar: when the
contract changes, this skill must follow the contract file.
The same file is the only source of the wording rules for the items of `Acceptance Criteria`,
`Definition of Done`, `Test Requirement` and `Key Invariants` (including how to read
comma-separated lists); do not copy these rules here — when in doubt about a wording, read
`node_modules/dark-factory/verifier/issue-contract.md`.

The content of the fields is still taken from the plan/PRD and the check against the real code:
`Affects` lists the whole expected diff, `Docs to Read` — concrete sources, `Key Invariants` —
the applicable constraints and forks resolved in advance. For an ad-hoc issue without a plan/PRD
use the same rules, but take the content from the code and documentation actually read.

### Editing the body of an issue with the `spec-approved` label

If the issue already has the `spec-approved` label (the body is fixed by the owner by a sha256
hash), only the owner edits its body — the executor does not call `gh issue edit` for such an issue
itself, even when the edit is needed for the Acceptance Criteria (see "4. Scope discipline during
implementation" in the `task-lifecycle` skill): instead it stops and asks the owner to make the
edit. After the owner edits the body of such an issue, the `spec-approved` label is set again —
otherwise the body hash diverges from the approved one, and the verifier returns FAIL "spec changed
after approval".

### Context: why, not only what

`## Context` is the only place of the issue where the executor (a human, Claude in a new session,
Ralph) sees the motive of the task. From the motive they decide small forks that are not in the
criteria, and the owner quickly understands from it why the task is needed. New issues use the
section name `Context`; the contract still accepts the earlier Russian name `Контекст` for existing
issues. The contract requires only the presence of the section and does not check its content, so
the composition is set here. The context consists of four parts, each starting with a fixed
opening (one paragraph per part):

- `Problem:` what is wrong now, concretely: the place in the code, the scenario, the example on
  which it is visible. Not "X needs improving", but what exactly happens now.
- `Why it matters:` what happens if it is not done: whom it affects and how, which risk or loss the
  task closes.
- `After the task:` what works and how after the change, described from the point of view of
  behavior (user, CI, agent), not as a list of files.
- `Boundary:` what the task deliberately does not do and which adjacent tasks take it (with `#N`
  links). If there is nothing adjacent, say so: `Boundary: there are no adjacent tasks.`

Existing issues use the Russian openings `Проблема:`, `Почему важно:`, `После задачи:`, `Граница:`;
when reading or reviewing such an issue, treat them as the same four parts.

Sources of the parts:

- an issue from a plan: the PRD sections `## Goal` (→ `After the task:`), `## Context and Project
  Alignment` (→ `Problem:`, `Why it matters:`) and `## Out of Scope` (→ `Boundary:`), and also the
  text of the plan phase (the earlier Russian names of these sections are read the same way);
- an issue without a PRD: the code you read (where the problem is visible) and the owner's request
  (why they raised it).

Size rules:

- The context explains the motive and the result. Do not retell `Affects`, the criteria or the
  content of the documents from `Docs to Read` in it: give details by a reference (path, ADR
  number, `#N`). It is usually 4–10 sentences for the whole section; bloating an issue is as
  harmful as leaving the context as a single phrase.
- Explain terms that the executor does not know without the plan (a label name, an internal name of
  a mechanism) with one phrase at the first mention.

The linter does not check the composition of the context; it is assessed by the independent
reviewer of the draft (see "Independent review of the issue draft").

### Converting a legacy issue to v2

When the body of an existing issue is rewritten from the legacy format to v2 (for example, by the
Issue-first step in the `task-lifecycle` skill), the context is not carried over as is: rewrite it
by the four parts above. Keep all facts of the old description, and assemble the missing parts from
the PRD/plan the issue refers to, from related issues and from the code. If some part cannot be
assembled from anything, ask the owner instead of inventing a motive. Before `gh issue edit` go
the same path as at creation: the linter with `--require-v2` and the independent reviewer of the
draft.

### Body example

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

## Independent review of the issue draft

This step does not replace the linter (the factory's `issue-lint.js` checks the format: sections, ID
prefixes, the `Verify:` grammar) — the reviewer checks verifiability in substance, the same thing
that the verifier later assesses independently on the PR, but before the issue is created, not
after. In addition, the reviewer is the only check of the composition of `## Context` (see
"Context: why, not only what"): like the future executor, they have neither the plan nor the PRD.

The reviewer is a read-only `research` agent started with a fresh context: it sees neither the
history of the current session, nor the plan/PRD from which the draft was assembled, nor the user's
earlier messages — only the issue body draft and the path to the contract. It does not create or
edit the issue, it only returns a list of remarks.

`research` returns the answer in its fixed format (`Finding` / `Relevant files` / `Important
implementation details` / `Risks or uncertainties`) and itself marks each item as an
"observation", without giving verdicts ("bug"/severity) — brief it so that the task fits this
format rather than redefining it:

Brief the agent with this text verbatim (substituting the full text of the issue body for
`<draft>`):

```
Task (Finding): for each item of `Acceptance Criteria`, `Test Requirement` and `Definition of
Done` in the issue body draft below, answer two questions and report the result as an observation
("observation"), not as a verdict:
1. Which concrete file, line or CI check will prove that this item is done?
2. How can the wording of the item be satisfied formally without satisfying it in substance
   (cheating the Verify)?
Give this line by line in the "Important implementation details" section of your answer, one
observation per item (use the item ID).

Additionally, in the "Risks or uncertainties" section list every item of type `[behavior]` that
has no separate companion item with a negative or boundary scenario ("Given … When … Then …" with a
refusal/error/empty/invalid input) — one such companion is expected for every positive
`[behavior]` item.

Also in the "Risks or uncertainties" section, for every `Key Invariants` item that speaks about a
module boundary, a contract or the direction of a dependency, assess change amplification: take one
natural future change of the varying part (another provider, another rule, another format), list
the components that would have to be changed for it after the issue is implemented, and mark as a
risk every consumer in this list that is unrelated to this varying part. Separately mark an
invariant that is worded vaguely ("the code is loosely coupled") and cannot be checked by imports
and calls.

As a separate observation in the "Finding" section assess the `## Context` section (the earlier
name `## Контекст` is equivalent): it must consist of parts with the openings `Problem:`, `Why it
matters:`, `After the task:` and `Boundary:` (the Russian openings `Проблема:`, `Почему важно:`,
`После задачи:`, `Граница:` of existing issues are equivalent). Name every part that is missing or
from which, without the plan and the PRD, it is unclear what the problem is now, why it should be
solved, what and how will work after the task, and what is not included in it. Separately name
terms that are not explained in the context, and places where the context retells `Affects` or the
criteria instead of the motive.

You have no access to the history of the current session, the plan/PRD or earlier messages — only
the draft below and the path to the contract `node_modules/dark-factory/verifier/issue-contract.md`
(read it before the draft). You do not create or edit the issue. Do not judge the format: the
linter (the factory's `issue-lint.js`) already checks the structure, ID prefixes and the `Verify:`
grammar — your task is verifiability in substance.

Issue body draft:
<draft>
```

Each observation marked in the answer must either be fixed in the draft (reword the Verify, add the
missing negative/boundary item, complete a part of the context), or be explicitly recorded in the
`Key Invariants` of the final issue with the reason why it is rejected — before moving on to `gh
issue create`. A remark must not be silently ignored.

## Verifiability of items

- Always create new issues in the v2 format and check them with the linter with `--require-v2`
  before sending.
- DoD names the required CI checks only with items of type `ci` in the form set by the contract.
  Do not add a meta-item about fulfilling the Acceptance Criteria.
- If the task changes architecture documentation, the path to the document must be concretely known
  already when the issue is created and stated by a verifiable item; do not create a conditional
  item "if the task is architectural".
- For **every** item of type `behavior` add at least one separate item of type `behavior` with a
  negative or boundary scenario in the form "Given … When … Then …". Do not hide the negative
  scenario only in prose or in Manual verification.
- Do not put manual, local and process checks into gated items. If the owner needs a manual check,
  use the non-gating section provided by the contract.
- For a move/removal/rename, state the verifiable absence of a concrete literal in a concrete path,
  when exactly that is the requirement of the result.
- For "the rest is not affected" name concrete positive and negative examples, so that the boundary
  of the behavior is testable.

**Label**: choose only from the labels that already exist in the repository (`gh label list`); do
not create new labels without an explicit request from the user. By default: `enhancement` for
implementation tasks, `documentation` for tasks that edit only documentation (project documents)
without code.

**Milestone**: the phase title with the epic prefix (`EPIC-NN · Phase N: name`) created in step 2,
or the existing milestone of the same epic and phase found by the duplicate check.

## Iterative phases (a loop "edit → run → compare, until it converges")

If a plan phase is explicitly described as a repeating loop without a fixed number of passes (text
like "repeat until criteria X are met" / "may need several rounds") — do not create issues for it 1:1
from the `**Tasks:**` checklist, as for an ordinary phase. Instead:

1. Combine the steps of one pass of the loop (diagnosis → edit → re-run → log update) into **one
   issue "Calibration round 1 (Phase N)"**, with the checklist of these steps inside the Body.
2. Create a separate **tracker issue** ("Round loop (Phase N) — tracker") in the same milestone —
   it is not closed until the final convergence and contains the checklist `- [ ] #<issue> Round
   N`, updated as new rounds are created.
3. The final step of the phase (if the plan describes a separate check after the loop, for example
   "make sure the version history reflects all iterations") remains a separate issue, but its Body
   explicitly says that it is closed only after the tracker issue confirms the end of the loop.
4. Each next round is a new issue "Calibration round N+1 (Phase N)", created only when the previous
   round did not lead to convergence; it is added to the tracker issue checklist.

Do not create several rounds ahead — round 2+ appears only when round 1 has not converged.

## Rules

- Do not change or delete the plan file itself — the skill only reads it.
- Do not create issues for phases/tasks that are not in the plan file — do not invent a new scope.
- One milestone per phase, exactly as the phases are split in the plan — do not merge or split them
  differently.
- If a task in the plan has no separate explanation besides its own text, the Body may be shorter
  (without empty sections), but the footer at the end is always mandatory — it is the only
  traceability back to the PRD (an issue from a plan) or an explicit statement that the issue was
  created separately, without a plan (an ad-hoc issue — see "Issue format").
- Do not run `gh pr create`, do not switch branches and do not commit anything — this is only an
  issue tracker, implementing code is not part of this skill.
