# The brain store: doctor terminal write failure reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the request-journal reads behind `gbrain doctor`'s `persistence_terminal_failures` check, `gbrain sources writer status`
and the terminal-failure gauges. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-terminal.ts`; the text
is pinned by `test/doctor-terminal-sql.test.ts` against the classifier fragments in `src/core/persistence/terminal-failures.ts`).
The TypeScript side is `src/core/rust-engine/store-members/doctor-terminal.ts`; the store side is
`rust/crates/gbrain-store/src/cli_reads/doctor_terminal.rs`.

## Served from the store

| JS | Reads |
| --- | --- |
| `brain.readTerminalFailureGroups({ spanDays, windowDays, sourceIds })` | the grouped aggregate: one row per classifier key per source, a total row per source, the 7-day buckets, and the supersession verdict |
| `brain.listTerminalFailureBatch({ sourceId, windowDays, before, limit })` | the drill-down: terminal receipts of one source, newest first, each paired with its later request |

The classification the SQL splices from TypeScript constants (knock-on origin and messages, the superseded-pass message, fixed-in
builds, connector write kinds, page-removal operations, the connector retry lineage depth) goes in with each call as `rules`, so
the store tests the same strings the SQL does and a constant changed in TypeScript cannot drift from it. The store ports the
classification (`recovery`, `terminal`, `ended`, `routed_message`, `knock_on`, `historical_by_build`, `schema_missing`,
`connector_retry` with its lineage depth) and the supersession and pass-superseded resolution.

Differences from the SQL a caller can see on a Rust brain:

- The 5-second statement and connection deadline is not enforced. The members take the same `opts` (`timeoutMs`, `signal`) the SQL
  path uses, and the Rust members ignore them, so a slow read there is unbounded.
- Recovery records, pass bindings and the managed-sync pass row have no writer on a Rust brain, so cross-arm only the Rust unit
  tests (`cargo test -p gbrain-store cli_reads_doctor_terminal`) cover recovery and the archived-source window; the parity case
  seeds every other column.

## Members with no writer on a Rust brain (answer empty)

`persistence_source_bindings` and the managed-sync pass row are written only through `executeRaw`, which a Rust brain refuses, so
no open pass exists there. These answer `[]` in TypeScript with no store call, which is what the same read finds on a PGLite brain
nothing has written to:

| JS | Resolves | Reads |
| --- | --- | --- |
| `brain.listOpenPassCheckpointBlockers(passOp, sourceIds)` | `[]` | the open managed-sync pass checkpoints, for `readCheckpointBlockerMap` |
| `brain.listWorktreeBlockerRequests(worktreeId, checkpoint)` | `[]` | the requests that hold one worktree checkpoint |

`test/engine-parity/doctor-terminal.test.ts` runs all four members on PGLite, Postgres and Rust and compares them.
