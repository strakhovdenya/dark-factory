# Ralph controlled run in a consumer (issue #48)

Protocol of one real run of Ralph from a pinned factory release in a connected consumer: one issue, one pull request, the real `claude` CLI and the real `code-review` skill. It is separate from the stub tests of `npm test` and of the Docker integration (#46), which prove the controller and the sandbox but never call a real model.

Result: **success**. All four steps of the pipeline passed in the same run and the pull request passed its CI and the Acceptance Verifier. The pull request was not merged.

## 1. What was run

| Item | Value |
|---|---|
| Consumer | `strakhovdenya/jobflow-cv-pipeline` (a monorepo, `apps/api` and `apps/web`) |
| Consumer issue | [#677](https://github.com/strakhovdenya/jobflow-cv-pipeline/issues/677) "web: remove dead regenerateCvDraftAction server action", label `spec-approved`, body sha256 `da7fb16a5c940f07e09794b525d25ed77b6c34ae22f146fac3a259255c6783fb` |
| Pull request created by Ralph | [#678](https://github.com/strakhovdenya/jobflow-cv-pipeline/pull/678), head SHA `7db570937b6f634b474d145acaafd0d0810bbb27`, base `main`, open and not merged |
| Branch | `task/ISSUE-677-web-remove-dead-regeneratecvdraftaction-server-act` |
| Factory release | tag `v0.1.3`, commit `33fa44be6803ad8c2190c3a60cd6ce41ff42b5df` (the pin in the consumer's `package.json` and the `resolved` entry of its `package-lock.json`) |
| Claude CLI | `2.1.283` (the sandbox pin of the consumer profile; the version field of the session journals of all three agent calls is `2.1.283`) |
| Model | `claude-sonnet-5-5` (`agentModel` of the run config; the journals show the same model) |
| Run id | `/var/tmp/ralph-runs/issue-677-sessions/2026-10-25T14-41-42-930Z`; the run started at 2026-10-25T14:41:29Z and finished at 14:48:15Z (`state.json`, `finishedAt`) |
| Controller host | Windows 11 Pro 10.0.26300, Node 22, `gh` logged in; Ralph itself ran in WSL2 Ubuntu (Node v22.23.4, git 2.53.0) |
| Docker | Docker Desktop with a Linux engine 29.8.0, integrated with the Ubuntu distribution |

The consumer issue is a small code change: one function removed from one `.ts` file. It was created for this run, split out of the consumer's #410, and checked with `issue-lint.js --require-v2` and an independent review of the draft before it was created.

### Command

```sh
# from the consumer root on Windows; the token is read from the user's environment and not printed
node node_modules/dark-factory/bin/ralph-wsl.js
```

`ralph-wsl.js` of the installed release updated the service clone of the consumer on the Linux file system of Ubuntu (`git fetch`, fast-forward, `npm ci` because the lock changed) and started the installed `ralph/run.js` there. `CLAUDE_CODE_OAUTH_TOKEN` was passed to WSL by name through `WSLENV`.

Run config (`.ralph/config.json` of the consumer, outside git): `issues: [{id: 677}]`, `maxIterations: 1`, `maxTurns: 150`, `reviewMaxTurns: 40`, `agentModel: claude-sonnet-5-5`, `agentTimeoutMinutes: 45`, `taskMaxMinutes: 60`, `taskMaxUsd: 10`, `wsl: {distro: Ubuntu, clone: <service clone on the Linux file system>, runsRoot: /var/tmp/ralph-runs}`. The profile enables Ralph and has no `ralph.enabledSteps`, so the baseline pipeline ran.

Two earlier attempts of the same command stopped before any agent call and are not part of this evidence: the first because `CLAUDE_CODE_OAUTH_TOKEN` was not visible to the shell that started it, the second because the issue had no `spec-approved` label. Neither started a container with the agent (the controller output of both ends before any agent call). Before the third attempt the wrapper archived the earlier runs root (`archive/20261025-144131`), so the run directory of the counted run started clean.

### Arguments of the Claude CLI

The arguments come from `buildClaudeArgs` of the installed release (`node_modules/dark-factory/ralph/agent.js`), for the model and the limits above:

```sh
claude -p --output-format stream-json --verbose --model claude-sonnet-5-5 --effort high \
  --max-turns <150 for the write call, 40 for the read-only calls> --max-budget-usd <10.00 less the recorded spend>
```

The prompt goes to the stdin of the container. The argument vector that the controller actually passed to the container is **not logged** by the controller, so the line above is the vector built by the installed `buildClaudeArgs` from the run config, not a copy of a recorded command line. The journals record the real CLI (`version` 2.1.283) and the model name `claude-sonnet-5-5`. The CLI printed `unrecognized_model` for this model name on every call but still completed all of them. The journal field holds the name that was requested; nothing in this run checks which model the CLI actually used if it did not recognize the name, so the model of the answers is not independently confirmed.

## 2. Source of the installed code

- The controller ran from `node_modules/dark-factory` of the service clone, installed by `npm ci` from the lock: version `0.1.3`, `resolved` `git+ssh://git@github.com/strakhovdenya/dark-factory.git#33fa44be6803ad8c2190c3a60cd6ce41ff42b5df`.
- Comparison with the pinned release: the sha256 of every file of the installed package outside its own `node_modules` (213 files) was computed in WSL and compared with the blob of the same path in tag `v0.1.3` of this repository (`git show v0.1.3:<path>`). All 213 files exist in the tag and none differs, so there are no edits of the core.
- The run clone and the agent container used the same installed release for `factory-setup` (`install-factory-setup-*.log` of the run exists and the step passed).
- Before the run the service clone had release `0.1.1` installed, left over from an earlier session. The wrapper's `npm ci` replaced it with the lock's `0.1.3` before the controller started, so the run did not use `0.1.1`.

## 3. Sandbox

Everything the agent and the project commands did ran in the Ralph Docker sandbox (`ralph-sandbox:local`, Node 22, `claude-code@2.1.283`): the installs (`install[0]`, `apps[0].install[0]`, `apps[1].install[0]`, `factory-setup`), the three agent calls and the three gate commands. The clone is `/var/tmp/ralph-runs/issue-677`, outside the home directory. Nothing project-specific was run on the host.

## 4. Steps of the same run

The order and outcomes are `state.json` of the runs root (`lastResult.steps`) and the controller output of the same run.

| Step | Outcome | Evidence in this run |
|---|---|---|
| `implement` | `passed` | 22 turns by the controller's count, 52 s; removed `regenerateCvDraftAction` from `apps/web/src/app/workspaces/[id]/actions.ts`; the acceptance self-report covers AC-1 and AC-2; the agent loaded the skills named by the profile's `skillRules` for `apps/web` (journal `01-implement`: `js-conventions`, `js-gof`, `js-data-structures`, `error-handling`, `modern-javascript`, `vercel-react-best-practices`, `ui-ux-pro-max`) |
| `self-review` | `passed` | 3 turns, 19 s; `REVIEW: PASS`; read-only call, the working tree was unchanged afterwards |
| `code-review` | `passed` | 2 turns, 35 s; the real call of the `code-review` skill through the Skill tool (section 5); `CODEREVIEW: PASS`, the skill reported no findings |
| `final-gate` | `passed` | in the sandbox without network: `tsc --noEmit` (3 s), `eslint .` (6 s), `vitest run` (17 s), all in `apps/web`; none skipped |

**No fix and no second review pass.** Neither review had findings, so the fix calls (`review-fix`, `code-review-fix`) and the repeated reviews did not run: the self-review returned PASS and the `code-review` skill reported no findings. This is the justified absence the issue allows; the fix path was not exercised by this run.

**No bypass.** The diff changes `apps/web/src/app/workspaces/[id]/actions.ts`, a `.ts` file that does not match the profile's `docOnlyPathPatterns` (`**/*.md`, `**/docs/`, `**/project-management/`), so the diff is not doc-only. `ralph.enabledSteps` is absent, so both reviews ran as the baseline pipeline, and the final gate ran its three commands instead of skipping.

## 5. The real `code-review` call

The journal of the third agent call (`03-code-review/projects/-workspace/*.jsonl` in the run's sessions directory) contains a `tool_use` of the `Skill` tool with `{"skill":"code-review","args":"medium"}` at 2026-10-25T14:47:17.305Z. It is followed in the controller output by the skill's own read-only commands (`git diff`, `grep`) and its `ReportFindings` call, and by the verdict line `CODEREVIEW: PASS`. Both its start and its verdict belong to the same run id. The permission rules and the text of the prompt alone are not counted as a call: the record is the `Skill` tool call in the journal.

## 6. Limits, time, iterations and cost

| Measure | Limit | Actual | Source and boundary |
|---|---|---|---|
| Iterations | `maxIterations` 1 | 1 | `state.json` `iterations`, controller output ("Iteration 1/1", then "maxIterations reached") |
| Time of the issue | `taskMaxMinutes` 60 | about 6 min 46 s | `state.json` `finishedAt` 14:48:15Z minus the run start 14:41:29Z; includes clone, installs, three agent calls, the gate and the push; excludes the wrapper's preparation of the service clone before the start |
| Time per agent call | `agentTimeoutMinutes` 45 | 52 s, 19 s, 35 s | controller output of each call |
| Agent turns | 150 write, 40 read-only | 22, 3, 2 by the controller; 16, 4, 9 assistant messages in the journals | the two counts are different measures (the controller's count was not checked against its source) and both are given; no count of either kind reaches the limit of its call |
| Cost, USD | `taskMaxUsd` 10 | **not available** | the controller keeps the cost of each call only inside its budget (`budget.record(result.costUsd ?? maxBudgetUsd)`) and writes it neither to the output, nor to `state.json`, nor to the journals; it is not replaced by zero |
| Tokens (assistant usage in the journals) | none | implement: input 32, cache creation 212 293, cache read 701 353, output 5 340; self-review: 8, 15 750, 136 764, 865; code-review: 18, 40 004, 205 496, 865 | sum of `message.usage` of the assistant messages of each call's journal; covers all three agent calls of the run (there were no fix calls) |

The run finished far inside the time and turn limits. The actual USD stays unknown. The three calls completed normally and none was refused for a spent budget, which is consistent with the controller having received a cost from each call (a missing cost is counted as the whole remaining cap, which would have left nothing for the next call), but that is an inference and the amounts are not recorded.

## 7. The pull request and its checks

PR #678 changes one file, `apps/web/src/app/workspaces/[id]/actions.ts`, which is the one file of the issue's `## Affects`. On the head SHA `7db570937b6f634b474d145acaafd0d0810bbb27` every check of the consumer's CI passed, including `Typecheck (apps/web)`, `Test (apps/web)`, `Lint (apps/web)`, `Test (apps/api)`, `Test (e2e)`, `Build`, `Docker Build & Smoke Test`, `CodeQL`, `Dependabot Severity Gate` and `Factory separation`. The consumer's Acceptance Verifier (`Acceptance Verifier / Verify`, `Verify second`, `Report`) ran from the pinned release (verifier commit `33fa44be6803ad8c2190c3a60cd6ce41ff42b5df`) on the same head and the comment reports `Acceptance verifier: PASS`. The pull request is open for the owner; it was not merged.

## 8. Stub results versus this run

The stub tests of this repository (`npm test`, the packed-package consumers, `npm run test:ralph:sandbox`) replace `claude` and prove the delivery, the sandbox boundaries and the permission files. They do not show that the installed CLI accepts the arguments of `buildClaudeArgs` or that the `code-review` skill is available at run time. This run does: the real CLI 2.1.283 completed three agent calls started by the controller, which builds its arguments with the installed `buildClaudeArgs`, and the journal holds a real `Skill` call of `code-review`. The argument vector itself is reconstructed (section 1), so the evidence for it is that the calls ran to completion, not a recorded command line. The result of #46 is not used as a substitute for any item above.

A skipped or missing `code-review`, a refusal of the CLI to accept the standard arguments, a failed pass, or a skip caused by a doc-only diff or by a pipeline setting would not count as success of the stage. None of them happened here (sections 4 and 5).

## 9. Remaining limits

- The proof holds for one platform: a Windows 11 controller host that starts Ralph in WSL2 Ubuntu with Docker Desktop and a Linux engine 29.8.0. A native Linux host, macOS and a Windows run without WSL are not covered.
- One issue in one consumer (a monorepo) was run; the second consumer shape (a single package) is covered only by the stub tests.
- The issue was a minimal deletion. The review fix paths (`review-fix`, `code-review-fix`) and the repeated review passes were not exercised by a real model.
- The USD cost and the exact argument vector of the container call are not recorded by the controller; recording them needs new logging in the product, which this task does not add.
- The CLI prints `unrecognized_model` for `claude-sonnet-5-5`; the calls still succeed, but the warning is not understood and should be watched on the next CLI pin.
- The run was started by the owner's token in their own environment; the key never reached an argument, an output or a file of this protocol.
