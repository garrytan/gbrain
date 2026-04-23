# Sprint 1.1 · Loop Observability on Interaction Identity

**Author:** scott.lee@rebellions.ai
**Date:** 2026-04-24
**Status:** Design — ready for implementation plan
**Depends on:** `2026-04-24-mbrain-sprint-1-0-interaction-identity-design.md` (must land first)
**Supersedes portion of:** `2026-04-24-mbrain-sprint-1-loop-observability-design.md` (superseded)

---

## 1. Context

Sprint 1.0 introduces `retrieval_traces.id` as the canonical agent-turn identifier and wires `interaction_id` into three immutable event tables (`canonical_handoff_entries`, `memory_candidate_supersession_entries`, `memory_candidate_contradiction_entries`). That sprint does not ship any user-visible change.

Sprint 1.1 builds on that foundation to deliver the original question mbrain must answer:

> **"Did the brain-agent loop actually run in the last 24 hours?"**

Answering requires two further ingredients:

1. The trace itself must carry more structured data — specifically a distinction between canonical reads and derived consultations, a durable write-outcome tag, and structured intent/scope-gate columns. Without these, audit metrics reduce to regex scraping (a flaw identified in the superseded spec).
2. An audit service that consumes traces plus the interaction-linked event rows and produces a report.

## 2. Goal

After Sprint 1.1 ships, `mbrain audit-brain-loop --since 24h --json` returns a report that answers, using SQL joins (not string parsing):

1. How many turns (traces) occurred in the window?
2. By intent, by scope, by scope_gate policy — what was the distribution?
3. For each turn, which canonical vs derived sources were consulted?
4. Of the turns, which produced a linked write event (handoff / supersession / contradiction)?
5. Which turns produced no durable write (read-only turns)?

Question 5 is answered **fully** for the three immutable event tables linked in Sprint 1.0. For capture / advance / reject transitions on `memory_candidate_entries`, the report provides an **approximate** count based on a same-window heuristic and clearly labels it as such.

## 3. Non-goals

- **No event log for `memory_candidate_entries` transitions.** Full correlation for captured / advance / rejected would require a new `memory_candidate_status_events` table (Sprint 2+).
- **No dashboard.** CLI + JSON output only.
- **No retention, TTL, or pruning.** Trace volume grows unbounded in this sprint. A future sprint adds `mbrain prune-traces`.
- **No scheduled cron.** Dream-cycle automation is Sprint 6+ work.
- **No CI changes.** Track A (Sprint 0) owns those.

## 4. Trace schema extension — migration 22

### 4.1 Columns added

Postgres / PGLite SQL:

```sql
ALTER TABLE retrieval_traces
  ADD COLUMN derived_consulted JSONB NOT NULL DEFAULT '[]';
ALTER TABLE retrieval_traces
  ADD COLUMN write_outcome TEXT NOT NULL DEFAULT 'no_durable_write'
  CHECK (write_outcome IN (
    'no_durable_write',
    'operational_write',
    'candidate_created',
    'promoted',
    'rejected',
    'superseded'
  ));
ALTER TABLE retrieval_traces
  ADD COLUMN selected_intent TEXT NOT NULL DEFAULT 'task_resume'
  CHECK (selected_intent IN (
    'task_resume',
    'broad_synthesis',
    'precision_lookup',
    'mixed_scope_bridge',
    'personal_profile_lookup',
    'personal_episode_lookup'
  ));
ALTER TABLE retrieval_traces
  ADD COLUMN scope_gate_policy TEXT NULL
  CHECK (scope_gate_policy IS NULL OR scope_gate_policy IN ('allow', 'deny', 'defer'));
ALTER TABLE retrieval_traces
  ADD COLUMN scope_gate_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_retrieval_traces_write_outcome
  ON retrieval_traces(write_outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_selected_intent
  ON retrieval_traces(selected_intent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_gate_policy
  ON retrieval_traces(scope_gate_policy, created_at DESC)
  WHERE scope_gate_policy IS NOT NULL;
```

Notes on defaults:

