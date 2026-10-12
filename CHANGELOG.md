# Changelog

All notable changes to dark-factory are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-10-12

### Added

- Package skeleton: `files` layout, `private: true`, `engines.node` `>=22`.
- Tag-based releases: the `Release` workflow checks that the `vX.Y.Z` tag matches `package.json` `version` and that `CHANGELOG.md` has a `## [X.Y.Z]` section before creating a GitHub Release.
- CI job `Test (Windows)`.
