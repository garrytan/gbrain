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

## Trend and ledger reads

- `readFenceTrendRecords` lists the `fence-trend` parents and keeps the first record of each whose `source_id` is asked and whose
  `day` is not before `fromDay` (ISO days compare as text). The rows are written by `recordSyncRunTrend` (`upsertFenceTrendRunRecord`)
  and `recordWriteTrend` / `recordPublicationFenceTrend` (`insertOpCheckpointIfAbsent`), typed members on every engine
  (`rust/docs/store/repair-fences.md`), so a brain that wrote none still reads `[]`.
- `readBudgetLedgerDay` reads the store's daily ledger (`budget_ledger.rs`, `rust/docs/store/repair-fences.md`): the day's reserved, committed and cap amounts as numeric text, or null when the day has no row.

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
