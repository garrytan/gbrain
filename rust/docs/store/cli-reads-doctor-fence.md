# The brain store: the fence census reads and writes

The doctor's `fence_integrity` check (`src/commands/doctor/checks/fence-integrity.ts`) runs the fence census
(`src/core/fence-repair/census.ts`, `census-store.ts`). Before lane 14 it ran about a dozen `executeRaw` statements, which a Rust brain
refuses, so the check came back as a typed refusal. Each statement is now a typed member in `src/core/engine-sql/fence-census.ts` (same
text, same parameters; `test/fence-census-sql.test.ts` pins every text against the original) and the Rust engine serves it from the store.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listFenceCensusSources({sourceIds})` | live sources with an incarnation (`archived` not true), by id | `censusSources` |
| `brain.readFencePassHorizon(graceMs)` | the store clock minus the grace, as ISO text | `passHorizon` (a Rust brain has one writer, so there is no older open transaction to wait for) |
| `brain.listFenceCensusPagesById(source, afterId, limit)` / `listFenceCensusPagesUpdated(source, lower, after, limit)` | pages of one source with `live` and, for a live markdown page that mentions a fence marker, its bodies | the two page scans |
| `brain.listLiveFencePageIds(ids)` | the ids among them that are not soft-deleted | the live-id probe |
| `brain.readFenceScanRecord(op, fingerprint)` / `writeFenceScanRecord(...)` | the scan record of one (source, incarnation) | `readScanRecord`, `writeScanRecord` |
| `brain.upsertFenceCandidatePart(...)` / `clearFenceCandidateParts(...)` | one judged `page` or `file` part of a candidate, keeping the other; a candidate left with no part is deleted | `upsertCandidatePart`, `clearCandidateParts` |
| `brain.listFenceCandidateRecords(op, sourceIds)` | the candidate rows of live source incarnations (was "empty, no writer" in [cli-reads-doctor-checkpoints.md](cli-reads-doctor-checkpoints.md)) | `readCandidateRecords` |
| `brain.countSegmentedFencePages(sourceIds, walkedSourceIds)` | live markdown pages stored in segments with no walked file | the doctor's skipped-pages count |

The census state is `op_checkpoints` rows in the store's housekeeping key space (`d 0x02 <op> 0x00 <fingerprint>`), where
`completed_keys` is `[record]`. No new key space is used.

## Answered empty (no writer on a Rust brain)

- `readFenceTrendRecords` returns `[]`: the trend rows (`fence-trend`) are written by `recordSyncRunTrend`, `recordWriteTrend` and
  `recordPublicationFenceTrend`, which stay on `executeRaw` (the managed-sync and write paths, which a Rust brain does not run).
- `readBudgetLedgerDay` returns null: `budget_ledger` has no Rust writer, so the fence repair has spent nothing.

## Differences from PGLite and Postgres

- Page scans read every page record and filter and sort in memory (the store has no `(source, id)` or `(source, updated_at)` index), so a
  scan of a large source costs one pass over the pages per batch.
- Orders are bytewise (`ORDER BY id` of sources, and slugs). PGLite and Postgres order text by collation (en_US on the gate database).
  The parity test uses lowercase-letter keys, where the two agree.
- Postgres binds the `after` time of an updated-page scan through a JS `Date`, which keeps milliseconds, so a cursor row whose time has
  microseconds can be listed once more. The census judges a page the same way twice, so this is harmless. Rust compares the full
  microsecond time. The parity test leaves the cursor row out of the comparison.

## Not moved

These statements stay raw and are not reached when the doctor runs on the fixture (so the check is served), but a Rust brain with such data
may still meet a typed refusal there. They are filed in `TODOS.md`:

- `unfenced-facts.ts`: `databaseOnlyPlacement`, the `planFence` occupied-rows read (needs the `source` column that `listStoredFenceFactRows`
  lacks) and the repair write (a write path).
- `attempts.ts`, `hold-fix.ts`, `repair-io.ts`, `uncommitted.ts`: repair-side reads the doctor calls with `.catch`.

Tests: `crates/gbrain-store/tests/cli_reads_doctor_fence.rs`, `test/engine-parity/doctor-fence-census.test.ts` (PGLite, Postgres and Rust),
`test/fence-census-sql.test.ts`.
