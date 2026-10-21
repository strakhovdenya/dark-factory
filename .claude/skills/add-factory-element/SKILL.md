---
name: add-factory-element
description: Procedure for adding a new element to the factory core (a Ralph step, a verifier check, a hook or a skill). Load before writing the first line of the new element, and follow the steps in order.
---

# Add a factory element

Applies to a new Ralph step, verifier check, hook or package skill. This is the rule from PRD item 16, written as steps so none are skipped. It does not apply to factory-only skills and agents in `.claude/`, which never ship to projects.

Stop and report to the owner if a step cannot be done; do not skip it.

## Steps

1. **Declare the knob in the profile schema.** The element's settings live in the profile schema (`.factory/profile.json` is the per-project file). The element reads its settings only from the profile; no project literals in core code (paths, app names, DB/ORM names, label values).
2. **Disable it by default.** The schema default switches the element off. A project that does not mention it behaves exactly as before. Register the element (registration + profile); do not hard-wire it into an existing pipeline. The default `false` of the schema is documentation, not the implementation: the code must treat an absent or false knob as off in every way of starting the element, a manual one included. The one exception is a mandatory diagnostic artifact of the round protocol (no switch). It qualifies only if it is on the closed list in invariant 6 of CLAUDE.md, adds no check, model call or authority, leaves the verdict alone and has its formation and publication isolated from the decision. Do not extend the list on your own; changing it means changing that paragraph of CLAUDE.md.
3. **Test on two fixture profiles.** Cover the element with tests on both fixture profiles: "monorepo" and "single package". No test may depend on one project's layout. Tests run under `npm test` and must pass on Windows and Linux, without network and without a real AI (stub the agent/model). Use the `fixture-profile-run` agent for the run and its report. If the fixture profiles do not exist yet, say so; do not write ad-hoc substitutes and call it done.
4. **Run the reference PR set if the verdict can change.** If the element can influence the verifier verdict, run the reference PR set (cases with an expected verifier verdict) and confirm no verdict changes unexpectedly. The verdict stays computed by code; an invalid profile or config is `FAIL`. If the element cannot influence the verdict, state that in the PR description.
5. **Scan the core for project literals.** Run the `core-literal-scan` agent and fix every finding that is not an allowed exception.
6. **Add a CHANGELOG entry.** Describe the element, its profile knob and the default (off).
7. **Check placement.** Package sources go to the package directories `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/` and `judge/`; nothing from `.claude/` or `.factory/` ships. Installing the package must not modify tracked files of the project.

## Reminder: when it takes effect

Hooks and skills active in the session come from the pinned release, not from the working copy. The new element reaches the factory's own session only after merge, a new release and a tag bump (see the `release` skill).
