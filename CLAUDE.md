# CLAUDE.md — dark-factory

Rules for Claude Code sessions in this repository. Keep it short; detailed guides (connecting a project, adding a factory element) are separate tasks (Phase 5).

## Purpose

dark-factory is the shared **core** of an AI software factory: Ralph (autonomous issue-executing agent), the Acceptance Verifier (PR verifier), and the Claude Code skills, agents and hooks that wrap them. Projects (consumers: `jobflow`, `cards`) install a pinned release of the package and supply project-specific values only through their own `.factory/profile.json` and overlays.

This repo is developed by its owner in an interactive Claude Code session. Ralph is not used on the factory itself.

## Repository layout

| Path | Role | Ships to projects |
|---|---|---|
| `bin/`, `doctor/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/` | Package sources (the `files` field of `package.json`) | **yes** |
| `.claude/` | Tooling for developing the factory only (its own scripts, settings, skills, agents) | no |
| `.factory/profile.json` | The factory's own project profile | no |
| `.github/` | CI of this repo | no |

Rules of placement:
- Something a project must receive → package dirs (`bin/`, `doctor/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/`).
- Something only used while developing the factory → `.claude/`. Never put package sources there, and never let the factory's own skills/agents reach projects.
- `.claude/` and `.factory/` are never part of the package.

## Commands

- `npm test` — the test command of every change (`node --test`). Tests must pass on **Windows and Linux**, **without network**, **without Docker** and **without a real AI** (stub the agent/model). CI jobs `Test (Linux)` and `Test (Windows)` run it on every PR.
- Portable tests (`ralph/**/*.test.js`) replace processes at the `child_process` boundary and need no Docker. Tests that need a real Docker engine live in `test/integration/`, are not part of `npm test` and are never replaced by a skip that reports success.
- The one exception to "a single test command": the Ralph Docker integration, `npm run prepare:ralph:sandbox` (builds the images; the only step that downloads) and then `npm run test:ralph:sandbox` (runs the suite on the prepared images, Linux host with a Linux Docker engine, stub agent, no AI). CI job `Ralph sandbox integration` runs both on every PR. See `ralph/README.md`.

- `factory doctor [<project-path>]` (`bin/doctor.js`, `bin.factory`; checks in `doctor/`) — read-only check that a project is connected to the factory: working tree plus GitHub labels, secret name and variables of that project. It fixes nothing and is not part of the verdict. See `README.md`.

## Core invariants (do not break)

1. No project literals in core code (paths, app names, DB/ORM names, label values of one project). `jobflow` and `cards` may appear only as names of consumer projects.
2. A project PR cannot change verifier code or verifier config; they come from the pinned factory release.
3. The verdict is computed by code, not by the model. An invalid profile or config → `FAIL`.
4. The Ralph agent gets no `gh` and no git command that changes the repository. It may only read git: `git status`, `git diff`, `git log`, and in the review passes also `git show`. Branches, commits, push and every GitHub operation (PRs, comments, labels) belong to the controller.
5. Updating the core in a project happens only through a PR that changes the pinned version.
6. A new step or check is wired in by registration + profile and is **off by default**. Ralph's base step pipeline (`implement`, `self-review`, `code-review`, `final-gate` in `ralph/steps/`) is the existing controller moved into the step registry, not a new extension: when Ralph is enabled and `ralph.enabledSteps` is absent, all four run, both reviews included; a profile can leave out a review only with an explicit full list. A newly registered Ralph step stays off until `ralph.enabledSteps` names it. The one exception is a mandatory diagnostic artifact of the round protocol, which has no switch. It adds no check, no model call and no authority, does not change the verdict, and a failure to form or publish it is isolated from the decision (it never fails the job that computes the verdict). The list is closed: `verdict-report` (job `Report`) and the policy snapshot (job `Verify`). `provenance.json` is not on it: it takes part in computing the verdict. A new artifact joins the list only by changing this paragraph.
7. One "path → skills" table, shared by the hook and by Ralph.
8. A project overlay can only add to the core (e.g. issue template sections), never remove or override.
9. Installing the package does not modify tracked files of the project.
10. Hook gates fail closed: any error, missing profile or unparsable input blocks.
11. Project context never enters the core; it reaches the core only via the profile and trusted configs.
12. The factory runs on its own pinned release (dogfooding), like any project.
13. The factory's own skills and agents are not shipped to projects.

## Adding a new factory element

Applies to a Ralph step, a verifier check, a doctor check, a hook, or a package skill. The one complete procedure is [docs/adding-an-element.md](docs/adding-an-element.md): the registration point and the knob of each kind, default-off, tests on the "monorepo" and "single package" fixture profiles, the reference PR set when the verdict can change, CHANGELOG, and delivery by release and pin update. Follow it; it does not replace the Core invariants above (invariant 6 keeps the only closed list of diagnostic exceptions). The `add-factory-element` skill drives it in a session.

## Release cycle (edit → release → bump tag)

The factory uses its own **pinned release** (git tag `vX.Y.Z`), installed like in any project. Hooks and skills active in your session come from that release, not from the working copy.

- Editing a hook or skill in the working copy does **not** change the behavior of the current session. The change takes effect only after: edit → merge → release a new tag → change the tag pinned in the factory.
- Do not try to "fix" a hook by editing it and expecting the session to pick it up.

## Recovery

- **Fresh clone:** run `npm install` first (restores the pinned release, including hooks and copies of skills), then work. Until the factory pins its own release (#27), `npm install` lays out no copies: run `node .claude/scripts/setup-metaskills.js` once, in an ordinary terminal, for the metaskills copies the development hooks of `.claude/` require.
- **Broken pinned release** (a hook gate blocks Write/Edit, so files cannot be edited): do not try to edit files. Use Bash or your own terminal and roll the pinned tag back to the previous release with an npm or git command (reinstall the previous `vX.Y.Z`, or check out the previous tag). Then fix the problem in the working copy, cut a new release, and move the pin forward.
- The exact rollback command depends on the installation mechanism chosen in the task "Factory on its own release"; that task refines this section.

## Task process

Factory work follows the same flow as projects: **GitHub Issue → branch → PR**.

- Issues follow the issue contract (core `verifier/issue-contract.md` + project overlay, Acceptance Criteria with `Verify:` lines).
- Before creating or editing an issue, check its body with the linter of this repo: `node verifier/issue-lint.js <issue.md> --require-v2` (it must report no `problems`).
- Branch name: `task/ISSUE-<n>-<slug>`.
- Before opening a PR, run `/code-review` on the branch and fix or explicitly dismiss every finding; mention the outcome in the PR description.
- PR description starts with `Closes #<n>`.
- The `issues` and `task-lifecycle` skills (base package set) drive this process. Before the first release they do not exist in this repo; they arrive as copies from the pinned release. Follow their procedures rather than restating them here.
- Until the first release is installed, follow the flow above manually.

## Style

- Node.js ≥ 22, plain JS, `node --test`. No network in tests.
- Code, comments, `CLAUDE.md` and package docs are in English.
