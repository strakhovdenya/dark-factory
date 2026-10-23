# Adding a setting to an existing mechanism

How to add one more optional field to something the factory already has, without breaking the projects that do not use it. The example followed from end to end is `ralph.stepBudgets`, which **already exists**: this guide explains how it is built and does not add or change any setting.

**Scope.** A *setting* is a new field of a mechanism that exists: a budget, a path, a command, a name in the profile or in a trusted config. A *new element* (a new Ralph step, verifier check, doctor check, hook or skill) is a different job with its own rules: follow [adding-an-element.md](adding-an-element.md). This guide does not replace it.

Related: [adding-an-element.md](adding-an-element.md), [connecting-a-project.md](connecting-a-project.md), [upgrading.md](upgrading.md).

## The example: `ralph.stepBudgets`

Ralph's two review steps (`self-review`, `code-review`) each may call a fixer after a fixable review failure. How many fix calls a review may use is the budget. Without the setting every review uses the default; the setting lets a project raise or lower it per step.

| Part | Where | What it says |
|---|---|---|
| Schema | [profile/schema.json](../profile/schema.json), `ralph.stepBudgets` | an optional object: step name to integer `>= 1`. It is **not** in `required`, and it has no schema default. Its description states the default. |
| Reader | [`resolvePipeline`](../ralph/steps/registry.js) in `ralph/steps/registry.js` | checks every key against the registry (`budgetProblems`: a registered step **with a fix**), then builds the budget of each step as `profile.ralph?.stepBudgets?.[name] ?? step.fix.budget`. |
| Default | the `fix.budget` of the step, `2` for `self-review` and `code-review` | used for every step the profile does not name, and for all of them when the field is absent. |
| Examples | `examples/profiles/<project>/.factory/profile.json` at the release tag | one example profile sets `"stepBudgets": { "self-review": 4, "code-review": 2 }`, the other leaves the field out and keeps the defaults. |
| Tests | [ralph/steps/registry.test.js](../ralph/steps/registry.test.js) | the cases run on both fixture profiles (`FIXTURE_PROFILES`: "monorepo" and "single package"); one test also loads the two example profiles and compares their budgets. |
| CHANGELOG | [CHANGELOG.md](../CHANGELOG.md), the entry that introduced `ralph.stepBudgets` together with the new meaning of `ralph.enabledSteps` | records the field, its meaning and its default. |

