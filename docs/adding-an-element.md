# Adding a new element to the factory

The one complete procedure for adding a **new element** to the factory core: a Ralph step, a verifier check, a doctor check, a hook or a package skill. It explains where each kind is registered, how a project turns it on, how to show that the off variant changes nothing, and how the element reaches a project.

**Scope.** A new element is not a *setting*. A setting is one more optional field of a mechanism that already exists; that is [adding-a-setting.md](adding-a-setting.md). Connecting a project is [connecting-a-project.md](connecting-a-project.md), moving a project to a newer release is [upgrading.md](upgrading.md). This guide changes none of them.

The rules that stay in [CLAUDE.md](../CLAUDE.md) are not repeated here: the Core invariants (including the closed list in invariant 6), the repository layout and the release cycle. Where this guide says "invariant N", it points to that file.

The behavior described below was checked against the code named in each section; the code in the two examples is illustrative and is not shipped. The guide does not describe a mechanism that is not there.

## 1. The common rules

These hold for every kind of element.

1. **Use the existing registration point of the kind** (section 2). There is no universal registry and no universal switch: each kind registers and is enabled in its own way.
2. **Registration is not enabling.** A registered element does nothing until a project enables it through the knob of its kind. The element is **off by default**: a project that does not mention it behaves exactly as before, in every way of starting it, a manual one included. A schema default of `false` is documentation; the code must treat an absent knob as off. A package skill is the one kind with no off switch today; see "Skills" in section 2.
3. **The element reads its settings only from the profile** (or a trusted config) through the existing readers. No project literals in core code (invariants 1 and 11).
4. **A new element may add** its own module, its entry in the registration list its kind owns, the schema fields and metadata it needs, documentation, tests and a CHANGELOG entry. It does **not** rewrite the execution engine or the existing steps and checks to make room for itself. The real files differ per kind; section 2 names them.
5. **Tests on two fixture profiles**, "monorepo" and "single package" (`test/fixtures/profiles/`), with an enabled variant and a disabled variant (section 4). No test depends on one project's layout. They run under `npm test` on Windows and Linux, without network, Docker or a real model (stub the agent and the model).
6. **Verdict impact** is judged from what the change really touches (section 5), and the PR description states it.
7. **CHANGELOG** entry (section 7): the element, its knob and its default (off).
8. **Placement**: package sources go to the package directories (`bin/`, `doctor/`, `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/`, `judge/`, `ralph/`). Nothing from `.claude/` or `.factory/` ships. Installing the package does not modify tracked files of the project (invariant 9).
9. **Delivery** is through a release and a pin update (section 6). The working copy of the factory is not what a project runs.

The one exception to default-off is a mandatory diagnostic artifact of the round protocol. It exists only if it is on the closed list in invariant 6 of [CLAUDE.md](../CLAUDE.md), and it must meet every condition stated there: it adds no check, no model call and no authority, it does not change the verdict, and a failure to form or publish it is isolated from the decision. This guide does not copy that list and does not extend it; changing it means changing that invariant. Arbitrary new diagnostics, logs or reports are not covered: they are ordinary elements and are off by default.

## 2. Registration and enabling, by kind

| Kind | Owner of the registration | Knob that enables it | When the knob is absent |
|---|---|---|---|
| Ralph step | [`ralph/steps/registry.js`](../ralph/steps/registry.js): the step is a module in `ralph/steps/` and joins `DEFAULT_REGISTRY` | name in `ralph.enabledSteps` (and `ralph.stepBudgets` for a fix budget) | the baseline pipeline runs; the step never runs |
| Verifier check | [`verifier/checks/index.js`](../verifier/checks/index.js): the check is a module in `verifier/checks/` and joins `CORE_CHECKS` | name in `verifier.checks` | no check runs by default; an unlisted check does not run |
| Doctor check | [`doctor/checks/index.js`](../doctor/checks/index.js): the check is a module in `doctor/checks/` and joins `CHECKS` | none: doctor runs **every** registered check | the check still runs; its requirements must be conditional (below) |
| Hook | a script in [`hooks/`](../hooks/README.md) and its entry in [`hooks/entries.js`](../hooks/entries.js) | the **project** adds the settings entry to its own `.claude/settings.json`; installing the package never edits settings | the hook is not wired and does not run |
| Package skill | a directory in `skills/`; installed only through [`skills/base-set.json`](../skills/base-set.json) | none today | see "Skills" below |

