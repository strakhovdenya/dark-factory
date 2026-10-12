# dark-factory

The shared core of an AI software factory: **Ralph** (an autonomous agent that executes GitHub issues), the **Acceptance Verifier** (a PR verifier whose verdict is computed by code, not by the model), and the Claude Code skills, agents and hooks that wrap them.

Projects install a pinned release of the package and supply project-specific values only through their own `.factory/profile.json` and overlays. Nothing project-specific lives in the core.

> Status: bootstrap. The package has no release yet; the repository is being built phase by phase.

## Repository layout

| Path | Role | Ships to projects |
|---|---|---|
| `skills/`, `agents/`, `hooks/`, `profile/`, `verifier/` | Package sources (the `files` field of `package.json`) | yes |
| `.claude/` | Tooling for developing the factory only | no |
| `.factory/profile.json` | The factory's own project profile | no |
| `.github/` | CI of this repository | no |

The rules for working in this repository (core invariants, release cycle, task process) are in [CLAUDE.md](CLAUDE.md).

## Why plain JavaScript and not TypeScript

The core is CommonJS JavaScript with no build step.

- **No build for consumers.** Hooks and scripts run directly with `node`. A TypeScript core would need compilation and built artifacts in every release, and every consuming project would depend on that step.
- **Fail-closed hooks stay simple.** A hook gate must block on any error. Fewer moving parts between the source and the executed file means fewer ways for a gate to break.
- **Types are still checked.** `tsc --noEmit` with `allowJs` and `checkJs` reads JSDoc annotations, so typos and wrong calls are caught in an editor hook and in CI, without compiling anything.
- **Portable code.** Code that moves between projects is plain JavaScript on Node.js 22 or newer, with no transpilation.

TypeScript is used here only as a checker. Consuming projects are free to write their own code in TypeScript.

## Commands

```sh
npm install        # installs dev tooling and copies the JS metaskills into .claude/skills/
npm test           # node --test; no network, no real AI
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit (checkJs)
```

CI runs the same checks on every pull request: `Test (Linux)`, `Lint` and `Typecheck`.
