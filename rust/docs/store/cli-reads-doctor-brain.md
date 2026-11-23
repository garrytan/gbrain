# The brain store: doctor brain reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the page, tag, fact, source and checkpoint statements that the storage-manifest, conversation-archive,
backup-coverage, git-hold and connector-checkpoint `gbrain doctor` checks ran through `executeRaw`. PGLite and Postgres run the
same SQL as before (`src/core/engine-sql/doctor-brain.ts`; the one composed statement is pinned by
`test/doctor-brain-sql.test.ts`). The TypeScript side is `src/core/rust-engine/store-members/doctor-brain.ts` and the Rust side
is `crates/gbrain-store/src/cli_reads/doctor_brain.rs` (behavior pinned by `tests/cli_reads_doctor_brain.rs`).

## Served by the store

The backup-coverage maturity read (`readBrainMaturity`) is the stats family's member; see [stats.md](stats.md). The orphan
connector checkpoint read (`listOrphanConnectorCheckpoints`) is served by the repair bookkeeping family; see
[repair-bookkeeping.md](repair-bookkeeping.md).

| JS | Reads | Rule |
| --- | --- | --- |
| `brain.listInterimStoredObjectCounts({type, shelfSourceId, prefix, adoptedTag})` | live pages of `type` outside the shelf source, whose slug starts with `prefix` and is not `prefix + 'index'`, with no `adoptedTag` tag, counted per source | rows ordered by source id bytewise |
| `brain.readOldestSourceCreatedAt()` | the earliest source `created_at`, or null with no source | ISO text |
| `brain.listVisibilityCandidatePages(sourceIds \| null)` | live pages of live sources whose frontmatter is an object with a `visibility` key in any letter case and a `visibility` value that is not the text `private` (a missing or non-text value counts as not private) | ordered by source id then slug, bytewise |
| `brain.countNoncanonicalHolds(holdOp, code, sourceIds \| null)` | how many `holdOp` holds record `code` (`visibility_noncanonical` for `countVisibilityNoncanonicalHolds`, `readers_noncanonical` for `countReadersNoncanonicalHolds`) for an unarchived source at the incarnation they record | a count |
| `brain.listReaderCandidatePages(sourceIds \| null)` | live pages of live sources whose frontmatter has a key other than `readable_by` that reads `readableby` lower-cased with each run of `-`, `_` and `[[:space:]]` removed | ordered by source id then slug, bytewise. Postgres orders this list by the database collation (the statement has no `COLLATE "C"`), so on a non-C database the two can differ |
| `brain.listContentBlockedReceipts()` | for each `managed-sync` checkpoint whose first record is not `done: true`, the failed, conflicted or cancelled request of the record's `sourceId` whose request id is the record's `pending.requestId`: `{ source_id, error_code, error_message, error_detail }` | rows ordered by the cursor's source id bytewise; rows of one source keep their scan order |

## Members with no writer on a Rust brain (answer empty)

These members answer the empty value with no store call, which is what the same read finds on a PGLite brain nothing has
written to. They are listed here so a later writer knows which reads it must feed:

| JS | Resolves | Reads |
| --- | --- | --- |
| `brain.listPassAdmittedReceipts(sourceId, passId)` | `[]` | the failed receipts of one admitted pass |

`test/engine-parity/doctor-brain.test.ts` runs the members on PGLite, Postgres and Rust and compares them.
