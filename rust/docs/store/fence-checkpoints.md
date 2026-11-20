# The brain store: fence-repair checkpoint reads and the candidate part upsert

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The fence-repair census (`src/core/fence-repair/census-store.ts`) keeps one judged candidate per `op_checkpoints` row and the
uncommitted-repair notices (`src/core/fence-repair/uncommitted.ts`) ride the same table. Three statements ran through
`executeRaw`: the candidate part upsert, the candidate read joined to `sources`, and the notice read. PGLite and Postgres run
the same SQL, now in `src/core/engine-sql/collate-store-reads.ts`. The store answers from the checkpoint parent row of
`op_checkpoint_values.rs` (`crates/gbrain-store/src/fence_checkpoints.rs`); it has no keys of its own. The TypeScript members
are in `src/core/rust-engine/store-members/collate-store-reads.ts`. The notice write and the notice delete reuse
`writeOpCheckpointValues` and `deleteOpCheckpoint`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.upsertFenceCandidatePart(spec)` | nothing; the part is stored in the candidate's row | `upsertFenceCandidatePart` |
| `brain.readFenceCandidateRecords(op, sourceIds)` | the records of live source incarnations | `readFenceCandidateRecords` |
| `brain.readOpCheckpointRecords(op, sourceIds)` | `[{ fingerprint, record }]` | `readOpCheckpointRecords` |

## What each member answers

| Member | Notes |
| --- | --- |
| `upsertFenceCandidatePart` | `spec` is `{ op, fingerprint, sourceId, incarnation, key, part, finding }`. A missing row holds `{ version: 1, source_id, incarnation, key, <part>: finding }`; an existing row keeps its other keys and replaces `<part>` (`page` or `file`), and its stamp is now. |
| `readFenceCandidateRecords` | The first `completed_keys` element of each row of `op` whose source exists with the recorded incarnation (compared as text) and, unless `sourceIds` is null, whose source id is in `sourceIds`. By fingerprint byte (`ORDER BY c.fingerprint COLLATE "C"`). |
| `readOpCheckpointRecords` | The row's fingerprint and its first `completed_keys` element (`null` when the array is empty) for each row of `op` whose record's `source_id` is in `sourceIds` (every row when null). By fingerprint byte. No source is required to exist. |

An op or fingerprint with a NUL is refused, as every checkpoint member does.
