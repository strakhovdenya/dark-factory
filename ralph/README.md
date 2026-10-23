# Ralph controller

Ralph executes GitHub issues of a consumer project (a repository that installed this package) with a Claude Code agent. The **controller** in this directory is deterministic code: it picks an issue, prepares a clone, runs the step pipeline (by default the agent and two review passes) in the Docker sandbox, checks the agent's boundaries after every turn, runs the project's gate and, only when everything is green, commits, pushes and opens the PR. The agent only edits files and reports a verdict.

Ralph is **off by default** (`ralph.enabled` in the profile). In this repository it stays disabled.

## Status: not ready to run from an installed package

The controller is in the package, but these stages are still missing; until they are done the controller is not declared ready, and a CLI run without the configuration below stops before doing anything:

| Missing stage | What it adds |
|---|---|
| Hooks | the skill-gate and lint/typecheck hooks of the package |
| Real Claude run in a consumer | a bounded run of the pinned `claude` CLI with the real `buildClaudeArgs` flags and the `code-review` skill |

There is no host fallback at any stage: without Docker nothing runs.

## Levels of verification

| Level | Command | Where it runs | What it proves |
|---|---|---|---|
| Portable | `npm test` | Linux and Windows, no Docker, no network, no AI | the controller, the sandbox arguments and policies, with processes replaced at the `child_process` boundary |
| Packed package | `npm test` (`test/installed-ralph.test.js`) | Linux and Windows, no Docker, no network, no AI | the real `npm pack` tarball installed in a monorepo and a single-package consumer: the installed CLI, the profile lookup and the clone's real setup, up to the controller's PR call |
| Docker integration | `npm run prepare:ralph:sandbox`, then `npm run test:ralph:sandbox` | Linux host (WSL included) with a Linux Docker engine and BuildKit | the real containers, mounts, networks, proxy, npm, time limits and cleanup, with a stub agent |
| Real Claude | a separate task | a consumer | the pinned CLI with the real flags and the `code-review` skill |

### Packed package

- **What is installed.** The tarball of `npm pack` of the current checkout, unpacked as `node_modules/dark-factory` in temporary consumers outside the checkout, with the full runtime closure of its packed `dependencies` (resolved through `package-lock.json`, copied from packages already installed by `npm ci`, no registry and no devDependencies). The run clone gets the same tarball and closure as its install step; nothing is copied from the checkout's sources and no `NODE_PATH` is set.
- **What runs for real.** The installed `ralph/run.js` as its own Node process (absolute path of the entry point, started from a subdirectory, no `--consumer-root`), git against a local bare origin, and the clone's own `bin/setup.js`.
- **What is replaced.** `test/fixtures/installed-ralph/boundary.js`, preloaded into the controller process, answers gh, emulates the Docker CLI (installs lay out the tarball, the gate succeeds, `factory-setup` runs the real setup on the host) and starts a stub agent instead of `claude`. It proves the delivery is complete and works in both consumer forms; it proves nothing about container isolation (Docker integration) or the real Claude CLI and its `code-review` skill (real Claude run).
- **Success** is the `done` result in `state.json` and the controller's own `gh pr create` call, not the exit code: the CLI returns 0 after a BLOCKED issue too.

### Docker integration

