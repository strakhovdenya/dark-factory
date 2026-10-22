# Ralph controller

Ralph executes GitHub issues of a consumer project (a repository that installed this package) with a Claude Code agent. The **controller** in this directory is deterministic code: it picks an issue, prepares a clone, runs the agent and two review passes in the Docker sandbox, checks the agent's boundaries after every turn, runs the project's gate and, only when everything is green, commits, pushes and opens the PR. The agent only edits files and reports a verdict.

Ralph is **off by default** (`ralph.enabled` in the profile). In this repository it stays disabled.

## Status: not ready to run from an installed package

The controller is in the package, but these stages are still missing; until they are done the controller is not declared ready, and a CLI run without the configuration below stops before doing anything:

| Missing stage | What it adds |
|---|---|
| Step registry | optional Ralph steps registered and switched on by `ralph.enabledSteps` |
| Profile lookup from the git root | the consumer root found from the current repository instead of `--consumer-root` |
| Skills setup in the clone | the package installs the required skills into the clone after the dependency install. Until then a required skill missing in the clone makes the issue BLOCKED before the agent |
| Hooks | the skill-gate and lint/typecheck hooks of the package |
| Docker integration tests | real-container proof of the sandbox protections (`test/integration/`); the reference Docker scenarios are recorded in `test/fixtures/ralph-controller/integration-cases.json` and are **not** verified by `npm test` |
| Packed-package check in consumers | the controller run from the installed tarball |

There is no host fallback at any stage: without Docker nothing runs.

## Explicit inputs

The controller never uses the process's current directory or the directory of the installed package.

```sh
node node_modules/dark-factory/ralph/run.js --consumer-root <path> [--config <local-config.json>] [--max-iterations <n>]
```

API: `runRalph({ consumerRoot, profile, localConfig, maxIterations })` in `run.js`.

