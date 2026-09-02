---
name: daily-task-manager
version: 2.0.0
description: |
  Task lifecycle management with stable task IDs. Add, complete, defer, remove,
  and review tasks with deterministic action routing and fail-closed ambiguity
  handling. Maintains a running task list as a brain page.
triggers:
  - "add task"
  - "complete task"
  - "what are my tasks"
  - "task list"
  - "defer task"
tools:
  - search
  - get_page
  - put_page
  - add_timeline_entry
mutating: true
upstream: daily-task-manager@fc834ee
---

# Daily Task Manager

## Contract

This skill guarantees:
- Tasks stored as a brain page (`ops/tasks.md`) with structured format and a stable `id` per task
- Task lifecycle: add → in-progress → complete | defer | remove
- Priority levels: P0 (urgent), P1 (today), P2 (this week), P3 (backlog)
- Completed tasks archived with completion date; deferred tasks carry a target date + reason
- Mutations never drop unrelated tasks or unknown sections
- Every action returns the structured result below (Returns)

### Returns

After every action, report a structured result so callers (including sub-agents) can chain reliably:

```
{action, task_id, status: ok|not_found|ambiguous|needs_confirmation, priority, date, page: "ops/tasks.md", saved: true|false}
```

For `review`, return the grouped active-task list instead of a single task_id. When invoked with the trigger "task list json", return a JSON array of task objects `{id, description, priority, due, status}` instead of markdown.

## Tool Interface

