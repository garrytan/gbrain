# The batch 9 repair statements

The typed members the batch 9 repair kinds (segmented-mirror, fences, slug-conflicts, missing-tables, planner-stats)
run through, so they work on a Rust brain. Each has one SQL copy in `src/core/engine-sql/` and a store function here.

| Members | Repair kind | SQL | Store | Contract |
|---|---|---|---|---|
| `insertRemirrorEffects` | `segmented-mirror` | `segmented-mirror-effects.ts` | `src/persistence/effects.rs` | One `withdrawal-mirror` and one `git` effect for a re-mirror's request row, with the source's incarnation and the worktree of its binding of that incarnation; a kind already queued is kept, an unknown source queues none (the withdrawal insert with two kinds). |
| `readRemirrorEffects` | `segmented-mirror` | `segmented-mirror-effects.ts` | `src/persistence/effects.rs` | A request's effects in kind order: state, error code, whether a recovery is open, whether its data holds `parked`, and its data's `skipped` list (else `[]`). A request id that is not a uuid refuses as `::uuid` does. |
| `listGlobalPurgeWithdrawals` | `segmented-mirror` (the typed withdrawal overlay, `page-state/snapshot.ts overlayCanonicalBodiesTyped`) | `segmented-mirror-effects.ts` | `src/facts/purge_ledger.rs` | A source's subject-`*` tombstones of the asked claim fingerprints as `{ visibility, fact_hash, withdrawn_at, purged: true }`, world rows only when asked, in (visibility, fingerprint) order. |

The parity cases are in `test/engine-parity/segmented-mirror-effects.test.ts`.
