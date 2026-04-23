# Sprint 1.0 · Agent-Turn Identity Foundation

**Author:** scott.lee@rebellions.ai
**Date:** 2026-04-24
**Status:** Design — ready for implementation plan
**Supersedes portion of:** `2026-04-24-mbrain-sprint-1-loop-observability-design.md` (superseded)
**Blocks:** `2026-04-24-mbrain-sprint-1-1-loop-observability-design.md`

---

## 1. The problem this sprint exists to solve

mbrain has no first-class concept of "an agent turn." Today:

- `retrieval_traces` is task-scoped. `persistSelectedRouteTrace` in `src/core/services/retrieval-route-selector-service.ts:290` throws when `task_id` is absent. Agent queries that do not belong to a task thread are not traced at all.
- Write-path services (`promoteMemoryCandidateEntry`, `rejectMemoryCandidateEntry`, `supersedeMemoryCandidateEntry`, `recordCanonicalHandoff`) have no parameter that identifies the turn or session they were invoked from.
- There is therefore no data key that ties a read to the writes that followed from it.

Until that correlation exists, any "loop observability" feature (Sprint 1.1 and beyond) is a string-match approximation. This sprint adds the minimum structural concept — **agent turn** — and nothing else. Observability is deferred.

## 2. Goal

Make `retrieval_traces.id` the canonical identifier for an agent turn, and allow write-event rows to reference it.

After this sprint:

1. `selectRetrievalRoute({ persist_trace: true })` works with no `task_id` (produces a trace row with `task_id = NULL`).
2. `recordCanonicalHandoff`, `supersedeMemoryCandidateEntry`, `createMemoryCandidateContradictionEntry` all accept an optional `interaction_id` and persist it on the new event row.
3. Given a trace row, a SQL join recovers every write event that cited it.
4. No user-visible behavior changes. No audit. No reports. Pure infrastructure.

## 3. Non-goals

- **No `interaction_id` on `memory_candidate_entries`.** That table carries mutable state (FSM status transitions). A single `interaction_id` column cannot represent "captured in turn A, promoted in turn B, rejected in turn C." Turn attribution for `captured` / `advance` / `reject` transitions is deferred to a future `memory_candidate_status_events` table (Sprint 2 or later).
- **No audit logic.** Sprint 1.1 owns `audit_brain_loop`.
- **No trace field extensions.** No `derived_consulted`, no `write_outcome`, no `selected_intent` column. Sprint 1.1 owns those.
- **No CI typecheck change.** Track A (Sprint 0) owns that.
- **No CLI or MCP surface additions.** The new parameters are accepted at the service layer only. CLI exposure happens in Sprint 1.1 via the audit op.

## 4. Type widening — prerequisite to task-optional traces

### 4.1 Current definitions

```ts
// src/core/types.ts
export type TaskScope = 'work' | 'personal' | 'mixed';
export type ScopeGateScope = 'work' | 'personal' | 'mixed' | 'unknown';

export interface RetrievalTrace {
  id: string;
  task_id: string | null;
  scope: TaskScope;           // ← too narrow for task-less traces
  // ...
}
```

When `task_id` is null, there is no `task_threads.scope` to copy. The trace's `scope` must be widened.

### 4.2 Change

```ts
export interface RetrievalTrace {
  id: string;
  task_id: string | null;
  scope: ScopeGateScope;      // widened
  // ...
}
```

The `scope` column in SQL is already `TEXT NOT NULL` — no migration needed. Callers of `putRetrievalTrace` must supply a `ScopeGateScope` value. Existing callers (only `persistSelectedRouteTrace` today) are updated in §5.

### 4.3 Type-narrowing callers

Any downstream code that treats `RetrievalTrace.scope` as `TaskScope` will now be a type error. Expected sites:

- `buildTaskResumeCard` in `task-memory-service.ts` if it consumes trace.scope.
- Any audit or bench script that reads trace rows.

