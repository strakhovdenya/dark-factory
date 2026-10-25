# dark-factory

## Overview

**dark-factory is a reusable "software factory" for AI-assisted development.** An AI agent takes a written task (a GitHub issue), implements it in an isolated sandbox and opens a pull request; an independent verifier then checks that pull request against the task. The factory is one package that any repository can install at a fixed version, so every project gets the same rules and the same checks.

**The problem it solves.** An AI coding agent is fast, but on its own it is hard to trust: it may touch files it should not, skip tests, quietly weaken a check, or claim a task is done when it is not. dark-factory puts the agent inside a process with hard boundaries and makes the final decision about a pull request by code, not by the model's opinion.

**How a task flows.**

```text
GitHub issue        Ralph                          pull request        Acceptance Verifier       verdict
(task with   ──►  (agent in a Docker sandbox:  ──►  (opened by the  ──►  (checks the PR against ──► PASS / FAIL /
 checkable          implement → self-review →        controller,          the issue, in CI)          NEEDS_HUMAN
 criteria)          code-review → final gate)        not by the agent)                              (computed by code)
```

1. A task is written as a GitHub issue in a fixed format: every acceptance criterion names the file, test or CI check that proves it.
2. **Ralph** picks the issue. Its controller (ordinary deterministic code) prepares a clean clone and runs the agent (Claude Code) in a Docker sandbox. The agent can only edit files and read git history; it cannot commit, push or talk to GitHub.
3. The agent's work goes through a self-review, a code review and the project's own lint, type and test commands. The controller checks the boundaries after every agent turn. Only when everything is green does the controller commit, push and open the pull request.
4. The **Acceptance Verifier** runs in CI from the pinned factory release. It reads the issue and the diff, a model judges the individual criteria, and code combines those answers with deterministic checks (files outside the task's scope, tampered tests, missing CI checks, an unapproved spec) into the verdict.

**What has been proven on a real project.** On 2026-10-25 Ralph from the pinned release `v0.1.3`, installed in a real consumer project (a TypeScript monorepo), took one real issue with the real Claude CLI and turned it into a pull request in under seven minutes. All four steps passed: implement, self-review, code review (the real `code-review` skill) and the final gate. The pull request passed every CI check of that project and the Acceptance Verifier with `PASS`. The full protocol, with links, versions, limits and what it does not prove, is in [docs/verification/ralph-consumer-run.md](docs/verification/ralph-consumer-run.md).

**Key engineering decisions.**

- **The verdict is computed by code.** The model only answers narrow questions about single criteria; the rules that turn the answers into `PASS` or `FAIL` are code with tests. An invalid profile or configuration is `FAIL`, never a silent pass.
- **The agent has no keys to the repository.** It cannot commit, push or use the GitHub CLI; every git and GitHub operation belongs to the controller. Protected paths (`.git/`, `.claude/`, the project profile) are checked after every agent turn, and a violation stops the task without a pull request.
- **Fail closed.** The Claude Code hooks that guard a developer session block on any error, missing profile or unreadable input, instead of letting the action through.
- **Pinned releases, also for the factory itself.** Projects install a release tag and every workflow refers to its exact commit; a pull request of a project cannot change the verifier that judges it. The factory develops itself on its own pinned release, exactly like a project.
- **No project knowledge in the core.** Paths, app names, commands and labels of a project live only in that project's `.factory/profile.json`; the core is shared unchanged.
- **Tests without network, Docker or AI.** `npm test` runs on Linux and Windows with processes replaced at the `child_process` boundary; a separate Docker suite checks the real sandbox with a stub agent; one controlled real run checks the real model. Each level is reported on its own, none stands in for another.
- **Plain JavaScript, no build.** Node.js 22, CommonJS, types checked by `tsc --noEmit` on JSDoc (see [Why plain JavaScript](#why-plain-javascript-and-not-typescript)).

**Status.** Early but working: four releases (`v0.1.0` to `v0.1.3`), a connected consumer project, and the factory itself running on `v0.1.3`. Ralph is confirmed by one controlled real run on one platform; see [Limits](#limits) for what that run does not cover.

## Technical reference

### Components

| Component | Directory | What it is |
|---|---|---|
| Ralph | `ralph/` | Controller that executes issues of a consumer with Claude Code in a Docker sandbox: step pipeline, boundary checks, budgets, git and GitHub operations. Off by default. [ralph/README.md](ralph/README.md) |
| Acceptance Verifier | `verifier/`, `.github/workflows/acceptance-verifier.yml` | Reusable workflow that checks a pull request against its issue; the verdict is computed by `verifier/verdict.js` |
| Calibration Judge | `judge/` | Optional analyser of failed verifier rounds; it only observes. Off by default |
| Hooks | `hooks/` | Claude Code hooks for a developer session: closure gate, skill gate, skill marker, lint and typecheck helpers. [hooks/README.md](hooks/README.md) |
| Skills and agents | `skills/`, `agents/` | Process skills (`prd`, `plan`, `issues`, `task-lifecycle`, ...), JS metaskills and agents copied into a project by setup |
| Profile | `profile/` | Schema (`profile/schema.json`) and loader of `.factory/profile.json`, branch naming, path patterns |
| Commands | `bin/`, `doctor/` | `dark-factory-setup`, `factory doctor`, `dark-factory-pin`, `dark-factory-ralph-wsl` |

### Guides

Step-by-step instructions live in `docs/` of this repository. They are not part of the installed package; read them at the release tag you use.

- [Connecting a project](docs/connecting-a-project.md): the order of installation, profile, trusted configs, GitHub settings, wrappers, hooks, the optional Ralph and Judge, and what `factory doctor` does and does not prove.
- [Upgrading the pinned release](docs/upgrading.md): moving the tag, the lock and the commit SHA of every wrapper in one PR, and recovery when the hooks block Claude Code.
- [Adding a setting](docs/adding-a-setting.md): adding a field to an existing mechanism, with `ralph.stepBudgets` as the worked example.
- [Adding an element](docs/adding-an-element.md): adding a new Ralph step, verifier check, doctor check, hook or package skill: where each is registered and enabled, proving that the disabled variant changes nothing, and delivery by release and pin update.
- [Ralph consumer run](docs/verification/ralph-consumer-run.md): the protocol of the controlled real run (#48).

### Repository layout

| Path | Role | Ships to projects |
|---|---|---|
| `bin/`, `doctor/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/` | Package sources (the `files` field of `package.json`) | yes |
| `.claude/` | Tooling for developing the factory only | no |
| `.factory/profile.json` | The factory's own project profile | no |
| `.github/` | CI of this repository | no |

The rules for working in this repository (core invariants, release cycle, task process) are in [CLAUDE.md](CLAUDE.md).

### Profile

Everything project-specific reaches the core through `.factory/profile.json` at the git root of the project, validated against `profile/schema.json` by `loadProfile`; an invalid profile is an error, never a fallback. It names the branch template, the apps with their `install` and `gate` commands (commands are never guessed), the rule files, the document directories, the `hooks.lint`/`hooks.typecheck` commands, the enabled verifier checks and the optional `ralph` and `judge` blocks. A new step or check is off until the profile enables it. Examples for a monorepo and a single package are in `examples/profiles/`; the field-by-field procedure is in [docs/connecting-a-project.md](docs/connecting-a-project.md#2-write-the-profile).

### Installing skills and agents in a project

`dark-factory-setup --consumer-root <path>` (`bin/setup.js`) lays out the whole base set of `skills/base-set.json` (process skills, JS metaskills, agents) plus the profile's `extraMetaskills` as plain copies in `<path>/.claude/skills/<name>/` and `<path>/.claude/agents/<name>.md`. The same file is the package's `postinstall`: with no argument it takes the git root found from `INIT_CWD` (the directory npm was started in, a subdirectory is fine). An explicit `--consumer-root` wins and must be the git root itself; the package directory is never a default, and no root or a root outside git is an error without writes. `code-review` (`runtimeSkills`) is bundled with the Claude CLI and is not copied. The profile is read only through `loadProfile`. Sources are the executing package and its pinned `metaskills` dependency (nested or hoisted); a missing source or a wrong version is an error, nothing is downloaded.

Ownership. Copies setup made are listed in `.claude/.factory-installed.json` (`{ "format_version": 1, "copies": [...] }`). A repeated run updates those copies and removes the ones that left the base set or the profile, only if they have no tracked files. **A path that exists but is not in the list is foreign**, even if Git ignores it and its name equals a base skill: setup stops with a conflict naming the path and never adopts it. Old copies from before the list existed must be removed or moved by hand once. A tracked path is always a conflict.

Git. Setup never changes tracked files, including `.gitignore`. The project must ignore every copy by name, plus the list:

```gitignore
.claude/.factory-installed.json
.claude/skills/prd
.claude/skills/js-gof
.claude/agents/verify.md
# ...one line per skill and agent of the set (a leading / and a trailing / for directories are fine)
```

A general mask such as `.claude/skills/` is not enough, and `git check-ignore` must confirm that a later rule or negation does not re-include the recipient; the error names the missing line. The whole plan (profile, sources, list, tracked files, ignore rules, conflicts, links outside the project) is checked before the first write. As the package's `postinstall` it exits non-zero on any of these problems, which fails the install: fix the cause, or install with `--ignore-scripts` and run `dark-factory-setup` once ready. The postinstall of the factory package itself lays out nothing, needs no profile and exits `0`: the root postinstall of this repository (`INIT_CWD` is the package root or one of its directories), npm's temporary preparation of the package as a git dependency (an `npm install` in the unpacked tag, possibly without `.git`), and, inside that preparation, the factory's own pinned release installed as a dependency of the prepared tree. Any other start is a consumer and is checked in full, a project named `dark-factory` included; an explicit `--consumer-root` pointing at the package's own repository is an error. The factory receives its copies from the postinstall of its installed release (`node_modules/dark-factory`), like any project; if that release is missing or its setup fails, `npm install` fails and nothing falls back to the working sources. Ralph runs setup in each clone itself, see [ralph/README.md](ralph/README.md). The full order of a first connection (profile, install with `--ignore-scripts`, exclusions, setup, hooks) is in [docs/connecting-a-project.md](docs/connecting-a-project.md).

### Ralph

Ralph (`ralph/`) executes GitHub issues of a consumer project with Claude Code in a Docker sandbox. It is **off by default** (`ralph.enabled`); in this repository it stays disabled.

- **Pipeline.** `implement`, `self-review`, `code-review`, `final-gate` from a step registry; with `ralph.enabledSteps` absent all four run, and a review is left out only by an explicit full list. Review fix budgets come from `ralph.stepBudgets`.
- **Agent rights.** Edits outside the protected paths and read-only git (`status`, `diff`, `log`, and `show` in the reviews); no `gh`, no commit, no push. Check commands are exactly the profile's gate commands.
- **Sandbox.** Every agent call, install and gate command runs in Docker; the gate has no network, installs and the agent reach the network only through a proxy allowlist. There is no host fallback.
- **Outcomes.** `done` (commit, push, PR, issue comment) or BLOCKED (comment, label `ralph-blocked`, no PR).
- **Running.** `node node_modules/dark-factory/ralph/run.js --config .ralph/config.json`, or on Windows `dark-factory-ralph-wsl` from a service clone in WSL2.

Inputs, protections, levels of verification and the files are in [ralph/README.md](ralph/README.md).

### Acceptance Verifier

A project calls the reusable workflow `.github/workflows/acceptance-verifier.yml` from a short wrapper (`examples/wrappers/acceptance-verifier.yml`) at the full commit SHA of its pinned release. Verifier code comes only from that commit, project values only from the project's default branch (`.factory/profile.json` and the trusted configs in `.github/verifier/`), and the PR head is read as data, never executed. The checks a profile enables are registered in `verifier/checks/` (`spec-approval`, `affects-scope`, `computed-items`, `test-tampering-scan`, `references`, `ci-checks`, `allowed-model`); the model answers the individual items of the issue, and `verifier/verdict.js` computes `PASS`, `FAIL` or `NEEDS_HUMAN`. When a v2 issue fails only on the model's judgement, a second run decides; disagreeing runs give `NEEDS_HUMAN`. The result is a PR comment and the commit status `Acceptance Verifier`. The issue format both sides share is [verifier/issue-contract.md](verifier/issue-contract.md); `node verifier/issue-lint.js <issue.md> --require-v2` checks a body before it is filed.

### Checking a project: `factory doctor`

`factory doctor [<project-path>]` (`bin/doctor.js`, the `factory` command of the package; `dark-factory-setup` stays) checks that the factory is connected to a project and lists every problem it finds as `subject: reason`. It only reads: it fixes nothing, installs nothing, runs no `git fetch`, CI, Docker, Ralph or model, does not check branch protection and does not run commands from the project's settings. Setup is only *prepared* (the same plan `dark-factory-setup` checks), never applied.

```sh
node_modules/dark-factory/bin/doctor.js doctor            # the project the current directory belongs to
node_modules/dark-factory/bin/doctor.js doctor ../other   # an explicit project
```

- **Project and branch.** Without an argument the root is the git root of the current directory (a subdirectory is fine); with `<project-path>` it is the git root of that path, and the files and every `gh` call (`label list`, `secret list`, `variable list`, run in that root) belong to it even when doctor is started from another repository. A missing path, a directory outside git or an unavailable `git` is an error (exit code 2) with no fallback to the package directory. The report names the checked root and the branch or `detached HEAD`.
- **Missing installation.** The package checked is `<root>/node_modules/dark-factory`, never the running copy. When it is missing, run an available copy of doctor on the project: the report names the package as not installed.
- **What is checked.** The profile (through `loadProfile`; names in `verifier.checks` against the core registry, an empty list stays empty); the five trusted configs `.github/verifier/{owners,required-checks,allowed-models,tampering-scan,risk-zones}.json` and an existing `issue-contract.overlay.json` with the parsers of the core (a missing overlay is fine); the labels `spec-approved`, `manual-verified`, `factory-cross-change`, `test-removal-approved`, the secret `OPENAI_API_KEY` (by name only, its value is never requested) and the variable `VERIFIER_MODEL`; the verifier wrapper (a job that calls the factory's reusable `acceptance-verifier.yml` by a full commit SHA with the same SHA in `with.factory-sha`; every checked wrapper pins one SHA); the six entries of the five hooks in `.claude/settings.json` (`hooks/entries.js`); the installed package, its hook scripts and the `dark-factory` release tag in the project's `package.json`; the skill and agent copies, their list and `.gitignore` exclusions.
- **Conditional blocks.** With `ralph.enabled` the labels `ralph-blocked` and `labels.humanNeeded` are required (a missing profile field is a problem). With `judge.enabled` the label `labels.calibration`, the variable `CALIBRATION_JUDGE_MODEL`, the Calibration Judge wrapper, both `.github/calibration/` configs and the verifier wrapper at `.github/workflows/acceptance-verifier.yml` are required. The spec-approval wrapper is required when `verifier.checks` has `spec-approval`. With `allowed-model`, `VERIFIER_MODEL` must be in `allowed-models.json`; `CALIBRATION_JUDGE_MODEL` is compared with `.github/calibration/allowed-models.json` only, the lists are never mixed. A disabled block asks for none of this.
- **Exit codes.** `0` no problems; `1` at least one problem, including a check that could not run (a failed `gh` call is reported as unavailable, not as a missing setting, and an invalid profile marks its dependent checks as not checked); `2` wrong usage, an unusable location, or a failure of doctor itself (nothing was verified).
- **Limits.** Secrets and variables are the repository's own (`gh secret list`, `gh variable list` without `--org` or `--env`); wrappers are read as block-style YAML text (a `jobs:` block, `uses` and `with.factory-sha` as plain or quoted scalars), not with a YAML parser.
- **Working tree, not CI.** Doctor looks at the local working tree. It does not prove the same files are on the default branch CI reads the trusted configs from, and it does not resolve the release tag to the pinned SHA (CI does).

### Moving to a newer release: `dark-factory-pin`

`node node_modules/dark-factory/bin/pin.js vX.Y.Z [--dry-run] [--base <branch>] [--allow-older]` (`bin/pin.js`, the `dark-factory-pin` command of the package) moves a connected project to a published release tag in one command. Before it writes anything it checks that the tag is published in the repository named by the project's own pin, that the working tree is clean and contains the default branch, and that every workflow calling the factory release is pinned to one full commit SHA (a call at a tag or a branch is refused). An older tag than the pinned one needs `--allow-older`. Then it installs the tag (`npm install --ignore-scripts`, restoring `package.json` and the lock if npm fails or locks another commit), puts the tag's commit SHA into those workflows, adds the missing `.gitignore` lines of the new base set (lines are only added), runs the setup and doctor of the new release and checks that only those files changed (untracked files included). It never commits, opens a pull request or touches a tag, and nothing runs it automatically. What it leaves to you is in [docs/upgrading.md](docs/upgrading.md).

### PRD and plan templates

The `prd` and `plan` skills get their template from the installed package, so the shared structure and the section instructions live in one place (`skills/templates.js`) and a project adds its own sections without copying anything:

```sh
node "<root>/node_modules/dark-factory/skills/templates.js" <prd|plan> --project "<root>"
```

`<root>` is the explicit absolute root of the consumer project; the module path is built from it, so the command works from any current directory, including a copied skill directory. The command reads the profile with `loadProfile`, prints the Markdown to stdout and creates no document. Any error (unknown kind, a missing `--project`, an invalid profile or overlay) exits non-zero with the reason on stderr and prints no template: there is no fallback to the base. Only `prd` and `plan` exist; the issue structure is not a template of this command.

Overlay. The profile can set `overlays.prd` and `overlays.plan` to a path relative to `.factory/overlays/` of the project. Without a setting the output is the base template. Only the overlay of the requested kind is read, and `loadProfile` never opens overlay files. The file is JSON of exactly this shape:

```json
{ "sections": [{ "title": "Additional section", "body": "Instructions" }] }
```

`sections` is an array (it may be empty). `title` is a non-empty single-line string, `body` a string; unknown fields, wrong types and invalid JSON are errors. The sections are added after the whole base, in array order, with their body. An overlay can only add: `removeSections` is always rejected (so is renaming by remove and add), and a title equal to a base section or its alias (the base heading is the English `Acceptance Criteria`; the earlier Russian «Критерии готовности (Acceptance Criteria)» stays as its alias, and so does the earlier Russian name of every other base section) or to another addition is rejected; titles are compared ignoring case and runs of whitespace. The path must be relative, without a `..` segment, and the file must stay inside `.factory/overlays/` also after symlinks are resolved; a reference to a missing file is an error naming the path. See `examples/profiles/*/.factory/overlays/prd.json`.

The structure of an issue has one mechanism only: the issue contract and the project overlay `.github/verifier/issue-contract.overlay.json`. `overlays.issue` is not a profile field and is rejected.

The base branch of an epic is named by the existing `branchNameFor` of `profile/branch.js` from the profile's `branchTemplate`, the tracking issue number and the short epic name with the suffix `-base`; the skills do not carry a branch prefix.

### Calibration Judge

**Calibration Judge** (`judge/`, reusable workflow `.github/workflows/calibration-judge.yml`) analyses failed Acceptance Verifier rounds and attributes each failure to the issue, the implementation, the verifier or the infrastructure, so the owner can calibrate the verifier and the issue skills. It only observes: it never changes a verdict, a status or a label. It is **off by default**: a project turns it on with `judge.enabled: true` and `labels.calibration` in its profile and a short wrapper (`examples/wrappers/calibration-judge.yml`). Every verifier round stores a snapshot of the rules it used, so Judge reads the rules of a past round from that round and never from the project's current settings.

### Why plain JavaScript and not TypeScript

The core is CommonJS JavaScript with no build step.

- **No build for consumers.** Hooks and scripts run directly with `node`. A TypeScript core would need compilation and built artifacts in every release, and every consuming project would depend on that step.
- **Fail-closed hooks stay simple.** A hook gate must block on any error. Fewer moving parts between the source and the executed file means fewer ways for a gate to break.
- **Types are still checked.** `tsc --noEmit` with `allowJs` and `checkJs` reads JSDoc annotations, so typos and wrong calls are caught in an editor hook and in CI, without compiling anything.
- **Portable code.** Code that moves between projects is plain JavaScript on Node.js 22 or newer, with no transpilation.

TypeScript is used here only as a checker. Consuming projects are free to write their own code in TypeScript.

### Commands

```sh
npm ci             # installs the pinned release; its setup lays out the copies of skills and agents; the root postinstall lays out nothing
npm test           # node --test; no network, no Docker, no real AI
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit (checkJs)
npm run prepare:ralph:sandbox && npm run test:ralph:sandbox   # Ralph Docker integration with a stub agent (Linux host, Linux Docker engine)
node node_modules/dark-factory/bin/doctor.js doctor           # connection check of this repository (needs gh)
```

The repository runs on its own pinned release; the commands to restore a missing or broken one, to make a release and to move the pin are in [CLAUDE.md](CLAUDE.md) (Release cycle, Recovery).

CI runs the same checks on every pull request: `Test (Linux)`, `Test (Windows)`, `Lint`, `Typecheck` and `Ralph sandbox integration`.

### Limits

What the controlled real run (#48, [protocol](docs/verification/ralph-consumer-run.md#9-remaining-limits)) does not cover:

- **One platform.** A Windows 11 controller host starting Ralph in WSL2 Ubuntu with Docker Desktop and a Linux engine. A native Linux host, macOS and Windows without WSL are not covered by a real run.
- **One consumer shape.** One issue in one monorepo consumer; the single-package shape is covered only by the stub tests.
- **No review fix by a real model.** The issue was a minimal deletion; both reviews passed at once, so the fix calls (`review-fix`, `code-review-fix`) and repeated review passes ran only with the stub agent.
- **Cost and argument vector are not recorded.** The controller does not log the USD cost of a call or the exact argument vector of the container call; adding that is a product change.
- **CLI warning.** The pinned CLI prints `unrecognized_model` for the configured model; the calls succeed, and the warning is to be watched on the next CLI pin.

Beyond that run: the hooks are tested by `npm test`, but a real interactive Claude Code session with them is not part of any recorded protocol, and Ralph is not used on this repository itself.
