# remediation records: the reindex spend read and the impact log row

Code: `src/core/rust-engine/store-members/remediation-records.ts`; the spend read is served by
`rust/crates/gbrain-store/src/chunk_queries/walk_reads.rs` through the napi method in
`rust/crates/gbrain-napi/src/families/chunk_queries.rs`. The reference is `src/core/engine-sql/remediation-records.ts`.

## Members

| Member | State |
|---|---|
| `readReindexSpendInputs(chunkerVersion, type)` | served |
| `insertImpactLogRow(row)` | refused by name (`raw_sql`), before any work |

`readReindexSpendInputs` counts the live markdown pages (`page_kind = 'markdown'`, no `deleted_at`, of `type` when one
is named) whose `chunker_version` is below `chunkerVersion` or whose contextual retrieval mode (the aliases family's
state) is unset. A page with no recorded chunker version is not below the fence, as `NULL < n` is not true in SQL; it
still counts when its mode is unset. `chars` sums `LENGTH(compiled_truth) + LENGTH(timeline)` in characters (Unicode
scalar values, as Postgres counts them); a page whose body columns are NULL (a segmented shell) is counted but adds no
characters, as `NULL + n` adds nothing to `SUM`.

`insertImpactLogRow` refuses: the store keeps no `migration_impact_log` records. Adding them is a store format change,
which waits until after the shadow tag. `closeStepImpact` (`src/core/onboard/impact-capture.ts`) lets the refusal
through, and the remediation run reports the step `impact_log: not_recorded` and keeps the job's status, so a step's
history row is never dropped silently. The parity case stops on this member by a pin in
`test/rust-stop-pins/lane-7.tsv`.
