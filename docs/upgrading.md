# Upgrading the pinned factory release

How a connected project moves to a newer release of dark-factory, and how to recover when a bad release blocks Claude Code. For the first connection see [connecting-a-project.md](connecting-a-project.md).

`vX.Y.Z` and `<commit-sha>` are placeholders: the release tag you move to and the 40-character commit of that tag. The package has no published release at the time of writing, so nothing here was run against one; the commands were checked against the code of the factory and against ordinary public git tags. Commands are POSIX shell (Bash, or Git Bash on Windows), run from the **git root** of your project.

## What an upgrade changes

An upgrade is **one PR** in the project, and it changes these together:

1. the tag in the root `package.json` (`github:strakhovdenya/dark-factory#vX.Y.Z`);
2. the lock file `package-lock.json`, so that it installs the same commit;
3. the commit SHA of the same release in **both places** (`uses: ...@<commit-sha>` and `with.factory-sha`) of **every** factory wrapper present in `.github/workflows/`: the verifier, the golden eval, spec-approval, factory separation and, when Judge is connected, Calibration Judge;
4. what the new release needs on the project side: new `.gitignore` exclusions for the new base set, profile fields named in the CHANGELOG, changed hook entries, and a repeated setup.

The pin may be moved in no other way (core invariant 5 of [CLAUDE.md](../CLAUDE.md)). Do not use `#main`, `@main`, `latest`, a range or a dependency without a release tag, in the dependency or in any wrapper; [connecting-a-project.md](connecting-a-project.md#pinning-rules) lists the forbidden forms.

**What CI does meanwhile.** The verifier reads the pin and the trusted settings from the project's **default branch**. The upgrade PR is therefore verified with the *previous* pinned release and the settings already on the default branch, until it is merged. Once merged, the tag in `package.json` must resolve to the SHA in the wrappers; otherwise the verifier gives `FAIL`, Judge stops with a configuration error, and the eval and separation workflows fail. This is why tag, lock and every wrapper move in one PR.

## Get the release commit SHA

The wrappers pin a **commit**. Get it from the remote, without cloning the factory, for the tag you are moving to. An annotated tag has two lines in the answer: the tag object (`refs/tags/vX.Y.Z`) and the commit it points to (`refs/tags/vX.Y.Z^{}`, "peeled"); the commit is the peeled line. A lightweight tag has only the first line, and that line is already the commit. Never use the SHA of an annotated tag object, a branch such as `main`, or "the first line" of an unfiltered answer.

```sh
factory_sha() {  # usage: factory_sha vX.Y.Z   (prints the commit SHA, fails when it cannot)
  tag=$1
  remote=https://github.com/strakhovdenya/dark-factory.git
  printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "not a release tag: $tag" >&2; return 1; }
  refs=$(git ls-remote "$remote" "refs/tags/$tag" "refs/tags/$tag^{}") || { echo "git ls-remote failed" >&2; return 1; }
  [ -n "$refs" ] || { echo "tag $tag does not exist in $remote" >&2; return 1; }
  sha=$(printf '%s\n' "$refs" | awk -v ref="refs/tags/$tag^{}" '$2 == ref { print $1 }')
  [ -n "$sha" ] || sha=$(printf '%s\n' "$refs" | awk -v ref="refs/tags/$tag" '$2 == ref { print $1 }')
  printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{40}$' || { echo "no commit SHA found for $tag" >&2; return 1; }
  printf '%s\n' "$sha"
}

NEW_SHA=$(factory_sha vX.Y.Z) || echo "STOP: no SHA, do not continue" >&2
```

The function and `NEW_SHA` live in the shell you pasted them into: define the function again in a new terminal, and do not run the commands below while `NEW_SHA` is empty (the replacement script refuses to run without two full SHAs).

An empty answer (a missing tag), a failed `git ls-remote` and a malformed value are all errors: stop, do not fall back to another ref. Check the result once more before pasting it anywhere: it is 40 lowercase hex characters, and it is the same on a second run.

**Doctor does not confirm the tag and the SHA belong together** (CI does at run time). Step 9 below checks it by the same command.

## Procedure

1. **Branch.** Create the upgrade branch the way the project names branches. Do the upgrade in an ordinary terminal: replacing the installed package under a running Claude Code session with active gates is what [Recovery](#recovery-when-the-hooks-block-claude-code) is about.
2. **SHA.** Choose the new tag, get `NEW_SHA` as above. Read the [CHANGELOG](../CHANGELOG.md) entries between your current tag and the new one: they name new profile fields, changed requirements and anything breaking.
3. **Compare the examples of the new tag.** `docs/` and `examples/` are not in the installed package; read them from the repository **at the new tag**, not from `main`:

   ```sh
   TAG=vX.Y.Z
   REF_DIR="$(mktemp -d)"
   git clone --depth 1 --branch "$TAG" https://github.com/strakhovdenya/dark-factory.git "$REF_DIR"
   diff -u "$REF_DIR/examples/wrappers/acceptance-verifier.yml" .github/workflows/acceptance-verifier.yml
   ```

   Do the same for each wrapper you have. Expected differences are the SHA (the example has a stand-in), the CI workflow name, and for Judge the default branch. A new input, permission or event in the example is a change you must carry over. Remove `$REF_DIR` afterwards.
4. **Install the new tag without lifecycle scripts.**

   ```sh
   npm install --ignore-scripts --save-dev "github:strakhovdenya/dark-factory#vX.Y.Z"
   ```

   Use `--save-prod` instead if the project keeps the dependency in `dependencies`; the pin must stay in exactly one of the two. `--ignore-scripts` disables the lifecycle scripts of everything this call installs and the project's own `preinstall`, `install`, `postinstall` and `prepare`, not only the factory's. It is how the new release is installed *before* its setup is prepared; it does not replace the project's own install, so run what the project needs from its scripts by its own instructions afterwards.
5. **Check the lock.** `package.json` and `package-lock.json` must both change, and the lock must hold the commit:

   ```sh
   git diff --stat package.json package-lock.json
   node -p 'require("./package-lock.json").packages["node_modules/dark-factory"].resolved'
   ```

   The printed `resolved` ends with `#<commit-sha>` and that SHA must equal `NEW_SHA`.
6. **New exclusions.** The new base set may add or remove skills and agents. Print the names from the **new** installed package and add the missing lines to `.gitignore`: this is step 5 of [connecting-a-project.md](connecting-a-project.md#5-add-the-exclusions-by-name) (the same `factory_ignore_lines`). Lines for copies that left the base set may stay or be cleaned in the same PR; setup removes such copies itself when they have no tracked files.
7. **Profile and hooks.** Apply the profile fields the CHANGELOG asks for (the strict loader rejects unknown fields and the new release may require new ones) and, if `hooks/README.md` of the new package changed the entries, update `.claude/settings.json` from it: `node_modules/dark-factory/hooks/README.md`.
8. **Run setup explicitly, then update the wrappers.**

   ```sh
   node node_modules/dark-factory/bin/setup.js --consumer-root .
   ```

   Setup validates everything before it writes anything; fix a reported cause (missing exclusion, conflicting copy) and run it again. Then update every wrapper. First see which SHAs are in use: normally exactly one.

   ```sh
   grep -hoE 'dark-factory/\.github/workflows/[a-z-]+\.yml@[0-9a-f]{40}' .github/workflows/*.yml | sed 's/.*@//' | sort -u
   ```

   Set `OLD_SHA` to it (more than one value means the project was already inconsistent: fix that by hand first) and replace it in every file that has it, covering both places:

   ```sh
   OLD_SHA=<current-commit-sha>
   node -e '
   const fs = require("fs");
   const [from, to, ...files] = process.argv.slice(1);
   const isSha = (value) => /^[0-9a-f]{40}$/.test(value);
   if (!isSha(from) || !isSha(to) || files.length === 0) { console.error("need two full commit SHAs and at least one file"); process.exit(1); }
   for (const file of files) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(from, to));
   ' "$OLD_SHA" "$NEW_SHA" $(grep -lF "$OLD_SHA" .github/workflows/*.yml)
   ```

   | Wrapper | Present when |
   |---|---|
   | Acceptance Verifier | always |
   | Acceptance Verifier Eval | the project uses the golden eval |
   | Spec Approval | `spec-approval` is in `verifier.checks` |
   | Factory Separation | the project uses the cross-side gate |
   | Calibration Judge | Judge is connected |

   **Doctor does not check the eval and separation wrappers**, yet they must move with the others: the reusable workflow fails when its `factory-sha` is not the commit of the pinned tag.
9. **Check.** Run doctor, then the checks it does not make:

   ```sh
   node node_modules/dark-factory/bin/doctor.js doctor
   ```

   Doctor reads the working tree and the repository's labels, secret names and variables (exit `0` none found, `1` problems or unavailable checks, `2` it could not run). It also confirms that the wrappers it knows (verifier and, when connected, Judge and spec-approval) pin one SHA with `uses` equal to `with.factory-sha`. Its success is **not** a proof that the tag resolves to that SHA, that the lock holds it, that the eval and separation wrappers moved, or that the files are on the default branch. Check those yourself with the whole pin in one command:

   ```sh
   TAG=$(node -p 'const p = require("./package.json"); const s = (p.dependencies || {})["dark-factory"] || (p.devDependencies || {})["dark-factory"]; s.slice(s.lastIndexOf("#") + 1)')
   SHA=$(factory_sha "$TAG") || echo "STOP: cannot resolve $TAG" >&2
   node -e '
   const fs = require("fs");
   const [tag, sha] = process.argv.slice(1);
   let bad = false;
   if (!/^[0-9a-f]{40}$/.test(sha)) { console.log("no SHA for the tag " + tag); process.exit(1); }
   const lock = require("./package-lock.json").packages["node_modules/dark-factory"];
   const locked = lock ? String(lock.resolved) : "(no entry)";
   console.log("lock: " + (locked.endsWith("#" + sha) ? "ok" : "MISMATCH " + locked));
   if (!locked.endsWith("#" + sha)) bad = true;
   for (const name of fs.readdirSync(".github/workflows").filter((n) => /\.ya?ml$/.test(n))) {
     const text = fs.readFileSync(".github/workflows/" + name, "utf8");
     const uses = [...text.matchAll(/dark-factory\/\.github\/workflows\/[\w.-]+@([^\s"']+)/g)].map((m) => m[1]);
     if (uses.length === 0) continue;
     const pins = [...text.matchAll(/^\s*factory-sha:\s*["']?([^\s"']+)/gm)].map((m) => m[1]);
     const ok = uses.length === pins.length && [...uses, ...pins].every((v) => v === sha);
     console.log(name + ": " + (ok ? "ok" : "MISMATCH uses=" + uses + " factory-sha=" + pins));
     if (!ok) bad = true;
   }
   console.log("tag " + tag + " = " + sha);
   process.exit(bad ? 1 : 0);
   ' "$TAG" "$SHA"
   ```

   It exits non-zero on any mismatch. The verifier gives `FAIL` for the same condition after merge.
10. **Open the PR** that changes the pin and what step 4–8 required, and nothing else. Mention the old and new tag and SHA. Remember that CI judges the PR with the previous pin; the new release applies after merge.

## Recovery when the hooks block Claude Code

The factory's gates **fail closed**. If the pinned release is missing or broken (no `node_modules/dark-factory`, a hook script that does not start), the `Bash` gate (`|| exit 2`) blocks every Bash call in Claude Code, `npm install` included, and `Write|Edit` is blocked too. A bad profile alone only blocks the gated operations and can be fixed from the session. For a missing or broken package:

- Do **not** try to repair it from the blocked session, and do not edit hook files expecting the session to pick them up: the hooks come from the installed release.
- Use an **ordinary terminal outside Claude Code**.
- Do not expect npm to roll back. A failed `postinstall` or an interrupted install can leave `node_modules` and the lock half changed, and npm neither removes the package nor restores the previous release by itself. Treat both as untrusted and restore them from Git.

Restore the project to the **known previous working state**. `<good-ref>` is the last commit (or the merge base of the upgrade branch) that worked. Commit or stash your own local work first (`git status --short`). Then put back, from that state, the pin, the lock, both SHAs of every wrapper that called the factory, and the profile, exclusion and hook-entry files the old release needs. Each path is restored on its own, so a file that did not exist at `<good-ref>` is reported and skipped instead of aborting the rest:

```sh
GOOD=<good-ref>
git rev-parse --verify "$GOOD^{commit}" || echo "STOP: unknown ref"
restore() { git cat-file -e "$GOOD:$1" 2>/dev/null && git checkout "$GOOD" -- "$1" || echo "not in $GOOD, left as it is: $1"; }
for path in package.json package-lock.json .gitignore .factory/profile.json .claude/settings.json; do restore "$path"; done
git grep -lF "dark-factory/.github/workflows/" "$GOOD" -- .github/workflows | sed "s/^[^:]*://" | while IFS= read -r path; do restore "$path"; done
```

The last line takes every wrapper that called the factory at `<good-ref>` (verifier, eval, spec-approval, separation, Judge), so both SHAs of each come back together. A wrapper that the upgrade *added* and that did not exist at `<good-ref>` stays as it is: remove it (`git rm`) if the old release has no use for it. `.gitignore`, the profile and `.claude/settings.json` come back whole; if they also hold unrelated changes made since `<good-ref>`, look at `git diff "$GOOD" -- <file>` and re-apply those. If the whole upgrade should go, `git revert` of the upgrade commit or merge does all of this in one step.

Then reinstall exactly what the lock says, run setup, and check by the requirements of that old release:

```sh
rm -rf node_modules
npm ci --ignore-scripts
node node_modules/dark-factory/bin/setup.js --consumer-root .
node node_modules/dark-factory/bin/doctor.js doctor
```

Run the project's own install-time scripts, which `--ignore-scripts` skipped, by the project's own instructions. Setup removes copies that are not in the old base set (only when they have no tracked files) and updates the others from the list it owns. Then return to the Claude Code session. Once the editing tools work again, fix the problem in a working copy, cut a fixed release, and move the pin forward by a new upgrade PR. The release-side procedure (cutting a tag, rolling back a release) is the factory's own, in [CLAUDE.md](../CLAUDE.md) (Release cycle, Recovery).
