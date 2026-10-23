# dark-factory

The shared core of an AI software factory: **Ralph** (an autonomous agent that executes GitHub issues), the **Acceptance Verifier** (a PR verifier whose verdict is computed by code, not by the model), and the Claude Code skills, agents and hooks that wrap them.

Projects install a pinned release of the package and supply project-specific values only through their own `.factory/profile.json` and overlays. Nothing project-specific lives in the core.

> Status: bootstrap. The package has no release yet; the repository is being built phase by phase. What is implemented (setup, `factory doctor`, the verifier, Judge, the hooks, the Ralph controller) is described below and in the guides; a live run of the pinned `claude` CLI from an installed release, hooks and Ralph included, is not confirmed yet (#48).

## Guides

Step-by-step instructions live in `docs/` of this repository. They are not part of the installed package; read them at the release tag you use.

- [Connecting a project](docs/connecting-a-project.md): the order of installation, profile, trusted configs, GitHub settings, wrappers, hooks, the optional Ralph and Judge, and what `factory doctor` does and does not prove.
- [Upgrading the pinned release](docs/upgrading.md): moving the tag, the lock and the commit SHA of every wrapper in one PR, and recovery when the hooks block Claude Code.
- [Adding a setting](docs/adding-a-setting.md): adding a field to an existing mechanism, with `ralph.stepBudgets` as the worked example.
- [Adding an element](docs/adding-an-element.md): adding a new Ralph step, verifier check, doctor check, hook or package skill: where each is registered and enabled, proving that the disabled variant changes nothing, and delivery by release and pin update.

## Repository layout

| Path | Role | Ships to projects |
|---|---|---|
| `bin/`, `doctor/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/` | Package sources (the `files` field of `package.json`) | yes |
| `.claude/` | Tooling for developing the factory only | no |
| `.factory/profile.json` | The factory's own project profile | no |
| `.github/` | CI of this repository | no |

The rules for working in this repository (core invariants, release cycle, task process) are in [CLAUDE.md](CLAUDE.md).

## Installing skills and agents in a project

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

A general mask such as `.claude/skills/` is not enough, and `git check-ignore` must confirm that a later rule or negation does not re-include the recipient; the error names the missing line. The whole plan (profile, sources, list, tracked files, ignore rules, conflicts, links outside the project) is checked before the first write. As the package's `postinstall` it exits non-zero on any of these problems, which fails the install: fix the cause, or install with `--ignore-scripts` and run `dark-factory-setup` once ready. In this repository the same file only runs the factory's own bootstrap until the factory runs on its own release. Ralph runs setup in each clone itself, see [ralph/README.md](ralph/README.md). The full order of a first connection (profile, install with `--ignore-scripts`, exclusions, setup, hooks) is in [docs/connecting-a-project.md](docs/connecting-a-project.md).

## Checking a project: `factory doctor`

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

## PRD and plan templates

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

## Optional elements

**Calibration Judge** (`judge/`, reusable workflow `.github/workflows/calibration-judge.yml`) analyses failed Acceptance Verifier rounds and attributes each failure to the issue, the implementation, the verifier or the infrastructure, so the owner can calibrate the verifier and the issue skills. It only observes: it never changes a verdict, a status or a label. It is **off by default**: a project turns it on with `judge.enabled: true` and `labels.calibration` in its profile and a short wrapper (`examples/wrappers/calibration-judge.yml`). Every verifier round stores a snapshot of the rules it used, so Judge reads the rules of a past round from that round and never from the project's current settings.

**Ralph** (`ralph/`) executes GitHub issues of a consumer project with Claude Code in a Docker sandbox; its controller owns every git and GitHub operation. It is **off by default** (`ralph.enabled`). The controller, its setup in the clone and the hooks are in the package; what is still missing is the live confirmation of a bounded run of the pinned `claude` CLI from a release (#48), so Ralph is not declared ready. [ralph/README.md](ralph/README.md) lists its inputs and the levels of verification. In this repository it stays disabled.

## Why plain JavaScript and not TypeScript

The core is CommonJS JavaScript with no build step.

- **No build for consumers.** Hooks and scripts run directly with `node`. A TypeScript core would need compilation and built artifacts in every release, and every consuming project would depend on that step.
- **Fail-closed hooks stay simple.** A hook gate must block on any error. Fewer moving parts between the source and the executed file means fewer ways for a gate to break.
- **Types are still checked.** `tsc --noEmit` with `allowJs` and `checkJs` reads JSDoc annotations, so typos and wrong calls are caught in an editor hook and in CI, without compiling anything.
- **Portable code.** Code that moves between projects is plain JavaScript on Node.js 22 or newer, with no transpilation.

TypeScript is used here only as a checker. Consuming projects are free to write their own code in TypeScript.

## Commands

```sh
npm install        # installs dev tooling; postinstall runs the repository's own metaskills bootstrap
npm test           # node --test; no network, no real AI
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit (checkJs)
```

CI runs the same checks on every pull request: `Test (Linux)`, `Lint` and `Typecheck`.
