---
name: release
description: Procedure for releasing a new factory version (git tag vX.Y.Z with a CHANGELOG entry) and moving the pinned tag in the factory itself and in the projects, plus rollback when a release is broken. Load when the owner asks for a release, a tag bump, or reports that a hook gate blocks Write/Edit.
---

# Release

The factory and every project consume the factory as a **pinned release**, a git tag `vX.Y.Z`. The flow is always: edit → merge → release a new tag → change the pinned tag. Editing a hook or skill in the working copy does not change the current session.

## Release

1. **Precondition.** The changes are merged to `main`, and `npm test` and CI (`Test (Linux)`, `Test (Windows)`, `Lint`, `Typecheck`) are green on `main`.
2. **Pick the version.** Use `vX.Y.Z`: patch for fixes, minor for new elements (off by default), major for changes that break a project profile or config.
3. **CHANGELOG.** Add an entry for the new version listing every change since the previous tag. Every added element must already have its entry (see `add-factory-element`). Land this through the normal flow: issue → branch `task/ISSUE-<n>-<slug>` → PR starting with `Closes #<n>` (or `Refs #<n>` when it is the first half of a two-PR task).
4. **Tag.** After the CHANGELOG is merged, the owner runs `node .claude/scripts/release-tag.js vX.Y.Z` in an ordinary terminal (`--dry-run` checks only). Before anything is created it checks that the target is the current commit of `origin/main`, that its `package.json` and CHANGELOG pass `release-check`, that the tag exists neither in the clone nor on `origin`, and that `Test (Linux)`, `Test (Windows)`, `Lint` and `Typecheck` succeeded on that commit. It then asks the owner to type the tag, pushes only the tag, and prints the commit SHA the wrappers pin. A pushed tag is public and is never moved, so confirm with the owner before pushing a tag; pass `--yes` only on the owner's explicit decision. The `Release` workflow then creates the GitHub Release.
5. **Bump in the factory.** The factory runs on its own release like any project. The pin moves by a separate PR that changes nothing else but what belongs to the pin, **together**: `package.json` (`devDependencies["dark-factory"]`), `package-lock.json` (the commit of the tag) and the full SHA `git rev-parse vX.Y.Z^{commit}` in both places (`uses` and `with.factory-sha`) of `.github/workflows/verifier-wrapper.yml` and `.github/workflows/spec-approval-wrapper.yml`. A tag that disagrees with a wrapper SHA is a `FAIL` of the verifier. On a clean `main`, the owner runs `node .claude/scripts/pin-release.js vX.Y.Z` (`--dry-run` checks only). It checks that the tag exists on `origin` at a commit of `origin/main` and that both wrappers carry one consistent pin, then changes exactly those four files (`npm install --ignore-scripts --save-dev`, the SHA in the wrappers), runs the setup of the new installed release and `factory doctor`, and prints the result. It restores `package.json` and the lock if npm fails or locks another commit. It does not commit or open the PR: create the branch `task/ISSUE-<n>-pin-vX.Y.Z`, review `git diff`, commit and open the PR. If the new release adds a skill or agent to the base set, setup stops naming the missing `.gitignore` line; add it in the same PR. From the first release that contains `bin/pin.js`, use that command of the installed release instead (`node node_modules/dark-factory/bin/pin.js vX.Y.Z`, it also adds the missing `.gitignore` lines itself) and retire `.claude/scripts/pin-release.js`. See `docs/upgrading.md`.
6. **Bump in projects.** For each consumer project, open a separate PR in that project that changes only the pinned version. The core is never updated in a project in any other way. Do not bundle project bumps into the factory PR.

### The first connection of the factory to its own release

A change that a release must contain before the factory can pin it is split in two PRs, in this order:

1. **PR-A** (`Refs #<n>`, does not close the task) carries what the release needs, its tests and the CHANGELOG notes of the version. It does not pin a tag that does not exist yet.
2. Merge it, wait for green CI on `main`, publish the tag (step 4). The tag is a release of the code of PR-A.
3. **PR-B** (`Closes #<n>`) pins the published tag, adds the profile, trusted configs, wrappers (with the SHA of the tag) and the hook settings, and removes what the release replaced. It records the connection in the CHANGELOG as a change **after** that tag, not as part of it.

For `v0.1.0` this is PR-A `Refs #27` → tag → PR-B `Closes #27`. After it every later release is only steps 1–5.

## Rollback: broken release

Hook gates fail closed, so a release with a broken gate can block Write/Edit in the factory, and a missing `node_modules/dark-factory` blocks every Bash call. Then:

1. **Do not try to edit files, and do not repair it from the blocked session.** Write/Edit are blocked, and editing a hook in the working copy will not be picked up anyway.
2. **Use the owner's own terminal outside Claude Code** (Bash inside the session may be blocked too). The exact commands — reinstalling the current pin, or putting the previous pin, lock, wrapper SHAs and settings back together and reinstalling — are in `CLAUDE.md` (Recovery). Public tags are not moved and the whole working copy is not rolled back instead of the dependency. The first release has no previous version: reinstall the current pin.
3. Once Write/Edit work again, fix the problem in the working copy, merge, cut a new release (steps above) and move the pin forward by PR.
4. If a broken release was already bumped in a project, roll that project's pin back by a PR that changes only the pinned version.
