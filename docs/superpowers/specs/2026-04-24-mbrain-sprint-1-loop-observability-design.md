# Sprint 1 · Loop Observability Design

**Author:** scott.lee@rebellions.ai (via brainstorming session)
**Date:** 2026-04-24
**Status:** Design approved — ready for implementation plan

---

## 1. Context and motivation

mbrain is built on a premise: the brain-agent loop (signal → scope → route → canonical read → verify → respond → write → trace) runs on every meaningful interaction. Today we cannot measure whether it actually does. The invariants live in `MBRAIN_AGENT_RULES.md` (docs) and the Stop hook (session-end nag). Neither produces data.

Every other improvement on the roadmap (curated-over-map ranking, mixed-intent classifier, code claim verification, dream-cycle automation) presumes the loop is running. If it is not, those features deliver nothing. Sprint 1 therefore closes the observability gap first.

The sprint targets three tightly coupled changes, bundled into a single PR because each enables the next and together they form the minimum unit of useful observability.

| # | Change | Invariant closed |
|---|---|---|
| 1 | Extend `retrieval_traces` to distinguish canonical vs derived reads and record write outcome | L6 (trace fidelity) |
| 2 | Add `audit_brain_loop` operation that reports compliance metrics from traces | C (loop measurement) |
| 3 | Add `bunx tsc --noEmit` to CI | D (typecheck gap) |

---

## 2. Goals

### 2.1 Primary goal

After Sprint 1 ships, the following question can be answered with data: *"Did the brain-agent loop actually run in the last 24 hours?"*

### 2.2 Explicit success criteria

The sprint is done when we can answer each of these questions from a single CLI invocation (`mbrain audit-brain-loop --since 24h --json`):

1. How many responses in the window consulted the brain before answering? (count)
2. How many read-only sessions ended without a follow-up write? (read-without-write backlog)
3. What ratio of retrieval reads were canonical vs derived? (L2 precondition)
4. Which `scope_gate` reasons dominated `defer`? (gate health)
5. Did all of the above flow through a codebase that typechecks under strict mode? (CI tsc passes)

### 2.3 Non-goals

- **No browser dashboard.** CLI + JSON output only.
- **No backfill.** Existing `retrieval_traces` rows retain default values; new traces populate the new fields.
- **No Sprint 2–4 work.** L1 intent classifier, L2 ranking, L4 code claim verification are explicitly deferred.
- **No single "compliance %" metric.** Raw counts + ratios only; policy and grades can layer on later.

### 2.4 Out-of-sprint but enabled

- Sprint 2 (L2 ranking) reads `derived_consulted` to know when canonical vs map disagreed.
- Sprint 3 (L4 verification) writes into the trace's `verification` array in a structured way.
- Future "brain health" dashboard consumes the audit report directly.

---

## 3. Component 1 — `retrieval_traces` fidelity (invariant L6)

### 3.1 Problem with current schema

```sql
CREATE TABLE retrieval_traces (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
  scope TEXT NOT NULL,
  route JSONB NOT NULL DEFAULT '[]',
  source_refs JSONB NOT NULL DEFAULT '[]',
  verification JSONB NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Three contract failures:

- `source_refs` conflates canonical citations with derived references (map nodes, atlas entries).
- `verification` accepts any free-form strings. Not structurally a problem for L6 directly, but means we cannot count outcomes.
- `outcome` is a free-form string. Cannot be aggregated without regex scraping.

L6 requires traces to distinguish "what canonical artifact was read", "what derived artifact was consulted for orientation", and "whether the interaction produced a durable write".

### 3.2 Migration 21 — `retrieval_trace_fidelity`

Postgres / PGLite SQL:

```sql
ALTER TABLE retrieval_traces
  ADD COLUMN derived_consulted JSONB NOT NULL DEFAULT '[]';
ALTER TABLE retrieval_traces
  ADD COLUMN write_outcome TEXT NOT NULL DEFAULT 'no_durable_write'
  CHECK (write_outcome IN ('no_durable_write', 'operational_write',
                           'candidate_created', 'promoted', 'rejected',
                           'superseded'));
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_write_outcome
  ON retrieval_traces(write_outcome, created_at DESC);
