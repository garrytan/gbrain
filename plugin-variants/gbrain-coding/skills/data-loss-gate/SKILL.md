---
name: data-loss-gate
version: 1.0.0
description: >
  Confirmation gate before any bulk delete, cleanup, or destructive operation
  that could result in data loss — shell-level (rm -rf, git rm, bulk sed) or
  brain-level (bulk forget, delete sweeps, purge-deleted, source removal,
  raw-SQL truncation). Presents a recoverability card and requires an explicit
  "yes" from the user before proceeding. Routing convention, not an
  operation-boundary enforcement.
triggers:
  - "bulk delete"
  - "wipe the"
  - "rm -rf"
  - "purge the"
  - "truncate"
  - "free up space"
  - "bulk forget"
  - "remove the source"
  - "drop the table"
mutating: true
writes_pages: true
writes_to:
  - daily/
upstream: data-loss-gate@fc834ee
# Brain-first applies in its inspection form: before deleting brain pages,
# check backlinks / graph dependencies (get_backlinks, graph) so the card's
# "what we'd lose" section is grounded in the actual target, not guesses.
brain_first: true
---

# Data Loss Gate — Confirmation Before Destructive Operations

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> inspect the actual target before proposing deletion: `get_backlinks`,
> `gbrain graph <slug>`, `git log` on the underlying files. The confirmation
> card below is only as good as the inspection behind it.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> the post-confirmation deletion log files date-keyed under `daily/`.

## What This Is

A gate that fires BEFORE any destructive operation and requires explicit user
confirmation. The agent stops, presents a recoverability card, and waits.

**Scope honesty:** this gate is a routing convention — the harness resolves it
into context when a destructive intent matches, and a well-behaved agent
follows it. It is NOT an operation-boundary enforcement: nothing in the gbrain
runtime mechanically blocks a delete if the skill never loads. (A native
confirm gate at the operation boundary is a filed TODO; until it lands, this
convention is the line of defense.) Some CLI surfaces carry their own flag
gates — e.g. `gbrain sources remove` requires `--confirm-destructive` — but
the flag confirms that the AGENT is sure. This skill exists to confirm that
the USER is.

## When This Fires

**Before ANY of these operations:**

Shell / filesystem level:

- `rm -rf` on any directory with data
- `rm` / `unlink` on more than 10 files
- `sed -i` that modifies more than 10 files
- `git rm` on tracked files
- Truncating or stripping content from files in bulk
- Overwriting files with smaller versions (content stripping)
- Any operation described as "cleanup" or "freeing space" that touches data files

Brain / database level (gbrain-specific):

- **Bulk forget** — scripting or looping `gbrain forget <fact-id>` over many
  facts. One forget is a considered, idempotent act; a forget sweep is data loss.
- **Page-delete sweeps** — `gbrain delete <slug>` in a loop, or any script that
  sweeps `delete_page` across a set of slugs. Deletes are soft (recoverable via
  `gbrain restore <slug>`) until purged — say so on the card, then gate anyway:
  a sweep that's wrong in bulk is expensive to un-wrong in bulk.
- **`gbrain purge-deleted`** — permanently removes soft-deleted pages. This is
  the point of no return for the soft-delete safety net.
- **Source removal** — `gbrain sources remove <id>` deletes the source AND
  every page in it. The `--confirm-destructive` flag does not substitute for
  the card.