### Ralph step

A step is data the controller runs; `ralph/core.js` never imports a step module. The step's fields and the checks applied to them are in the header of [`ralph/steps/registry.js`](../ralph/steps/registry.js) and in `stepProblems` there.

- **Registration.** Add the module under `ralph/steps/` and add it to the array given to `createRegistry` for `DEFAULT_REGISTRY`. Do not edit `ralph/core.js` or the four base steps. A step module must not require `ralph/steps/registry.js` (the registry requires the step modules, so that would be a require cycle); share helpers through other modules, as `self-review.js` does with `implement.js`.
- **Enabling.** `ralph.enabledSteps` is the *whole* pipeline, in run order (schema description in [`profile/schema.json`](../profile/schema.json)). A new name is accepted only if the registry the run uses has it.
- **No profile code.** The profile only names registered steps. No code is loaded from the profile or from a path. The packaged Ralph CLI (`ralph/run.js`, run as the entry point) uses the packaged `DEFAULT_REGISTRY`.
- **`deps.stepRegistry`.** `runRalph`, `prepareRun` and `ralph/core.js` accept a prepared registry. This is an existing programmatic API, used by the tests, and it is not a way for a project to add a step: the entry point of the CLI does not pass one. A test that passes its own registry shows that the pipeline handles the step; it does **not** show that the step's module is in the release a project installs. That proof is the module plus its `DEFAULT_REGISTRY` entry in the release.
- **The base pipeline is not an extension.** `implement`, `self-review`, `code-review`, `final-gate` are the existing controller moved into the registry. When Ralph is enabled and `ralph.enabledSteps` is absent, all four run, **both reviews included**. A profile can leave out a review only with an explicit, complete list. A newly registered step is **not** added to the baseline: it stays off until a project names it.
- **Explicit list rules** (`pipelineStructureProblems`): `implement` is first and `final-gate` is last, each exactly once; `self-review` comes before `code-review` when both are listed; no duplicates; an empty list is invalid because it has no mandatory step (`loadProfile` rejects it). A new step goes between the mandatory ends. These rules need no new switch.
- **Rights of an agent step.** An agent step names a **permission profile of the controller** in `permissions` (`implementer`, `reviewer` or `code-reviewer`, the keys of `PERMISSION_PROFILES` in [`ralph/workspace.js`](../ralph/workspace.js)); it never supplies raw permission rules, and an unknown name fails when the pipeline is resolved. The controller writes the profile and makes the agent call; the git and GitHub powers (branches, commits, push, PRs, comments, labels) stay with the controller and are not given to the agent (invariant 4). A deterministic `kind: 'check'` step runs plain code with no model; it is not a way around the agent wrapper for work that needs an agent.
- **Fix.** Only a read-only agent step may have `fix` (a separate write call after a fixable failure, with its own `pass`, permission profile and `budget`). A check step has none. `ralph.stepBudgets` can name only a registered step that has a fix, and a budget for a step that is not in `enabledSteps` enables nothing.

Real example of a step with a fix: [`ralph/steps/self-review.js`](../ralph/steps/self-review.js).

### Verifier check

- **Module and codes.** The check is a module in `verifier/checks/` with `name`, `stage` (`spec` or `report`), `codes`, `run(context)` and optional `prepareReport` and `note` (header of [`verifier/checks/registry.js`](../verifier/checks/registry.js)). It declares every reason code it may emit; `runCheck` fails on an undeclared code, so the closed list of codes is the core's plus the declared ones.
- **Registration.** Add it to `CORE_CHECKS` in `verifier/checks/index.js`. Registration order is the order of reasons in the verdict.
- **Enabling.** Only `verifier.checks`. A name missing from the list does not run the check, and a name no registered check has fails the verdict (`unknown_check`). Keep the description of `verifier.checks` in the schema in step with the registered names. Do not add a parallel list of checks to doctor.

