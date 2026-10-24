# CLAUDE.md — dark-factory

Rules for Claude Code sessions in this repository. Keep it short; detailed guides (connecting a project, adding a factory element) are separate tasks (Phase 5).

## Purpose

dark-factory is the shared **core** of an AI software factory: Ralph (autonomous issue-executing agent), the Acceptance Verifier (PR verifier), and the Claude Code skills, agents and hooks that wrap them. Projects (consumers: `jobflow`, `cards`) install a pinned release of the package and supply project-specific values only through their own `.factory/profile.json` and overlays.

This repo is developed by its owner in an interactive Claude Code session. Ralph is not used on the factory itself.

## Repository layout

| Path | Role | Ships to projects |
|---|---|---|
| `bin/`, `doctor/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/` | Package sources (the `files` field of `package.json`) | **yes** |
| `.claude/` | Tooling for developing the factory only (its own scripts, skills `add-factory-element` and `release`, agents `core-literal-scan` and `fixture-profile-run`; `settings.json` wires the hooks of the installed release) | no |
| `.factory/profile.json` | The factory's own project profile (the standard profile of a project: the seven verifier checks, Ralph and Judge off) | no |
| `.github/` | CI of this repo, the trusted verifier configs in `.github/verifier/` and the wrappers `verifier-wrapper.yml` and `spec-approval-wrapper.yml` (the files `acceptance-verifier.yml` and `spec-approval.yml` are the reusable workflows themselves) | no |

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

The factory runs on its own **pinned release**, installed like in any project: the root `package.json` has `devDependencies["dark-factory"]: "github:strakhovdenya/dark-factory#vX.Y.Z"`, so the release lands in `node_modules/dark-factory` and the lock holds the commit of the tag. Hooks (`.claude/settings.json`), the base set of skills and agents (copies laid out by the setup of the installed release, listed by name in `.gitignore` and in `.claude/.factory-installed.json`), `factory doctor` and the Acceptance Verifier of the pull requests all come from that release, not from the working copy. The root `postinstall` (`node bin/setup.js`) of this repository lays out nothing: it ends successfully for the factory package itself (see README), and the copies come from the postinstall of the installed release.

- Editing a hook, skill, verifier check or setup in the working copy does **not** change the behavior of the current session or of CI. The change takes effect only after: edit → merge → release a new tag → change the pin of the factory.
- Do not try to "fix" a hook by editing it and expecting the session to pick it up.
- **Standard pin.** A release is a tag `vX.Y.Z` on a commit of `main` with green CI, made with `node .claude/scripts/release-tag.js vX.Y.Z` (the `release` skill). The factory then moves to it in **one** PR that changes `package.json`, `package-lock.json` and the full commit SHA (`git rev-parse vX.Y.Z^{commit}`) in both places of both wrappers, `verifier-wrapper.yml` and `spec-approval-wrapper.yml`; `node .claude/scripts/pin-release.js vX.Y.Z` does exactly that and runs setup and doctor, the PR stays yours. A tag is never moved and a branch is never pinned. The steps are in [docs/upgrading.md](docs/upgrading.md).
- **First connection.** The tag `v0.1.0` could not be pinned by the PR that prepared it, so the first connection took three steps in this order: PR-A (package fixes of setup and the notes of `0.1.0`, `Refs`) → merge, green CI on `main`, the tag published → PR-B (the pin, profile, trusted configs, wrappers, settings and the removal of the bootstrap, `Closes`). The same order applies to any change that a release must contain before the factory can use it.
- **From the first PR after the wrappers are merged**, the pinned verifier checks the factory's pull requests. Its `affects-scope` check turns a file outside the issue's `## Affects` into `FAIL` with `out_of_scope_file`, instead of the diff review of the bootstrap period. This is not a ban on changing the core: a core change inside the Affects of its issue is the normal case. Past pull requests are not re-checked.

## Recovery

All of this is done in an **ordinary terminal outside Claude Code**. Inside a session the `Bash` gate of a missing or broken release blocks every Bash call, `npm` included, and `Write|Edit` too.

- **Fresh clone:** `npm ci`. It installs the pinned release and runs its setup, which lays out the copies of skills and agents. Then `node node_modules/dark-factory/bin/doctor.js doctor`. Doctor reads the GitHub settings with `gh`, so it needs `gh auth login`.
- **Missing or broken installed package** (a gate blocks Write/Edit, `node_modules/dark-factory` is gone or does not start): do not try to repair it from the blocked session and do not edit hook files. Do not roll back the whole working copy and do not move a public tag. Reinstall exactly what the lock says, and run setup and doctor:

  ```sh
  rm -rf node_modules
  npm ci --ignore-scripts
  node node_modules/dark-factory/bin/setup.js --consumer-root .
  node node_modules/dark-factory/bin/doctor.js doctor
  ```

  For the first release there is no previous version: this reinstalls the current pin.
- **A broken release** (the pinned tag itself is bad): put the previous working state of the pin back and reinstall. `<good-ref>` is the last commit that worked; commit or stash your own work first. The pin, the lock, both SHAs of both wrappers and the files that go with the old release come back together, the dependency and nothing else:

  ```sh
  GOOD=<good-ref>
  git checkout "$GOOD" -- package.json package-lock.json .gitignore .factory/profile.json .claude/settings.json .github/workflows/verifier-wrapper.yml .github/workflows/spec-approval-wrapper.yml
  rm -rf node_modules
  npm ci --ignore-scripts
  node node_modules/dark-factory/bin/setup.js --consumer-root .
  node node_modules/dark-factory/bin/doctor.js doctor
  ```

  Once `Write|Edit` works again, fix the problem in the working copy, cut a new release and move the pin forward by PR. Setup removes copies that left the base set only when they have no tracked files.
- **Clone from before the first connection** (it still has the old unmanaged copies): once, before `npm ci`, delete the five old copies `.claude/skills/{data-structures,js-data-structures,js-conventions,error-handling,js-gof}`, and `.claude/skills/modern-javascript` if it is still tracked (`git rm -r --cached .claude/skills/modern-javascript`, then delete the directory); then `npm ci`. Setup never adopts a path it does not own, so it stops with the path named until this is done. Own tools and your own changes are kept.

## Task process

Factory work follows the same flow as projects: **GitHub Issue → branch → PR**.

- Issues follow the issue contract (core `verifier/issue-contract.md` + project overlay, Acceptance Criteria with `Verify:` lines).
- Before creating or editing an issue, check its body with the linter of this repo: `node verifier/issue-lint.js <issue.md> --require-v2` (it must report no `problems`).
- Branch name: `task/ISSUE-<n>-<slug>`.
- Before opening a PR, run `/code-review` on the branch and fix or explicitly dismiss every finding; mention the outcome in the PR description.
- PR description starts with `Closes #<n>`.
- The `issues` and `task-lifecycle` skills (base package set) drive this process. They are copies laid out by the setup of the installed release. Follow their procedures rather than restating them here.
- The Acceptance Verifier of the pinned release checks the pull request against the issue; the `Affects` section of the issue must name every file the PR changes.

## Style

- Node.js ≥ 22, plain JS, `node --test`. No network in tests.
- Code, comments, `CLAUDE.md` and package docs are in English.