These sites must narrow or accept the wider type. No behavior change expected at runtime because existing rows still carry `work`/`personal`/`mixed` values.

## 5. Relaxing `persistSelectedRouteTrace`

### 5.1 Current behavior

```ts
// src/core/services/retrieval-route-selector-service.ts
async function persistSelectedRouteTrace(
  engine: BrainEngine,
  taskId: string,
  selected: RetrievalRouteSelectorResult,
): Promise<RetrievalTrace> {
  const thread = await engine.getTaskThread(taskId);
  if (!thread) {
    throw new Error(`Task thread not found: ${taskId}`);
  }
  return engine.putRetrievalTrace({
    id: crypto.randomUUID(),
    task_id: taskId,
    scope: thread.scope,
    // ...
  });
}
```

`selectRetrievalRoute` only calls this when `input.persist_trace && input.task_id` are both truthy. Task-less persistence is unreachable.

### 5.2 New behavior

```ts
async function persistSelectedRouteTrace(
  engine: BrainEngine,
  selected: RetrievalRouteSelectorResult,
  taskId?: string,
): Promise<RetrievalTrace> {
  const thread = taskId ? await engine.getTaskThread(taskId) : null;
  const scope: ScopeGateScope = thread?.scope
    ?? selected.scope_gate?.resolved_scope
    ?? 'unknown';

  return engine.putRetrievalTrace({
    id: crypto.randomUUID(),
    task_id: thread ? taskId! : null,
    scope,
    // ... other fields unchanged
  });
}
```

Caller update in `selectRetrievalRoute`:

```ts
if (!input.persist_trace) {
  return selected;
}
// task_id no longer required
return {
  ...selected,
  trace: await persistSelectedRouteTrace(engine, selected, input.task_id),
};
```

Edge cases:

- `persist_trace=true`, `task_id` provided but thread not found → do not throw. Fall through to the `scope_gate` resolution or `'unknown'`. The trace is still persisted with `task_id = null` (we do not persist a dangling FK value). A `verification` entry `"task_id_not_found:<id>"` records the event.
- `persist_trace=true`, no `task_id` → persist with `task_id = null`, scope from `scope_gate` or `'unknown'`.

## 6. `interaction_id` on immutable event rows

### 6.1 Tables that receive the column

Only tables where **each row represents one event and is created once** get `interaction_id`:

| Table | Rationale |
|---|---|
| `canonical_handoff_entries` | Created once per candidate when promotion is recorded. Immutable by design (UNIQUE on `candidate_id`). |
| `memory_candidate_supersession_entries` | Created once per supersession. Immutable. |
| `memory_candidate_contradiction_entries` | Created once per contradiction record. Immutable. |

### 6.2 Tables that do not

- `memory_candidate_entries` — mutable status row. Excluded by design (see §3).
- `retrieval_traces` — itself the source of the id; already has `id`.
- `task_threads`, `task_attempts`, `task_decisions`, `task_working_sets` — operational work state, orthogonal to this sprint.

### 6.3 Migration 21 — `interaction_id_on_event_rows`

Postgres / PGLite SQL:

```sql
ALTER TABLE canonical_handoff_entries
  ADD COLUMN interaction_id TEXT;
ALTER TABLE memory_candidate_supersession_entries
  ADD COLUMN interaction_id TEXT;
ALTER TABLE memory_candidate_contradiction_entries
  ADD COLUMN interaction_id TEXT;

CREATE INDEX IF NOT EXISTS idx_canonical_handoff_interaction
  ON canonical_handoff_entries(interaction_id)
  WHERE interaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supersession_interaction
  ON memory_candidate_supersession_entries(interaction_id)
  WHERE interaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contradiction_interaction
  ON memory_candidate_contradiction_entries(interaction_id)
  WHERE interaction_id IS NOT NULL;
```

