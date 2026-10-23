# Factory hooks

Claude Code hooks shipped in the package. They work in the consumer repository by its profile
(`<consumer root>/.factory/profile.json`). Installing the package does not wire them in: a project
adds the settings below to its `.claude/settings.json`.

| Hook | Event / matcher | Kind | What it does |
|---|---|---|---|
| `closure-gate.js` | `PreToolUse` / `Bash`, `PreToolUse` / `mcp__github__issue_write` | gate | `git commit` / `git push` need the `task-lifecycle` skill and then ask the person to confirm the closure checks; `gh issue create|edit` and `issue_write` need the `issues` skill and a body that passes the issue linter |
| `skill-gate.js` | `PreToolUse` / `Write\|Edit` | gate | blocks an edit until the skills the shared "path → skills" table requires for the file were loaded in the session |
| `skill-marker.js` | `PostToolUse` / `Skill` | helper | records each loaded skill in the session marker |
| `lint.js` | `PostToolUse` / `Write\|Edit` | helper | runs the profile's `hooks.lint` commands for the changed file |
| `typecheck.js` | `PostToolUse` / `Write\|Edit` | helper | runs the profile's `hooks.typecheck` commands for the changed file |

## Settings

Copy this into the project's `.claude/settings.json` (merge with existing `hooks` entries). It has
six entries for the five hooks, described once in `entries.js` (used by `factory doctor` and checked against this JSON by `settings-entry.test.js`).

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/closure-gate.js\" || exit 2",
            "statusMessage": "Checking the task closure gate..."
          }
        ]
      },
      {
        "matcher": "mcp__github__issue_write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/closure-gate.js\" || exit 2",
            "statusMessage": "Checking the issue body against the format contract..."
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/skill-gate.js\" || exit 2",
            "statusMessage": "Checking required skills are loaded..."
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/skill-marker.js\" || true"
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/lint.js\" || true",
            "statusMessage": "Running lint hooks..."
          },
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/dark-factory/hooks/typecheck.js\" || true",
            "statusMessage": "Running typecheck hooks..."
          }
        ]
      }
    ]
  }
}
```

- **Shell form, Bash only.** The commands are shell strings run by Bash: Bash on Linux and macOS,
  Git Bash on Windows (the shell Claude Code uses there). PowerShell and the exec form are not
  supported. `node` is called directly, not through `node_modules/.bin`.
- **Gates end with `|| exit 2`.** Any non-zero exit of the gate process, including a missing
  package or script (`Cannot find module`), becomes exit code 2, which blocks the tool call.
- **Helpers end with `|| true`.** The marker, lint and typecheck never block, whatever happens.
- The path assumes the package is installed at `node_modules/dark-factory` of the consumer root.
  The hooks themselves find their package files relative to their own location.

## Consumer root and profile

- The consumer root is only `CLAUDE_PROJECT_DIR` (set by Claude Code). There is no fallback on the
  current directory or the package directory.
- The profile is read with `loadProfile` from `<root>/.factory/profile.json`. A missing or invalid
  profile blocks a gated operation with the reason and the profile path.

## Closure gate

- The event is classified first. `git commit` / `git push` and `gh issue create|edit` count only at
  the start of a shell segment (after `&&`, `||`, `;`, `|` or a new line, optionally after
  environment assignments and Git global options); `echo git commit` or `grep "git push"` are not
  intercepted. `gh` may be `gh.exe` or an absolute path.
- Any other valid Bash command passes silently without reading the profile. An unparsable event
  blocks, because the action cannot be identified.
- For a target operation `CLAUDE_PROJECT_DIR`, `session_id` and a valid profile are required.
- `git commit` / `git push`: blocked until `task-lifecycle` is loaded in the session, then the hook
  prints `{"hookSpecificOutput": {"permissionDecision": "ask", ...}}` on stdout so the person
  confirms the closure checks.
- Issue writes: blocked until `issues` is loaded. A body is checked with the issue linter (format
  v2) against the core contract plus the consumer overlay
  `<root>/.github/verifier/issue-contract.overlay.json`, read by this explicit path whatever the
  current directory; a missing overlay means the core contract only, a damaged or weakening
  overlay blocks. `gh issue` must pass the body with `--body-file <path>` (or `-F`); an inline
  `--body`/`-b` (even next to `--body-file`), `--body-file -`, `create` without a body file, a
  missing file and a file outside the command's working directory and the OS temp directory
  (symlinks resolved) are blocked. An `edit` or MCP `update` that sends no body only needs the
  skill. This is a local pre-check; the verifier still reads trusted configs from the default
  branch in CI.

## Skill gate

- Needs `CLAUDE_PROJECT_DIR`, `session_id` and `file_path`; a missing value, an unparsable event or
  a missing or invalid profile blocks.
- The absolute `file_path` is made relative to the consumer root (the drive letter case does not
  matter on Windows) and passed to the shared table `profile/skill-rules.js`, the same one Ralph
  uses. A file outside the root requires no skills.
- The message names the relative path, the labels of the matched profile `skillRules` and the
  skills still missing.

## Session marker

- File: `<os temp dir>/claude-loaded-skills-<session_id>.json`, a JSON array of skill names, shared
  by the three hooks. A missing file is an empty set. `name` and `plugin:name` both count as
  `name`; another session's marker never counts.
- A damaged marker (invalid JSON, not an array of strings) blocks both gates. The next `Skill`
  event rebuilds it from an empty set with the skill loaded now; earlier entries are not restored,
  so load the required skills again. The file is replaced through a temporary file and a rename;
  parallel updates are not merged.
- An unusable `Skill` event (unparsable, no session or skill) writes nothing.

## Lint and typecheck

- Each hook uses only its own profile array: `hooks.lint` or `hooks.typecheck`. No entries, empty
  arrays or no matching pattern means nothing runs; there are no default commands.
- Every entry whose `paths` match the changed file (minimatch: `*`, `**`, `{a,b}`, dot files
  included, case-sensitive, path relative to the root with `/`) runs once, in array order. A file
  outside the root runs nothing.
- `{file}` in every `argv` string is replaced by the absolute path of the changed file and stays
  one argument; `cwd` is relative to the root. No shell.
- A spawn error, a missing binary or a non-zero exit is reported and the next entry still runs.

## Diagnostics

All diagnostics go to stderr. No log files are written in the project or the installed package.
A gate keeps stdout for its JSON decision only.

## Recovery

Two different situations:

- **Package works, profile is bad** (missing, invalid JSON, schema errors): only the gated
  operations are blocked (commit, push, issue writes, and edits for the skill gate). Ordinary Bash
  commands still pass, so the profile can be fixed from the Claude session.
- **Package is missing or broken** (no `node_modules/dark-factory`, a script that does not start):
  the `|| exit 2` of the Bash gate blocks **every** Bash call, `npm install` included, before the
  classifier runs. This is the intended fail-closed behavior; there is no exception for recovery
  commands. The owner restores the package from an ordinary terminal outside Claude Code: install
  the dependencies (`npm install`) or roll the pinned factory version back the way the project
  installs it, then return to the session.
