# Rust engine fixes that master also needs (2026-11-18)

Renumbered v331 -> v334 on 2026-11-20 (master's D1 frontmatter migration takes v331).

The Rust engine branches fixed six defects while they made CI green, and one fix needed a new index.
Each entry below says whether
master has the same code, with file and line. Master was read at `4fb16138a0` with
`git show origin/master:<path>`. The Rust branch refs are on `rust-engine/ci-red` and
`rust-engine/sequence-order`.

This is research, not a promise about current behavior. No change to master was made.

## Summary

| Defect | Rust branch fix | Same code on master | Effect on master |
|---|---|---|---|
| Journal reservations sorted by the text form of `sequence` | `39d3911c88` | Yes: `src/core/persistence/receipt-true-up.ts:83-84` | Same bug. The reservation sweep can skip rows past sequence 9, 99, 999 and so on. |
| Fence trend prefix sorted by the text form of `sequence` | `d231ce57d4` | Yes: `src/core/persistence/sync-prepare.ts:626` and `:646` | Same bug. Trend sample paths and the open-import list come out of order past a power of ten. |
| Projection window `ord` read as a BigInt on Postgres | `abf4d9aada` | Same SQL: `src/core/page-state/projection-window.ts:83` | No wrong value reaches a caller today. The only reader converts with `Number()`. |
| Projection queue walked in the server's text order on Postgres | `0044e342e9` | Yes: `src/core/page-state/projections.ts:763`, `:793`, `:806`, `:808`; `src/core/page-state/projection-window.ts:79-85`; `src/core/page-state/image-seal.ts:80`, `:81`, `:85` | Same bug on a Postgres server whose collation is not C (for example en_US.utf8). The drain, its preview, the resident window and the image seal visit jobs in a different order than PGLite. |
| No index serves the byte-order queue walk | `v331` migration on this branch (renumbered from v326, then v327, then v328 was reserved for #9704, then master took v329 in #9824, then master took v330 in #9839; now v331) | Yes: `src/core/page-state/projection-schema.ts:51-57` has only the primary key | No effect until master pins `COLLATE "C"`; then each window lane reads and sorts the whole queue on a non-C Postgres. |
| Duplicate take-supersession row in the canonical writer census | `f3906b8497` | Yes: `docs/architecture/canonical-writers.tsv:272` (stale) and `:274` | The stale row describes code that is gone. No test rejects a duplicate row on master. |
| Partial-clone holds on git 2.43 | none | Same code: `src/core/persistence/sync-blobs.ts:55-62` | Two tests fail on git 2.43. They pass on CI's git 2.56. |

## Journal reservations (39d3911c88)

`RESERVATIONS_AFTER_SQL` selects `sequence::text AS sequence` and ended with `ORDER BY sequence`. In
an `ORDER BY`, a bare output-column name wins over the table column, so the rows sort as text:
`10`, `11`, `9`. `sweepCompactedReservations` keeps the window's last row as its cursor, so the
sweep can jump over rows and never return their reserved bytes.

Master has the same statement inline in `src/core/persistence/receipt-true-up.ts:83-84`:

```sql
SELECT id,sequence::text AS sequence,compacted
    FROM persistence_requests WHERE sequence>$1::bigint ORDER BY sequence LIMIT $2
```

The fix is `ORDER BY persistence_requests.sequence`. The Rust branch case in
`test/persistence-receipt-true-up.test.ts` (sequences 9, 10, 11) fails on the old statement.

## Fence trend prefix (d231ce57d4)

`fenceTrendRows` and the open-import read in `readFenceTrendPrefix` select
`sequence::text AS sequence` and ended with `ORDER BY sequence`. `addFencesNormalized` keeps the
first five paths in row order as `sample_paths`, and `FenceTrendPrefix.open` keeps row order. Both
came out as 10, 11, 9. PGLite shows it too: text `'10'` sorts before `'9'` in every collation.

Master has both lines: `src/core/persistence/sync-prepare.ts:626` and `:646`. The new test
`test/sync-fence-trend-sequence-order.test.ts` uses a real database on PGLite and Postgres. It fails
on both engines before the fix, and each of its two assertions fails alone when its read is
reverted.

## Projection window `ord` (abf4d9aada)

`row_number()` returns `int8`. The Postgres engine parses `int8` as a JS BigInt
(`types: { bigint: postgres.BigInt }`, master `src/core/connection-manager.ts:268` and
`src/core/db.ts:531`). On the Rust branch, `readProjectionWindow` in
`src/core/engine-sql/persistence-housekeeping.ts` returns rows typed `ord: number` without a
conversion, so the Postgres parity case saw a BigInt. The fix casts in SQL:
`(row_number() OVER (...))::int AS ord`.

Master has the same SQL in `src/core/page-state/projection-window.ts:83`. Its only reader,
`src/core/page-state/projections.ts:673` and `:694`, wraps `ord` in `Number()`, so no BigInt
reaches a caller on master. The cast is worth porting when that window moves behind a typed
contract.

## Projection queue order (0044e342e9)

The projection queue's keyset comparison `(source_incarnation, slug) > (...)` and its `ORDER BY` used
the server's default collation for `slug`. On a Postgres database with a language collation
(en_US.utf8), `notes/a1`, `notes/a-b`, `notes/a_b` and `notes/ab` sort in a different order than
in byte order. PGLite and the Rust engine (`job_order` in
`rust/crates/gbrain-store/src/persistence/projection_queue.rs` compares `slug.as_bytes()`) use byte
order. The fix pins `COLLATE "C"` on the comparison and the `ORDER BY` together, in the drain and
its preview, the resident window (both copies) and the image-seal walk. Postgres refuses a
collated column in a `UNION ALL`'s own `ORDER BY`, so the window now orders in an outer select.

Master has the same code at `src/core/page-state/projections.ts:763`, `:793`, `:806` and `:808`,
`src/core/page-state/projection-window.ts:79-85` and `src/core/page-state/image-seal.ts:80`, `:81`
and `:85`. Master has no `projectionWindowFragment`, so the engine-sql copy has nothing to fix there.

Cost, and the index that pays it back (v331 on this branch): the only index on `page_projection_jobs`
is its primary key `(source_incarnation, slug)` with the default collation, and the planner treats
the default collation and "C" as different collations, so the pinned comparison cannot use it. On
300,000 queue rows in an en_US.utf8 database the pinned forward lane alone went from an index scan
(0.18 ms) to a full scan and sort (20 ms) on a scratch copy of the table. Migration v331
(`src/core/schema-migrations/v331-projection-jobs-byte-order-index.ts`) adds
`idx_page_projection_jobs_slug_c` on `(source_incarnation, slug COLLATE "C")`, built CONCURRENTLY on
Postgres. With it the forward lane is an index scan again (0.13 ms).

The whole window read (`selectProjectionWindowJobs`, median of five runs on the full schema at
300,000 rows) took 70.4 ms before the pin, 129.9 ms with the pin and no index, and 69.4 ms with the
pin and the index. Most of the 70 ms is older and unrelated to collation: `max(updated_at)` for the
mark and the high water, and the `recent` lane's `ORDER BY updated_at DESC`, each scan the table
because no index has `updated_at`.

The segmented-queue listing (`listPendingSegmentedProjections`, `ORDER BY j.updated_at, j.slug
COLLATE "C"`, 3,000 segmented pages of 300,000) scans the jobs table and sorts it with or without the
pin (35.7 ms before the pin, 34.8 ms after, 34.2 ms with v331). The pin did not cause the scan, so
v331 adds no second index. A trial index on `(updated_at, slug COLLATE "C")` made the planner walk
it with a nested loop into the pages table, and the same listing took 126.8 s.

Master has no index for the pinned order either: `page_projection_jobs` is created at
`src/core/page-state/projection-schema.ts:51-57` with only `PRIMARY KEY(source_incarnation,slug)`,
and no master migration adds an index on the table. If master takes the `COLLATE "C"` pin, it needs
this index in the same change. A C-collated database (`datcollate` C) is not measured here.

## Take-supersession census row (f3906b8497)

Master's `docs/architecture/canonical-writers.tsv` lists `src/core/repair/take-supersession.ts`
twice. Line 272 says the reprojection runs "inside withCoordinatedWrite under the page key"; line
274 names the `managed_maintenance_take_reproject` request. Master's
`src/core/repair/take-supersession.ts` has no `withCoordinatedWrite` call, so line 272 is stale.

The Rust branch deletes the stale row and adds the case "each file has exactly one row in
canonical-writers.tsv" to `test/canonical-writer-inventory.test.ts`. Master has no such case, so a
duplicate row passes there.

## Partial-clone holds on git 2.43 (no fix)

On git 2.43.0, `git cat-file --batch` exits 128 when it meets a missing blob in a partial clone,
instead of printing `<oid> missing`. `readBlobBytes` (`src/core/persistence/sync-blobs.ts:55`, the
call at `:62`) does not catch the exit, so the file is held `page_write_failed`, not
`git_object_missing`. Master has the same code at the same lines.

Two PGLite cases in `test/sync-partial-clone-2331.test.ts` fail on git 2.43.0:

- line 158: "a blobless clone without a checkout fetches nothing and holds every committed file
  git_object_missing"
- line 191: "a treeless clone without a checkout stops the run naming the partial clone, fetches
  nothing, and syncs once the user fetches the trees"

Both pass on CI's git 2.56.0 (master run 44277593744, job 134709792876). Nothing was changed. A
user with an older git and a partial clone sees the less specific hold code.

## Follow-up: ranking stages that fail with no trace (no fix)

A search's post-fusion ranking stages are fail-open: when a stage's read fails, the search ranks
without that stage. The Rust branch `rust-engine/admit-write` now lets a refused engine capability
(`engine_capability_missing`) through four more of these stages, so a Rust brain that does not
serve a stage's read fails the search instead of ranking without the stage and looking healthy.
Every other failure stays silent on Postgres and PGLite, on purpose: this note records it, and
nothing was changed.

Master, read at `3f2ed1e6f9`, has the same four catches with no rethrow:

| Stage | Master |
|---|---|
| Backlink boost | `src/core/search/hybrid.ts:597` |
| Salience boost | `src/core/search/hybrid.ts:606` |
| Recency boost | `src/core/search/hybrid.ts:631` |
| Graph signals | `src/core/search/hybrid.ts:669`, and the adjacency read in `src/core/search/graph-signals.ts:348` |

The alias and supersession stages (`hybrid.ts:684` and `:699`) already rethrow a capability
refusal on master. Master has no engine that refuses these reads, so the missing rethrow has no
effect there today.

What stays silent: a missing table on an old schema, a statement timeout or a dropped
connection on one of the backlink, salience or recency reads ranks the search without that
stage, and nothing records it. Only the graph-signals read writes an audit row. A follow-up
could count or log these stage failures; it would not change the results.
