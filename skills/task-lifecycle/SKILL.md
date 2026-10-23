---
name: task-lifecycle
description: Repository task state-transition procedure. Load after an implementation plan is approved, before entering implementation, and reload before task closure/commit. Do not load for research, explanation, planning-only work, or Ralph coding agents whose Git/GitHub lifecycle is controller-owned.
---

# Task Lifecycle

This skill is the authoritative procedural workflow for taking one human-driven implementation task from approval to PR. The root `CLAUDE.md` contains the always-on policy and routes here; do not duplicate this procedure back into the root file.

## When to load this skill

Load it at task lifecycle boundaries, not merely because repository work is being discussed:

1. **Entering implementation:** after the user approves the implementation plan, before Issue/branch/Project-state changes or the first source edit.
2. **Entering closure:** reload it after implementation/verification is complete, before `git add`, commit, push, and PR creation.

Do **not** load it for research, explanation, architecture discussion, repository exploration, or planning-only work that has not been approved for implementation.

Do **not** load this skill inside Ralph's nested coding agents. Ralph's deterministic controller owns issue selection, branch/clone state, commit, push, PR creation, and stopping behavior; giving the coding agent this human-driven Git/GitHub lifecycle would conflict with its constrained permissions. Ralph's controller must preserve the equivalent lifecycle guarantees independently.

## Core rules

- Work on one task at a time. Do not choose the next task automatically.
- GitHub Issues are the execution source of truth.
- Do not silently change product scope.
- Keep changes small and reviewable.
- If the task cannot be completed safely, comment `BLOCKED: <reason>` on the active Issue and stop. Do not close it and do not invent a workaround.

## 1. Plan first

Before code changes, present a written plan covering files, approach, and risks. Wait for explicit user approval (`go`, `approved`, or equivalent).

For an urgent hotfix the plan may be one or two lines, but Issue-first, Branch-first, Acceptance Criteria, Test Requirement, and closure verification still apply.

## 2. Issue first

Before the first implementation Write/Edit:

1. Ensure a fully-specced GitHub Issue exists. Do not implement against a title-only issue.
2. For an ad-hoc task, search existing issues first; do not create a duplicate.
3. Use `node_modules/dark-factory/verifier/issue-contract.md` (the contract of the installed factory) as the single source of truth for the issue body format. Load the `issues` skill before `gh issue create` or `gh issue edit` even for a standalone task: it explains how to derive checkable content without duplicating the contract. Check the body with `node node_modules/dark-factory/verifier/issue-lint.js <file> --require-v2` from the project root; it must report no `problems`. Nothing is copied into the project for this.
   Compare the existing issue body with the contract: owner-run checks belong only in the contract's non-gated manual section, gated items must be repository- or CI-verifiable, and every path the task will touch belongs in `## Affects`. If the body is in an outdated format, propose rewriting it before the first edit.
   When the body is rewritten into v2, or when its `## Контекст` does not explain the motive of the task (what is wrong now, why it matters, what works after the task, what is out of scope), expand `## Контекст` by the rule in the `issues` skill ("Контекст: зачем, а не только что" and "Перевод legacy issue в v2") as part of that rewrite.
4. When the profile sets `githubProject`, every active task Issue must be on that GitHub Project. Standalone issues need no milestone; epic-derived issues use their phase milestone.
5. Treat the Issue body as the implementation contract: Context, Affects, Docs to Read, Key Invariants, Acceptance Criteria, Test Requirement, Definition of Done, Dependencies.

If a state-machine transition table is present in the Issue's Key Invariants, use it directly. Do not derive a different transition table from older docs. If it conflicts with referenced documentation, stop and ask.

## 3. Branch first

Immediately after plan approval and Issue confirmation:

1. Check `git status` and `git branch --show-current`.
2. Do not carry unrelated dirty state onto a new task branch.
3. Start from an up-to-date default branch unless this is an epic sub-task that intentionally targets an epic base branch.
4. Name task branches by the `branchTemplate` of the project profile.
5. When the profile sets `githubProject`, set the Issue's GitHub Project status to **In Progress** as soon as the branch is created.

Resolve the identifiers from GitHub, never from memory: the project node id and the owner with `gh project view <githubProject> --owner <owner> --format json`, the Status field id and its In Progress option id with `gh project field-list <githubProject> --owner <owner> --format json`. Add an issue that is not yet on the Project with `gh project item-add <githubProject> --owner <owner> --url <issue-url>`. Resolve the project item id with `gh project item-list <githubProject> --owner <owner> --format json -q '.items[] | select(.content.number==<n>) | .id'`, then update it with `gh project item-edit --id <item-id> --field-id <Status field> --project-id <project> --single-select-option-id <option>`.

