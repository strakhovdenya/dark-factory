---
name: epic-discovery
description: Find, analyze, or scope the next epic/phase and determine current epic progress. Use when asked what comes next, which phase is active, or to scope an epic that was not already named.
---

# Epic and Phase Discovery

Use this source order; do not infer current project status from a single stale planning file.

1. The project's epic definitions (why each epic exists: goal, business value, scope, acceptance criteria). Look in the documents the project rule files (`ruleFiles` of `.factory/profile.json`) point to and in the directories `docs.prd` and `docs.plans` of the profile, when set.
2. The roadmap or plan documents: phase order, dependencies, done criteria, physical result. Epic and phase numbers may be independent and only roughly map 1:1; check both.
3. Any frozen historical task board or backlog document. Use it only for work broken down before the project moved to GitHub Issues, and only as history.
4. For work broken down in GitHub Issues, use the Issues and milestones (and the GitHub Project `githubProject` of the profile, when set) as the execution/status source of truth.
5. Check the documentation for a dedicated methodology document for the epic.
6. Check for relevant research documents. Research supplements methodology/PRD/plan; it does not override already resolved decisions.

Do **not** treat a progress summary file as authoritative for current status when its source of updates is frozen or may be stale; cross-check it against Issues, milestones and git/PR history.

For current work, establish status from open/closed Issues, milestones, and the GitHub Project. For older work, cross-check the frozen task board with git/PR history.

When reporting the next epic/phase, distinguish:
- product definition (epics doc),
- sequencing/dependencies (roadmap),
- execution decomposition (Issues/milestones),
- observed current status (GitHub),
- optional methodology/research context.

Do not silently create Issues or start implementation from this skill. Use the `issues` skill for backlog creation and `task-lifecycle` for implementation.
