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
| `readOldestSyncHoldAt` | `fences`, `slug-conflicts` (their verification) | `fence-repair-records.ts` | `listOpCheckpointRecords` (TS store member) | The earliest `held_at` of the asked sources' `sync-hold` records with the asked code, or null. |
| `readLastFinishedJobAt` | the fence hold fixes (`fence-repair/hold-fix.ts`) | `fence-repair-records.ts` | `src/jobs/status.rs` | The latest `finished_at` of the completed jobs of a name, as UTC ISO seconds, or null. |
| `reclaimBudgetReservations`, `reserveBudgetReservation`, `dispatchBudgetReservation`, `settleBudgetReservation`, `releaseBudgetReservation` | the model tier of `fences` and `slug-conflicts` (the paid-call protocol, `budget/daily-ledger.ts`) | `budget-ledger-writes.ts` | `src/budget_ledger.rs` (TS: `rust-engine/store-members/budget-ledger.ts`) | The store functions keep `budget_ledger` and `budget_reservations` (keys `a 0x09`, `a 0x0A`; amounts in ten-thousandths, printed as `numeric::text`), with the day read `read_budget_ledger_day`. Until the day read `readBudgetLedgerDay` (the fence census lane's member) is on this branch, the TS members refuse by name and write nothing; the protocol reads a refusal as `ledger_unavailable` and makes no paid call. |

The parity cases are in `test/engine-parity/segmented-mirror-effects.test.ts`, `repair-fence-records.test.ts`,
`budget-ledger-writes.test.ts` and `jobs-status.test.ts`. Until lane 14's fence census and daily budget ledger members (`engine-sql/fence-census.ts`) are on
this branch, `fences` and `slug-conflicts` stop at plan entry on an engine without raw SQL ("repair fences census";
`test/engine-parity/repair-fence-kinds.test.ts`).

`missing-tables` and `planner-stats` need no member: their reads are catalog probes
(`src/core/rust-engine/store-members/catalog.ts`). `readMissingTables` checks PGLite's table list and answers none
missing, because the store creates every record family when it opens and no command drops one; `readPlannerTableStates`
answers no table, because the store has no planner. Each preview is what a healthy PGLite brain previews
(`test/engine-parity/repair-runner.test.ts`).
