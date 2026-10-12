---
name: release
description: Procedure for releasing a new factory version (git tag vX.Y.Z with a CHANGELOG entry) and moving the pinned tag in the factory itself and in the projects, plus rollback when a release is broken. Load when the owner asks for a release, a tag bump, or reports that a hook gate blocks Write/Edit.
---

# Release

The factory and every project consume the factory as a **pinned release**, a git tag `vX.Y.Z`. The flow is always: edit → merge → release a new tag → change the pinned tag. Editing a hook or skill in the working copy does not change the current session.

## Release

1. **Precondition.** The changes are merged to `main`, and `npm test` and CI `Test (Linux)` are green on `main`.
2. **Pick the version.** Use `vX.Y.Z`: patch for fixes, minor for new elements (off by default), major for changes that break a project profile or config.
3. **CHANGELOG.** Add an entry for the new version listing every change since the previous tag. Every added element must already have its entry (see `add-factory-element`). Land this through the normal flow: issue → branch `task/ISSUE-<n>-<slug>` → PR starting with `Closes #<n>`.
4. **Tag.** After the CHANGELOG is merged, tag the merge commit `vX.Y.Z` and push the tag. Confirm with the owner before pushing a tag; a pushed tag is public.
5. **Bump in the factory.** Change the pinned tag in the factory itself by a separate PR that changes only the pinned version (the factory runs on its own release like any project).
6. **Bump in projects.** For each consumer project, open a separate PR in that project that changes only the pinned version. The core is never updated in a project in any other way. Do not bundle project bumps into the factory PR.

## Rollback: broken release

Hook gates fail closed, so a release with a broken gate can block Write/Edit in the factory. Then:

1. **Do not try to edit files.** Write/Edit are blocked, and editing a hook in the working copy will not be picked up anyway.
2. **Use Bash or the owner's own terminal** to move the pin back to the previous release with an npm or git command: reinstall the previous `vX.Y.Z` with npm, or check out the previous tag with git. The exact command depends on the installation mechanism chosen for the factory's own release; check `CLAUDE.md` (Recovery) and `package.json` for the current form.
3. Once Write/Edit work again, fix the problem in the working copy, merge, cut a new release (steps above) and move the pin forward by PR.
4. If a broken release was already bumped in a project, roll that project's pin back by a PR that changes only the pinned version.