SQLite (`sqlite-engine.ts`, migration ladder case 21): same `ALTER TABLE ADD COLUMN` (SQLite supports it), partial indexes drop the `WHERE` clause.

**No FK constraint.** `interaction_id` is a plain TEXT. Reasons:

- Loose coupling: if a trace is later deleted (retention, test cleanup), events referencing it remain valid.
- No engine surprise: SQLite partial FK semantics are awkward and we avoid the cost.
- The reference is still verifiable at audit time via join.

### 6.4 Type additions

```ts
// src/core/types.ts — add to each existing interface:
export interface CanonicalHandoffEntry {
  // existing fields...
  interaction_id: string | null;
}
export interface CanonicalHandoffEntryInput {
  // existing fields...
  interaction_id?: string | null;
}
// (repeat for supersession and contradiction)
```

Both `interaction_id` on the returned entry and `interaction_id?` on the input are optional additions. Existing callers compile unchanged (optional on input, nullable on read).

### 6.5 Engine method updates

Three engines update three insert methods (`createCanonicalHandoffEntry`, `supersedeMemoryCandidateEntry`, `createMemoryCandidateContradictionEntry`). Each reads `input.interaction_id ?? null` and writes it into the new column. SELECTs append the column to their SELECT list and pass it into the row mapper.

### 6.6 Service-layer updates

Three services extend their input types:

```ts
// canonical-handoff-service.ts
export interface RecordCanonicalHandoffInput {
  candidate_id: string;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;   // new
}

// memory-inbox-supersession-service.ts
export interface SupersedeMemoryCandidateEntryInput {
  superseded_candidate_id: string;
  replacement_candidate_id: string;
  review_reason?: string | null;
  interaction_id?: string | null;   // new
}

// memory-inbox-contradiction-service.ts
export interface CreateMemoryCandidateContradictionInput {
  // existing...
  interaction_id?: string | null;   // new
}
```

Each passes the field through to the engine input.

## 7. Scenario tests added in this sprint

### 7.1 S17 — task-less trace is persisted with unknown scope

```ts
test('S17 — selectRetrievalRoute without task_id persists a trace with unknown scope', async () => {
  // Call selectRetrievalRoute with intent='broad_synthesis', persist_trace=true,
  // no task_id.
  const result = await selectRetrievalRoute(engine, {
    intent: 'broad_synthesis',
    query: 'test',
    persist_trace: true,
  });
  expect(result.trace).toBeDefined();
  expect(result.trace!.task_id).toBeNull();
  expect(result.trace!.scope).toBe('unknown');   // or 'work' if scope_gate inferred
});
```

### 7.2 S18 — handoff carries interaction_id and is recoverable by it

```ts
test('S18 — canonical handoff with interaction_id is queryable via the trace id', async () => {
  // 1. Call selectRetrievalRoute to produce a trace; note trace.id.
  // 2. Seed a staged candidate with provenance.
  // 3. promoteMemoryCandidateEntry(...).
  // 4. recordCanonicalHandoff({ candidate_id, interaction_id: trace.id }).
  // 5. Query canonical_handoff_entries WHERE interaction_id = trace.id.
  // 6. Assert exactly one row and it is the expected handoff.
});
```

### 7.3 S19 — supersession carries interaction_id across engines

Mirrors S7's cross-engine pattern (SQLite, PGLite, Postgres) but asserts that an interaction-linked supersession entry survives the trigger check **and** retains the `interaction_id` on readback.

### 7.4 S20 — absent interaction_id is a valid state

```ts
test('S20 — handoff without interaction_id is accepted and readback returns null', async () => {
  // Record handoff without passing interaction_id. Row exists, row.interaction_id === null.
});
```

This guards against a future regression where the field is accidentally made required.

## 8. End-to-end flow after this sprint

