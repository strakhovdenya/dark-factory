# dark-factory

The shared core of an AI software factory: **Ralph** (an autonomous agent that executes GitHub issues), the **Acceptance Verifier** (a PR verifier whose verdict is computed by code, not by the model), and the Claude Code skills, agents and hooks that wrap them.

Projects install a pinned release of the package and supply project-specific values only through their own `.factory/profile.json` and overlays. Nothing project-specific lives in the core.

> Status: bootstrap. The package has no release yet; the repository is being built phase by phase.

## Repository layout

| Path | Role | Ships to projects |
|---|---|---|
| `bin/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/` | Package sources (the `files` field of `package.json`) | yes |
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

A general mask such as `.claude/skills/` is not enough, and `git check-ignore` must confirm that a later rule or negation does not re-include the recipient; the error names the missing line. The whole plan (profile, sources, list, tracked files, ignore rules, conflicts, links outside the project) is checked before the first write. As the package's `postinstall` it exits non-zero on any of these problems, which fails the install: fix the cause, or install with `--ignore-scripts` and run `dark-factory-setup` once ready. In this repository the same file only runs the factory's own bootstrap until the factory runs on its own release. Ralph runs setup in each clone itself, see [ralph/README.md](ralph/README.md).

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

`sections` is an array (it may be empty). `title` is a non-empty single-line string, `body` a string; unknown fields, wrong types and invalid JSON are errors. The sections are added after the whole base, in array order, with their body. An overlay can only add: `removeSections` is always rejected (so is renaming by remove and add), and a title equal to a base section or its alias (`Acceptance Criteria` for «Критерии готовности (Acceptance Criteria)») or to another addition is rejected; titles are compared ignoring case and runs of whitespace. The path must be relative, without a `..` segment, and the file must stay inside `.factory/overlays/` also after symlinks are resolved; a reference to a missing file is an error naming the path. See `examples/profiles/*/.factory/overlays/prd.json`.

The structure of an issue has one mechanism only: the issue contract and the project overlay `.github/verifier/issue-contract.overlay.json`. `overlays.issue` is not a profile field and is rejected.

The base branch of an epic is named by the existing `branchNameFor` of `profile/branch.js` from the profile's `branchTemplate`, the tracking issue number and the short epic name with the suffix `-base`; the skills do not carry a branch prefix.

## Optional elements

**Calibration Judge** (`judge/`, reusable workflow `.github/workflows/calibration-judge.yml`) analyses failed Acceptance Verifier rounds and attributes each failure to the issue, the implementation, the verifier or the infrastructure, so the owner can calibrate the verifier and the issue skills. It only observes: it never changes a verdict, a status or a label. It is **off by default**: a project turns it on with `judge.enabled: true` and `labels.calibration` in its profile and a short wrapper (`examples/wrappers/calibration-judge.yml`). Every verifier round stores a snapshot of the rules it used, so Judge reads the rules of a past round from that round and never from the project's current settings.

**Ralph** (`ralph/`) executes GitHub issues of a consumer project with Claude Code in a Docker sandbox; its controller owns every git and GitHub operation. It is **off by default** (`ralph.enabled`) and is not ready to run from an installed package yet: [ralph/README.md](ralph/README.md) lists its inputs and the stages still missing. In this repository it stays disabled.

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