```

SQLite mirror (in `sqlite-engine.ts` migration ladder, version 21):

```ts
case 21: {
  this.database.exec(`
    ALTER TABLE retrieval_traces
      ADD COLUMN derived_consulted TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE retrieval_traces
      ADD COLUMN write_outcome TEXT NOT NULL DEFAULT 'no_durable_write';
  `);
  this.ensureRetrievalTraceIndexes();
  break;
}
```

SQLite cannot add a CHECK constraint via ALTER. The SQLite implementation of `putRetrievalTrace` asserts the value against `RETRIEVAL_TRACE_WRITE_OUTCOME_VALUES` at runtime and throws `RetrievalTraceError('invalid_write_outcome', …)` if the caller passes an unknown value. This mirrors how the memory-inbox enum validation currently works in operations before the DB CHECK was added.

### 3.3 Type changes

```ts
// src/core/types.ts
export type RetrievalTraceWriteOutcome =
  | 'no_durable_write'
  | 'operational_write'
  | 'candidate_created'
  | 'promoted'
  | 'rejected'
  | 'superseded';

export interface RetrievalTrace {
  id: string;
  task_id: string | null;
  scope: string;
  route: string[];
  source_refs: string[];
  derived_consulted: string[];                 // new
  verification: string[];
  outcome: string;
  write_outcome: RetrievalTraceWriteOutcome;   // new
  created_at: Date;
}

export interface RetrievalTraceInput {
  id: string;
  task_id: string | null;
  scope: string;
  route: string[];
  source_refs: string[];
  derived_consulted?: string[];                // optional; default []
  verification: string[];
  outcome: string;
  write_outcome?: RetrievalTraceWriteOutcome;  // optional; default 'no_durable_write'
}
```

Existing callers of `putRetrievalTrace` continue to compile because both new fields are optional on input.

### 3.4 Engine interface additions

```ts
// src/core/engine.ts
interface BrainEngine {
  // existing:
  putRetrievalTrace(input: RetrievalTraceInput): Promise<RetrievalTrace>;
  listRetrievalTraces(taskId: string, opts?: { limit?: number }): Promise<RetrievalTrace[]>;

  // new:
  listRetrievalTracesByWindow(filters: {
    since: Date;
    until: Date;
    task_id?: string;
    scope?: string;
    limit: number;
    offset: number;
  }): Promise<RetrievalTrace[]>;
}
```

Three engines implement `listRetrievalTracesByWindow` with their native SQL dialect. Postgres uses the new index; SQLite falls back to `created_at` range scan, which is acceptable until trace volume grows.

### 3.5 Selector populate rule

`src/core/services/retrieval-route-selector-service.ts: persistSelectedRouteTrace` is modified to populate both new fields:

```ts
function collectDerivedConsulted(route: RetrievalRouteSelection | null): string[] {
  if (!route) return [];
  const p = route.payload as any;
  switch (route.route_kind) {
    case 'broad_synthesis':
      return [p.map_id, ...(p.atlas_ids ?? [])].filter(Boolean);
    case 'mixed_scope_bridge':
      return collectDerivedConsulted(p.work_route);
    case 'task_resume':
    case 'precision_lookup':
    case 'personal_profile_lookup':
    case 'personal_episode_lookup':
      return [];
  }
}
```

`write_outcome` defaults to `'no_durable_write'` at the selector — it is a read path. The other values are stamped by the writer (promotion, rejection, supersession services) when they produce their own trace rows.

### 3.6 Scenario S14 flip

`test/scenarios/s14-retrieval-trace-fidelity.test.ts` currently has a `test.todo` noting the derived_consulted gap. Sprint 1 replaces it with a real test:

```ts
test('S14 — broad_synthesis trace separates canonical and derived sources', async () => {
  // Seed: 1 curated note + 1 context map built via buildStructuralContextMapEntry.
  // Call selectRetrievalRoute with intent='broad_synthesis', persist_trace=true.
  // Read the persisted trace.
  expect(trace.derived_consulted.length).toBeGreaterThan(0);   // map_id populated
  expect(trace.source_refs).not.toContain(trace.derived_consulted[0]);  // not double-counted
  expect(trace.write_outcome).toBe('no_durable_write');
});
```

---

## 4. Component 2 — `audit_brain_loop` operation (invariant C)

### 4.1 Input / output types

```ts
// src/core/types.ts
export interface AuditBrainLoopInput {
  since?: Date | string;
  until?: Date | string;
  task_id?: string;
  scope?: 'work' | 'personal' | 'mixed' | 'unknown';
  limit?: number;
}

