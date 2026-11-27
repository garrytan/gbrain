# The batch 9 repair statements

The typed members the batch 9 repair kinds (segmented-mirror, fences, slug-conflicts, missing-tables, planner-stats)
run through, so they work on a Rust brain. Each has one SQL copy in `src/core/engine-sql/` and a store function here.

| Members | Repair kind | SQL | Store | Contract |
|---|---|---|---|---|
| `insertRemirrorEffects` | `segmented-mirror` | `segmented-mirror-effects.ts` | `src/persistence/effects.rs` | One `withdrawal-mirror` and one `git` effect for a re-mirror's request row, with the source's incarnation and the worktree of its binding of that incarnation; a kind already queued is kept, an unknown source queues none (the withdrawal insert with two kinds). |
| `readRemirrorEffects` | `segmented-mirror` | `segmented-mirror-effects.ts` | `src/persistence/effects.rs` | A request's effects in kind order: state, error code, whether a recovery is open, whether its data holds `parked`, and its data's `skipped` list (else `[]`). A request id that is not a uuid refuses as `::uuid` does. |
| `listGlobalPurgeWithdrawals` | `segmented-mirror` (the typed withdrawal overlay, `page-state/snapshot.ts overlayCanonicalBodiesTyped`) | `segmented-mirror-effects.ts` | `src/facts/purge_ledger.rs` | A source's subject-`*` tombstones of the asked claim fingerprints as `{ visibility, fact_hash, withdrawn_at, purged: true }`, world rows only when asked, in (visibility, fingerprint) order. |

| `insertOpCheckpointIfAbsent`, `replaceOpCheckpointAtVersion` | `fences` (the attempt store, `fence-repair/attempts.ts`) | `fence-repair-records.ts` | `src/persistence/op_checkpoint.rs` | Store the checkpoint parent only when none exists; replace its records only while the first record's `v` is the expected version (a `v` that is not an integer refuses as `::int` does, a missing one matches nothing). Each is one store write. |
| `listSourceCheckpointRecords` | `fences` (uncommitted repairs, `fence-repair/uncommitted.ts`) | `fence-repair-records.ts` | `listOpCheckpointRecords` (TS store member) | The first record of each parent of an op whose record names an asked source (every one when none is asked), in fingerprint byte order. |
| `upsertFenceTrendRunRecord` | the fence trend of a sync run (`fence-repair/census-store.ts` `recordSyncRunTrend`) | `fence-repair-records.ts` | `src/persistence/op_checkpoint.rs` (`upsert_fence_trend_run_record_in`) | Stores `[record]` when the parent is new; a rewrite replaces the record and keeps the `day` of the first record (null when it has none), so a resumed run counts once. One store write. A page write's trend row (`recordWriteTrend`) is `insertOpCheckpointIfAbsent`. |
| `readOldestSyncHoldAt` | `fences`, `slug-conflicts` (their verification) | `fence-repair-records.ts` | `listOpCheckpointRecords` (TS store member) | The earliest `held_at` of the asked sources' `sync-hold` records with the asked code, or null. |
| `readLastFinishedJobAt` | the fence hold fixes (`fence-repair/hold-fix.ts`) | `fence-repair-records.ts` | `src/jobs/status.rs` | The latest `finished_at` of the completed jobs of a name, as UTC ISO seconds, or null. |
| `reclaimBudgetReservations`, `reserveBudgetReservation`, `dispatchBudgetReservation`, `settleBudgetReservation`, `releaseBudgetReservation` | the model tier of `fences` and `slug-conflicts` (the paid-call protocol, `budget/daily-ledger.ts`) | `budget-ledger-writes.ts` | `src/budget_ledger.rs` (TS: `rust-engine/store-members/budget-ledger.ts`) | The store keeps `budget_ledger` and `budget_reservations` (keys `a 0x09`, `a 0x0A`; amounts in ten-thousandths, printed as `numeric::text`); each write is one store write. The day read `readBudgetLedgerDay` (`store-members/fence-census.ts`) reads the same records, so a written day reads back on every engine (`test/engine-parity/budget-ledger-writes.test.ts`). |

The parity cases are in `test/engine-parity/segmented-mirror-effects.test.ts`, `repair-fence-records.test.ts`,
`budget-ledger-writes.test.ts` and `jobs-status.test.ts`.

`fences` and `slug-conflicts` no longer stop at plan entry on an engine without raw SQL: the fence census, the daily ledger day read and
the hold reads are typed members, and the previews of a brain with a broken fence, a legacy checkout file and a database-only page are
equal on PGLite, Postgres and Rust (`test/engine-parity/repair-fence-kinds.test.ts`). Two reads that ran as one statement now compose
typed members: `readGitHold` (`persistence/sync-holds.ts`) is `readGitHoldRow` plus the source's mirror flag from
`readGitHoldReportInputs`, and `canonicalOriginPage` (`persistence/origin-guard.ts`) is `listLiveOriginPages` plus the slugs from
`listOriginClaimants`. A legacy checkout file applies on Rust (backup, rewrite, import, a second preview finds nothing).

What still stops on Rust: the apply of a repaired page of a database-only source. The write is accepted, the page publication refuses
with `engine_capability_missing` at `guardFenceRows` (`trust/fence-guard.ts`, the facts-fence re-projection of every page publish: its
`UPDATE facts SET row_num`, row-number read, move and trusted-private statements still run through `executeRaw`, a facts-lane gap listed
in `docs/research/rust-engine-raw-sql-gaps.md`), the request stays queued, and the repair stops with the typed `raw_sql` refusal
"repair write publication" (`repair/settle.ts`). The same stop ends any page write that carries a facts fence. A managed source needs
the `managed_persistence` capability, which a Rust brain holds.

`missing-tables` and `planner-stats` need no member: their reads are catalog probes
(`src/core/rust-engine/store-members/catalog.ts`). `readMissingTables` checks PGLite's table list and answers none
missing, because the store creates every record family when it opens and no command drops one; `readPlannerTableStates`
answers no table, because the store has no planner. Each preview is what a healthy PGLite brain previews
(`test/engine-parity/repair-runner.test.ts`).
