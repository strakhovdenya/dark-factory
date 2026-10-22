---
name: adr
description: Creates a new ADR entry or amends an existing one in the project ADR file (docs.adr of the profile), using a fixed template and a duplicate-topic/independent-review procedure. Load before writing to the ADR file for any binding architecture/process decision — new decision, superseding decision, or an amendment to an already-accepted entry.
---

# ADR Skill

The ADR file is a single, ever-growing file of binding decisions, several of them possibly carrying
multiple dated `Amendment` blocks. Its path is the `docs.adr` field of the project profile
(`.factory/profile.json`), relative to the project root. This skill exists so every entry keeps the
same shape and the same procedure, instead of being written ad hoc.

## Locate the ADR file first

Read `docs.adr` from `.factory/profile.json`. It is the path of one file, not a directory.

- If the profile has no `docs.adr` (or the profile cannot be read), say that **no ADR file is
  configured** and stop. Do not guess a path, do not reuse a path from another project, do not create
  a file on your own. The owner sets `docs.adr` first.
- Otherwise, every mention of "the ADR file" below is that path.

This skill does not replace the `task-lifecycle` skill. Writing/amending an ADR is part of the
"architecture documentation must stay current" duty that lifecycle skill already names for
architectural changes — this skill only governs the shape and procedure of the ADR entry itself.

## When to load this skill

Load it before any write to the ADR file:

- Recording a new binding decision (new numbered entry).
- Recording a decision that supersedes an earlier one (new numbered entry with `supersedes
  ADR-NNN` in its `Decision:`).
- Amending an already-`Accepted` entry (a dated `Amendment` block appended under it — never an
  edit to the existing text).

Do not load it to merely read or discuss the ADR file.

The shared "path → skills" table requires this skill for exactly that file (the `docs.adr` path),
and the skill gate hook of the installed factory blocks a `Write`/`Edit` to it until the skill is
loaded. That gate is a backstop, not a replacement for following the procedure below: it only proves
the skill was loaded, not that its steps were followed. It does not cover a Bash-driven edit (e.g.
`sed`) to the same file — the rule below still applies there.

## The file stays one file (no splitting, no rotation)

The ADR file does not get split into multiple files and does not get a size-based rotation. A single
file that the project's rules import by default keeps every accepted decision visible to every agent;
splitting it would make older ADRs invisible to an agent that only has the current file in context.
The file keeps growing as a single append-mostly document — this skill never proposes otherwise,
regardless of the file's length at the time it is loaded.

## Step 1 — Determine the next ADR number (new entries only)

Read the ADR file and find the highest existing `## ADR-NNN` heading. The
next new entry is `NNN + 1`. Do this by reading the file, every time — never ask the user for the
number and never hardcode a number remembered from an earlier session (the file grows between
sessions).

If the user is asking to **amend** an existing entry, the target number must already exist as a
`## ADR-NNN` heading in the file. If it does not exist, stop and tell the user the number they gave
does not match any entry — do not invent a plausible number and do not silently pick the nearest
existing one.

## Step 2 — Check for an existing entry on the same topic

Before drafting anything, search the ADR file for entries already covering
the same topic (grep for the relevant module/service/rule name, not just the literal wording the
user used — topics are frequently rephrased across entries).

- **No overlap found:** proceed to draft a new entry (Step 3).
- **Clear overlap, and the request is explicitly to record a change to that same decision:**
  proceed as an amendment (Step 3, amendment form) to the entry found.
- **Overlap found but it is unclear whether this is a new decision, an amendment to the found
  entry, or a duplicate of it:** stop and ask the user directly which of the three it is, quoting
  the found entry's number and title. Do not guess and do not silently proceed with any of the
  three.

## Step 3 — Draft the entry

### New entry template

```markdown
## ADR-NNN — <short title>

Status: `Accepted`

Decision:
<the decision itself, stated as a rule that governs future work, not a narrative of the discussion>

Alternatives considered:
- <option A> — <why it was rejected>
- <option B> — <why it was rejected>

Reason:
<why this decision, referencing the actual trade-off/incident/constraint that drove it>

Source:
<who decided it and when/where, e.g. "project owner, YYYY-MM-DD, via Issue #NNN">
```

