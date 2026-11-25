# The brain store: doctor checkpoint reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the `op_checkpoints` and `ingest_log` statements that `gbrain doctor` checks ran through `executeRaw`. PGLite and
Postgres run the same SQL as before (`src/core/engine-sql/doctor-checkpoints.ts`; the three statements that splice a shared
predicate are pinned by `test/doctor-checkpoints-sql.test.ts`). The TypeScript side is
`src/core/rust-engine/store-members/doctor-checkpoints.ts`; the store side is `crates/gbrain-store/src/cli_reads/doctor_checkpoints.rs`.

## Members the store serves

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.writeDoctorLastKnown({op, rows})` | one row per `(op, entry)`, replaced on a later write | `writeDoctorLastKnown` |
| `brain.readDoctorLastKnown(op)` | `[{fingerprint, entry}]` for the op | `readDoctorLastKnown` |
| `brain.readLatestConnectorReceipt()` | the summary of the newest `source_type = 'connector'` row, or null | `readLatestConnectorReceipt` |
| `brain.listFactsAbsorbFailureGroups()` | the last 24 hours of `facts:absorb` failures grouped by source and reason | `listFactsAbsorbFailureGroups` |
| `brain.readSyncAdmissionSettingRow(key, op, fp)` | the config value, with no dating row | `readSyncAdmissionSettingRow` |
| `brain.readHeldHitRows({ holdOp, pageIds, sourceIds, types, terms, cap })` | every `holdOp` record naming one of `pageIds` (of a source at the recorded incarnation) with its page's `knowledge_revision`, by fingerprint bytewise; then `{ could_affect }`: how many holds of unarchived sources in `sourceIds` (at most `cap`) name one of `pageIds`, a page of one of `types`, or hold one of `terms` as a whole word in `lower(path slug title)`. The TypeScript member passes each relevance pattern as its word and refuses any other pattern | `readHeldHitRows` |
| `brain.listDerivedOriginParks(op)` | `[{park}]`: the first record of each `op` parent whose fingerprint is the decimal id of a soft-deleted page, oldest parent first, ties by fingerprint bytewise | `listDerivedOriginParks` |

Last-known rows live in the housekeeping key space (`d 0x02 <op> 0x00 <fingerprint>`, a `HousekeepingRow`). The fingerprint is the
entry name and `completed_keys` is `[value]` as a jsonb value (keys ordered by length, then bytes), so a read returns what
PGLite's `completed_keys[1]` holds. A write with no rows does nothing.

`listFactsAbsorbFailureGroups` reverse-scans `INGEST_LOG` (rows are keyed by `created_at`, then id) and stops at the first row older
than 24 hours. Groups are keyed by source id and the reason up to the first `:`. They are returned in source byte order, then
count descending, then reason ascending, which is the SQL's `ORDER BY` with the `C` collation. `n` is the count as a string and
`newest` is the group's latest `created_at` as an ISO-8601 UTC string with microsecond precision.

`readSyncAdmissionSettingRow` reads the value through `getConfig`. The SQL also selected `updated_at` of the config row and the
pass row's `set_at`; the store keeps no dating row for a config key, so `row_value` and `set_at` come back null. With `set_at` unknown the admission status counts every open pass and unpublished destructive request as earlier
(`src/core/persistence/sync-admission.ts`), which is what a PGLite brain with no dating row already does; a Rust brain has no pass rows.

## Members with no writer on a Rust brain (answer empty)

These read `op_checkpoints` rows that only the managed-sync (git) pass writes: per-source cursors, pass rows, stops, backlog headers,
purge parks, identity downgrades and held atoms; and the credential re-chunk holds,
which only the credential re-seal migration writes through `executeRaw`. A Rust brain has no such writer and no
managed-sync writer (`persistence_journal` family in `members.ts`), so the true answer is none: a list member returns `[]`, a single-row
member returns null. They are listed here so a later writer knows which reads it must feed:

`readOpCheckpointKeys`, `listPurgeParks`,
`listUnfinishedManagedSyncCursors`, `listManagedSyncPassStops`, `listManagedSyncBacklogHeaders`, `readManagedSyncPassRow`,
`listLiveManagedSyncPassRows`, `listCheckpointBlockedSources`, `listOpenIdentityDowngrades`, `listHeldManagedAtomRows`, `listCredentialResealHoldRows`.

`crates/gbrain-store/tests/cli_reads_doctor_checkpoints.rs` covers the three served stores. `test/engine-parity/doctor-checkpoints.test.ts`
runs every member on PGLite, Postgres and Rust and compares them.

`readSoakCounterRows` is served from the store now: it reads the day rows the typed `addSoakCounterEvent` writes after a
`gbrain repair --apply`, `sync unblock --apply`, `sources retry-held`, a recovery-flag sync and the needs-human sweep
(`readOpCheckpointRecords`, `completed_keys->0` of each found day; `test/engine-parity/soak-counter-writes.test.ts`).

`listFenceCandidateRecords` is served from the store now: the fence census writes its candidate rows (see [cli-reads-doctor-fence.md](cli-reads-doctor-fence.md)).