export interface AuditBrainLoopReport {
  window: { since: string; until: string };
  total_traces: number;
  by_route_kind: Partial<Record<RetrievalRouteIntent | 'null_route', number>>;
  by_write_outcome: Partial<Record<RetrievalTraceWriteOutcome, number>>;
  by_scope: Partial<Record<'work' | 'personal' | 'mixed' | 'unknown', number>>;
  canonical_vs_derived: {
    canonical_ref_count: number;
    derived_ref_count: number;
    canonical_ratio: number;
  };
  task_compliance: {
    tasks_with_traces: number;
    tasks_without_traces: number;
    top_backlog: Array<{
      task_id: string;
      last_trace_at: string;
      last_route_kind: string | null;
    }>;
  };
  health_signals: {
    null_route_rate: number;
    scope_defer_rate: number;
    most_common_defer_reason: string | null;
  };
  summary_lines: string[];
}
```

### 4.2 Service — `brain-loop-audit-service.ts`

Pure function, engine is the only dependency.

```ts
export async function auditBrainLoop(
  engine: BrainEngine,
  input: AuditBrainLoopInput = {},
): Promise<AuditBrainLoopReport> {
  const since = normalizeSince(input.since);   // default: now - 24h
  const until = normalizeUntil(input.until);   // default: now
  const limit = clamp(input.limit ?? 50, 1, 500);

  const traces = await listAllRetrievalTracesInWindow(engine, since, until, input);
  const allTasks = await engine.listTaskThreads({ limit: 1000 });

  return buildReport(traces, allTasks, since, until, limit);
}
```

Helpers:
- `listAllRetrievalTracesInWindow` paginates in batches of 500 through `listRetrievalTracesByWindow`.
- `buildReport` is pure — deterministic given input. Testable without an engine.
- `summary_lines` is human-readable, ≤5 lines, each citing the specific metric that warrants attention (e.g., `"canonical_ratio=0.42 — below L2 threshold; consider enabling ranking"`).

### 4.3 Operation — `operations-brain-loop-audit.ts`

Follows the extraction pattern from `operations-memory-inbox.ts` (keeps `operations.ts` from growing further).

```ts
export function createBrainLoopAuditOperations(deps: {
  OperationError: OperationErrorCtor;
}): Operation[] {
  const audit_brain_loop: Operation = {
    name: 'audit_brain_loop',
    description: 'Audit whether the brain-agent loop executed in a window.',
    params: {
      since: { type: 'string',
               description: 'ISO timestamp or relative (24h, 7d). Default 24h.' },
      until: { type: 'string', description: 'Default: now.' },
      task_id: { type: 'string' },
      scope: { type: 'string', enum: ['work', 'personal', 'mixed', 'unknown'] },
      limit: { type: 'number', description: 'Backlog cap (default 50, max 500).' },
    },
    handler: async (ctx, p) => auditBrainLoop(ctx.engine, {
      since: typeof p.since === 'string' ? p.since : undefined,
      until: typeof p.until === 'string' ? p.until : undefined,
      task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
      scope: typeof p.scope === 'string' ? (p.scope as any) : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    }),
    cliHints: { name: 'audit-brain-loop', aliases: { n: 'limit' } },
  };

  return [audit_brain_loop];
}
```

`operations.ts` gets two lines: an import and a spread into the registry.

### 4.4 Scenario S15

`test/scenarios/s15-brain-loop-audit.test.ts`:

1. **counts traces by route_kind and write_outcome across a window** — seed 3 tasks, run `selectRetrievalRoute(persist_trace=true)` on 2, skip 1. Assert counts.
2. **window filter excludes older traces** — insert a trace with `created_at` = 48h ago directly via engine. `audit({ since: 24h ago })` returns 0.
3. **canonical_vs_derived ratio reflects derived_consulted** — seed a context map + curated note. `broad_synthesis` trace → `canonical_ratio < 1`.
4. **empty window returns zeroed report** — empty brain → `total_traces=0`, all group maps `{}`, `summary_lines` non-empty and includes a string indicating no activity (exact phrasing decided in implementation; test asserts substring `"no"` and `"activity"` both present rather than exact match).

### 4.5 CLI contract

```
mbrain audit-brain-loop --since 24h --json
mbrain audit-brain-loop --task-id task-S3
mbrain audit-brain-loop --scope personal --since 7d
mbrain audit-brain-loop --limit 100
```

Output without `--json` is a text report built from `summary_lines` plus the group counts in aligned columns. With `--json`, the full `AuditBrainLoopReport` as pretty JSON.

---

## 5. Component 3 — CI typecheck (invariant D)

### 5.1 Workflow change

`.github/workflows/test.yml`:

```yaml
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@...
      - uses: oven-sh/setup-bun@...
        with:
          bun-version: latest
      - run: bun install
      - run: bunx tsc --noEmit --pretty false   # NEW — runs before tests
      - run: bun test