1. **`consumerRoot`** — absolute path of the top of the consumer's git repository. It must have an `origin`. Every git and gh call of the controller runs there or in its run clone; the clone is made from that origin.
2. **The profile** — `<consumerRoot>/.factory/profile.json`, loaded and validated by `profile/load.js`. It is the only source of project values: apps, `install`, `apps[].install`, `apps[].gate`, `dependencySync`, `protectedPaths`, `docOnlyPathPatterns`, `ruleFiles`, `agentEnvironment`, `skillRules`, `labels.humanNeeded`, `ralph.humanNeededVerdict`, `ralph.techDebtTrackerIssue`, `branchTemplate`, `sandbox`.
3. **The local run config** — personal, **outside Git** (default `<consumerRoot>/.ralph/config.json`; add `.ralph/` to the consumer's `.gitignore`):

   | Field | Meaning |
   |---|---|
   | `issues` | required: `[{ "id": 12, "dependsOn": [11] }]`, the queue of this run |
   | `maxIterations`, `maxTurns`, `reviewMaxTurns` | iteration and turn limits |
   | `agentTimeoutMinutes`, `taskMaxMinutes`, `taskMaxUsd` | per-call and per-issue budgets |
   | `agentModel` | exact model ID passed to the CLI |
   | `runsRoot` | where clones, session journals, logs, the lock and the state live; absolute or relative to `consumerRoot`, default `<consumerRoot>/.ralph-runs`; never inside the operator's home (see `sandbox/README.md`) |

   Unknown fields are rejected. `branchPrefix` is rejected: task branches are named by the profile's `branchTemplate`.
4. **Credentials** — `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the controller's environment. They reach the agent container by name only (never in argv, never in the profile or logs). Without either, the agent is not started. The operator's own Claude, git and gh configuration is never read. The controller itself uses the operator's `git` and `gh` login for the consumer repository.

## Readiness checks (before the lock, the clone and the agent)

In this order, each with an exact error and no side effects:

1. `ralph.enabled` is `true`, and the fields an enabled controller needs are present: `ralph.humanNeededVerdict`, `labels.humanNeeded`, `ralph.techDebtTrackerIssue`, `sandbox`. No project default is assumed.
2. The local run config is valid; the agent model is a model ID.
3. The sandbox section is valid (`sandbox.validateSandboxConfig`); the runs root resolves outside the home directory (`sandbox.resolveRunsRoot(localConfig, consumerRoot)`).
4. `branchTemplate` recognizes its own branch names.
5. `consumerRoot` is the top of a git repository with an `origin`.
6. The labels `ralph-blocked` and `labels.humanNeeded` exist in the consumer repository (exact names). The controller never creates labels.

Then: the lock (`<runsRoot>/run.lock`), the sandbox startup (Docker engine, leftovers of this consumer, image build) and the issue loop. State goes to `<runsRoot>/state.json`.

## Connecting a consumer

1. Create the labels once:
   ```sh
   gh label create ralph-blocked --description "Ralph stopped on this issue; a human must resolve it and remove the label"
   gh label create <labels.humanNeeded> --description "Ralph needs a human decision"
   ```
   The controller sets `ralph-blocked` on every BLOCKED outcome; the human-needed verdict sets both labels. An issue with either label is not picked by later runs, and issues that depend on it are `blocked-by-dependency`. A human removes the label after resolving the cause.
2. Fill the profile (see below) and create the local run config.
3. Add `.ralph/`, `.ralph-runs/` (or your `runsRoot`), `.claude/settings.local.json` and the installed skill copies to `.gitignore`.

## What the agent may do

- **Git: read only.** Implementation and fix passes may run `git status`, `git diff`, `git log`; the self-review and code-review passes also `git show`. `git commit`, `git push` and every `gh` command are denied; no other git command is allowed. `.git` is mounted read-only in every sandbox phase. Branches, commits, push, PRs, comments and labels are done by the controller only.
- **Check commands come from the profile gate.** For every `apps[].gate` command of every app, the agent and both reviewers get exactly two Bash rules: the argv joined with single spaces, and the same followed by ` *` for extra arguments. Example: `{ "argv": ["node", "node_modules/eslint/bin/eslint.js", "."] }` grants `Bash(node node_modules/eslint/bin/eslint.js .)` and `Bash(node node_modules/eslint/bin/eslint.js . *)`. Nothing broad is added (`Bash`, `Bash(*)`, `npm run`, a bare package runner), and install or sync commands are never granted. A profile without gate commands grants no check command. The prompts list the same commands with their cwd.
- **Edits.** Edit/Write everywhere except the protected paths (deny rules); the review passes cannot edit at all.

## Protections kept for every project

The profile can add constraints but not switch these off:

- A boundary check after **every** agent turn and once more before commit: any changed path under `protectedPaths` plus the core entries `.git/` and `.claude/` (glob semantics of `profile/path-patterns.js`, case-insensitive; new, deleted, renamed — both sides —, type-changed and binary files by path), a fingerprint of `.git/`, and package.json scripts/dependencies or tool configs changed without being named in the issue's Affects. A violation is BLOCKED, no PR.
- Read-only review passes must leave the working tree unchanged.
- Per-call timeout and whole-issue time/USD budgets.
- An exclusive lock per runs root.
- The independent final gate before commit (skipped only for a doc-only diff: every changed path matches `docOnlyPathPatterns`); the gate fails if a check changes the working tree.
- The review diff includes new untracked files.
- `DEL_RALPH: <reason>` on the first line of a file asks the controller to rename it to `del_ralph_<name>`; the controller re-runs the gate afterwards.

## Dependency installs and `dependencySync`

- In a fresh clone the root `install` runs once, then each app's `install` in profile order. Commands are not guessed; an absent list means no command. The first failure makes the issue BLOCKED with the step, its cwd and the log; nothing after it runs (no further installs, no agent, no gate, no PR).
- The agent cannot install. When it changes a manifest, the controller synchronizes dependencies after the last agent pass and before the final gate with the profile's **`dependencySync`** commands (root) and **`apps[].dependencySync`** (per app), arrays of `{ argv, cwd }`:
  - Trigger (decided by the core): a git status entry — either side of a rename, deletions included — whose path is the root `package.json` or exactly `<app.path>/package.json`. The root manifest is served by the root `dependencySync` and by an app with path `.`; an app manifest by that app.
  - Each affected area runs once: the root first, then apps in profile order, commands in array order. Ordinary installs are not repeated.
  - Execution: the sandbox with the install policy — read-only `.git`, the run's network through the proxy, the validated `sandbox.installEnv`. Never on the host.
  - BLOCKED before the final gate, commit, push and PR: a changed manifest none of whose areas has a command (the reason names the file and the missing field), a `package.json` outside the root and the app paths, or a failing or timed-out command (step, cwd and log).
  - After a successful sync the diff is refreshed; the final gate and the boundary check see it, and the commit includes it.
  - The commands **must not run lifecycle scripts** of the project or its dependencies. For npm consumers:
    ```json
    "dependencySync": [{ "argv": ["npm", "install", "--ignore-scripts"], "cwd": "." }]
    ```
  - The core never parses a package manager's argv and never substitutes npm. `{file}` in install, gate and sync argv is a plain literal.

## Sandbox policy per phase

| Phase | `.git` | Network | `installEnv` |
|---|---|---|---|
| agent (all passes) | read-only | run network, proxy allowlist only | no |
| install, dependencySync | read-only | run network, proxy allowlist only | yes |
| gate | read-only | none | no |

## Outcomes

- **done** — commit with the implementation's `TYPE: ISSUE-<n> SUMMARY` (a review fix never replaces it), push, PR to the base the branch came from, then the issue comment: the acceptance self-report of the latest agent call, the test evidence and the summaries of every review fix.
- **BLOCKED** — comment with the reason, label `ralph-blocked` (plus `labels.humanNeeded` for the human-needed verdict), no commit, no PR. The run directory is kept for a human.
- Code-review findings outside the issue's Affects go to the tech-debt tracker issue `ralph.techDebtTrackerIssue` and do not block.

## Branches

- Name: `branchNameFor(branchTemplate, issue, title)` from `profile/branch.js` (`{slug}`: lower-case title, non-alphanumeric runs as `-`, at most 50 characters, `issue` when empty).
- An existing PR in any state, or a branch left on the remote, is found by `issueNumberOfBranch` of the same template, so a changed title does not create a second branch. A failed PR lookup leaves the issue unselected.
- Base: the consumer's default branch from the clone (`refs/remotes/origin/HEAD`) for an independent issue or one whose dependency is merged; the dependency's task branch while it is not merged. An unresolvable default branch stops the issue before the agent.

## Files

| File | Role |
|---|---|
| `run.js` | CLI and `runRalph`: readiness checks, lock, sandbox startup, issue loop |
| `core.js` | one issue, start to finish |
| `github.js` | every git/gh call, with an explicit cwd |
| `workspace.js` | clone, installs, dependency sync, gate, DEL_RALPH, permissions |
| `prompts.js` | the four prompts |
| `parsing.js` | verdicts, self-report, porcelain, issue sections (names from the issue contract) |
| `agent.js` | `claude -p` in the sandbox |
| `boundary.js` | checks after every turn, scrubbed env, budgets |
| `config.js` | constants, local run config, state, lock |
| `sandbox.js`, `sandbox/` | the Docker runtime (see `sandbox/README.md`) |

Portable tests (`*.test.js` here) run under `npm test` without network, Docker or a model: gh is replaced at the `child_process` boundary, Docker at the sandbox runtime, and git runs on local temporary repositories.
