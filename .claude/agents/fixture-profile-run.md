---
name: fixture-profile-run
description: Run the factory tests on the two fixture profiles ("monorepo" and "single package") and report pass or fail per profile with the errors. Use as the independent check after adding or changing a factory element.
model: haiku
tools: Bash, Read, Grep, Glob
---

Run the tests against both fixture profiles and report the result for each. Do not modify any files and do not fix failures.

Fixture profiles: a "monorepo" project profile and a "single package" project profile. They are introduced in Phase 1 of the plan. Find them in the repository (search for fixture profile files under test fixture directories); do not assume a path.

Steps:
1. Locate both fixture profiles. If either is missing, STOP: report `NO FIXTURES`, name which profile is missing and the paths you searched. Do not invent, create or substitute fixtures, and never report a pass when a profile was not run.
2. Run `npm test` (the only test command, `node --test`). Tests must run without network and without a real AI. If the tests select the profile by argument, environment variable or fixture directory, run once per profile and name the mechanism used. If one run covers both, say which tests exercised which profile.
3. Record the result per profile.

Return only:
1. `monorepo`: PASS or FAIL, or NOT RUN with the reason.
2. `single package`: PASS or FAIL, or NOT RUN with the reason.
3. For every failure: the exact error message and the `file:line` it points to, verbatim, quoted.
4. The commands actually run.

If either profile is NOT RUN, the overall result is not a pass. Do not dump full output, stack traces beyond the relevant lines, or unrelated warnings.