```

### 5.2 Baseline cleanup

Before adding the CI step, run `bunx tsc --noEmit` locally and fix every existing error. Known candidates:

- Remaining `as any` casts in `operations.ts` on handler parameter coercion
- Non-exhaustive switches (verify all `MemoryCandidateStatus`, `RetrievalRouteIntent`, `ScopeGateScope` consumers)
- Record-key omissions if any patches landed since the memory-inbox-status `assertNever` fix

Baseline cleanup is committed separately (`chore: clean tsc baseline`) so the CI-add commit is trivial.

### 5.3 What we gain

- Reviews no longer need to manually flag `as any`, non-exhaustive switches, or missing Record keys.
- New contributors see the failure immediately on PR open instead of during review.
- Sprint 2 onward can lean on type narrowing when adding fields (e.g., `AuditBrainLoopReport` extension) knowing TS will catch mismatches.

### 5.4 Risks

| Risk | Mitigation |
|---|---|
| Baseline cleanup surfaces more errors than expected | Commit 1 is self-contained; can be held back if large |
| External library type changes break CI later | `skipLibCheck: true` already set in `tsconfig.json` |
| Bun's TS bundler vs `tsc` disagreement on something esoteric | We ship the same `tsc` config Bun uses internally; unlikely but documented |

---

## 6. End-to-end data flow

A single qualified interaction under Sprint 1:

```
[ agent request ]
      │
      ▼
  selectRetrievalRoute(input, persist_trace=true)
      │  1. scope_gate.evaluate → allow / deny / defer
      │  2. route dispatch → route_kind-specific service
      │  3. canonical sources → source_refs
      │  4. derived artifacts → derived_consulted           (NEW)
      │  5. verification = [intent:*, selection_reason:*, scope_gate:*]
      │  6. write_outcome = 'no_durable_write'              (NEW)
      │
      ▼
  engine.putRetrievalTrace(...)    — migration 21 accepts new columns
      │
      ▼
  retrieval_traces row persisted with all 8 fields

... if a write follows (promotion / rejection / supersession) ...
  additional trace row with write_outcome ∈ { promoted, rejected, superseded }

... on demand ...
  audit_brain_loop({ since: 24h })
      │
      ▼  window scan → group → compute ratios → summary
  AuditBrainLoopReport (JSON or text)