The field lives at the profile level, so its shape does not depend on the project layout. The same snippet is valid for a monorepo and for a single package (with Ralph enabled, which needs `techDebtTrackerIssue` and `sandbox`, see [connecting-a-project.md](connecting-a-project.md#11-optional-ralph)):

```json
{ "ralph": { "enabled": true, "techDebtTrackerIssue": 5, "stepBudgets": { "self-review": 4, "code-review": 2 } } }
```

Checked on the two fixture profiles of the repository (`test/fixtures/profiles/monorepo` and `.../single-package`, each with `ralph` replaced by the case below; the results were identical for both):

| Case | Outcome |
|---|---|
| field absent | budgets `self-review` 2, `code-review` 2, the baseline pipeline: nothing changes for a project that does not use the field |
| `{ "self-review": 4, "code-review": 2 }` | budgets 4 and 2 |
| `enabledSteps` without `code-review` and `{ "code-review": 3 }` | accepted; the budget is kept but `code-review` is **not** enabled by it |
| `{ "self-review": 0 }` | rejected by `loadProfile`: `ralph.stepBudgets.self-review: must be >= 1` |
| `{ "self-review": 1.5 }`, `"2"` or `false` | rejected by `loadProfile`: `ralph.stepBudgets.self-review: must be integer` |
| `{ "implement": 1 }` | rejected when the pipeline is resolved: `step "implement" has no fix to budget` |
| `{ "unknown-step": 1 }` | rejected when the pipeline is resolved: `step "unknown-step" is not registered` |
| `{ "reviewRetries": 3 }` (any field the schema does not have) | rejected by `loadProfile`: `ralph.reviewRetries: unknown field` |

Two layers decide: the schema (type, range, unknown fields) in `loadProfile`, and the registry (is this a real step with a fix) in `resolvePipeline`, which runs before Ralph does anything.

## The order of work in the factory

1. **Decide what "absent" means.** The field is optional, and a project that does not mention it behaves exactly as before. Here the absent field is the old fixed budget of `2`.
2. **Declare it in the schema** ([profile/schema.json](../profile/schema.json)), optional, with a description that states the meaning, the type and the default. If the field belongs to a trusted config rather than the profile, the same applies to its parser.
3. **One reader.** The code that owns the behaviour reads the field from the already validated profile (`loadProfile` is the only reader of the file) and falls back to the previous value when it is absent. No project literals in core code.
4. **Do not invent a value for "off".** A path, command or budget is made optional by *leaving it out*. Do not give it `false`, `0` or an empty string meaning "none": `stepBudgets` rejects `0` and `false` instead of treating them as "no fixes", and the way to leave a review out is `ralph.enabledSteps`. A boolean belongs only to a real on/off switch of a whole capability (`ralph.enabled`, `judge.enabled`).
5. **A setting never turns a capability on by itself.** A budget for a review that is not in `enabledSteps` is valid and enables nothing. A new capability is **off by default**, named by its own switch or list.
6. **Examples and fixtures.** Show the field in an example profile if projects will copy it. Fixtures and examples are formats, not ready connections.
7. **Tests on both fixture profiles**, "monorepo" and "single package": a positive case, the absent case (old behaviour unchanged), and error or boundary cases (below the minimum, wrong type, unknown key). No test may depend on the layout of one project, use the network, Docker or a real model; they must pass on Windows and Linux (`npm test`).
8. **If the setting can change the verifier verdict**, run the reference PR set (cases with an expected verifier verdict) and confirm that no verdict changes unexpectedly; this is the requirement of [adding-an-element.md](adding-an-element.md#5-verdict-impact-three-different-checks). `ralph.stepBudgets` does not touch the verifier verdict, so it needs no such run. Running the reference set is part of the task that adds a setting, not of writing this guide.
9. **CHANGELOG.** Add an entry: the field, where it is read, the default (what absent means).
10. **Merge, then release.** Like any change, it reaches projects only with a new release tag (see [CLAUDE.md](../CLAUDE.md), Release cycle).

## Order in a project: release, installed loader, profile

The profile schema rejects unknown fields (`additionalProperties: false`). An older release does not know the new field, so its loader rejects a profile that has it: `ralph.<field>: unknown field`. Everything that loads the profile then fails: `dark-factory-setup`, `factory doctor`, the verifier (an invalid profile is `FAIL`), Ralph, and the hooks, which **fail closed** and so block gated operations in Claude Code.

Hence the rule: **a profile may carry the field only where the installed release understands it.**

1. Develop and merge the setting in the factory, then cut the release that contains it (the CHANGELOG names the version).
2. In the project, move the pin to that release by the normal upgrade ([upgrading.md](upgrading.md)): tag, lock, wrappers, setup.
3. Only after the new release is **installed** in the working tree, add the field to `.factory/profile.json`. Editing the profile under the old installed release makes the gates block.

You can tell what an installed release knows:

```sh
node -p 'Boolean(require("./node_modules/dark-factory/profile/schema.json").properties.ralph.properties.stepBudgets)'
```

(replace the path with the property of the new field).

**Is a separate PR needed to enable a setting?** No, and there is no such rule. What is required is consistency: at every place where the profile is read, the release that reads it must understand the field.

- If the pinned release already knows the field, adding it is an ordinary change to the profile in whatever PR needs it.
- If the pin has to move first, the upgrade PR can carry the new pin, lock, wrappers **and** the field together. The PR is judged by CI with the previous pin and the profile already on the default branch, so the field takes effect when the PR merges, together with the release that reads it. A separate "pin only" PR followed by a "field" PR is equally valid.
- Do not add the field early: not to the default branch with an older pin, not to a base branch that Ralph clones (the clone installs its own pinned release and must load the same profile), not into a PR before the new release is installed locally.
- To go back, remove the field before moving the pin to a release that does not know it ([upgrading.md](upgrading.md#recovery-when-the-hooks-block-claude-code) covers a blocked session).

## Absent is not enabled

Two different things are easy to mix:

- **A parameter that is absent** keeps the previous behaviour. `stepBudgets` absent: both reviews keep their default budget of 2.
- **Enabling a new capability** is an explicit act of the project, taken in its own switch. A new step is registered in the code but runs only when `ralph.enabledSteps` lists it; a new check runs only when `verifier.checks` names it. Merely setting a tuning field, such as a budget, enables nothing.

So a project can add `stepBudgets` for a step it does not run, and nothing changes until it enables the step.

## When it is not a setting

A new Ralph step, verifier check, doctor check, hook or skill is registered in the place its kind owns, stays off until a project enables it, and has its own tests, verdict-impact assessment and CHANGELOG entry. The whole procedure, including how each kind is enabled and delivered, is in [adding-an-element.md](adding-an-element.md). How the factory installs its own release (#27) and the live confirmation of Claude runs (#48) are other work: this guide does not depend on either.