`Status`, `Decision` and `Reason` are the three fields every existing entry in the file already
carries. `Source` is optional, as it already is throughout the file (older entries sometimes omit
it). `Alternatives considered` is a **new, mandatory** field for every entry this skill writes —
not optional, and not folded back into prose inside `Reason`. An existing file may already
describe rejected alternatives inside `Reason` prose; this skill makes that
content its own labelled field going forward, in the spirit of MADR's "Considered options," without
adopting MADR's full structure (no separate "Decision Drivers"/"Decision Outcome" sections — that
would not fit the shape of the entries already in the file). Every `Alternatives considered` line must
name an option that was **actually compared**, with a concrete reason it was rejected — not a
token placeholder entry invented to satisfy the template.

If the decision explicitly replaces an earlier one, say so in `Decision:` itself:

```markdown
Decision:
This supersedes ADR-0NN for <the specific scope that changed>. <the new rule>.
```

The superseded entry's own text is never edited — see "Never edit an accepted entry" below.

### Amendment form (existing entry, already `Accepted`)

Append, directly under the existing entry's own text (before the next `## ADR-` heading), a
dated block in the same shape already used throughout the file (follow the existing amendment blocks
of the file when there are any):

```markdown
**Amendment (YYYY-MM-DD, ISSUE-n): <short description of what changed>**

<the change itself, stated as a rule>

Alternatives considered:
- <option> — <why rejected>

Reason:
<why this amendment>
```

Use today's actual date and the real Issue number driving the amendment — never a placeholder.
`Alternatives considered` is mandatory in an amendment block too, on the same "actually compared"
standard as a new entry, unless the amendment is a pure correction of a factual/typo error with no
alternative approach to weigh — state that explicitly instead of inventing an alternative.

## Never edit an accepted entry's existing text

Once an entry's `Status` is `Accepted`, its existing `Decision`/`Reason`/`Alternatives
considered`/`Source` text is never rewritten or deleted. A change in direction is recorded exactly
one of two ways, both already established in the file:

1. A **new numbered entry** with `supersedes ADR-NNN` in its own `Decision:` text.
2. A **dated `Amendment (YYYY-MM-DD, ISSUE-n): ...` block** appended under the existing entry.

There is no third way. If neither shape fits what the user is asking for, stop and ask rather than
inventing a new convention.

## Step 4 — Independent review of the draft (before writing to the file)

Before appending the draft (new entry or amendment block) to the ADR file,
run the read-only `research` agent with fresh context — it must not
see this session's history, the reason the decision came up, or prior discussion, only the draft
text itself. It does not edit the file and does not decide anything; it returns observations.

Brief the agent with this text verbatim, substituting the full draft text for `<draft>`:

```
Task (Finding): read the ADR file in full. Against the draft ADR entry (or
amendment block) below, report as observations, not verdicts:
1. Any existing ADR entry whose Decision overlaps with or contradicts this draft, by number and
   title — quote the conflicting/overlapping line from both the draft and the existing entry.
2. Whether each line under the draft's "Alternatives considered" describes an option that reads as
   actually having been compared (a concrete rejection reason tied to this decision), versus a
   generic or token entry that could apply to any decision.
3. Whether the draft's Decision is stated as an enforceable rule for future work, or only as a
   narrative of what was discussed.

You have no access to this session's history or to why this decision came up — only the draft
below and the ADR file itself. You do not edit the file and do not decide
whether the draft is acceptable.

Draft:
<draft>
```

Every observation the agent returns must either be fixed in the draft, or — if it is judged not
applicable — explicitly recorded in the draft's own text as why it was not addressed (e.g. as an
extra clause in `Reason:` or `Alternatives considered:`). Do not silently discard an observation.
Only once every observation is addressed or explicitly recorded does the draft get appended to
the ADR file.

## Step 5 — Write the entry

Append the reviewed draft to the end of the ADR file (new entry) or directly
under the target entry, before the next `## ADR-` heading (amendment). Do not reorder, renumber, or
otherwise touch any other part of the file.

If the decision is architectural in the sense the project rules already define (module/service
boundaries, dependency direction, endpoints/data flow, state transitions), also update whichever
other doc those rules name as authoritative for that kind of change in the same change — this skill
does not substitute for that existing rule.