```

---

## 7. Rollout and commit plan

One PR, seven commits, each independently green:

| # | Subject | Scope |
|---|---|---|
| 1 | `chore: clean tsc baseline` | Fix every existing `tsc --noEmit` error. No behavior change. |
| 2 | `ci: add bunx tsc --noEmit to test workflow` | Workflow file; one line added |
| 3 | `feat: extend retrieval_traces with derived_consulted + write_outcome` | Migration 21 (3 engines), type additions, engine methods |
| 4 | `feat: populate derived_consulted from broad-synthesis routes` | Selector update; S14 flipped to real test |
| 5 | `feat: add brain-loop audit service + operation` | `brain-loop-audit-service.ts`, `operations-brain-loop-audit.ts`, operations registration |
| 6 | `test: add scenario S15 for brain-loop audit` | Four tests |
| 7 | `docs: update scenario README and architecture guide` | Move S14 to green, add S15 row, update S/R table |

`bun test` passes after each commit. `tsc --noEmit` passes after each commit from #1 onward. Bisect is clean.

---

## 8. Risks and mitigations

| # | Risk | Impact | Probability | Mitigation |
|---|---|---|---|---|
| 1 | Migration 21 fails on PGLite or SQLite | Brain boot failure | Medium | New schema test mirroring `memory-inbox-schema.test.ts`, run on all three engines before merge |
| 2 | Existing `putRetrievalTrace` callers miss new fields | TS error (now caught by CI) or default accepted | Low | Both new fields optional with defaults; existing call sites unaffected |
| 3 | `audit_brain_loop` slow on large brains | CLI latency | Low | 500-batch window scan, `limit` param caps backlog rows |
| 4 | `write_outcome` enum needs future expansion | Breaking CHECK to extend | Low | Follow the `memory_candidate_entries.status` extension pattern (migration adds new allowed values) |
| 5 | `derived_consulted` pollution by mis-populate | L2 measurement incorrect | Medium | S14 explicitly asserts `source_refs` and `derived_consulted` are disjoint |
| 6 | CI baseline cleanup expands scope | PR delay | Medium | Commit 1 is independent; held back if too large. Verify locally first. |

---

## 9. Done criteria

- [ ] `bunx tsc --noEmit` is clean locally and on CI
- [ ] `retrieval_traces` has `derived_consulted` and `write_outcome` columns on SQLite, PGLite, and Postgres
- [ ] `bun run test:scenarios` — S14 is a real test, green; S15 all 4 tests green
- [ ] `mbrain audit-brain-loop --since 1h --json` returns valid JSON conforming to `AuditBrainLoopReport`
- [ ] `bun test` overall pass count equals or exceeds the pre-sprint baseline
- [ ] Zero `as any` / non-exhaustive-switch review comments needed on the PR

---

## 10. Rollback plan

Each component rolls back independently:

- **Migration 21** — add reverse migration dropping the two columns. `LATEST_VERSION` moves forward but the net effect is no-op. Old code tolerates the absent columns because both are optional.
- **`audit_brain_loop` operation** — remove the spread in `operations.ts`. Schema and traces remain. No data loss.
- **CI tsc step** — delete the one-line workflow change.

There is no scenario where all three must roll back together.

---

## 11. Out of scope but referenced

These items are explicitly *not* Sprint 1 deliverables but benefit from its infrastructure:

- **Sprint 2** — `broad-synthesis-route-service` ranking step that prefers curated over map (invariant L2). Consumes `derived_consulted` to surface disagreements.
- **Sprint 3** — `reverify_code_claims` operation (invariant L4). Writes into the trace's `verification` array using a structured shape TBD.
- **Future dream-cycle cron** — invokes `audit_brain_loop` nightly, produces a health digest, seeds dream-cycle suggestions accordingly.

---

## 12. Open questions the plan must resolve

Deferred to `writing-plans`:

1. Exact TypeScript signature of `listRetrievalTracesByWindow` — cursor vs offset pagination.
2. Whether migration 21's SQLite branch should backfill default values explicitly or rely on `ALTER ADD COLUMN DEFAULT`.
3. Whether `summary_lines` should be a separate `i18n`-able module or inline English for Sprint 1.
4. CLI output format default — JSON or human-readable. Current proposal: human-readable by default, `--json` flag for structured.
