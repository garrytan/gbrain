# The brain store: doctor brain reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the page, tag, fact, source and checkpoint statements that the storage-manifest, conversation-archive,
backup-coverage, git-hold and connector-checkpoint `gbrain doctor` checks ran through `executeRaw`. PGLite and Postgres run the
same SQL as before (`src/core/engine-sql/doctor-brain.ts`; the one composed statement is pinned by
`test/doctor-brain-sql.test.ts`). The TypeScript side is `src/core/rust-engine/store-members/doctor-brain.ts` and the Rust side
is `crates/gbrain-store/src/cli_reads/doctor_brain.rs` (behavior pinned by `tests/cli_reads_doctor_brain.rs`).

## Served by the store

The backup-coverage maturity read (`readBrainMaturity`) is the stats family's member; see [stats.md](stats.md).

| JS | Reads | Rule |
| --- | --- | --- |
| `brain.listInterimStoredObjectCounts({type, shelfSourceId, prefix, adoptedTag})` | live pages of `type` outside the shelf source, whose slug starts with `prefix` and is not `prefix + 'index'`, with no `adoptedTag` tag, counted per source | rows ordered by source id bytewise |
| `brain.readOldestSourceCreatedAt()` | the earliest source `created_at`, or null with no source | ISO text |
| `brain.listVisibilityCandidatePages(sourceIds \| null)` | live pages of live sources whose frontmatter is an object with a `visibility` key in any letter case and a `visibility` value that is not the text `private` (a missing or non-text value counts as not private) | ordered by source id then slug, bytewise |

## Members with no writer on a Rust brain (answer empty)

The git-hold, managed-sync receipt and connector checkpoint rows live in `op_checkpoints` and `persistence_requests`, which only
`executeRaw` writes, and a Rust brain refuses `executeRaw`; no row of them exists there. These members answer the empty value
with no store call, which is what the same read finds on a PGLite brain nothing has written to. They are listed here so a later
writer knows which reads it must feed:

| JS | Resolves | Reads |
| --- | --- | --- |
| `brain.countVisibilityNoncanonicalHolds(holdOp, sourceIds)` | `0` | the `visibility_noncanonical` hold rows of live sources |
| `brain.listContentBlockedReceipts()` | `[]` | the failed receipts that block a managed-sync cursor |
| `brain.listPassAdmittedReceipts(sourceId, passId)` | `[]` | the failed receipts of one admitted pass |
| `brain.listOrphanConnectorCheckpoints(query)` | `[]` | the checkpoint and retry rows no source can load (also the list the repair preview prints) |

`test/engine-parity/doctor-brain.test.ts` runs the members on PGLite, Postgres and Rust and compares them.
