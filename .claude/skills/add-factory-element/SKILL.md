---
name: add-factory-element
description: Procedure for adding a new element to the factory core (a Ralph step, a verifier check, a hook or a skill). Load before writing the first line of the new element, and follow the steps in order.
---

# Add a factory element

Applies to a new Ralph step, verifier check, doctor check, hook or package skill. It does not apply to factory-only skills and agents in `.claude/`, which never ship to projects.

## Steps

1. **Read [docs/adding-an-element.md](../../../docs/adding-an-element.md) in full before writing the first line of the element, and follow it.** It holds the one complete procedure (registration point and knob per kind, default-off, tests, verdict impact, CHANGELOG, delivery) and ends with a checklist; work through that checklist before calling the element done. This skill does not repeat it. The Core invariants stay in `CLAUDE.md`, including the closed list of diagnostic exceptions in invariant 6; do not extend that list on your own.
2. **Run the factory's checking agents** the document refers to. They are tools for developing the factory in `.claude/`, not runtime dependencies of a project:
   - `fixture-profile-run`: the tests on the "monorepo" and "single package" fixture profiles. If the fixture profiles do not exist, say so; do not write ad-hoc substitutes and call it done.
   - `core-literal-scan`: project literals in core code. Fix every finding that is not an allowed exception.

Stop and report to the owner if a requirement of the document cannot be met; do not skip it.

## Reminder: when it takes effect

Hooks and skills active in the session come from the pinned release, not from the working copy. The new element reaches the factory's own session only after merge, a new release and a tag bump (see the `release` skill).