- **Mount removal** — `gbrain mounts remove <id>` only removes the local
  registration (the mounted brain's database survives; re-add to recover). Gate
  it anyway when the flow ALSO plans to delete the mount's underlying database
  or files — then the full card applies to those.
- **Raw-SQL truncation** — any `DROP TABLE`, `TRUNCATE`, or `DELETE` without a
  narrow `WHERE` against the brain database, via any path (psql, a migration
  script, an engine `executeRaw` call).
- Deleting database rows in bulk; dropping tables, collections, or indexes.

## What To Do

### Step 1: STOP before executing

Do NOT run the destructive command. Inspect the actual target first
(backlinks, graph edges, git history, file contents — whatever grounds the
card), then present the user with:

### Step 2: The Confirmation Card

```
⚠️ DATA DELETION — Confirmation Required

What: [exactly what will be deleted/modified]
Count: [number of files/rows/pages/facts affected]
Size: [how much data will be removed]
Location: [exact paths, slugs, or source/mount ids]

Why: [the reason for the deletion]

Recoverable?
- [ ] Backed up to a remote (git remote, database backup, object storage)
- [ ] In git history (can git checkout)
- [ ] Soft-deleted in the brain (restorable via `gbrain restore` until purged)
- [ ] Re-fetchable from an upstream source (which one, how long)
- [ ] NOT recoverable — permanent data loss

What we'd lose:
- [specific data/capability that would be gone]
- [any downstream systems that depend on this data]

Alternative to deletion:
- [compress instead of delete?]
- [move to cold storage?]
- [archive to a remote backup?]
- [soft-delete and defer the purge?]

Proceed? (yes/no)
```

### Step 3: Wait for explicit "yes"

- Do NOT proceed on "ok", "sure", "go ahead" — require "yes" or "do it"
- If the user says "wait" or asks a question, answer it and re-present the card
- If the user says "no", stop immediately and suggest alternatives

For the mechanics of presenting the gate and stopping the turn, use the
[ask-user](../ask-user/SKILL.md) choice-gate pattern — this skill supplies the
card content and the explicit-yes strictness; ask-user supplies the
stop-and-wait discipline.

### Step 4: Execute with logging

After confirmation:

1. Log what was deleted to `daily/notes/YYYY-MM-DD.md` under `## Data Deletions`
2. Include: timestamp, what, count, size, recovery path
3. If the deletion is large (>1GB or >1000 files/pages), do it in chunks with
   progress updates

## No Exception Classes

There are no categories of data that are disposable by default. Old logs, git
stash entries, build artifacts, caches — each of these has, at some point,
been the source of truth for something. Disposability is a property of the
SPECIFIC target, verified by inspecting it (backlinks, git status, what
depends on it, whether it's re-fetchable and at what cost) — never a property
of its category. If the inspection genuinely shows the target is ephemeral and
regenerable, the card is quick to fill out and the user's "yes" is quick to
get. That's the cost of the gate working.

## Why This Exists

A downstream agent once deleted a multi-gigabyte cache of raw source files
from its brain's data directory to free disk space. The files looked like
"just cache" — but they were the source data for a planned feature. The data
happened to be re-fetchable from its upstream source, but the deletion was
still wrong because:

1. It destroyed work that had a planned use
2. It happened without the data owner's consent
3. The "cleanup" framing made it seem safe when it wasn't

**The rule: if it's data and it's bulk, ASK FIRST. Always.**

## Anti-Patterns

- ❌ "These are just cache files" — cache files can be the source of truth
- ❌ "We can re-fetch from the API" — re-fetching costs time, money, and may not produce identical data
- ❌ "It's gitignored so it doesn't matter" — gitignored ≠ unimportant
- ❌ "The disk is full, I need to free space NOW" — even under pressure, ask first
- ❌ "I'll clean up and tell the user after" — the confirmation must come BEFORE the deletion
- ❌ "It's only a soft delete" — a wrong sweep is still expensive to un-wrong in bulk, and purge makes it permanent
- ❌ "The command already has --confirm-destructive" — the flag confirms the agent's intent, not the user's consent
- ❌ Presenting deletion as the only option without listing alternatives

## Dedup (sharp boundaries)

- **[conventions/test-before-bulk.md](../conventions/test-before-bulk.md)** —
  the write-side sibling. test-before-bulk gates bulk WRITE quality (test 3-5
  items before running 170); data-loss-gate gates bulk DESTRUCTION (confirm
  before deleting anything in bulk). A flow that rewrites pages in place needs
  both: test-before-bulk for the new content, data-loss-gate for what the
  rewrite destroys.
- **[ask-user](../ask-user/SKILL.md)** — the confirmation MECHANICS (2-4
  options, escape hatch, stop the turn, handle the response). data-loss-gate
  is a specialized caller: it supplies the destructive-op card and the
  strict explicit-yes rule ("ok" is not consent). Route to ask-user for any
  non-destructive decision gate.
- **[maintain](../maintain/SKILL.md)** — brain health checks and routine
  cleanup (orphans, backlinks, stale detection). maintain FINDS candidates
  for cleanup; when acting on them crosses into bulk deletion, data-loss-gate
  fires before execution. "Check brain health" routes to maintain, not here.

## Contract

This skill guarantees:

- No destructive operation in scope (the "When This Fires" list) executes
  before the confirmation card is presented and the user answers with an
  explicit "yes" / "do it".
- The card always includes the recoverability checklist, what-we'd-lose, and
  at least one alternative to deletion.
- Confirmed deletions are logged to `daily/notes/YYYY-MM-DD.md` under
  `## Data Deletions` with timestamp, scope, and recovery path.
- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:`.
- Privacy contract preserved: no real names, no fork-specific filesystem path
  literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this
section exists for the conformance test.

## Output Format

Two artifacts:

1. **The confirmation card** (pre-execution) — the exact fenced block in
   Step 2, presented via the ask-user stop-and-wait pattern. The turn ends
   after the card; no further tool calls until the user responds.
2. **The deletion log entry** (post-execution, only after explicit "yes") —
   appended to `daily/notes/YYYY-MM-DD.md`:

```markdown
## Data Deletions

- **[HH:MM]** [what was deleted] — [count], [size]. Reason: [why].
  Recovery: [backup/git/restore path, or "none — permanent"].
```