```
[ agent request ]
      │
      ▼
  selectRetrievalRoute(input, persist_trace=true)
      │   (task_id optional)
      ▼
  retrieval_traces row created        ← trace.id = INTERACTION_ID
      │
      │  agent computes a response, then decides to write
      ▼
  promoteMemoryCandidateEntry(id)     (still no interaction_id; sprint 2 concern)
      │
      ▼
  recordCanonicalHandoff({
      candidate_id,
      interaction_id: INTERACTION_ID    ← NEW
  })
      │
      ▼
  canonical_handoff_entries row created with interaction_id populated
```

Sprint 1.1 will consume the two data points (`retrieval_traces.id` and `canonical_handoff_entries.interaction_id`) in its audit service.

## 9. Rollout — single PR, six commits

| # | Subject | Notes |
|---|---|---|
| 1 | `feat(types): widen RetrievalTrace.scope to ScopeGateScope` | types.ts only; expect downstream TS errors, fix inline |
| 2 | `feat(selector): persist traces without task_id` | selector service update + new test S17 |
| 3 | `feat(schema): migration 21 — interaction_id on event rows` | migrate.ts + sqlite-engine case 21 + schema tests (3 engines) |
| 4 | `feat(engine): insert/select interaction_id on event row methods` | three engines × three methods |
| 5 | `feat(services): accept optional interaction_id on write services` | canonical-handoff, supersession, contradiction |
| 6 | `test(scenarios): S18 S19 S20 interaction_id correlation tests` | |

Each commit is independently green; `bun test` passes after each.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Widening `RetrievalTrace.scope` produces many TS errors | Expected. Fixed inside commit 1. Errors unrelated to scope are not in this PR — file in Track A. |
| Migration 21 breaks an engine due to `ALTER ADD COLUMN` semantics on SQLite with existing data | Schema test mirrors `memory-inbox-schema.test.ts` pattern across three engines; seeded data is asserted to survive migration. |
| `persistSelectedRouteTrace` without task_id writes wrong scope | Test S17 asserts the derived scope explicitly; code falls back through scope_gate → 'unknown'. |
| A service caller forgets to thread `interaction_id` through | Harmless — it defaults to null. No correctness impact on the turn itself; only observability gap in Sprint 1.1 reports. |
| Future code adds `interaction_id` to `memory_candidate_entries` against policy | Non-technical guardrail: this spec's §3 documents the prohibition, Sprint 1.1 and later specs reference it. |

## 11. Done criteria

- [ ] Migration 21 applies cleanly on SQLite, PGLite, and Postgres (schema test passes on all three).
- [ ] `selectRetrievalRoute({ persist_trace: true })` succeeds with no `task_id` and writes a trace row with `task_id = NULL`.
- [ ] `recordCanonicalHandoff`, `supersedeMemoryCandidateEntry`, `createMemoryCandidateContradictionEntry` accept and persist `interaction_id`.
- [ ] S17, S18, S19, S20 green.
- [ ] `bun test` overall pass count unchanged or increased.
- [ ] `bunx tsc --noEmit` output strictly smaller or equal to the pre-PR count (we do not add new TS errors, though pre-existing ones may linger until Track A).
- [ ] Zero changes to `memory_candidate_entries` schema.

## 12. Rollback

Forward-only migration framework (see migrate.ts). Rollback path:

- Revert the PR's code commits. `retrieval_traces.task_id` callers treat null as valid after commit 2, so reverting the selector change does not require a data migration.
- Migration 21's added columns are nullable with no default non-null usage. Leaving them in place after revert is safe (forward-only — we do not drop them).

## 13. What this sprint deliberately does not resolve

- Capture / advance / reject events on `memory_candidate_entries` have no interaction link. Sprint 1.1's audit notes this with an `approximate_correlation` flag.
- No schema CHECK constraint on `interaction_id` format (it is free-form TEXT). If abuse becomes a concern, add validation at the engine insert later.
- No retention / TTL on `retrieval_traces`. Volume is expected to grow; Sprint 2+ can add a `mbrain prune-traces` operation.
