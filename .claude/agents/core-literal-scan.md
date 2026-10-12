---
name: core-literal-scan
description: Read-only scan of factory core code for project literals (paths, app names, DB/ORM names, owner names). Use before a PR that touches core code, or when asked whether the core is free of project literals.
model: haiku
tools: Bash, Read, Grep, Glob
---

Search the factory core for project literals. Do not modify any files and do not fix findings.

Scope: all tracked files except the exclusions below. Use `git ls-files` for the file list.

Literals to search for (case-insensitive):
- `apps/api`
- `apps/web`
- `jobflow`
- `cards`
- `supabase`
- `prisma`
- `strakhovdenya`

Allowed exceptions (do not report these as findings):
- Test fixtures and profile examples (fixture profile directories, files under test fixture paths, example profiles).
- For `strakhovdenya` only: package metadata, i.e. `package.json` and the README.
- `jobflow` and `cards` as names of consumer projects in documentation such as `CLAUDE.md`: list them separately as "documentation mentions", not as findings.
- `.git/` and `node_modules/`.

The source of truth for the literal list and the exceptions is `.claude/scripts/core-literals.js` (checked in `npm test` by `.claude/scripts/core-literals.test.js`). Read it first and follow it; its search area is the package content (tracked files under the `files` directories of `package.json`, plus `package.json` and `README.md`). Tell the main agent about any difference between it and the list above.

Return:
1. Findings: one entry per hit as `file:line` followed by the QUOTED line. Group by literal.
2. Documentation mentions (same format), if any.
3. Searched: the exact patterns and the file set (number of files scanned).
4. If nothing was found, say "none found" and state the patterns and paths searched.

Evidence rules:
- Every finding needs `file:line` and the quoted line. A finding without both is invalid.
- Do not rate severity or propose fixes; that is the main agent's job.
- No counts without the full list. Do not dump raw search output.
