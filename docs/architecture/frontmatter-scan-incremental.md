# Frontmatter scan: DB-backed incremental state (Phase 2 design sketch)

**Status:** Designed, not built. Captured here as the starting point for the
follow-up PR after v0.38.2.0.

## Why this exists

v0.38.2.0 fixed the load-bearing bug class that caused `gbrain doctor` to
hang on large brains: the disk walker descended into `node_modules/`, `.git/`,
and other vendor trees on every tick. After that fix doctor completes in
seconds on most brains, and bounded wall-clock (default 30s, with honest
partial-state surfacing) on any brain.

But the steady-state cost of `frontmatter_integrity` is still O(N) in real
syncable pages: every doctor tick re-walks the filesystem and re-parses
every `.md` file. For users with 200K+ pages the steady-state cost is in
the seconds even after Fix 1. For sub-second steady-state doctor (the
right shape for cron-monitored health checks), the scan needs to become
incremental.

This document captures the Phase 2 design before the follow-up PR starts,
so the implementer doesn't have to re-derive it.

## Goal

Doctor's `frontmatter_integrity` check completes in O(1) SQL queries
regardless of brain size, with the same per-source breakdown and partial-
state semantics as v0.38.2.0's bounded-walk approach. Incremental refresh
runs as a sync-side write + an autopilot cycle phase, so the steady-state
work is amortized across the workflow that already touches each file.

## Schema

New table:

```sql
CREATE TABLE frontmatter_scan_state (
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,  -- relative to source.local_path
  mtime_ms     BIGINT NOT NULL,
  content_hash TEXT NOT NULL,  -- sha256 of file content at scan time
  codes        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ParseValidationCode[]
  last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, path)
);

CREATE INDEX frontmatter_scan_state_has_issues_idx
  ON frontmatter_scan_state (source_id)
  WHERE codes != '[]'::jsonb;
```

Why these columns:
- `mtime_ms` + `content_hash`: incremental check picks one. mtime is faster
  (no read); content_hash is the truth (defeats touch-without-change cases).
  The incremental walker uses mtime as a fast gate and content_hash as the
  fallback when mtime suggests change.
- `codes` JSONB: per-row error code list, NULL/`[]` means clean. Doctor
  aggregates with `jsonb_array_length(codes) > 0`.
- Partial index on `WHERE codes != '[]'::jsonb`: doctor's aggregate query
  only walks rows with issues, which is a small fraction of pages.

This follows the canonical `applyForwardReferenceBootstrap` pattern in
`src/core/pglite-engine.ts` (and `postgres-engine.ts`) — the new column /
table additions go into the bootstrap probe set per CLAUDE.md so old brains
walking forward through the schema chain don't wedge on the table not
existing.

## Migration shape

```ts
// src/core/migrate.ts — append after the v80 entry
const migrations = [
  // ...existing v1-v80...
  {
    version: 81,
    name: 'frontmatter_scan_state',
    sql: `
      CREATE TABLE IF NOT EXISTS frontmatter_scan_state (...);
      CREATE INDEX IF NOT EXISTS frontmatter_scan_state_has_issues_idx ...;
    `,
  },
];
```

Plus the forward-reference probe entries in both engine bootstraps. Plus
the `REQUIRED_BOOTSTRAP_COVERAGE` extension in
`test/schema-bootstrap-coverage.test.ts`.

## Writers

Two paths write rows:

1. **Sync-side write** (canonical). `src/core/sync.ts:performSync` already
   parses every file it touches. After the existing `parseMarkdown` call,
   `UPSERT` into `frontmatter_scan_state` with the file's path / mtime /
   content_hash / codes. Cost: one row per file synced. Zero extra parse
   work — the parse already happened.

2. **Incremental scan** (`gbrain frontmatter scan --incremental`). Walks
   the disk via `walkBrainTree`, for each file checks `mtime > last_scanned_at`
   OR `content_hash != stored`, only re-parses changed files. Most ticks:
   zero work after the first full backfill. Also exposed as an autopilot
   cycle phase (`frontmatter_scan`) so it runs alongside the other periodic
   maintenance phases.