- `derived_consulted` defaults to `[]` so existing rows (from before migration 22) are valid.
- `write_outcome` defaults to `'no_durable_write'` because older trace rows were never paired with a write.
- `selected_intent` defaults to `'task_resume'` for historical rows only because all pre-existing traces had a task_id (Sprint 1.0 hadn't shipped yet). If this is wrong for any specific environment it is corrected by the selector on the next trace write; no data migration required.
- `scope_gate_policy` and `scope_gate_reason` default to NULL because old rows did not record them explicitly.

SQLite (`sqlite-engine.ts` migration case 22): same `ALTER TABLE ADD COLUMN` statements. SQLite does not support adding a CHECK constraint via ALTER, so the engine-level `putRetrievalTrace` validates the three enum values against constant arrays and throws `RetrievalTraceError('invalid_<field>', …)` on violation.

### 4.2 Type additions

```ts
// src/core/types.ts
export type RetrievalTraceWriteOutcome =
  | 'no_durable_write'
  | 'operational_write'
  | 'candidate_created'
  | 'promoted'
  | 'rejected'
  | 'superseded';

export type ScopeGatePolicy = 'allow' | 'deny' | 'defer';

export interface RetrievalTrace {
  // existing:
  id: string;
  task_id: string | null;
  scope: ScopeGateScope;
  route: string[];
  source_refs: string[];
  verification: string[];
  outcome: string;
  created_at: Date;

  // new in migration 22:
  derived_consulted: string[];
  write_outcome: RetrievalTraceWriteOutcome;
  selected_intent: RetrievalRouteIntent;
  scope_gate_policy: ScopeGatePolicy | null;
  scope_gate_reason: string | null;
}

export interface RetrievalTraceInput {
  // existing + new with sensible defaults:
  derived_consulted?: string[];
  write_outcome?: RetrievalTraceWriteOutcome;
  selected_intent?: RetrievalRouteIntent;
  scope_gate_policy?: ScopeGatePolicy | null;
  scope_gate_reason?: string | null;
}
```

All new input fields optional. Existing callers compile unchanged.

## 5. Selector populate rules

### 5.1 `derived_consulted`

```ts
// src/core/services/retrieval-route-selector-service.ts
function collectDerivedConsulted(
  selection: RetrievalRouteSelection | null,
): string[] {
  if (!selection) return [];
  const payload = selection.payload;
  switch (selection.route_kind) {
    case 'broad_synthesis': {
      const p = payload as BroadSynthesisRoute;
      return [p.map_id, ...(p.recommended_reads ?? []).map(r => r.map_id).filter(Boolean)];
    }
    case 'mixed_scope_bridge': {
      const p = payload as MixedScopeBridgeRoute;
      return collectDerivedConsultedFromBroad(p.work_route);
    }
    case 'task_resume':
    case 'precision_lookup':
    case 'personal_profile_lookup':
    case 'personal_episode_lookup':
      return [];
  }
}

function collectDerivedConsultedFromBroad(broad: BroadSynthesisRoute | null): string[] {
  if (!broad) return [];
  return [broad.map_id];
}
```

The previous spec sketch incorrectly read `route.payload.map_id` — corrected here to match the actual type. `RetrievalRouteSelection.payload` is typed `unknown`, so the narrowing cast to the specific route type is explicit and documented.

### 5.2 `write_outcome`, `selected_intent`, `scope_gate_policy`, `scope_gate_reason`

```ts
return engine.putRetrievalTrace({
  id: crypto.randomUUID(),
  task_id: thread ? taskId! : null,
  scope,
  route: selected.route?.retrieval_route ?? [],
  source_refs: collectSourceRefs(selected.route),
  derived_consulted: collectDerivedConsulted(selected.route),
  verification: [
    `intent:${selected.selected_intent}`,
    `selection_reason:${selected.selection_reason}`,
    ...buildScopeGateVerification(selected.scope_gate),
  ],
  outcome: selected.route
    ? `${selected.selected_intent} route selected`
    : `${selected.selected_intent} route unavailable`,
  selected_intent: selected.selected_intent,
  scope_gate_policy: selected.scope_gate?.policy ?? null,
  scope_gate_reason: selected.scope_gate?.decision_reason ?? null,
  write_outcome: 'no_durable_write',  // selector is read-only
});
```

The free-form `verification` array and `outcome` string are retained for backwards compatibility; they are no longer the primary aggregation source.

### 5.3 `write_outcome` set by write services

Write services that produce their own trace row (e.g., when a promotion is the *result* of an agent turn) stamp the appropriate `write_outcome`. This sprint does not add such traces — the selector remains the only writer of trace rows. Future sprints may add writer-triggered traces.

## 6. Audit service

### 6.1 Location and shape

```ts
// src/core/services/brain-loop-audit-service.ts
export interface AuditBrainLoopInput {
  since?: Date | string;       // default: now - 24h
  until?: Date | string;       // default: now
  task_id?: string;
  scope?: ScopeGateScope;
  limit?: number;              // backlog cap; default 50, max 500
}

export interface AuditBrainLoopReport {
  window: { since: string; until: string };
  total_traces: number;
  by_selected_intent: Partial<Record<RetrievalRouteIntent, number>>;
  by_scope: Partial<Record<ScopeGateScope, number>>;
  by_scope_gate_policy: Partial<Record<ScopeGatePolicy, number>>;
  most_common_defer_reason: string | null;
  canonical_vs_derived: {
    canonical_ref_count: number;
    derived_ref_count: number;
    canonical_ratio: number;
  };
  linked_writes: {
    handoff_count: number;
    supersession_count: number;
    contradiction_count: number;
    traces_with_any_linked_write: number;
    traces_without_linked_write: number;
  };
  approximate: {
    // Correlation not yet implemented for these; same-window heuristic only.
    candidate_creation_same_window: number;
    candidate_rejection_same_window: number;
    note: string;   // e.g., "approximate; precise correlation requires memory_candidate_status_events"
  };
  task_compliance: {
    tasks_with_traces: number;
    tasks_without_traces: number;
    task_scan_capped_at: number | null;
    top_backlog: Array<{
      task_id: string;
      last_trace_at: string;
      last_route_kind: string | null;
    }>;
  };
  summary_lines: string[];
}
```

### 6.2 Logic

```ts
export async function auditBrainLoop(
  engine: BrainEngine,
  input: AuditBrainLoopInput = {},
): Promise<AuditBrainLoopReport> {
  const since = normalizeSince(input.since);
  const until = normalizeUntil(input.until);
  const limit = clamp(input.limit ?? 50, 1, 500);

  const traces = await listAllRetrievalTracesInWindow(engine, since, until, input);
  const traceIds = traces.map(t => t.id);

  // Structured aggregations — pure SQL on the new columns.
  const byIntent = groupBy(traces, t => t.selected_intent);
  const byScope = groupBy(traces, t => t.scope);
  const byGate = groupBy(traces, t =>
    t.scope_gate_policy ?? null).filter(k => k !== null);
  const mostCommonDefer = findMostCommon(
    traces.filter(t => t.scope_gate_policy === 'defer'),
    t => t.scope_gate_reason,
  );

  // Canonical vs derived directly from columns, no parsing.
  const canonicalCount = sum(traces, t => t.source_refs.length);
  const derivedCount = sum(traces, t => t.derived_consulted.length);

  // Linked writes — join on interaction_id.
  const linked = await countLinkedWrites(engine, traceIds);

  // Same-window heuristic for unlinked events.
  const approximate = await approximateUnlinkedCandidateEvents(engine, since, until);

  // Task compliance with pagination.
  const { tasksWithTraces, tasksWithoutTraces, cappedAt } =
    await computeTaskCompliance(engine, traces);

  return buildReport({
    window: { since, until },
    traces,
    linked,
    approximate,
    byIntent, byScope, byGate, mostCommonDefer,
    canonicalCount, derivedCount,
    tasksWithTraces, tasksWithoutTraces, cappedAt,
    limit,
  });
}
```

### 6.3 Linked writes — the join this sprint makes possible

```ts
async function countLinkedWrites(
  engine: BrainEngine,
  traceIds: string[],
): Promise<LinkedWriteCounts> {
  if (traceIds.length === 0) return zeroed();

  const handoff = await engine.listCanonicalHandoffEntriesByInteractionIds(traceIds);
  const supersession = await engine.listMemoryCandidateSupersessionEntriesByInteractionIds(traceIds);
  const contradiction = await engine.listMemoryCandidateContradictionEntriesByInteractionIds(traceIds);

  const linkedTraceIds = new Set<string>();
  for (const row of handoff) linkedTraceIds.add(row.interaction_id!);
  for (const row of supersession) linkedTraceIds.add(row.interaction_id!);
  for (const row of contradiction) linkedTraceIds.add(row.interaction_id!);

  return {
    handoff_count: handoff.length,
    supersession_count: supersession.length,
    contradiction_count: contradiction.length,
    traces_with_any_linked_write: linkedTraceIds.size,
    traces_without_linked_write: traceIds.length - linkedTraceIds.size,
  };
}
```

Three new engine methods (`listCanonicalHandoffEntriesByInteractionIds` + two peers) are added. Each takes an ID array and returns matching rows. Implementations are straightforward `WHERE interaction_id = ANY(...)` on Postgres/PGLite, parameterized IN clause on SQLite.

### 6.4 Task compliance with pagination (Finding 6 fix)

`TaskThreadFilters` gains an `offset` field. `computeTaskCompliance` paginates through in batches of 500 up to a cap of 5000 rows. If more tasks exist, the report's `task_scan_capped_at` is set to the cap. Test S21 asserts this behavior explicitly.

### 6.5 Approximate correlation for unlinked candidate events

```ts
async function approximateUnlinkedCandidateEvents(
  engine: BrainEngine,
  since: Date,
  until: Date,
): Promise<ApproximateCounts> {
  const candidates = await engine.listMemoryCandidateEntries({ /* window filter */ });
  const createdInWindow = candidates.filter(c =>
    c.created_at >= since && c.created_at < until).length;
  const rejectedInWindow = candidates.filter(c =>
    c.status === 'rejected' && c.reviewed_at && c.reviewed_at >= since && c.reviewed_at < until).length;
  return {
    candidate_creation_same_window: createdInWindow,
    candidate_rejection_same_window: rejectedInWindow,
    note: 'approximate; precise correlation requires memory_candidate_status_events (not shipped in Sprint 1.1)',
  };
}
```

The `note` string is intentional: readers are told this number is not correlated.

## 7. Operation and CLI

Extraction pattern matches `operations-memory-inbox.ts`:

```ts
// src/core/operations-brain-loop-audit.ts
export function createBrainLoopAuditOperations(deps: {
  OperationError: OperationErrorCtor;
}): Operation[] {
  const audit_brain_loop: Operation = {
    name: 'audit_brain_loop',
    description: 'Audit whether the brain-agent loop executed in a window.',
    params: {
      since: { type: 'string', description: 'ISO timestamp or relative (24h, 7d). Default: now-24h.' },
      until: { type: 'string', description: 'Default: now.' },
      task_id: { type: 'string' },
      scope: { type: 'string', enum: ['work', 'personal', 'mixed', 'unknown'] },
      limit: { type: 'number', description: 'Backlog cap (default 50, max 500).' },
    },
    handler: async (ctx, p) => auditBrainLoop(ctx.engine, /* coerced params */),
    cliHints: { name: 'audit-brain-loop', aliases: { n: 'limit' } },
  };
  return [audit_brain_loop];
}
```

`operations.ts` receives two lines: `import { createBrainLoopAuditOperations } from './operations-brain-loop-audit.ts';` and a spread into the operation registry.

CLI:

```
mbrain audit-brain-loop --since 24h --json
mbrain audit-brain-loop --task-id task-S3
mbrain audit-brain-loop --scope personal --since 7d
mbrain audit-brain-loop --limit 100
```

Default (no `--json`) is a text block built from `summary_lines` plus aligned count columns. `--json` emits the full `AuditBrainLoopReport` as pretty JSON.

## 8. Scenario tests added in this sprint

### 8.1 S14 — flip from `test.todo` to real test

The scenario spec already has a placeholder:

```ts
// test/scenarios/s14-retrieval-trace-fidelity.test.ts
test.todo('S14 gap — retrieval_traces needs a derived_consulted field ...');
```

Replace with a real test exercising the new column.

### 8.2 S22 — audit correlates trace with linked handoff

```ts
test('S22 — audit links a trace to a canonical handoff via interaction_id', async () => {
  // 1. selectRetrievalRoute(..., persist_trace: true) → trace
  // 2. seed + promote + recordCanonicalHandoff({ interaction_id: trace.id })
  // 3. auditBrainLoop({ since: 1h ago })
  // 4. expect report.linked_writes.handoff_count === 1
  //    and report.linked_writes.traces_with_any_linked_write === 1
});
```

### 8.3 S23 — audit reports structured intent/scope distributions without parsing

Three seed traces with varied intents and scopes → audit report's `by_selected_intent` / `by_scope` / `by_scope_gate_policy` match exactly.

### 8.4 S24 — approximate-correlation note is present and labeled

```ts
test('S24 — audit labels unlinked candidate events as approximate', async () => {
  // Seed candidates created directly on engine (no retrieval trace).
  // Run audit.
  // expect report.approximate.note to contain "approximate"
  // expect report.approximate.candidate_creation_same_window === 1
  // expect report.linked_writes.traces_with_any_linked_write === 0
});
```

### 8.5 S21 — task scan is capped and reports `task_scan_capped_at`

Seed 5001 task threads → audit → `task_scan_capped_at === 5000`.

### 8.6 S25 — empty window returns zeroed report

Empty brain → all counts zero, `summary_lines` non-empty and includes substrings `"no"` and `"activity"`.

## 9. Rollout — single PR, six commits

| # | Subject | Notes |
|---|---|---|
| 1 | `feat(schema): migration 22 — retrieval_trace fidelity columns` | migrate.ts + SQLite case 22 + cross-engine schema test |
| 2 | `feat(types): add trace fidelity + scope_gate typing` | types.ts additions |
| 3 | `feat(selector): populate derived_consulted + structured trace fields` | selector change + S14 flipped to real test |
| 4 | `feat(engine): add listByInteractionIds methods on event tables` | three engines × three new methods |
| 5 | `feat(services+ops): brain-loop audit service + operation + CLI` | new service + op file + operations.ts registration + pagination fix on TaskThreadFilters |
| 6 | `test(scenarios): S21–S25 audit coverage` | |

Each commit independently green. Bisect-friendly.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Migration 22 conflicts with a fresh Sprint 1.0 install (migration 21) not yet applied | This spec explicitly depends on Sprint 1.0 landing first (§header). Release notes call this out. |
| `CHECK` constraint on SQLite cannot be added via ALTER | Engine-level runtime validation in `putRetrievalTrace` (explicit check against enum arrays). S14 asserts the runtime guard rejects an invalid value. |
| `listByInteractionIds` query explodes for large trace windows | Called with <=10k trace IDs in practice; batched into chunks of 1000 in the engine method if needed. |
| `approximate.note` becomes stale wording | Kept short and generic; full story lives in `docs/superpowers/specs/` and can be cited from there. |
| Pagination cap of 5000 tasks hides real data | `task_scan_capped_at` is surfaced in the report so the caller sees it. Production use raises the cap explicitly. |

## 11. Done criteria

- [ ] Migration 22 applies on SQLite, PGLite, Postgres.
- [ ] `bun run test:scenarios` — S14 real test green, S21–S25 green.
- [ ] `mbrain audit-brain-loop --since 1h --json` returns a valid `AuditBrainLoopReport`.
- [ ] Audit counts for intent / scope / gate are computed from columns, not from `verification` strings (verified by code review).
- [ ] `report.linked_writes.handoff_count` is nonzero when a trace-linked handoff exists in the window.
- [ ] `report.approximate.note` explicitly labels unlinked candidate events as approximate.
- [ ] `bun test` overall pass count unchanged or increased.
- [ ] No mutation to `memory_candidate_entries` schema or services (policy boundary from Sprint 1.0 preserved).

## 12. Rollback

Forward-only. If the PR is reverted:

- Migration 22 columns remain in the DB with default values (`derived_consulted = []`, `write_outcome = 'no_durable_write'`, etc.). Harmless.
- `audit_brain_loop` operation disappears with the code revert.
- Sprint 1.0's `interaction_id` infrastructure continues to function (it is upstream).

## 13. What this sprint deliberately does not resolve

- **Full correlation for `memory_candidate_entries` transitions** — capture / advance / reject are reported as approximate. Fix path: Sprint 2 adds `memory_candidate_status_events` table.
- **Trace retention / pruning** — traces grow unbounded. Fix path: `mbrain prune-traces` operation in a later sprint.
- **Structured `verification` array** — still free-form strings. Sprint 1.1 does not need to parse it because the three new column fields cover the documented metrics. Future sprints may structure specific verification categories (e.g., code claim checks in L4 / Sprint 3).
- **Dashboard / UI** — CLI + JSON only.
- **Cron automation for audit** — out of scope.