- **Requirements.** A Linux host (a Linux distribution under WSL counts) with a Linux Docker engine and BuildKit (`docker buildx`). Any other host or engine stops the run with the reason before any scenario; Windows with Docker Desktop is not a supported platform of this suite (the controller on Windows is covered by `npm test`). `npm ci` must have run: the factory copy is made offline from this checkout's `node_modules`.
- **Configuration.** `test/fixtures/ralph-sandbox/integration.json`: Node `22`, the exact Claude CLI `2.1.283`, the image tags (`ralph-sandbox-it:source`, `ralph-sandbox-it:stub`) and the names of the controlled test service. The base fixture profiles keep their placeholder versions.
- **`npm run prepare:ralph:sandbox`** (`test/integration/prepare-ralph-sandbox.js`) is the only step that builds or downloads: it lays out the current working version of the factory as an installed package with its runtime dependencies, builds the source image with that copy's own `sandbox.buildImage`, then the derived stub image (`test/fixtures/ralph-sandbox/Dockerfile`), which puts a stub `claude` first in `PATH` and carries the factory copy, the fixture commands and a minimal HTTPS npm registry with a test certificate.
- **`npm run test:ralph:sandbox`** (`test/integration/run-ralph-sandbox.js`) never builds or pulls. It fails with the reason when the Docker CLI is missing, the engine is unreachable or not Linux, an image is missing, or `claude --version` of the source image is not the pin; then it runs `test/integration/ralph-sandbox.test.js` with the node test runner and fails on any failure, cancellation, skip, todo or a run without tests. After the images are prepared nothing reaches `registry.npmjs.org` or another external host: npm talks to the fixture registry through the real proxy.
- **Runs root.** Clones, sessions and every mount source live in the system temporary directory, which must be outside the operator's home (the suite checks it); the same rule as the `runsRoot` of a real run.
- **CI.** The workflow `.github/workflows/ralph-sandbox-integration.yml` (job `Ralph sandbox integration`) runs automatically on every pull request (opened, new commits, reopened) on the head of the PR, and can be started with `workflow_dispatch`. It prepares the images and runs the suite as separate steps, without AI secrets.
- **What the stub proves and what it does not.** The stub is a separate process in the real agent container: it reads the permission settings the controller wrote for its pass, probes the container (credentials, home, mounts, `.git`, network) and answers like the CLI. It proves the controller's settings and the container boundaries; it does not prove that a real Claude obeys the permission rules, the real CLI flags or the `code-review` skill: those belong to the real Claude run.
- **Maps.** The reference Docker scenarios (`test/fixtures/ralph-sandbox/cases.json`, `test/fixtures/ralph-controller/integration-cases.json`) name the integration tests that execute them. The status `integration-mapped` records coverage, never a passed run; the result of a run is the CI job.

## Skills and agents setup in the clone

Preparing a clone runs in this order: all installs of the root and of the apps, then the package's own setup, then the check of the required skills, then the agent permissions and the agent. Setup is clone preparation, not a step of the pipeline registry.