### Doctor check

Doctor ([`doctor/registry.js`](../doctor/registry.js)) runs **every** check in `CHECKS` ([`doctor/checks/index.js`](../doctor/checks/index.js)); there is no profile list of enabled doctor checks. So "registered" already means "run for every connected project". Registration and conditionality are two different things:

- A new doctor check, or a new requirement inside an existing one, must be **conditional on the project having enabled the thing it checks**, using the existing setting of the profile. See how [`doctor/checks/github.js`](../doctor/checks/github.js) requires the Ralph labels only when `ralph.enabled` is `true` and the Judge label and variable only when `judge.enabled` is `true`.
- When the optional function is not enabled, doctor must not add the requirement for its labels, wrappers, hooks or files. A disabled element creates no new installation problem.
- The requirements of the base connection stay as they are. Conditionality applies to the new element and does not weaken them.
- Doctor stays read-only and is not part of the verdict.

### Hook

A hook has two halves that belong to different owners.

- **The factory** ships the script in `hooks/`, describes its settings entry in [`hooks/entries.js`](../hooks/entries.js) (`HOOK_ENTRIES`), documents it in [`hooks/README.md`](../hooks/README.md), and keeps `hooks/settings-entry.test.js` true (the JSON in the README must say what `entries.js` says).
- **The project** wires it by adding the entry to its `.claude/settings.json`. Installing the package does not edit settings.
- **Gate or helper.** A gate fails closed (`|| exit 2`): any error, a missing profile or unparsable input blocks (invariant 10). A helper never blocks (`|| true`). Choose the kind deliberately and do not turn a gate into a helper to make a failure disappear.

**Known limitation.** `factory doctor` currently requires **every** entry of `HOOK_ENTRIES` ([`doctor/checks/hooks.js`](../doctor/checks/hooks.js) reports each one that is not wired), and there is no ready mechanism for optional entries. So the obvious change is wrong: adding the entry of a new optional hook to `HOOK_ENTRIES` makes every consumer that has not enabled the hook get a doctor problem the moment it takes the release. That is a new mandatory requirement for projects that did not turn the element on, which breaks default-off. A CHANGELOG entry does not make it acceptable. This guide does not design the mechanism. The task that introduces a new optional hook must itself make four things agree before it merges: its enabling in the profile, the metadata in `entries.js`, the README, and doctor (which must not require the entry unless the profile enables the hook), and it must show that a project without the enabling gets no new doctor problem.

### Skills

The rules of this guide apply to package skills too: off by default, two fixture profiles, CHANGELOG, placement in `skills/`. The mechanism is narrower than for the other kinds:

- Skills installed into projects are the **base set** of `skills/base-set.json`, copied by `bin/setup.js`. `factory doctor` (the `setup` check) requires those copies. Adding a skill to the base set therefore makes it present and required in every connected project at the next pin update. There is **no** mechanism for an optional package skill today, and none is promised here.
- A new skill is added to the base set only as a deliberate decision of the base set itself, not as a quiet extension.
- Factory-only skills and agents in `.claude/` are tooling for developing the factory. They never ship and are not covered by this guide.

## 3. Examples

Both examples are about elements **shipped in the package**. The dummy elements in the tests are test doubles, not shipped code.

### Example A: a Ralph step (illustration)

A hypothetical check step `docs-lint`. Its module and registration:

```js
// ralph/steps/docs-lint.js  (new module, in the package)
const docsLint = {
  name: 'docs-lint',
  kind: 'check',
  skipOnDocOnly: false,
  run: (ctx) => (findProblems(ctx.diff).length === 0 ? { kind: 'passed' } : { kind: 'blocked', reason: 'docs lint failed' }),
};
module.exports = { docsLint };
```

```js
// ralph/steps/registry.js  (the one line the registration adds)
const { docsLint } = require('./docs-lint');
const DEFAULT_REGISTRY = createRegistry([implement, selfReview, codeReview, finalGate, docsLint]);
```