The incremental walker handles two cases sync misses:
- Files edited outside sync (user opens an editor, saves, never `git
  commit`s).
- Sources whose `local_path` isn't a git repo (sync only sees git-touched
  files).

## Doctor reader

```ts
// src/commands/doctor.ts:frontmatter_integrity (Phase 2 shape)
const rows = await engine.executeRaw<{ source_id: string; issues: number }>(
  `SELECT source_id, count(*) FILTER (WHERE jsonb_array_length(codes) > 0)::int AS issues
   FROM frontmatter_scan_state
   GROUP BY source_id`,
);
```

One SQL query, constant time regardless of brain size. The partial-state
surfacing from v0.38.2.0 stays — when `frontmatter_scan_state` is stale
(no rows for a registered source, or `last_scanned_at` >24h old for any
source), doctor warns about freshness rather than reporting potentially-
stale data as authoritative.

## Sequencing concerns

1. **First-ever scan.** A fresh upgrade has no rows in
   `frontmatter_scan_state`. Two options:
   - Lazy: doctor reports "no scan state yet; run `gbrain frontmatter scan
     --incremental` once" (operator-driven).
   - Eager: the migration that creates the table also enqueues an autopilot
     cycle job to do the first full scan.

   Recommendation: lazy, with a clear hint. The autopilot path is heavier
   surface (must add the new `frontmatter_scan` phase to the existing
   cycle.ts machinery + the doctor-routed background job system).

2. **Source archival / deletion.** `frontmatter_scan_state` has `ON DELETE
   CASCADE` on `sources(id)`, so soft-delete + 72h TTL + purge already
   clean it up. No additional logic needed.

3. **Path renames inside a source.** Sync would `DELETE` the old row by
   path (via a periodic reconcile step) and `INSERT` the new row. Without
   that step, the table accumulates stale path rows. Either:
   - A reconcile step in the incremental scanner: any path-row not seen
     during the walk gets deleted.
   - Or: doctor reports "N stale rows in frontmatter_scan_state" as a
     freshness signal, with `gbrain frontmatter scan --reconcile` as the
     remediation.

## Cost estimate

- One UPSERT per file synced. Negligible vs the parse + DB write that sync
  already does.
- Incremental refresh runtime: dominated by mtime stats. ~ms per 1000 files
  on SSD.
- Doctor read: one indexed SQL query. Sub-100ms on any brain size.

## What this design deliberately does NOT do

- **Replace v0.38.2.0's bounded-walk safety net.** Phase 2 makes the
  steady-state cheap, but the disk walker (with its deadline check) stays
  as the source-of-truth fallback for sources whose scan state is missing
  or stale. Belt-and-suspenders.
- **Introduce a separate frontmatter validation rule set.** Reuses
  `parseMarkdown(..., {validate: true})` and the existing
  `ParseValidationCode` enum. Single source of truth.
- **Add a new background daemon.** Wires into the existing
  `autopilot-cycle` Minion handler as a new phase, alongside sync /
  extract / embed / etc.

## Open questions for the implementer

1. **Path normalization.** `pages.source_path` and the disk walker's
   relative path computation are similar but not identical (slashes,
   leading `./`, etc.). The incremental scanner needs to match what sync
   stores so UPSERTs key correctly. Audit before writing.
2. **Soft-delete interaction.** A page that gets soft-deleted in the DB
   (v0.26.5) still has a file on disk. Should the incremental scan
   continue to track its frontmatter state? Probably yes (so a future
   `restore_page` doesn't surprise with stale frontmatter), but worth
   confirming with the soft-delete owner.
3. **Two-phase rollout.** Land the table + writes first, let it backfill
   for a release cycle, then switch the doctor reader. Avoids the
   "Phase 2 ships but the table is empty" case where doctor regresses to
   reporting "no scan state."

## TODO file entry

```
- [ ] Implement Phase 2: DB-backed frontmatter scan state.
      Design lives at docs/architecture/frontmatter-scan-incremental.md.
      Schema migration v81 + sync-side UPSERT + incremental scan command
      + autopilot cycle phase + doctor reader. Two-phase rollout: ship
      table + writes first; flip the reader one release later.
```