The setup is `node_modules/dark-factory/bin/setup.js --consumer-root /workspace`, taken from the factory release **installed in the clone** (never from the controller's own version or a project script). It runs in the existing install sandbox: read-only `.git`, isolated git environment, the profile's `installEnv`, the step time limit and a log next to the install logs (`install-factory-setup-*.log`). The controller adds no hidden `npm install`: the package must be installed by the project's own install commands, and `--ignore-scripts` is fine because the controller runs setup itself. A non-zero exit, a timeout, a failure to start or a clone without the installed package is an `InstallError` for the step `factory-setup`: the issue is BLOCKED with no agent, no gate, no commit, no push and no PR, and nothing is run on the host. The clone's `.gitignore` must carry the named entries setup requires (see the root README).

## Inputs and the consumer root

The controller never uses the directory of the installed package. The current directory is only the starting point of the root search (or the base of a relative CLI path); after the root is known every git and gh call has an explicit cwd.

```sh
# from the consumer root
node node_modules/dark-factory/ralph/run.js [--config <local-config.json>] [--max-iterations <n>]
# from any subdirectory: the absolute path of the installed entry point
node "$(git rev-parse --show-toplevel)/node_modules/dark-factory/ralph/run.js" [--config <local-config.json>] [--max-iterations <n>]
# or for any location
node node_modules/dark-factory/ralph/run.js --consumer-root <path> [--config <local-config.json>] [--max-iterations <n>]
```

- **`--consumer-root` is optional and wins.** The path is resolved against the current directory and must be the top of a git repository; a wrong value is an error, never replaced by a search for another project.
- **Without it** the root is `git rev-parse --show-toplevel` of the current directory, so a run from a subdirectory finds the project's root and profile. Outside a git repository the CLI stops with an error about the root.
- The profile of that root is loaded and validated before the lock, the runs directory and the clone: a missing file (the error names the expected path) or an invalid field (named) stops the run.

API: `runRalph({ consumerRoot, profile, localConfig, maxIterations, deps })` in `run.js`. `consumerRoot` stays explicit in the API. `deps.stepRegistry` is an optional prepared step registry (see "Step pipeline"); without it the default registry of `steps/registry.js` is used.

1. **`consumerRoot`** — absolute path of the top of the consumer's git repository. It must have an `origin`. Every git and gh call of the controller runs there or in its run clone; the clone is made from that origin.
2. **The profile** — `<consumerRoot>/.factory/profile.json`, loaded and validated by `profile/load.js`. It is the only source of project values: apps, `install`, `apps[].install`, `apps[].gate`, `dependencySync`, `protectedPaths`, `docOnlyPathPatterns`, `ruleFiles`, `agentEnvironment`, `skillRules`, `labels.humanNeeded`, `ralph.humanNeededVerdict`, `ralph.techDebtTrackerIssue`, `ralph.enabledSteps`, `ralph.stepBudgets`, `branchTemplate`, `sandbox`.
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

## Trusted profile of a run

- **Snapshot.** `runRalph` makes a deep copy of the validated host profile and freezes it recursively (nested objects and arrays) before the readiness checks. That one snapshot is the `ctx.profile` of every issue of the run; the caller's object stays mutable and is not used afterwards, and the host's file is not read again.
- **Base check.** For each issue, right after the clone checks out the base that is actually used (the default branch or, for a stacked issue, the dependency's task branch) and before the egress proxy, dependency installation and the agent, the clone's `.factory/profile.json` is loaded with the same loader and compared with the snapshot by JSON value (object key order and formatting do not matter, array order does). A missing, invalid or different profile makes the issue `prepare_failed` with a configuration error naming the host, the clone and the base (a loader failure keeps its own reason). The controller never repairs or publishes a profile: commit the same profile to the base.
- **Protected file.** `.factory/profile.json` is a core protected path next to `.git/` and `.claude/`, whatever `protectedPaths` and the issue's Affects say: the agent gets Edit/Write denials for it, and a change or deletion is BLOCKED right after that turn, with no further step, commit, push or PR.

## Readiness checks (before the lock, the clone and the agent)

In this order, each with an exact error and no side effects:

1. `ralph.enabled` is `true`, and the fields an enabled controller needs are present: `ralph.humanNeededVerdict`, `labels.humanNeeded`, `ralph.techDebtTrackerIssue`, `sandbox`. No project default is assumed.
2. The step pipeline against the step registry in force (`deps.stepRegistry` or the default): every name in `ralph.enabledSteps` is registered, every `ralph.stepBudgets` key is a registered step with a fix, every registered step is well formed and names a known permission profile. This holds even when the issue queue is empty.
3. The local run config is valid; the agent model is a model ID.
4. The sandbox section is valid (`sandbox.validateSandboxConfig`); the runs root resolves outside the home directory (`sandbox.resolveRunsRoot(localConfig, consumerRoot)`).
5. `branchTemplate` recognizes its own branch names.
6. `consumerRoot` is the top of a git repository with an `origin`.
7. The labels `ralph-blocked` and `labels.humanNeeded` exist in the consumer repository (exact names). The controller never creates labels.

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

## Step pipeline

One issue runs through a pipeline of **steps**. The steps live in a registry (`steps/registry.js`, step name -> step); `core.js` never imports a step module and runs only the steps of the resolved pipeline.

| Base step | Kind | What it does |
|---|---|---|
| `implement` | agent, writes, profile `implementer` | the agent implements the issue (`steps/implement.js`) |
| `self-review` | agent, read-only, profile `reviewer`, fix `review-fix` | a fresh agent checks the diff against the issue (`steps/self-review.js`) |
| `code-review` | agent, read-only, profile `code-reviewer`, fix `code-review-fix` | the `code-review` skill in report-only mode (`steps/code-review.js`) |
| `final-gate` | check (code, no model) | the profile's gate commands of the touched apps (`steps/final-gate.js`) |

- **`ralph.enabledSteps`** — absent: the baseline pipeline `implement`, `self-review`, `code-review`, `final-gate` (both reviews on). An explicit list is the **whole** pipeline in run order: `implement` first and `final-gate` last, each exactly once; the reviews may be left out (`["implement", "self-review", "final-gate"]` has no code-review), and when both are listed `self-review` comes first. Other registered steps go between them and run only when listed. `[]` is invalid. `loadProfile` checks this structure; the runner checks the names against the registry.
- **`ralph.stepBudgets`** — step name -> integer >= 1, the number of **fix calls** of a review step (4 allows at most five review calls). Defaults: `self-review` 2, `code-review` 2. Budgets are independent; the task's time and cost limits still cover every call. A key that is not a registered step with a fix is a configuration error; a budget of a registered review that is not enabled is allowed and does not enable it. Example: `"stepBudgets": { "self-review": 4, "code-review": 2 }`.
- **Step kinds.** An `agent` step has a `mode` (`read-only` or `writes`), the name of a controller permission profile (`implementer`, `reviewer`, `code-reviewer` — a step never supplies raw rules), a prompt builder and an output parser; a read-only step may have a `fix` (its own prompt and parser, profile `implementer`, default budget). A `check` step is a deterministic function. Every step returns an outcome: `passed`, `passed-out-of-scope`, `failed` (fixable), `blocked`, `human-needed`, `error` or `unparseable`.
- **What the controller does for every step.** Each agent call — fixes included — goes through the controller's wrapper: the named permission file written before the call, the scrubbed environment and sandbox, the per-call timeout, the task's time and cost budget, `maxTurns` for write calls and `reviewMaxTurns` for read-only calls. After every call the boundary check; after every read-only call the working tree must equal its state right before that call. After every passed write call the diff must be non-empty and DEL_RALPH is applied. A review loop is: read-only call -> on a fixable failure with budget left, a fix call -> read-only call again; an exhausted budget or an unreadable review verdict is BLOCKED without a fix. Out-of-scope findings go to the tech-debt tracker and the pipeline continues.
- **Finishing.** Dependency sync runs after every earlier step, right before `final-gate` (doc-only diffs included); the gate and the last boundary check see the refreshed diff. Then: boundary check, commit, push, PR, report.
- **Doc-only diff.** Steps with `skipOnDocOnly` (the reviews and the gate commands) are skipped; `final-gate` stays in the pipeline with the outcome `skipped`. Boundary checks, dependency sync and DEL_RALPH still apply.
- **Result.** Once the steps have started, the result of `runIssue` has `steps`: the ordered `{ name, outcome }` list (`outcome` is a step outcome or `skipped`); on a stop the failing step is last. There is no separate log.
- **Extensions.** A new step is a registry entry plus its name in `ralph.enabledSteps`; it stays off until a profile lists it. Pass the prepared registry as `deps.stepRegistry`, e.g. `createRegistry([...DEFAULT_REGISTRY.values(), myStep])`. No code is loaded from the profile or from a path.

## What the agent may do

- **Git: read only.** Implementation and fix passes may run `git status`, `git diff`, `git log`; the self-review and code-review passes also `git show`. `git commit`, `git push` and every `gh` command are denied; no other git command is allowed. `.git` is mounted read-only in every sandbox phase. Branches, commits, push, PRs, comments and labels are done by the controller only.
- **Check commands come from the profile gate.** For every `apps[].gate` command of every app, the agent and both reviewers get exactly two Bash rules: the argv joined with single spaces, and the same followed by ` *` for extra arguments. Example: `{ "argv": ["node", "node_modules/eslint/bin/eslint.js", "."] }` grants `Bash(node node_modules/eslint/bin/eslint.js .)` and `Bash(node node_modules/eslint/bin/eslint.js . *)`. Nothing broad is added (`Bash`, `Bash(*)`, `npm run`, a bare package runner), and install or sync commands are never granted. A profile without gate commands grants no check command. The prompts list the same commands with their cwd.
- **Edits.** Edit/Write everywhere except the protected paths (deny rules); the review passes cannot edit at all. The controller's own `.claude/settings.local.json` is excluded in the clone (`.git/info/exclude`), so it never counts as a change and is never committed.

## Protections kept for every project

The profile can add constraints but not switch these off:

- A boundary check after **every** agent turn and once more before commit: any changed path under `protectedPaths` plus the core entries `.git/`, `.claude/` and `.factory/profile.json` (glob semantics of `profile/path-patterns.js`, case-insensitive; new, deleted, renamed — both sides —, type-changed and binary files by path), a fingerprint of `.git/`, and package.json scripts/dependencies or tool configs changed without being named in the issue's Affects. A violation is BLOCKED, no PR.
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
- Base: the consumer's default branch from the clone (`refs/remotes/origin/HEAD`) for an independent issue or one whose dependency is merged; the dependency's task branch while it is not merged (the remote branch the template recognizes as the dependency's, so a renamed dependency still works; its name by the current title when there is none). An unresolvable default branch stops the issue before the agent.

## Files

| File | Role |
|---|---|
| `run.js` | CLI and `runRalph`: readiness checks, lock, sandbox startup, issue loop |
| `core.js` | one issue, start to finish: runs the resolved step pipeline |
| `steps/` | the step registry (`registry.js`) and the base steps `implement`, `self-review`, `code-review`, `final-gate` |
| `github.js` | every git/gh call, with an explicit cwd |
| `workspace.js` | clone, installs, dependency sync, gate, DEL_RALPH, named permission profiles |
| `prompts.js` | the four prompts |
| `parsing.js` | verdicts, self-report, porcelain, issue sections (names from the issue contract) |
| `agent.js` | `claude -p` in the sandbox |
| `boundary.js` | checks after every turn, scrubbed env, budgets |
| `config.js` | constants, local run config, state, lock |
| `sandbox.js`, `sandbox/` | the Docker runtime (see `sandbox/README.md`) |

Portable tests (`*.test.js` here) run under `npm test` without network, Docker or a model: gh is replaced at the `child_process` boundary, Docker at the sandbox runtime, and git runs on local temporary repositories.
