# Changelog

All notable changes to dark-factory are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Project profile schema `profile/schema.json` (JSON Schema 2020-12, unknown fields rejected) and `loadProfile(projectRoot)` in `profile/load.js`, the single reader of `.factory/profile.json`; errors name the offending field by full path. Ralph is off by default (`ralph.enabled`); the schema has no way to exclude base skills. Adds the `ajv` dependency and the `profile/` package directory.
- Fixture profiles "monorepo" and "single package" (`test/fixtures/profiles/`) for core tests, and example profiles of the consumer projects with their current values (`examples/profiles/`); `npm test` now includes `examples/**/*.test.js`. Neither directory ships in the package.
- Acceptance Verifier core in the new package directory `verifier/`, moved from the consumer project's verifier at its reference commit with the same verdicts on the same inputs: the verdict CLI `verifier/verdict.js` and its modules `verifier/verdict/`, the model prompt `verifier/prompt.md` and output schema `verifier/schema.json`, the input producers (`affects-scope.js`, `test-tampering-scan.js`, `spec-hash.js`, `label-authority.js`, `issue-lint.js`, `factory-separation.js`, `metrics.js`) and the golden eval engine `verifier/eval/`. Project literals were removed from the code, prompt and test fixtures.
- Deterministic verifier checks are modules in `verifier/checks/` with one interface (context in, FAIL reasons out) and are called only through a registry: `spec-approval`, `affects-scope`, `computed-items`, `test-tampering-scan`, `references`, `ci-checks`, `allowed-model`. A check declares its reason codes at registration; the closed list of codes is the core's plus the declared ones. Profile knob `verifier.checks` picks the checks that run; **none run by default**. A name no registered check has fails the verdict (`unknown_check`).
- Risk zones (`verifier/risk-zones.js`): the core's base list (`auth`, `secrets`, `ci`, `fs_shell_sinks`, `dependencies`, `none`) plus the project's zones from its trusted `.github/verifier/risk-zones.json`, rendered into the prompt (`{{RISK_ZONES}}`) and the schema enum. A project can only add zones; removing or redefining a base zone is rejected. The verdict CLI takes `--project <root>` (profile) and `--risk-zones <file>`; an invalid profile or a missing or invalid zone config fails the verdict (`config_invalid`), and a report naming a zone outside the merged list fails it.
- The golden eval engine reads its case directory from the profile (`verifier.goldenDir`, via `loadProfile`): `verifier/eval/verifier-eval.js --project <root> <results-dir>`; without the field it exits with an error naming it. The case format is unchanged.
- Reusable workflows (`workflow_call`) that projects call from short wrappers, moved from the consumer project's own workflows: `.github/workflows/acceptance-verifier.yml` (jobs `Verify`, `Verify second`, `Report`, status `Acceptance Verifier`), `acceptance-verifier-eval.yml` (golden eval), `spec-approval.yml` (spec freeze on `spec-approved`) and `factory-separation.yml` (check `Factory separation`). Verifier code comes only from this repository at the SHA the wrapper calls (`factory-sha` input); the profile and trusted configs (`.factory/profile.json`, `.github/verifier/`, including `risk-zones.json`) only from the project's default branch; the PR head is data only. The branch template and golden case directory come from the profile, the model and enforce mode from wrapper inputs (project variables `VERIFIER_MODEL`, `VERIFIER_ENFORCE`; advisory by default), `OPENAI_API_KEY` from an explicit `secrets:` entry. Example wrappers in `examples/wrappers/`. Nothing runs until a project adds a wrapper.
- `verifier/factory-version.js`: reads the factory release tag from the `dark-factory` dependency in the project's default-branch `package.json` and checks that it resolves to the wrapper's SHA. A floating reference (branch, `latest`, range, no tag), a missing dependency or a tag on another commit fails the workflow, and the verifier verdict is `FAIL`.
- `npm test` checks the package content (tracked files under the `files` directories, `package.json`, `README.md`) for project literals via `.claude/scripts/core-literals.js`; a finding fails the existing `Test (Linux)` and `Test (Windows)` jobs with file, line and literal. Development-only; nothing ships.

## [0.1.0] - 2026-10-12

### Added

- Package skeleton: `files` layout, `private: true`, `engines.node` `>=22`.
- Tag-based releases: the `Release` workflow checks that the `vX.Y.Z` tag matches `package.json` `version` and that `CHANGELOG.md` has a `## [X.Y.Z]` section before creating a GitHub Release.
- CI job `Test (Windows)`.
