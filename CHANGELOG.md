# Changelog

All notable changes to dark-factory are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Project profile schema `profile/schema.json` (JSON Schema 2020-12, unknown fields rejected) and `loadProfile(projectRoot)` in `profile/load.js`, the single reader of `.factory/profile.json`; errors name the offending field by full path. Ralph is off by default (`ralph.enabled`); the schema has no way to exclude base skills. Adds the `ajv` dependency and the `profile/` package directory.

## [0.1.0] - 2026-10-12

### Added

- Package skeleton: `files` layout, `private: true`, `engines.node` `>=22`.
- Tag-based releases: the `Release` workflow checks that the `vX.Y.Z` tag matches `package.json` `version` and that `CHANGELOG.md` has a `## [X.Y.Z]` section before creating a GitHub Release.
- CI job `Test (Windows)`.
