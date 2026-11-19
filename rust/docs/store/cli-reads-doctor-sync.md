# The brain store: doctor sync reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the managed-sync cursor, failure, pass and durable-failure statements that `gbrain doctor` checks ran through
`executeRaw`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-sync.ts`; the text is pinned by
`test/doctor-sync-sql.test.ts`). The TypeScript side is `src/core/rust-engine/store-members/doctor-sync.ts`.

## Members with no writer on a Rust brain (answer empty)

Managed-sync cursors, failure rows and pass rows are written only through `executeRaw`, which a Rust brain refuses, so no row of
them exists there. These members answer the empty value with no store call, which is what the same read finds on a PGLite brain
nothing has written to. They are listed here so a later writer knows which reads it must feed:

| JS | Resolves | Reads |
| --- | --- | --- |
| `brain.listManagedSyncCursorFailureRows(sourceIds)` | `[]` | the cursor rows that carry a failure, for `readManagedSyncFailures` |
| `brain.listManagedSyncOrphanRowsets(sourceIds, movedMessage)` | five empty lists (`cursors`, `failures`, `passes`, `retiredCursors`, `retiredFailures`) | the five reads of `classifyManagedSyncOrphans` |
| `brain.listDurableManagedSyncFailureKeys(keys)` | `[]` | the failure keys that still have a durable row, for `mirrorOnlyManagedFailures` |

`test/engine-parity/doctor-sync.test.ts` runs the members on PGLite, Postgres and Rust and compares them.