| Profile of a project | Result |
|---|---|
| no `enabledSteps` (disabled) | baseline pipeline: `implement`, `self-review`, `code-review`, `final-gate`. `docs-lint` is never called; the run, the PR and the statuses are the same as before the release |
| `"enabledSteps": ["implement", "self-review", "code-review", "docs-lint", "final-gate"]` (enabled) | the step runs once, after `implement` and the reviews and before `final-gate`; a `blocked` outcome stops the run before the gate |
| `"enabledSteps": ["implement", "docs-lint", "final-gate"]` | a valid explicit list with no reviews (the owner's choice); not what a project gets by accident |
| `"enabledSteps": ["docs-lint"]` | rejected when the pipeline is resolved: `implement` and `final-gate` are missing |

An agent step differs in the shape of the object (`kind: 'agent'`, `mode`, `permissions` naming one of the controller's permission profiles, `buildPrompt`, `parseOutput`, optionally `fix`), not in how it is registered and enabled.

**What the existing tests prove.** [`ralph/profiles.test.js`](../ralph/profiles.test.js) runs the controller end to end on both fixture profiles with a dummy step added to a **test registry** (`registryWithDummy`, passed as `deps.stepRegistry`):

- "dummy step enabled by profile runs in order": with the step in `enabledSteps`, it runs once, sees the diff of `implement`, and the steps appear in order.
- "dummy step disabled by profile changes nothing": with the step registered and not listed, it is called zero times and the result, steps, agent passes, event sequence, PR and labels are equal to a control run without it.
- "failing dummy step blocks before final gate": a `blocked` outcome stops the run before the gate.

They prove that the controller handles an extra step and that off means unchanged. They do **not** prove that your module is part of the release a project installs: the test hands the controller a registry. The packaged CLI uses `DEFAULT_REGISTRY`, so the delivery proof is the module plus its entry in `DEFAULT_REGISTRY`, and a test of your own step should import the real module and the real registry the same way the CLI does.

### Example B: a verifier check (illustration)

A hypothetical report-stage check `changelog-entry`, with a declared code:

```js
// verifier/checks/changelog-entry.js  (new module, in the package)
const { deterministicReason } = require('../verdict/reason');

const CODE = 'changelog_entry_missing';

module.exports = {
  name: 'changelog-entry',
  stage: 'report',
  codes: [CODE],
  run: (context) => (hasChangelogEntry(context) ? [] : [deterministicReason(CODE, 'the change has no CHANGELOG entry')]),
};
```

```js
// verifier/checks/index.js  (the registration)
const CORE_CHECKS = [ /* existing checks */, require('./changelog-entry') ];
```

| `verifier.checks` of a project | Result |
|---|---|
| does not list it (disabled) | the check does not run and adds no reason; the verdict is the same as before the release |
| lists `"changelog-entry"` (enabled) | it runs; a missing entry adds `changelog_entry_missing` and the verdict is `FAIL`; with the entry the verdict is unchanged |
| lists a name no registered check has | the verdict is `FAIL` with `unknown_check`; a profile must not name the check under a release that does not have it |

**What the existing tests prove.** [`verifier/profiles.test.js`](../verifier/profiles.test.js) runs the verdict on both fixture profiles with `dummy-check` registered on a **test registry** (`createCoreRegistry()` plus `register`):

- "dummy check enabled by profile adds its reason": listed in `verifier.checks`, it runs once and its declared code is the verdict's reason.
- "dummy check disabled by profile changes nothing": registered but not listed, it does not run and the summary and failures equal a run on the plain registry, for a passing and a failing case.

As in example A, this proves the registry and profile selection work for a check that is registered and off, not that your check ships. The shipped proof is the module and its entry in `CORE_CHECKS`, with its own tests on both profiles.

## 4. Proving the element works and that off changes nothing

For each element, in tests that run under `npm test`:

1. **Control run** on each of the two fixture profiles without the element enabled.
2. **Disabled variant**: the element registered, not enabled. Compare with the control: the step is not called, or the check adds no reason; the outcome, the steps, the events, the verdict and the reasons are equal.
3. **Enabled variant**: the knob names it. The expected effect appears (the step runs in its place; the check adds its declared reason).
4. **Invalid variants** of the knob that matter to the kind (an unregistered name, a pipeline without the mandatory ends).

Both profile shapes are needed because the element must not depend on one layout. A test runs without network, Docker and a real model.

Beyond tests, run the checks the factory provides: the `fixture-profile-run` agent for the run on both profiles and the `core-literal-scan` agent for project literals. They are factory development tools in `.claude/`, not dependencies of a consumer.

## 5. Verdict impact: three different checks

Decide whether the change can influence the verifier verdict from **what it really touches**, not from the type of element. A Ralph step usually cannot, but a change to the shared profile, the schema or the inputs of the verdict can, whatever the element is. State the finding in the PR description, including "does not influence the verdict" when that is the case.

| What | What it is | When |
|---|---|---|
| Fixture tests on two profiles | `npm test`, section 4 | every element |
| Deterministic reference set | cases with an expected verdict, computed by the real verifier code from **recorded** model reports and fixed inputs: the cases of `verifier/profiles.test.js` and `test/fixtures/verifier/` (the golden eval run there on a PASS and a FAIL case per profile). No model call | when the element can influence the verdict: confirm no verdict changes unexpectedly |
| Model eval | the manual `Acceptance Verifier Eval` workflow (`verifier/eval/verifier-eval.js` with the project's `verifier.goldenDir`): replays golden cases against the current prompt, schema and model pin with real model calls | a change of the prompt, the model schema, the model pin or the inputs of the verdict: assess whether an eval is needed. A paid run is the owner's decision. Writing or reviewing this guide needs none |

The reference set and the model eval are different checks and one does not replace the other. The verdict is always computed by code; an invalid profile or config is `FAIL` (invariant 3).

## 6. Delivery to a project

An element reaches a project in two separate steps: development in the factory, then adoption by the project.

1. **In the factory.** Make the change on a task branch and merge it. The working copy and the merge do not change what projects (or the factory's own session) run.
2. **Release.** Cut a new tag `vX.Y.Z` with the CHANGELOG entry (the `release` skill). Hooks and skills active in a session come from the installed release, not from the working copy.
3. **In the project.** Move the pin by the pin-update PR from [upgrading.md](upgrading.md): tag, lock, wrappers, setup. Read the CHANGELOG between the old and the new tag.
4. **Enabling.** The project enables the element in its own configuration (the knob of the kind: `ralph.enabledSteps`, `verifier.checks`, its `.claude/settings.json` entry). The configuration must be read by a release that understands it: the schema rejects unknown fields and an unregistered name fails, so do not enable the element earlier than the installed release has it. [adding-a-setting.md](adding-a-setting.md#order-in-a-project-release-installed-loader-profile) explains the order in detail.

A separate "enabling" PR is **not** required in every case: when the pin update PR already carries the enabling, or when the pinned release already has the element, it can be one ordinary change. What is required is consistency: wherever the profile is read, the release that reads it must know the element.

Because the installed release is what runs, a green test in the working copy is not evidence that a project has the element. The factory itself installing its own release (self-install) is separate work and is **not** a prerequisite for adding an element.

## 7. CHANGELOG

Add an entry under `[Unreleased]` for the element: what it is, its knob, the default (off), and that it does not influence the verdict (or how it does). The entry records the change; it does **not** make an element mandatory for consumers that did not enable it. In particular a new requirement in doctor for a feature a project has not turned on is not made acceptable by being listed in the CHANGELOG.

## Checklist

- [ ] (Package skill only) The decision to put it in the base set, which makes it required everywhere, was made deliberately.
- [ ] The element is registered in the place its kind owns, with no edit to `ralph/core.js`, the base steps or the other checks.
- [ ] The knob is declared in the schema (or the project-side entry documented) and the element is off when it is absent.
- [ ] Nothing new is required of a consumer that has not enabled it, doctor included.
- [ ] Control, disabled and enabled variants are tested on the monorepo and single-package fixture profiles.
- [ ] Verdict impact is stated; the deterministic reference set was run if the verdict can change; the need for a model eval was assessed if the prompt, schema, model pin or inputs changed.
- [ ] `fixture-profile-run` and `core-literal-scan` are clean.
- [ ] CHANGELOG entry; the delivery path (release, pin update, enabling) is described in the PR.