Use ONLY the declared tools. `get_page("ops/tasks.md", include_content=true)` to read the canonical markdown and its `content_hash`; `put_page("ops/tasks.md", content=…, expected_content_hash=…)` to write; `add_timeline_entry` for the audit trail; `search` for cross-referencing. Do not shell out to `gbrain` CLI verbs from this skill; the tools are the interface. (When the user runs this manually outside an agent, the CLI equivalents are `gbrain get ops/tasks --include-content --json` / `gbrain put ops/tasks --expected-content-hash HASH` — equivalents only, not the skill's interface.)

## Action Routing

Map user intent deterministically before touching state:
- "add / remind me to / put X on my list" → **add**
- "done with X / finished X / completed X / ✅ X" → **complete**
- "push X / defer X / move X to next week" → **defer**
- "delete X / remove X / kill task X" → **remove** (explicit delete words only — never infer remove)
- "what are my tasks / task list / what's on my plate (today)" → **review** ("today" filters to P0+P1)

## Phases

1. **Load.** `get_page("ops/tasks.md", include_content=true)`. Preserve the returned canonical `content` and `content_hash`. **First run:** if the page does not exist, create it from the Output Format template with `expected_content_hash="absent"`, then proceed.
2. **Validate.** Determine the action via Action Routing. If required fields are missing (see per-action rules), ask ONE concise clarification before mutating state. Never fabricate priorities, due dates, or defer reasons.
3. **Identify the target task** (complete/defer/remove): match by `id` when given; otherwise fuzzy-match description against ACTIVE tasks only. Zero matches → return `not_found`, do not mutate. Multiple matches → list candidates with IDs, return `ambiguous`, do not mutate.
4. **Execute:**
   - **Add:** Require a description. Priority: use the user's stated/clearly-implied level; otherwise default to **P3 and say so in the reply + timeline entry**. Due date only if supplied or explicit in the user's words. Mint a new task ID (`t-YYYYMMDD-NN`, NN = next free ordinal that day). Add a timeline entry.
   - **Complete:** Mark `[x]`, move to Completed with `(completed: YYYY-MM-DD)`.
   - **Defer:** Require a target date/timeframe AND a reason; ask if missing. Move to Deferred preserving original text, ID, and priority unless the user changes them.
   - **Remove:** Destructive — require explicit confirmation unless the user's message already contains it. Prefer suggesting complete or defer.
   - **Review:** Read-only. Never mutates. Active tasks grouped by priority, IDs shown.
5. **Save.** `put_page("ops/tasks.md", content=<complete edited canonical content>, expected_content_hash=<hash from Load>)` after any mutation. Diff-mindset: touch only the affected lines; preserve all other content, including sections this skill doesn't recognize. On `write_conflict`, re-read the page, re-identify the same user-requested action, reapply it to the new canonical content, remint an add ID if necessary, and retry. Stop after three total write attempts and report the conflict; never fall back to an unguarded put.

## Edge Cases

- **First run:** page missing → create from template before acting; `status: ok`, note "initialized".
- **Malformed page:** if `ops/tasks.md` exists but doesn't match the schema, do NOT rewrite it wholesale. Append/edit within it minimally, preserve unknown content verbatim, and flag the malformation in the reply.
- **Retry/duplicate add:** if an identical description already exists in active tasks, do not add a duplicate — report the existing task ID instead.
- **Dates:** ISO 8601 (`YYYY-MM-DD`) everywhere. Compute "today"/"next week" with code/clock, never guess.
- **Page identifier:** always `ops/tasks.md` (with extension) in tool calls; this is the single canonical location.
- **Concurrent mutation.** `put_page` replaces the whole page, so every task mutation must carry the exact `content_hash` returned by its read. A conflict means another writer won; re-read and reapply the intended action. Never retry the stale body or omit `expected_content_hash`. Avoid parallel task mutations because repeated conflicts add latency, but correctness no longer depends on a single-writer assumption.

## Output Format

### Persisted page format

Each task carries a stable ID so later actions can target it safely:

```markdown
# Tasks

## P0 — Urgent
- [ ] <!-- id: t-20260115-01 --> {task description} (due: {date})

## P1 — Today
- [ ] <!-- id: {task-id} --> {task description} (due: {date optional})

## P2 — This Week
- [ ] <!-- id: {task-id} --> {task description} (due: {date optional})

## P3 — Backlog
- [ ] <!-- id: {task-id} --> {task description}

## Deferred
- [ ] <!-- id: {task-id} --> {task description} (deferred until: {date}; reason: {reason})

## Completed
- [x] <!-- id: {task-id} --> {task description} (completed: {date})
```

### User-facing response

After a mutation: one concise line — action, task ID, priority/status, relevant date, saved-or-not. For review: active tasks grouped by priority. Keep replies compact; avoid tables on narrow chat surfaces.

## Anti-Patterns

Each with its corrective action:
- Adding a task without priority → default P3 and SAY the default was applied (never silent).
- Mutating on an ambiguous reference → stop, list candidates with IDs, ask.
- Completing without a completion date → always stamp `(completed: YYYY-MM-DD)`.
- Deferring without target date + reason → ask for both first.
- Removing without explicit confirmation → confirm first; offer complete/defer instead.
- Overwriting the page wholesale / dropping unknown sections → minimal diff edits only.
- Using undeclared tools or CLI verbs → `get_page`/`put_page`/`search`/`add_timeline_entry` only.
- Fabricating due dates, priorities, or reasons → never invent required fields; ask.
- Unbounded list growth → when Backlog exceeds ~20 items, prompt a weekly review.
- Storing tasks outside the brain page → everything lives in `ops/tasks.md` (searchable).
- Writing `ops/tasks.md` without `expected_content_hash`, or retrying a stale body after `write_conflict` → silent lost-update risk; always re-read, reapply and retry with the new hash.

## Design Rationale (failure modes this version closes)

- **Interface drift:** an earlier version declared `get_page`/`put_page` as tools but instructed CLI verbs in the body — models picked one at random. The declared tools are now the interface; CLI is relegated to a human-equivalent note.
- **Unmatchable tasks:** without task IDs, "complete the deploy task" against two similar tasks silently mutated the wrong one. Stable `t-YYYYMMDD-NN` IDs + fail-closed ambiguity handling fix this.
- **First-run crash:** assuming `ops/tasks.md` exists made a missing page undefined behavior. Create-from-template on first run fixes this.
- **Wholesale overwrite risk:** "write updated task list" invited full-page rewrites that drop concurrent edits. Minimal-diff mandate + preserve-unknown-content rule fix this.