### Epic base branches / stacked work

For a multi-task epic, the base branch is built by the existing `branchNameFor` of the installed package (`profile/branch.js`) from the profile: `branchNameFor(profile.branchTemplate, <tracking-issue-n>, "<epic-short-name>-base")`, where the tracking issue number is resolved from the Issues created for the epic and the slug is the short epic name with the `-base` suffix. Do not assemble the name by hand:

```sh
node -e "const [root, issue, name] = process.argv.slice(1); const p = root + '/node_modules/dark-factory/'; const { loadProfile } = require(p + 'profile/load'); const { branchNameFor } = require(p + 'profile/branch'); console.log(branchNameFor(loadProfile(root).branchTemplate, Number(issue), name + '-base'))" "<root>" <tracking-issue-n> "<epic-short-name>"
```

Before opening sub-task PRs into an epic base branch, ensure that base branch has the same required-status-check protection as the default branch.

Before starting the next dependent sub-task, check whether the immediately preceding PR into the epic base is still open. If it is, ask whether to wait or intentionally proceed in parallel; do not silently branch around a pending dependency.

## 4. Scope discipline during implementation

When new work surfaces mid-task:

- If it is required for the active Issue's Acceptance Criteria to be true and stays within the Issue's current `## Affects`, implement it in the current task and note the extra change in the PR description.
- If it is required for the active Issue's Acceptance Criteria to be true but falls outside the Issue's current `## Affects`, stop before implementing it. Do not extend `Affects` yourself and do not implement the extra work under the active Issue. Ask the owner to update the Issue body (`Affects`, and any other section the extra work touches); if the Issue carries the `spec-approved` label, also ask the owner to re-apply it after that edit before continuing — this applies even when the Acceptance Criteria wording itself is unchanged, since `spec-approved` freezes the Issue body by hash and silently widening the real diff past the approved `Affects` reopens the exact scope gap that label exists to close.
- If it is unrelated to the active Issue's Acceptance Criteria, do not mix it into the current change. Create a separate fully-specced Issue, add it to the Project, tell the user, and continue the active task unless the user explicitly asks to bundle it.

For architecture changes, update the relevant documentation in the same change. Architecture includes module/service boundaries, dependency direction, HTTP endpoints/data flow, state transitions, and new binding decisions. Update whichever source is authoritative: the rule files named in the profile (`ruleFiles`), the project documents, and/or the ADR file (`docs.adr`; use the `adr` skill).

If documentation outside the active task needs unrelated changes, propose them rather than silently expanding scope. Update the project's changelog, when it keeps one, after meaningful completed work.

## 5. Verification and closure gate

The closure checklist is a **hard gate**. Do not commit until every applicable item is verified.

Before commit:

- All Acceptance Criteria in the Issue body are actually satisfied and their checkboxes are marked `[x]`.
- If implementation diverged materially from the Issue's original approach, add an Issue comment explaining what changed and why.
- Post test evidence to the Issue: commands run, result, and concrete evidence.
- Verify the implementation against the metaskills loaded before coding.
- Ensure architecture documentation is current when the change is architectural.
- Ensure the eventual PR body will include `Closes #<n>`; do not manually close the Issue before merge.
- State which Issue(s), if any, are now unblocked/open next. Do not start them automatically.

Immediately before `git commit`, show explicit closure status to the user as ✅/❌ lines.

Then ask two separate questions and wait for explicit answers:

1. Run `/code-review` against the working diff first?
2. Does root `README.md` need updating for this task?

Only edit the root README when the user answers yes.

The git closure gate hook of the installed factory independently blocks `git commit`/`git push` until this skill has been loaded in the session, then prompts for confirmation. That hook is a backstop, not a replacement for this lifecycle.

## 6. Git / PR order

After closure is satisfied:

1. `git add <files>`
2. `git commit -m "<type>: ISSUE-<n> ..."` using the appropriate conventional-commit type.
3. `git push -u origin <branch-name>`
4. `gh pr create ... --body "Closes #<n> ..."` against the intended base.
5. Stop completely. Do not select or start the next task.

Never create the PR before pushing the branch.

## Hotfixes

Urgency may compress planning, but not traceability or verification:

- create/complete the Issue immediately if it did not exist;
- branch from the default branch;
- keep real Acceptance Criteria and Test Requirement;
- run the same closure gate before commit.
