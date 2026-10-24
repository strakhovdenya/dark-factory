# Connecting a project to the factory

How to connect a repository to dark-factory, in the order that works. It is a procedure to follow, not a record of a finished connection: no project has been connected by following this text yet, and the package has no published release at the time of writing.

- **Placeholders.** `vX.Y.Z` is the release tag you choose and `<commit-sha>` is the 40-character commit of that tag. Both must be replaced with real values from a published release; until one exists the connection cannot be completed. Do not stand in `main` or any other moving reference for them (see [Pinning rules](#pinning-rules)).
- **Shell.** Commands are POSIX shell: Bash on Linux and macOS, Git Bash on Windows. Run them from the **git root** of your project unless a step says otherwise.
- **Live Claude.** Everything below is checked against the code of the factory. A live run of the pinned `claude` CLI from an installed release (including the factory's hooks and Ralph) is a separate, still open confirmation (#48); this guide does not claim it.

Related guides: [upgrading.md](upgrading.md) (moving the pin, getting the release commit SHA, recovery) and [adding-a-setting.md](adding-a-setting.md) (adding a field to an existing mechanism).

## What is required and what is optional

| Part | Status | What it needs |
|---|---|---|
| Pin: `dark-factory` dependency at a release tag, with a consistent lock file | required | root `package.json`, `package-lock.json` |
| Profile `.factory/profile.json` | required | [profile/schema.json](../profile/schema.json) |
| Skill and agent copies (`dark-factory-setup`) and their `.gitignore` entries | required | steps 4–6 |
| Five trusted verifier configs in `.github/verifier/` | required | step 7 |
| Four core labels, secret `OPENAI_API_KEY`, variable `VERIFIER_MODEL` | required | step 8 |
| Verifier wrapper `.github/workflows/acceptance-verifier.yml` | required | step 9 |
| Six hook entries of five hooks in `.claude/settings.json` | required | step 10 |
| Ralph (autonomous issue executor) | optional, **off by default** | step 11 |
| Calibration Judge (analyser of failed verifier rounds) | optional, **off by default** | step 12 |
| Spec-approval wrapper | required **only if** `verifier.checks` lists `spec-approval` | step 9 |
| `allowed-model` check | optional: only if `verifier.checks` lists it | step 7 |
| Eval and factory-separation wrappers | optional | step 9 |
| PRD/plan overlays, issue-contract overlay | optional, can only add to the core | step 12 |

A project with Ralph and Judge switched off is a valid, complete connection: none of their labels, variables, configs, wrappers or Docker are needed.

## Prerequisites

- Node.js 22 or newer and npm (the `engines` of the package), `git`, and the GitHub CLI `gh` logged in with rights to the project repository (labels, secrets, variables).
- The factory repository `strakhovdenya/dark-factory` must be readable from the machine and from CI: npm installs it as a git dependency.
- Docker, an Anthropic credential and a free runs directory are needed **only** for Ralph (step 11).
- Do the bootstrap in an ordinary terminal, outside Claude Code (see the warning in step 10).

## Where each file comes from

The package that npm installs contains only its package directories (`bin/`, `doctor/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/`). `docs/` and `examples/` of this repository are **not** in `node_modules/dark-factory`.

| You need | Take it from |
|---|---|
| Executables, `profile/schema.json`, `hooks/README.md`, `verifier/issue-contract.md`, `skills/base-set.json` | the installed package: `node_modules/dark-factory/...` |
| Workflow wrappers (`examples/wrappers/*.yml`), example profiles (`examples/profiles/`), these guides | the factory repository **at the release tag you chose** (not `main`) |

Read the examples from the same tag the project pins. Fetch them once into a temporary directory outside the project:

```sh
TAG=vX.Y.Z   # the release tag you chose
REF_DIR="$(mktemp -d)"
git clone --depth 1 --branch "$TAG" https://github.com/strakhovdenya/dark-factory.git "$REF_DIR"
ls "$REF_DIR/examples/wrappers"
```

A failed clone (for example, no such tag) stops the procedure: do not continue with another branch. Remove `$REF_DIR` when you are done. Example profiles and the test fixtures `test/fixtures/profiles/{monorepo,single-package}` show the *format*; they carry values of other projects or placeholders and are not a ready connection: fill every value for your own project.

## Pinning rules

The dependency in the root `package.json` must be a release tag of this repository:

```json
{ "devDependencies": { "dark-factory": "github:strakhovdenya/dark-factory#vX.Y.Z" } }
```

`vX.Y.Z` above is a placeholder you fill in with a real tag. The following are **forbidden** and are rejected by the verifier (`FAIL`) and by `factory doctor`:

- a branch reference: `github:strakhovdenya/dark-factory#main`, `...#master`, any branch name;
- `latest`, a semver range (`^1.2.0`, `~1`, `1.x`), a bare `github:strakhovdenya/dark-factory` with no tag, or any dependency source other than this repository;
- `dark-factory` listed in both `dependencies` and `devDependencies` with different values.

The same rule holds for the wrappers: `uses: strakhovdenya/dark-factory/.github/workflows/<name>.yml@<commit-sha>` with a full 40-character commit SHA, never `@main`, `@v1`, `@latest` or a tag name. The tag and the SHA must name the same commit: [upgrading.md](upgrading.md#get-the-release-commit-sha) shows how to get it.

## Procedure

### 1. Choose the release and read its examples

Pick the tag (`vX.Y.Z`), clone the reference copy as shown above and get `<commit-sha>` of the tag with the command from [upgrading.md](upgrading.md#get-the-release-commit-sha). The command stops with an error when the tag does not exist; do not go on without a SHA.

Create a branch for the connection in your project the way the project names its branches.

### 2. Write the profile

Create `.factory/profile.json`. The file is validated by `loadProfile` against [profile/schema.json](../profile/schema.json); unknown fields are rejected, and only `branchTemplate` and `apps` are required. Setup (step 6) and every other tool read the profile, so it comes first.

**Single package.** One app at the root:

```json
{
  "branchTemplate": "task/ISSUE-{issue}-{slug}",
  "apps": [
    {
      "name": "main",
      "path": ".",
      "install": [{ "argv": ["npm", "install"], "cwd": "." }],
      "gate": [{ "argv": ["npm", "test"], "cwd": "." }]
    }
  ],
  "verifier": { "checks": ["ci-checks"] }
}
```

**Monorepo.** One app per package; the factory is still installed once, at the git root:

```json
{
  "branchTemplate": "task/ISSUE-{issue}-{slug}",
  "install": [{ "argv": ["npm", "install"], "cwd": "." }],
  "apps": [
    {
      "name": "api",
      "path": "packages/api",
      "install": [{ "argv": ["npm", "install"], "cwd": "packages/api" }],
      "gate": [{ "argv": ["npm", "test"], "cwd": "packages/api" }]
    },
    {
      "name": "web",
      "path": "packages/web",
      "install": [{ "argv": ["npm", "install"], "cwd": "packages/web" }],
      "gate": [{ "argv": ["npm", "test"], "cwd": "packages/web" }]
    }
  ],
  "verifier": { "checks": ["ci-checks"] }
}
```

Replace every value: app names and paths, the install and gate commands (argv arrays, no shell; `install` and `gate` are used by Ralph and the `verify` agent), and the branch template. In both forms the package lives in `<git-root>/node_modules/dark-factory` and the pin is in the **root** `package.json`; a repository without a root `package.json` needs a small private one for the pin. Other installation locations are not supported.

`verifier.checks` is a deliberate choice: the list names the deterministic checks that run, and an absent or empty list turns **none** on. The core checks are `spec-approval`, `affects-scope`, `computed-items`, `test-tampering-scan`, `references`, `ci-checks`, `allowed-model`; a name that no check has fails the verdict. Each check you list brings its own requirements below (for example `spec-approval` needs its wrapper, `allowed-model` needs `allowed-models.json`).

Optional fields (`install` at the root, `dependencySync`, `protectedPaths`, `docOnlyPathPatterns`, `skillRules`, `extraMetaskills`, `ruleFiles`, `overlays`, `docs`, `hooks`, `labels`, `judge`, `sandbox`, `ralph`) are described in the schema; add them when the matching part needs them.

### 3. Inventory old copies

Setup owns the skill and agent copies it lays out, and never takes over a path it did not create. Look at what already exists in `.claude/skills/` and `.claude/agents/`:

```sh
git ls-files .claude
ls -la .claude/skills .claude/agents 2>/dev/null
```

A copy of a factory skill or agent made earlier by hand or by an old installer (same name, tracked or not) will be reported as a conflict. Either remove it from Git (`git rm -r --cached <path>`, then delete the files) or, if it holds project-specific content you want to keep, move it to a name the factory does not use (`git mv`) and fix the skill's own `name` to match. Skills and agents that are the project's own and have other names are untouched. Do not widen `.gitignore` to hide a conflicting copy and do not delete files you have not looked at.

You can also let step 6 name the exact conflicts: setup checks its whole plan before writing anything and stops with the paths in question.

### 4. Install the pinned release without lifecycle scripts

From the git root:

```sh
npm install --ignore-scripts --save-dev "github:strakhovdenya/dark-factory#vX.Y.Z"
```

This changes `package.json` and `package-lock.json`; commit both. The install puts the package in `node_modules/dark-factory` and does not run the factory's `postinstall` (which would run setup before the project is ready).

`--ignore-scripts` is a property of this one npm call, not of the factory: it disables the lifecycle scripts of **everything** that call installs or rebuilds, that is the dependencies' install scripts (native builds, downloaded binaries) and the project's own `preinstall`, `install`, `postinstall` and `prepare`. The bootstrap therefore does not stand in for the project's own install. Whatever your project needs from those scripts you run afterwards by the project's own instructions (for example its documented install or `prepare` step). Later plain `npm install` or `npm ci` runs the factory's `postinstall` (setup) normally, which is why steps 5 and 6 must be committed.

Check the pin and the lock agree on the tag's commit (the lock stores the commit):

```sh
node -p 'const p = require("./package.json"); (p.dependencies || {})["dark-factory"] || (p.devDependencies || {})["dark-factory"]'
node -p 'require("./package-lock.json").packages["node_modules/dark-factory"].resolved'
```

The second value ends with `#<commit-sha>`, which must be the release commit from step 1. Doctor does not check this.

### 5. Add the exclusions, by name

Setup requires every copy it will make, and its list file, to be named in `.gitignore` and effectively ignored. A mask such as `.claude/skills/` is **not** accepted. Print the exact names from the installed release (the whole base set, plus the profile's `extraMetaskills`):

```sh
factory_ignore_lines() {
  node -e '
const set = require("./node_modules/dark-factory/skills/base-set.json");
const profile = require("./.factory/profile.json");
const skills = [...set.processSkills, ...set.jsMetaskills].map((entry) => entry.name);
const extra = profile.extraMetaskills || [];
const lines = [
  ".claude/.factory-installed.json",
  ...[...new Set([...skills, ...extra])].map((name) => ".claude/skills/" + name),
  ...set.agents.map((entry) => ".claude/agents/" + entry.name + ".md"),
];
console.log(lines.join("\n"));
'
}
factory_ignore_lines
```

Append the lines that `.gitignore` does not have yet. Do it by hand, or with this loop, which adds a missing line and never duplicates one (if `.gitignore` does not end with a newline, add one first):

```sh
factory_ignore_lines | while IFS= read -r line; do
  tr -d '\r' < .gitignore 2>/dev/null | grep -qxF -- "$line" || printf '%s\n' "$line" >> .gitignore
done
```

Review `git diff .gitignore`. Then confirm Git really ignores the copies (a later rule or a `!` negation can re-include a path):

```sh
git check-ignore -v .claude/.factory-installed.json .claude/skills/prd .claude/agents/verify.md
```

Commit these lines with the connection: setup never edits `.gitignore` and never changes a tracked file.

The list depends on the release and on `extraMetaskills`. When you change either (a new tag, a new metaskill) repeat this step; [upgrading.md](upgrading.md) does so.

### 6. Run setup explicitly

```sh
node node_modules/dark-factory/bin/setup.js --consumer-root .
```

`--consumer-root` must be the git root itself. Setup validates the whole plan (profile, sources, list, tracked files, ignore rules, conflicts, links outside the project) **before the first write**, so a failed run leaves nothing half-done. On success it prints `dark-factory-setup: N copies installed, M removed (...)` and writes the copies plus `.claude/.factory-installed.json`. Lines starting with `strict mode:` on stderr come from the schema compiler and are warnings, not errors; the exit code and the `dark-factory-setup:` line are what count.

| Message (shortened) | Cause | What to do |
|---|---|---|
| `Profile not found: expected <path>` or a field error from the profile | no or invalid `.factory/profile.json` | create or fix it (step 2) |
| `.gitignore has no entry for "<path>": add the line "<path>"` | exclusion missing | add that exact line (step 5) |
| `git does not ignore "<path>" despite its .gitignore entry` | a later rule or negation re-includes it | fix the rule order; keep the exact line |
| `conflict: "<path>" has tracked files (...)` or `.claude/.factory-installed.json is tracked` | a tracked old copy or list | remove it from Git or move it (step 3) |
| `conflict: "<path>" exists and is not listed in .claude/.factory-installed.json` | a foreign copy, even if ignored and with a base skill's name | delete it or move it away by hand; setup never adopts or overwrites it |

After fixing the cause, **run setup again**. Repeated runs update the copies the list owns and remove those that left the base set or the profile (only when they have no tracked files). Do not move on to hooks until setup succeeds.

### 7. Trusted verifier configs

The verifier reads these from the project's **default branch**, never from a PR. All five are required (a missing or malformed one is a `FAIL` and a doctor problem). The formats below are minimal valid shapes with placeholders; fill in your real owners, CI checks and models. The parsers are the source of truth: [doctor/checks/trusted-configs.js](../doctor/checks/trusted-configs.js) lists them.

`.github/verifier/owners.json`: a JSON array of the GitHub logins whose labels count (`spec-approved`, `manual-verified`, `factory-cross-change`, `test-removal-approved`):

```json
["<github-login-of-an-owner>"]
```

`.github/verifier/required-checks.json`: a JSON array of the names of the CI check runs that must succeed (used by the `ci-checks` check); use the exact check names your CI reports:

```json
["<name-of-a-CI-check-run>"]
```

`.github/verifier/allowed-models.json`: a JSON array of the model IDs the verifier may use. If `allowed-model` is in `verifier.checks`, the value of the variable `VERIFIER_MODEL` must be in it:

```json
["<model-id>"]
```

`.github/verifier/tampering-scan.json`: an object mapping a file class to patterns for your paths. A pattern matches a whole path (`*` stays inside one directory, `**` crosses directories, no braces); a pattern ending in `/` is a directory prefix. The scan understands the classes `test`, `workflow` and `config`:

```json
{
  "test": ["<glob-of-your-test-files>"],
  "workflow": [".github/workflows/"],
  "config": ["<glob-of-your-tool-configs>"]
}
```

`.github/verifier/risk-zones.json`: extra risk zones; the core's base zones (`auth`, `secrets`, `ci`, `fs_shell_sinks`, `dependencies`, `none`) cannot be redefined. An empty addition is valid:

```json
{ "zones": [] }
```

Empty `owners.json` or `required-checks.json` parse, but give **no** protection: nobody can approve and no CI result is required. Put in the real values before relying on the verifier. Do not copy the domains, models or labels of the factory's tests or of another project.

### 8. Labels, secret, variable

Required in every connected project:

```sh
gh label create spec-approved
gh label create manual-verified
gh label create factory-cross-change
gh label create test-removal-approved
gh secret set OPENAI_API_KEY          # reads the value from the prompt, never put it on the command line
gh variable set VERIFIER_MODEL --body "<model-id>"
```

`OPENAI_API_KEY` and `VERIFIER_MODEL` are shared by the verifier and Judge. Run the commands in the project repository (add `--repo <owner>/<name>` otherwise).

Enforcement is separate and optional. By default the verifier is **advisory**: the `Acceptance Verifier` status does not fail on a non-PASS verdict. With the variable `VERIFIER_ENFORCE` set to `true` the status fails on a non-PASS verdict, and you can then require it in branch protection if you choose to. Connecting the factory does not require either.

### 9. Workflow wrappers

A workflow in another repository cannot subscribe to your workflow events, so each reusable workflow of the factory is called from a short wrapper that stays in the project. Copy the wrappers you need from `$REF_DIR/examples/wrappers/` (the reference copy of **your tag**) into `.github/workflows/` and fill in the project values. Do not edit the permissions or inputs: they are what the reusable workflow needs.

| Wrapper file | Needed when | Events (as in the example) | Replace |
|---|---|---|---|
| `acceptance-verifier.yml` | always | `workflow_run` of your CI workflow, type `completed` | the CI name in `workflows: [CI]` (the exact `name:` of your CI workflow); the commit SHA in both places |
| `spec-approval.yml` | `spec-approval` is in `verifier.checks` | `issues: labeled` | the commit SHA in both places |
| `factory-separation.yml` | you want the cross-side change gate | `pull_request` | the commit SHA in both places |
| `acceptance-verifier-eval.yml` | you replay golden cases (`verifier.goldenDir`) | `workflow_dispatch` (manual) | the commit SHA in both places |
| `calibration-judge.yml` | Judge is enabled (step 12) | `workflow_run` of the verifier wrapper, `pull_request_target: labeled`, `issues: labeled`, `workflow_dispatch` | the commit SHA in both places; `branches: [main]` becomes your default branch; `workflows: [Acceptance Verifier]` stays the `name:` of your verifier wrapper |

"Both places" is `uses: strakhovdenya/dark-factory/.github/workflows/<name>.yml@<commit-sha>` and `with.factory-sha`. They must be the same full commit SHA, and the same in every wrapper, equal to the commit of the tag in `package.json`. The examples carry the stand-in `0123456789abcdef0123456789abcdef01234567`, which is not a real commit; replace it everywhere:

```sh
node -e '
const fs = require("fs");
const [sha, ...files] = process.argv.slice(1);
for (const file of files) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("0123456789abcdef0123456789abcdef01234567", sha));
' "<commit-sha>" .github/workflows/acceptance-verifier.yml   # and every other wrapper you copied
grep -n "factory-sha\|dark-factory/.github" .github/workflows/*.yml
```

Do not change the events: the verifier is a `workflow_run`, eval is `workflow_dispatch`, spec-approval is `issues: labeled`, factory separation is `pull_request`, Judge keeps its four. `workflow_run` and the labeled events (verifier, spec-approval, Judge) always run the file from the **default branch**, so those wrappers act only after they are merged; they do not run for the PR that adds them. The `pull_request` wrapper (factory separation) is the exception: it runs the version in the PR.

Optional configs for the optional wrappers: factory separation reads `.github/verifier/factory-separation.json` (an object with `specPatterns` and `verifierPatterns` arrays of path patterns and a non-empty `label` string; without the file the check passes with a notice), and the eval reads the cases from `verifier.goldenDir`. Doctor checks neither wrapper nor `factory-separation.json`.

### 10. Hooks

Hooks are wired in by the project after setup succeeded. Add the **six entries of the five hooks** to the committed `.claude/settings.json`, merged with existing `hooks`. Do not copy them from here: the single source of the JSON is [hooks/README.md](../hooks/README.md) (installed as `node_modules/dark-factory/hooks/README.md`), and [hooks/entries.js](../hooks/entries.js) describes the entries that doctor checks. Points to keep:

- The commands are Bash strings (Bash on Linux and macOS, Git Bash on Windows), `node "$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/<script>.js"` with the path quoted. PowerShell and exec form are not supported.
- The three gates (`closure-gate.js` for `Bash` and `mcp__github__issue_write`, `skill-gate.js` for `Write|Edit`) end with `|| exit 2`; the three helpers (`skill-marker.js`, `lint.js`, `typecheck.js`) end with `|| true`.
- Gates **fail closed**. If `node_modules/dark-factory` is missing or broken, the `Bash` gate blocks every Bash call in Claude Code, **`npm install` included**, and there is no exception. A fresh clone, a deleted `node_modules` or a broken release must be repaired from an ordinary terminal outside Claude Code (install the dependencies, or roll the pin back, see [upgrading.md](upgrading.md#recovery-when-the-hooks-block-claude-code)); never by trying to edit files in the blocked session.
- The hooks read your `.factory/profile.json`; `hooks.lint` and `hooks.typecheck` have no default commands.

Keep `.claude/settings.json` tracked; `.claude/settings.local.json` is personal and should be ignored.

### 11. Optional: Ralph

Ralph is **off by default** (`ralph.enabled`). Skip this step to keep it off. Its full contract is [ralph/README.md](../ralph/README.md); this is only the connection order.

1. **Profile.** `ralph.enabled: true` with `ralph.techDebtTrackerIssue` (an issue number), `ralph.humanNeededVerdict`, `labels.humanNeeded`, and a `sandbox` section (image `name:tag`, `nodeVersion`, exact `claudeCodeVersion`, `allowedHosts`, optional `installEnv`). Values are yours; a missing one stops the run before anything starts:

   ```json
   {
     "labels": { "humanNeeded": "<human-needed-label>" },
     "sandbox": {
       "image": "<image-name>:<tag>",
       "nodeVersion": "22",
       "claudeCodeVersion": "<exact X.Y.Z>",
       "allowedHosts": ["<registry-host>", "<model-api-host>"]
     },
     "ralph": { "enabled": true, "techDebtTrackerIssue": 1, "humanNeededVerdict": "BLOCKED-<REASON>" }
   }
   ```

   Ralph runs each app's `install`, then `gate` before a commit; changes of a manifest are synchronized by `dependencySync` (arrays of `{ argv, cwd }`, **without lifecycle scripts**, for npm `npm install --ignore-scripts`). The installs of a fresh clone must leave `node_modules/dark-factory` in place; the controller then runs the clone's own setup, so the `.gitignore` entries of step 5 must be committed.
2. **Labels.** `gh label create ralph-blocked` and `gh label create "<human-needed-label>"`: the controller never creates labels.
3. **Local run config**, outside Git, default `.ralph/config.json`, with explicit limits:

   ```json
   {
     "issues": [{ "id": 12, "dependsOn": [] }],
     "agentModel": "<exact-model-id>",
     "maxIterations": 1,
     "agentTimeoutMinutes": 60,
     "taskMaxMinutes": 120,
     "taskMaxUsd": 10,
     "runsRoot": "<absolute-path-outside-your-home>"
   }
   ```

   Add `.ralph/`, the runs root (when inside the project) and `.claude/settings.local.json` to `.gitignore`. `runsRoot` is mounted into containers and must be **outside the operator's home directory**; it is a personal setting and is not in the profile.

   **Windows operators:** to run Ralph fast through WSL, add the optional `wsl` section and start it with `dark-factory-ralph-wsl`; see "Running on Windows through WSL" in [ralph/README.md](../ralph/README.md).
4. **Credentials and engine.** Put `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment of the process that starts the controller (never in the profile, argv or Git); it reaches the agent container by name only. Docker is required; there is no host fallback. The operator's own `git` and `gh` login is used for the project repository, which must have an `origin`.
5. **Profile on the base.** The controller clones from `origin` and requires the clone's `.factory/profile.json` to equal the profile it started with, so commit the same profile to the branch Ralph clones from (the default branch, or the base of a stacked issue).
6. **Run it** with the entry point of the installed package, from the root or from any subdirectory:

   ```sh
   node node_modules/dark-factory/ralph/run.js --config .ralph/config.json
   node "$(git rev-parse --show-toplevel)/node_modules/dark-factory/ralph/run.js"
   ```

What stays on regardless of the profile: the controller owns every git and GitHub operation (the agent only reads git: `git status`, `git diff`, `git log`, and `git show` in the review passes), boundary checks after every turn, protected paths (`.git/`, `.claude/`, `.factory/profile.json` plus yours), and time and cost budgets. The baseline pipeline runs `implement`, `self-review`, `code-review`, `final-gate`; with `ralph.enabledSteps` absent **both reviews run**, and an explicit list is the *whole* pipeline (a review is left out only by a full list that omits it). Review fix budgets are set independently by `ralph.stepBudgets` ([adding-a-setting.md](adding-a-setting.md) shows how that field works). Project skills reach the agent through `skillRules`, `extraMetaskills` and `ruleFiles`, not through a copy of the controller.

Ralph's level of verification is spelled out in [ralph/README.md](../ralph/README.md) ("Levels of verification"): portable tests, the packed package and the Docker integration with a stub agent do not show that a real Claude run works (#48), and no operating system beyond what that file states is claimed.

### 12. Optional: Judge and overlays

**Calibration Judge** (an optional analyser of failed verifier rounds that only observes) is off unless the profile has `judge.enabled: true`. To enable it:

- profile: `"judge": { "enabled": true }` and `"labels": { "calibration": "<calibration-label>" }` (required together);
- GitHub: that label, the variable `CALIBRATION_JUDGE_MODEL`, and the wrapper `calibration-judge.yml` (step 9);
- the verifier wrapper must be at exactly `.github/workflows/acceptance-verifier.yml`;
- two configs in `.github/calibration/`: `allowed-models.json` (a JSON array of model IDs; `CALIBRATION_JUDGE_MODEL` must be in it) and `taxonomy.json`. For the taxonomy start from `test/fixtures/judge/taxonomy.json` of your tag and keep every key: the loader (`judge/taxonomy.js`) only demands the ten keys it lists, but the Judge's validator reads more of the vocabulary (for example the `defect_fate` keys), so a passing doctor does not show the taxonomy is complete.

The verifier model list and the Judge model list are separate files; a model is checked only against its own list.

**Overlays** are optional and can only **add** to the core; a removal or an override is rejected. There are two different mechanisms:

- PRD and plan templates: `.factory/overlays/<file>.json` named in the profile as `overlays.prd` / `overlays.plan`, with the shape `{ "sections": [{ "title": "...", "body": "..." }] }` (see [README.md](../README.md#prd-and-plan-templates) and `examples/profiles/*/.factory/overlays/prd.json` at your tag).
- The issue contract: `.github/verifier/issue-contract.overlay.json`, read from the default branch, which adds sections (`title`, `required`, optionally `idPrefix` and `alternativeNames`) and `forbiddenPhrases` to the contract [verifier/issue-contract.md](../verifier/issue-contract.md). There is no `overlays.issue` field in the profile and it is rejected.

### 13. Check, then merge

```sh
node node_modules/dark-factory/bin/doctor.js doctor            # the project of the current directory
node node_modules/dark-factory/bin/doctor.js doctor ../other   # an explicit project path
```

Exit code `0`: no problem found. `1`: at least one problem is listed as `subject: reason`, including a check that could not run (a failed `gh` call is reported as `check unavailable: ...`, not as a missing setting). `2`: wrong usage, an unusable location, or a failure of doctor itself, so nothing was verified. Doctor only reads: it fixes nothing, does not fetch, and starts no CI, Docker, Ralph or model. It reads the **working tree** and the repository's labels, secret names and variables through `gh`.

A result of `0` does **not** prove:

- that the tag in `package.json` resolves to the SHA in the wrappers (CI checks that; you check it with the command in [upgrading.md](upgrading.md#get-the-release-commit-sha)), nor that the lock holds that commit;
- that the same files exist on the **default branch**, where CI reads the pin and the trusted configs;
- anything about the eval and factory-separation wrappers, `factory-separation.json`, `VERIFIER_ENFORCE` or branch protection;
- that a live Claude run, the hooks in a real session or Ralph work (#48 is open);
- that disabled parts (Ralph, Judge) are anything but absent: they are not checked while off.

Those items stay the connecting owner's to check. The connection is complete when the PR is merged to the default branch (until then CI uses the settings already on it), the checks above hold, and the first PR after the merge is verified by the pinned release.
