# The brain store: export reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements `gbrain export` ran through `executeRaw` (`src/commands/export.ts`,
`src/core/export-snapshot.ts`, the segmented-body reads of `src/core/page-body/read-range.ts` and the folder-rule read
of `src/core/access/policy-transfer.ts`). PGLite and Postgres run the same SQL as before, now in
`src/core/engine-sql/export-reads.ts` and `transaction-settings.ts`. The store answers from its records
(`crates/gbrain-store/src/cli_reads/export.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/cli-reads-export.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |

## What the store does not keep

- **A statement timeout.** `setLocalStatementTimeout(ms)` does nothing on the Rust engine: the store has no statement
  timeout. It refuses an `ms` that is not a non-negative integer, and refuses on a transaction that has ended, as the
  other transaction members do. It runs only in TypeScript and has no store method.
